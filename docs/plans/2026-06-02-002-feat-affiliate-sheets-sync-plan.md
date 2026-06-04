---
title: "feat: AffiliateSheetsSync.gs — Daily affiliate click metrics to Google Sheets"
date: 2026-06-02
status: active
depth: standard
---

# feat: AffiliateSheetsSync.gs — Daily Affiliate Click Metrics to Google Sheets

## Summary

Build a new Google Apps Script (`AffiliateSheetsSync.gs`) that reads affiliate LP-click data from the Amplitude-sourced `Affiliates-data` tab, **filters for `utm_content=adaff` rows only**, calculates per-influencer click metrics (this month, previous month, lifetime from May 2026, unpaid), reads influencer metadata from the `NotionValues` sheet, and writes a merged summary table to the `MergeData` tab of the Affiliate Channel spreadsheet — daily, as a full clear-and-rewrite.

This replaces the Notion-write path in `AffiliateNotionSync.gs` for the primary affiliate payment view, and also corrects the existing bug where that script counted all utm_campaign traffic regardless of channel.

---

## Problem Frame

`AffiliateNotionSync.gs` has two issues:

1. **No `utm_content` filter** — counts all LP clicks for a campaign, not just affiliate-link traffic (`utm_content=adaff`). This inflates affiliate click numbers.
2. **Writes to Notion** — slow (rate-limited to ~3 req/s), requires Notion API credentials, runs monthly. The user needs a daily view in Google Sheets for the current payment cycle.

The payment cycle starts **May 2026**. Lifetime clicks are calculated from 2026-05 onwards.

---

## Output: MergeData Tab Schema

| Column | Source | Notes |
|---|---|---|
| Name | utm_campaign key | Normalized from Amplitude data |
| Status | NotionValues pass-through | e.g. "Affiliate" |
| Affiliate: Unpaid Clicks | Calculated | Months after Last Payment date |
| Affiliate: Clicks This Month | Calculated | Current calendar month, adaff only |
| Affiliate: Clicks Previous Month | Calculated | Previous calendar month, adaff only |
| Affiliate: Lifetime Clicks | Calculated | May 2026 onwards, adaff only |
| Affiliate: Last Payment | NotionValues pass-through | Date or blank |
| Affiliate: Current Month | Dynamic label | e.g. "June" |

---

## Data Sources

| Source | Spreadsheet ID | Tab | Content |
|---|---|---|---|
| Amplitude data | `AFF_SHEET_ID` (in AffiliateSync.gs) | `Affiliates-data` | Daily rows: date, utm_campaign, utm_content, LP clicks |
| Influencer metadata | `1eFkukSGwI7E4bQFk2lolekx3abQkYKBzr3r2V8bpV6A` | first tab (gid=0) | Name, Status, Affiliate: Last Payment |
| Output | `19COFeVqjvByU1NZUVnBnuxA1_6eBToZnitGzz0mRWlA` | `MergeData` | Merged summary — cleared and rewritten daily |

---

## High-Level Technical Design

*Directional guidance for review, not implementation specification.*

```
affiliateSheetsSync()
  ├── asmLoadAffData_()       → { campaign → { 'YYYYMM' → lpClicks } }
  │     filters: utm_content=adaff, date >= 2026-05
  │
  ├── asmLoadNotionValues_()  → [ { resolvedKey, signal, name, status, lastPayment } ]
  │     3-signal waterfall per influencer (port of utm_resolver.py):
  │       1. UTM Handle  2. URL utm_campaign param  3. Influencer UTM
  │
  ├── asmBuildRows_()         → [ outputRow[] ]
  │     for each influencer in notionValues:
  │       resolvedKey → exact lookup in ampData
  │       compute: thisMonth, prevMonth, lifetime, unpaid
  │       unpaidClicks = sum(months after lastPaymentYM)
  │                       if lastPayment null: = lifetimeClicks
  │
  └── asmWriteMergeData_()    → clears tab, writes header + rows
```

**Unpaid Clicks definition:**
- `lastPaymentYM` = `YYYYMM` integer derived from the Last Payment date
- `unpaid` = sum of monthly buckets where `monthYM > lastPaymentYM`
- If Last Payment is blank/null: all lifetime months are unpaid

---

## Implementation Units

### U1. Script scaffold, constants, and daily trigger

**Goal**: Create the file with all constants, shared date helpers, and trigger-registration function.

**Dependencies**: None

**Files**:
- `AppsScript/AffiliateSheetsSync.gs` (create)

**Approach**:
- Constants block:
  - `ASM_MERGE_SHEET_ID` = `'19COFeVqjvByU1NZUVnBnuxA1_6eBToZnitGzz0mRWlA'`
  - `ASM_NOTION_VALUES_ID` = `'1eFkukSGwI7E4bQFk2lolekx3abQkYKBzr3r2V8bpV6A'`
  - `ASM_AFF_DATA_TAB` = `'Affiliates-data'`
  - `ASM_MERGE_TAB` = `'MergeData'`
  - `ASM_LIFETIME_START` = `'2026-05'`
