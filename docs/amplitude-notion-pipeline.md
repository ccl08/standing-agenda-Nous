# Amplitude → Notion Pipeline

> **Location:** `AppsScript/Final GASP/`
> **Script ID:** `17K7NRO6NauzMAfxtawFcKvgPnRoNr2l_oatkRfu0BOlz2d_iyrQuUKty`
> **Timezone:** Europe/London
> **Last updated:** 2026-06-10

---

## Overview

This pipeline syncs daily influencer performance data from Amplitude into Notion post pages. It runs automatically 4× per day and chains two stages:

```
Amplitude API
     │
     ▼
Google Sheet (Daily-data tab)    ← AmplitudeSync.js
     │
     ▼
Notion Pages (per influencer post) ← NotionSync.js
```

**Three metrics are tracked per influencer per day:**

| Metric | Amplitude event | Notion property |
|--------|----------------|-----------------|
| Landing Page Views | `Viewed Marketing Site Landing Page` | `Landing Page Views` |
| Accounts Created | `G_account_created` | `Accounts Created` |
| Delegations | `G_delegation_enabled` | `Delegations` |

All data is filtered to `utm_medium = Influencers`.

---

## Files

| File | Purpose |
|------|---------|
| `AmplitudeSync.js` | Fetches data from Amplitude API → writes to Google Sheet |
| `NotionSync.js` | Reads Google Sheet + Posts sheet → writes metrics to Notion pages |
| `appsscript.json` | Project manifest (timezone, runtime V8, logging) |
| `.clasp.json` | clasp config linking to the Apps Script project |

---

## Configuration — Script Properties

All secrets and sheet IDs are stored in **Project Settings → Script Properties**. Never hardcode these.

| Key | What it is |
|-----|-----------|
| `AMPLITUDE_API_KEY` | Amplitude project API key |
| `AMPLITUDE_SECRET_KEY` | Amplitude project secret key |
| `AMPLITUDE_SHEET_ID` | Google Sheet ID where Amplitude data is written (`Daily-data` tab) |
| `NOTION_TOKEN` | Notion integration token (Internal Integration Secret) |

---

## Triggers

Managed by `setupAllTriggers()` in `AmplitudeSync.js`. Run this function once from the Apps Script editor to install triggers.

**Current schedule — `dailySync()` runs at:**
- 7am
- 9am
- 1pm (13:00)
- 8pm (20:00)

`notionSync()` has **no separate trigger** — it is chained inside `dailySync()`.

To reset triggers: select `setupAllTriggers` in the editor function dropdown → Run. It logs every deletion and creation so you can verify.

---

## Stage 1 — AmplitudeSync.js

### `dailySync()`
Main entry point. Called by all 4 daily triggers.

1. Deletes yesterday's rows from the `Daily-data` sheet
2. Fires 3 Amplitude API requests **in parallel** (`UrlFetchApp.fetchAll`) for yesterday's date
3. Writes the new rows to the sheet
4. Chains `notionSync()` — wrapped in try/catch so a Notion failure never marks the Amplitude sync as failed

### `backfill()`
Run **manually only — never put on a trigger.** Re-fetches everything from `2026-06-01` to yesterday.

- Fetches all data first; only clears and rewrites the sheet if all fetches succeed
- A mid-run Amplitude API failure leaves the sheet untouched

### `fetchAllAmplitude_(start, end)`
Internal helper. Builds one request per event and fires them all in parallel via `UrlFetchApp.fetchAll()`. Throws immediately on any non-200 response (all-or-nothing semantics).

### `syncRange(start, end)`
Fetches a custom date range and appends to the sheet. Used internally by `backfill()`, also available for manual runs.

---

## Stage 2 — NotionSync.js

### `notionSync()`
Main entry point. Called by `dailySync()` after the Amplitude sync completes.

**Processing window:** posts from yesterday and two days ago (stories are live on post day + next day, so both days are updated to capture the cumulative total).

**Per-post flow:**
1. Resolve the Amplitude `utm_campaign` key for the influencer (see UTM resolution below)
2. Sum metrics across the 2-day date window
3. Check delta — skip if values are identical to the last write (see LastWritten below)
4. Write LP / Acc / Del to the Notion page via REST API
5. Update the LastWritten cache

### UTM Resolution Waterfall

For each post, the key is resolved in priority order:

| Priority | Source | Notes |
|----------|--------|-------|
| 1 | **Corrections sheet** | Manual overrides — highest trust |
| 2a | **UTM Match Key column** | Explicit key set in Posts sheet |
| 2b | **URL utm_campaign** | Extracted from `Influencer link Amplitude match`, validated against known Amplitude keys |
| 3 | **UTM rollup / raw** | From Posts sheet columns |
| 4 | **IG handle** | Last resort |

