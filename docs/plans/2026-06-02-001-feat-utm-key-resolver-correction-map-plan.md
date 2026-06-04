---
title: "feat: UTM Key Resolver and Correction Map"
type: feat
status: active
created: 2026-06-02
depth: standard
---

# feat: UTM Key Resolver and Correction Map

## Problem Frame

The Amplitude → Posts reporting join fails silently for at least 11 influencers because
the UTM campaign slug in the "Influencer link Amplitude match" URL does not match the
campaign key Amplitude actually recorded. A further 16+ influencers have blank URLs
or empty campaign parameters. Without a resolver, those rows return zero from Amplitude
with no indication anything went wrong.

The fix is two-layered:
1. A **correction map** (a CSV file you own) that translates wrong/missing URL keys to the
   real Amplitude key, keyed by influencer name so one entry covers all past and future posts.
2. A **resolver module** that runs a 4-signal waterfall — first signal that resolves wins,
   and unresolvable rows are flagged explicitly rather than silently returning zero.

---

## Scope

**In scope:**
- `data base/utm_key_corrections.csv` — master correction map, seeded with all 11 confirmed mismatches
- `utm_resolver.py` — standalone resolver module implementing the 4-signal waterfall
- Update `compare_amplitude_posts.py` to use the resolver and surface unmapped influencers

**Out of scope (deferred):**
- Daily 9am reporting script and scheduling (separate follow-up)
- Google Sheets write path for joined output
- n8n workflow integration
- Fuzzy/ML-based matching — explicit waterfall only

---

## Output Structure

```
data base/
  utm_key_corrections.csv     ← new: master correction map (owned by you)
utm_resolver.py               ← new: reusable resolver module
compare_amplitude_posts.py    ← modified: uses resolver, surfaces unmapped rows
```

---

## Key Technical Decisions

**1. Correction map keyed by influencer name, not URL key.**
The URL slug can change between posts (e.g. post1 vs post7 could use different slugs in theory),
but the influencer name in the Posts CSV is stable. One correction entry covers all past and
future posts from that influencer without maintenance.

**2. 4-signal waterfall — first match wins:**
```
Signal 1: UTM Match Key field          (manually curated, highest trust)
Signal 2: correction_map[influencer]   (your override table)
       or url_utm_campaign             (if it directly exists in Amplitude)
Signal 3: Influencer UTM (rollup)      (designed for blank-URL cases)
Signal 4: ref_IG Handle (strip @/_)    (last resort)
→ none:   flag as unmapped             (never silently return zero)
```

**3. CSV format for the correction map.**
Editable in any spreadsheet, diffable in git, no database. You add one row when a new
mismatch is discovered. The resolver reloads it on each run, so changes take effect immediately.

**4. Resolver as a standalone importable module.**
Both `compare_amplitude_posts.py` and the future daily report script need the same logic.
Keeping it in one file means fixes propagate everywhere automatically.

**5. Resolver resolves the key string only — it does not query Amplitude.**
Separation of concerns: the resolver answers "what Amplitude key should I use for this
influencer?". The calling script handles the Amplitude lookup and aggregation.

---

## Implementation Units

### U1. utm_key_corrections.csv

**Goal:** Create the master correction map seeded with all confirmed mismatches from analysis.

**Dependencies:** None.

**Files:**
- `data base/utm_key_corrections.csv` (new)

**Approach:**
Four columns: `influencer_name`, `amplitude_key`, `source`, `notes`.

- `influencer_name`: exact string from the Posts CSV "Influencer" column (case-sensitive match)
- `amplitude_key`: the key that exists in Amplitude with real data
- `source`: `confirmed` (validated against Amplitude data) | `inferred` (strong signal, unverified)
- `notes`: short explanation of why the override exists — essential for future maintenance

Seed rows (all confirmed from analysis):

| influencer_name | amplitude_key | source | notes |
|---|---|---|---|
| Sharon (diary of my home life) | diaryofmy.home.life | confirmed | URL uses sharon.diary — wrong slug |
| Gemma Miles | .gemmalouisemiles | confirmed | URL uses gemma.louise.miles |
| Keeping Kate | keeping.kate | confirmed | URL uses keepingkate — missing dot |
| Karen Goodbrand | missionstyle. | confirmed | URL uses missionstyle_ (underscore→dot) |
| Poppy Sparks | poppy.sparks | confirmed | URL uses poppysparks — missing dot |
| Natasha Sandhu | natashamsandhu | confirmed | Two Amplitude keys exist; this one covers posts from May 18 onward |
| Jordan Brook | jordanbrook11 | confirmed | URL uses jordan.brook |
| Charissa-Rae Mcaneny | charissa-rae.mcaneny | confirmed | URL uses charissarae |
| Rebecca Evans | beckyhomesweethomeaccount | confirmed | URL uses rebecca.evans |
| Tash G | tash.blake.ivy | confirmed | URL has typo: tash.blakke.ivy |
| Ellie Glow Mama | .glowmama. | confirmed | URL uses _glowmama_ |

**Test scenarios:** None for the file itself — correctness is validated when U2 resolves known cases.

**Verification:** File loads without parse errors; all 11 rows present; no duplicate influencer_name entries.

---

### U2. utm_resolver.py

**Goal:** Implement the 4-signal waterfall as a reusable module any script can import.

**Dependencies:** U1 (correction map must exist).

**Files:**
- `utm_resolver.py` (new)

**Approach:**
A `UTMResolver` class:

- `__init__(corrections_path, amplitude_keys=None)`:
  - Loads `utm_key_corrections.csv` → builds `name_map` (influencer_name → amplitude_key)
  - Accepts an optional set of known Amplitude keys (used to validate signal 2 direct match)
  - If `amplitude_keys` is not provided, signal 2 direct match is skipped (safe fallback)