- Date helpers: `asmParseDate_()`, `asmParseYearMonth_()`, `asmGetCurrentYM_()`, `asmGetPrevYM_()`, `asmYmToMonthName_()` — mirror the `ansParseDate_` / `ansParseYearMonth_` pattern from `AffiliateNotionSync.gs`
- Fuzzy match helpers: copy `ansAlpha_` and `nsEditDist_` from `AffiliateNotionSync.gs` / `NotionSync.gs`, rename with `asm` prefix
- `asMCreateDailyTrigger()`: delete any existing trigger for `affiliateSheetsSync`, register a new daily time-based trigger at 8am

**Patterns to follow**: `ansCreateMonthlyTrigger()` in `AppsScript/AffiliateNotionSync.gs`

**Test scenarios**:
- Calling `asMCreateDailyTrigger()` twice results in exactly one trigger (idempotent)
- `asmParseDate_('20260601')` returns a valid Date for 2026-06-01
- `asmParseDate_('')` returns null
- `asmGetCurrentYM_()` returns `202606` on June 2026
- `asmGetPrevYM_()` returns `202605` when current month is June
- `asmGetPrevYM_()` handles January correctly (rolls back to December of prior year)
- `asmYmToMonthName_(202606)` returns `'June'`

**Verification**: All helpers unit-testable via Logger.log. Trigger visible in Apps Script dashboard after calling setup function.

---

### U2. Amplitude data reader with utm_content filter

**Goal**: Load and filter `Affiliates-data`, returning per-campaign monthly LP-click totals for `adaff` traffic only from May 2026 onwards.

**Dependencies**: U1

**Files**:
- `AppsScript/AffiliateSheetsSync.gs`

**Approach**:
- Open `AFF_SHEET_ID` (shared constant defined in `AffiliateSync.gs`), read `Affiliates-data` tab
- Detect column indices by header name: `utm_campaign`, `utm_content`, `date`, `viewed marketing site landing page`
  - Normalize all values: `utm_campaign.trim().toLowerCase()`, `utm_content.trim().toLowerCase()`
- **Only read `viewed marketing site landing page`** — no other Amplitude event counts (mirrors `amp["lp_views"]` in `compare_amplitude_posts.py`)
- If `utm_content` column is absent (older rows), treat row as non-adaff and skip
- Skip rows where `utm_content !== 'adaff'`
- Skip rows where parsed date < ASM_LIFETIME_START (2026-05)
- Build two outputs:
  - `ampData`: `{ campaign: { 'YYYYMM': lpClicks } }` — e.g. `{ 'alice.t.(gfy)': { '202605': 14, '202606': 6 } }`
  - `amplitudeKeys`: `Set` of all unique `utm_campaign` strings in the adaff-filtered data (used by U3 to validate waterfall signals — mirrors `amplitude_keys = set(amp["utm_campaign"].unique())` in `compare_amplitude_posts.py:44`)
- Log: total rows read, adaff rows counted, campaigns found

**Key fix note**: `AffiliateNotionSync.gs:ansLoadAffiliateDataRange_()` at line 138 has no utm_content check — this function is the corrected replacement.

**Patterns to follow**: `ansLoadAffiliateDataRange_()` in `AppsScript/AffiliateNotionSync.gs:138`

**Test scenarios**:
- Row with `utm_content='adaff'`, date `20260601`, campaign `danielle`, lp=10 → included in `{ danielle: { '202606': 10 } }`
- Row with `utm_content='organic'` → excluded
- Row with `utm_content=''` or column missing → excluded
- Row with `utm_content='ADAFF'` (uppercase) → included (case-insensitive match)
- Row dated `20260430` (before May 2026) → excluded even if adaff
- Two rows same campaign, same month → totals aggregate (not overwrite)
- Two rows same campaign, different months → separate YYYYMM buckets

**Verification**: `testAffiliateSheetsSync()` logs campaign count and a sample of per-month buckets. Compare to a manual filter of the Affiliates-data tab.

---

### U3. NotionValues sheet reader

**Goal**: Load influencer metadata (UTM Handle, name, status, last payment) from the NotionValues sheet, returning a resolved utm_campaign key per influencer using a 3-signal waterfall.

**Dependencies**: U1

**Files**:
- `AppsScript/AffiliateSheetsSync.gs`