If none resolve, the post is logged as `unresolved` and skipped.

### Fallback Matching

If the resolved key returns zero LP views, two fallback passes are attempted:

**Pass 1 — URL fallback:** Extracts `utm_campaign` directly from the `ampMatchUrl` field. If it finds data, the write proceeds with a `🔗 URL fallback` log entry.

**Pass 2 — Similarity fallback:** Runs Levenshtein string similarity against all active keys (those with LP > 0 on that date). If the best candidate scores ≥ 75%, data is written with a `⚠️ SIMILARITY GUESS (score=N%)` log entry including the matched key. **These should be reviewed and added to the Corrections sheet to prevent future guessing.**

### Delta Detection — LastWritten Tab

To avoid hammering the Notion API with unchanged values, `notionSync()` maintains a `LastWritten` tab on the Amplitude spreadsheet with columns:

```
pageId | lp | acc | del | updatedAt
```

- Loaded **once** at the start of each run (not per post)
- Before each Notion write, the new values are compared to the cached values
- If identical → skip, log `unchanged`
- If different (or no cached entry) → write to Notion, update the cache row in-place
- If the tab is missing → it is created automatically and all posts are treated as changed on that first run

### Zero-Write Protection

If metrics resolve to `lp=0, acc=0, del=0`, the post is skipped. Existing Notion data is never overwritten with zeros.

---

## Corrections Sheet

**Sheet ID:** `15C0ewJj7th_lFoV_fgz3UhNAQk16ddeCOf_OJYEwd0o`

The first tab (gid 0) maps influencer names to their correct `utm_campaign` key:

```
Column A: Influencer name (as it appears in the Posts sheet)
Column B: Correct utm_campaign key (lowercase)
```

This is the highest-priority signal in the UTM resolution waterfall. When a similarity guess appears in `Logs-daily`, add the correct mapping here to prevent future guessing.

The `Logs-daily` tab (gid `719363483`) on the same spreadsheet records every run's output.

---

## Logging

Every `notionSync()` run appends rows to the `Logs-daily` tab. Status values:

| Status | Meaning |
|--------|---------|
| `✅ matched LP=N Acc=N Del=N` | Normal exact match — written to Notion |
| `🔗 URL fallback: matched via utm_campaign in ampMatchUrl ("key")` | Matched via URL extraction |
| `⚠️ SIMILARITY GUESS (score=N%): wrote data from key "X" — confirm and add to Corrections sheet` | Fuzzy match — review required |
| `unchanged` | Values identical to last write — Notion API call skipped |
| `no data` | All metrics are zero — write skipped |
| `unresolved` | No UTM key could be resolved for this influencer |
| `❌ <error message>` | Exception during processing |

The final execution log line shows: `updated=N unchanged=N skipped=N errors=N`

---

## Testing & Diagnostics

All test functions are **read-only** — they do not write to Notion or update the LastWritten cache.

| Function | How to use |
|----------|-----------|
| `testNotionSync()` | Tests a single post date. Set `NS_TEST_DATE` at the top of the file before running |
| `testTwoDayWindow()` | Previews the 2-day attribution window without writing. Set `NS_TEST_POST_DATE` |
| `debugAmplitude()` | Prints all distinct dates in the Amplitude sheet + first few raw rows. Run when debugging date mismatches |
| `backfill()` | Rebuilds the entire Amplitude sheet from `2026-06-01`. Run manually, never on a trigger |

---

## Local Development with clasp

```bash
# Navigate to the project
cd "AppsScript/Final GASP"

# Pull latest from Apps Script
clasp pull

# Push local changes to Apps Script
clasp push

# Open in browser
clasp open
```

Credentials for clasp login are stored per-machine via `clasp login`. The `.clasp.json` file contains only the `scriptId` — no secrets.

---

## Data Flow Diagram

```
[Amplitude API]
      │  3 parallel requests (fetchAll)
      │  filter: utm_medium = Influencers
      │  group by: utm_campaign
      ▼
[Google Sheet: Daily-data tab]
      │  columns: utm_Campaign, Date, Viewed Landing Page, Accounts Created, Delegations
      │
      ├── [Posts sheet: gid 558266150]
      │       influencer name, post date, Notion page ID, UTM fields, ampMatchUrl
      │
      ├── [Corrections sheet: gid 0]
      │       influencer name → utm_campaign override map
      │
      ├── [LastWritten tab]
      │       pageId → last written lp/acc/del (delta detection cache)
      │
      ▼
[Notion Pages]
      properties: Landing Page Views, Accounts Created, Delegations
      rate limit: 350ms between writes, 10s backoff on 429
```