- `resolve(row)` → `(amplitude_key: str | None, signal: int, confidence: str)`:
  - `row` is a dict or pandas Series with the Posts CSV columns
  - Returns the resolved key, which signal (1–4) produced it, and a confidence label
  - Returns `(None, 0, "unmapped")` when no signal resolves

- `resolve_dataframe(posts_df)` → posts_df with three new columns added:
  - `_resolved_key`, `_signal_used`, `_confidence`

- `get_unmapped(posts_df)` → list of influencer names that resolved to None

Waterfall implementation detail:
```
# Directional guidance — not implementation specification

Signal 1: row["UTM Match Key"] if not blank → return it
Signal 2: name_map.get(row["Influencer"]) if present → return it
          else: extract utm_campaign from URL
                if url_campaign in amplitude_keys → return url_campaign
Signal 3: row["Influencer UTM (rollup)"] if not blank → return it
Signal 4: clean(row["ref_IG Handle"]) if not blank
          where clean = strip whitespace, strip leading @, strip leading/trailing _
→ return (None, 0, "unmapped")
```

**Patterns to follow:** URL extraction logic already in `compare_amplitude_posts.py` (lines 18–34) — copy the `extract_utm_campaign` helper rather than re-implementing.

**Test scenarios:**
- Sharon row resolves to `diaryofmy.home.life` via signal 2 (correction map), not via URL
- Maddie Ball row resolves to `ayupwithmads` via signal 2 (direct URL match, present in Amplitude)
- Row with blank URL but filled "Influencer UTM (rollup)" resolves via signal 3
- Row with only ref_IG Handle (e.g. `@mummythatsings`) resolves via signal 4 → `mummythatsings`
- IG handle with leading underscore (e.g. `_housewise`) → resolves to `housewise` after cleaning
- Row with UTM Match Key filled → signal 1 wins even when correction map has a different entry
- Completely unknown influencer (no URL, no UTM, no IG handle) → returns `(None, 0, "unmapped")`
- `get_unmapped` returns the correct list when called on a dataframe with 2 unmapped rows
- `resolve_dataframe` adds all three new columns without mutating original dataframe

**Verification:** All test scenarios above pass when run against the Posts CSV; Sharon and the 10 other known-mismatch influencers resolve with `_signal_used = 2` and the correct amplitude key.

---

### U3. Update compare_amplitude_posts.py

**Goal:** Replace the inline key-derivation block with the resolver; surface unmapped influencers
in the report output; add `signal_used` column to the saved CSV.

**Dependencies:** U1, U2.

**Files:**
- `compare_amplitude_posts.py` (modify)

**Approach:**
Replace lines 36–46 (the `_utm_campaign` / `_fallback_utm` / `_match_key` derivation block)
with a `UTMResolver` init + `resolve_dataframe` call. The resolver provides `_resolved_key`
which replaces `_match_key` throughout the rest of the script.

Two output changes:
1. Add `signal_used` column to `amplitude_vs_posts_comparison.csv` — so you can see at a glance
   how each row was matched (1=explicit override, 2=URL/map, 3=UTM rollup, 4=IG handle)
2. Add `── UNMAPPED INFLUENCERS ──` section to the printed report, listing influencers where
   `_confidence == "unmapped"` — separate from "no Amplitude rows" (which means key resolved
   but Amplitude had no data for that window)

The distinction matters: "unmapped" = resolver couldn't find a key (needs manual fix);
"no Amplitude rows" = key found but Amplitude genuinely has zero data (may be correct).

**Patterns to follow:** Existing section-print pattern in the script (lines 177–180).

**Test scenarios:**
- Re-running the script after U1+U2 shows Sharon's 3 posts now have Amplitude data (previously "no Amplitude rows")
- "UNMAPPED INFLUENCERS" section lists influencers with no resolution path (Lauren Davies / `.housewise` is expected to still appear if no Amplitude data exists under any variant)
- `amplitude_vs_posts_comparison.csv` contains `signal_used` column with values 1–4 or "unmapped"
- Total "no Amplitude rows" count decreases compared to the previous run (UTM mismatches resolved)
- Previously-failing Sharon post4 shows Amplitude values now, even if they still mismatch reported values

**Verification:** Run `python compare_amplitude_posts.py`; report shows fewer "no Amplitude rows";
the 11 seeded correction entries all appear as `signal_used = 2` in the output CSV.

---

## Deferred to Follow-Up Work

- Daily 9am script that runs the resolver + fetches live Amplitude API data + writes joined output to Sheets
- Handling the Natasha Sandhu dual-key edge case properly (two Amplitude keys for the same influencer covering different date ranges) — current plan uses `natashamsandhu` as a single override
- Lauren Davies (`.housewise`) — no Amplitude key with data found yet; may need manual investigation of the actual UTM used

---

## Risks

**New influencer joins without a URL → silent gap.**
Mitigated: `get_unmapped` surfaces them. The daily report script (future) should assert
`len(get_unmapped(posts)) == 0` and fail loudly if new unmapped rows appear.

**Influencer name in Posts CSV has inconsistent formatting** (emoji, trailing spaces, alternate spellings).
Mitigated: correction map lookup should strip and normalize both sides before comparing.
Add `.strip()` to both the map key at load time and the row value at resolve time.

**Correction map grows stale** — someone adds a new influencer with the wrong UTM, it goes
undetected because signal 2 falls through to signal 3/4 which happen to resolve.
Mitigated: the `source` and `notes` columns give you an audit trail; periodic re-running of
the comparison script surfaces new mismatches before they cause reporting errors.