**Approach**:
- Open `ASM_NOTION_VALUES_ID`, read first sheet (index 0)
- Detect headers by name (case-insensitive)
- **Confirmed column names** (from `I.Influencers - I.Influencers.csv`):
  - `UTM Handle` — the affiliate link utm_campaign value (e.g. `alice.t.(gfy)`)
  - `Influencer Link Amplitud match` — full URL; extract utm_campaign via URL parse
  - `Influencer UTM` — rollup UTM (last resort)
  - `Name` — display name
  - `Status` — e.g. `"Affiliate"`
  - `Affiliate: Last Payment start` — date string (Notion exports date ranges with `start` suffix)
- Filter to rows where `Status` contains `"Affiliate"` (143 rows currently)
- **3-signal waterfall per influencer** (port of `utm_resolver.py:UTMResolver.resolve()`, validated against `amplitudeKeys` set from U2 — same pattern as `compare_amplitude_posts.py:44–46`):
  1. `UTM Handle` — normalize to lowercase; accept only if present in `amplitudeKeys`
  2. Extract `utm_campaign` from `Influencer Link Amplitud match` URL (URL-parse the query string); accept only if present in `amplitudeKeys`
  3. `Influencer UTM` — normalize to lowercase; used as fallback without key validation
  - If all three fail → `resolvedKey: null` (log as unresolved)
- Parse `Affiliate: Last Payment start` as a Date via `asmParseDate_()`
- Return `[{ resolvedKey: string|null, signal: number, name: string, status: string, lastPayment: Date|null }]`

**Patterns to follow**: Waterfall logic in `utm_resolver.py:73–121` (port to GAS); header-detection in `AppsScript/AffiliateNotionSync.gs:149`

**Test scenarios**:
- Row with UTM Handle=`alice.t.(gfy)` → `resolvedKey='alice.t.(gfy)'`, signal=1
- Row with blank UTM Handle, URL=`...utm_campaign=hayleyrubery` → `resolvedKey='hayleyrubery'`, signal=2
- Row with blank UTM Handle, blank URL, Influencer UTM=`moneysavvymumuk` → `resolvedKey='moneysavvymumuk'`, signal=3
- Row with all three empty → `resolvedKey: null`
- Row with Last Payment set → `lastPayment` is a valid Date
- Non-affiliate rows (Status != 'Affiliate') are excluded

**Verification**: `testAffiliateSheetsSync()` logs each influencer with their resolved key, signal number, and last payment date.

---

### U4. Per-influencer metrics aggregation

**Goal**: For each influencer resolved in U3, look up their amplitude data by resolved UTM key and compute all output metrics.

**Dependencies**: U2, U3

**Files**:
- `AppsScript/AffiliateSheetsSync.gs`

**Approach**:
- For each influencer from U3, use `resolvedKey.toLowerCase()` as a direct key lookup in the amplitude map
- Log any influencer where `resolvedKey` is null (unresolved — will show 0s)
- With the matched campaign, extract monthly buckets from amplitude data
- Compute:
  - `currentYM` = `asmGetCurrentYM_()`
  - `prevYM` = `asmGetPrevYM_()`
  - `clicksThisMonth` = `ampData[campaign][currentYM] || 0`
  - `clicksPrevMonth` = `ampData[campaign][prevYM] || 0`
  - `lifetimeClicks` = sum of all months in `ampData[campaign]` (all are ≥ 2026-05 by U2 filter)
  - `lastPaymentYM` = `lastPayment ? (lastPayment.getFullYear()*100 + lastPayment.getMonth()+1) : 0`
  - `unpaidClicks` = sum of buckets where `parseInt(monthKey) > lastPaymentYM`; if `lastPaymentYM === 0`, equals `lifetimeClicks`
- Build output row array in column order matching MergeData schema
- Include influencer even if no campaign match (all click fields = 0)
- "Affiliate: Current Month" = `asmYmToMonthName_(currentYM)`

**Patterns to follow**: Waterfall resolution in `utm_resolver.py:95–121`; monthly bucketing in `AppsScript/AffiliateNotionSync.gs:163`

**Test scenarios**:
- Influencer with no amplitude match: all click columns = 0, status/name/last payment still populated
- Influencer with last payment April 2026 (YYYYMM=202604): unpaid = May+June+... total only
- Influencer with null last payment: unpaid = lifetimeClicks
- Influencer with last payment June 2026 (current month): unpaid = 0 (no months after current month yet)
- Influencer whose UTM Handle matches exact campaign key: clicks populated correctly
- Influencer whose UTM Handle has no matching campaign key: all click columns = 0

**Verification**: Smoke test logs each row with matched campaign key and computed values. Cross-check manually against Amplitude data for one influencer.

---

### U5. MergeData writer and entry point

**Goal**: Entry-point function that orchestrates the full pipeline and writes results to the MergeData tab.

**Dependencies**: U2, U3, U4

**Files**:
- `AppsScript/AffiliateSheetsSync.gs`

**Approach**:
- `affiliateSheetsSync()`: main entry function (also the trigger handler)
  1. Log run start with timestamp
  2. Load amplitude data (U2)
  3. Load NotionValues (U3)
  4. Build rows (U4)
  5. Write to MergeData (U5 helper below)
  6. Log summary: rows written, unmatched influencers, duration
- `asmWriteMergeData_(rows)`:
  - Open `ASM_MERGE_SHEET_ID`, get or create tab named `ASM_MERGE_TAB`
  - `sheet.clearContents()` — full clear before rewrite
  - Write header row as row 1
  - Write all data rows in a single `sheet.getRange(...).setValues(allRows)` call
  - If zero data rows: write header only, log warning

**Patterns to follow**: Bulk `setValues()` rather than per-row appends (better performance, atomic write)

**Test scenarios**:
- Running `affiliateSheetsSync()` twice: second run overwrites first, no duplicate rows
- Zero matching influencers: header row written, body empty, no crash
- MergeData tab does not exist: tab is created and written correctly
- Header row matches the 8-column schema exactly (column order matters)

**Verification**: Run `affiliateSheetsSync()` from Apps Script editor. Check MergeData tab in the target spreadsheet. Row count should match influencer count in NotionValues.

---

### U6. Smoke test function

**Goal**: Manual dry-run function that logs the would-be output without writing to Sheets.

**Dependencies**: U2, U3, U4

**Files**:
- `AppsScript/AffiliateSheetsSync.gs`

**Approach**:
- `testAffiliateSheetsSync()`:
  - Run U2 + U3 + U4
  - Log all headers detected in NotionValues (for column-name verification)
  - Log each output row in a readable format
  - Log counts: matched, unmatched, total influencers
  - Do NOT call `asmWriteMergeData_` (read-only test)

**Test scenarios**:
- Logging output matches expected values for at least one known influencer (e.g. Danielle JX)
- Unmatched influencers are clearly flagged in the log

**Verification**: Run from Apps Script editor, check execution log. Compare matched campaign keys against the Affiliates-data tab manually.

---

## Key Technical Decisions

| Decision | Rationale |
|---|---|
| `utm_content='adaff'` filter applied at read time (U2) | Cleaner than post-aggregation filtering; makes the filter visible at the data layer |
| Lifetime starts 2026-05, not 2026-03 | User confirmed payment cycle starts May 2026 |
| Unpaid = months strictly after lastPaymentYM | Consistent with existing Notion data (verified against screenshot: Mercedes 76 prev paid, 193 this month unpaid) |
| All NotionValues influencers appear in output | Even with 0 amplitude data — the payment view must show all affiliates, not just active ones |
| Clear-and-rewrite pattern | Simpler than upsert; daily runs are idempotent; no stale rows |
| **Exact match via `UTM Handle`** | CSV confirms `UTM Handle` = exact `utm_campaign` value in Amplitude; no fuzzy matching needed or wanted |

---

## Scope Boundaries

**In scope:**
- New `AffiliateSheetsSync.gs` with daily trigger
- `utm_content=adaff` filter (also documents the same bug in `AffiliateNotionSync.gs`)
- All 8 output columns matching the Notion I.Influencers view
- May 2026 as lifetime start

**Out of scope:**
- Modifying `AffiliateNotionSync.gs` (existing Notion sync untouched)
- Backfilling data before May 2026
- Automating Last Payment updates (currently manual in Notion)

### Deferred to Follow-Up Work
- Once MergeData is validated, `AffiliateNotionSync.gs` Notion-write path may be deprecated
- A "mark as paid" function that writes Last Payment back to NotionValues when payment is processed

---

## Risks

| Risk | Mitigation |
|---|---|
| NotionValues column names differ from expected | U3 logs all detected headers on first run; implementer verifies before wiring match logic |
| `utm_content` column absent in older Affiliates-data rows | U2 treats missing column as non-adaff (skip) — older rows silently excluded |
| Fuzzy match fails for new/renamed influencers | Same limitation as `AffiliateNotionSync.gs`; unmatched rows show 0s rather than crashing |
| AFF_SHEET_ID not accessible from the new script's Apps Script project | Must be deployed in the same GAS project as `AffiliateSync.gs` or the constant must be re-declared locally |

---

## Deferred Implementation Notes

- The exact YYYYMM integer key format (`202605`) should be verified against the date values actually present in Affiliates-data headers at implementation time.
- If the NotionValues sheet is inside the *same* target spreadsheet (`19COFeVqjvByU1NZUVnBnuxA1_6eBToZnitGzz0mRWlA`) rather than the separate ID provided, `ASM_NOTION_VALUES_ID` should be replaced with `ASM_MERGE_SHEET_ID` and the tab read by name. Implementer should confirm which spreadsheet holds the NotionValues tab.
