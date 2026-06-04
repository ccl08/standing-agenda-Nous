"""
Daily Amplitude → Notion sync pipeline.

Reads Amplitude traffic data from a live Google Sheet, resolves each post's
UTM key using the correction map, calculates per-post metrics for the
attribution window (post date → next post date, or today), and writes
Landing Page Views / Accounts Created / Delegations back to each Notion page.

Dependencies:  pip install pandas requests gspread google-auth notion-client
Environment:   NOTION_TOKEN=<your-notion-integration-token>
Schedule:      Run daily at 08:00 (via n8n Execute Command or cron)
"""

import io
import os
import requests
import pandas as pd
from urllib.parse import urlparse, parse_qs
from utm_resolver import UTMResolver, SHEETS_CREDS_PATH

# Load .env if present (works both locally and when called from n8n)
try:
    from dotenv import load_dotenv
    load_dotenv(os.path.join(os.path.dirname(__file__), ".env"))
except ImportError:
    pass

# ── Configuration ──────────────────────────────────────────────────────────────
AMPLITUDE_SHEET_ID = "1eghadoVWL30ALoa8ieemziRJL4rcHOOTniQz40xFlW8"
POSTS_SHEET_ID     = "1dMyCjRce8kdMPacpGV-gk9T0mRhnHvh7Xwn0fQpKsJY"
POSTS_SHEET_GID    = "558266150"
CORRECTIONS_SOURCE = (
    "https://docs.google.com/spreadsheets/d/"
    "15C0ewJj7th_lFoV_fgz3UhNAQk16ddeCOf_OJYEwd0o/edit?gid=0#gid=0"
)
NOTION_TOKEN = os.environ.get("NOTION_TOKEN", "")

# Notion property names (must match exactly what's in the database)
NOTION_LP_PROP  = "Landing Page Views"
NOTION_ACC_PROP = "Accounts Created"
NOTION_DEL_PROP = "Delegations"

# Only sync posts published within this many days (avoids updating entire history daily)
SYNC_LOOKBACK_DAYS = 180


# ── Google Sheets reader ───────────────────────────────────────────────────────
def _normalize_columns(df):
    """
    Strip emoji prefixes that Notion/Sync2Sheets adds to column names.
    E.g. '📅  Post date start' → 'Post date start'
    Also normalises known spelling variants so the UTM resolver finds them.
    """
    import re
    def clean(col):
        col = re.sub(r'^[^\x00-\x7F]+\s*', '', col)
        return col.strip()

    df.columns = [clean(c) for c in df.columns]

    # Known variant: sheet spells it 'Amplitud match' (missing 'e') with capital L
    df.columns = [
        c.replace("Influencer Link Amplitud match", "Influencer link Amplitude match")
        for c in df.columns
    ]
    return df


def read_gsheet(sheet_id, gid="0"):
    """Load a Google Sheet as a DataFrame. Falls back to service account if not public."""
    url = (
        f"https://docs.google.com/spreadsheets/d/{sheet_id}"
        f"/export?format=csv&gid={gid}"
    )
    try:
        r = requests.get(url, allow_redirects=True, timeout=30)
        r.raise_for_status()
        return _normalize_columns(pd.read_csv(io.StringIO(r.text), low_memory=False))
    except Exception:
        pass

    try:
        import gspread
        from google.oauth2.service_account import Credentials
        creds = Credentials.from_service_account_file(
            SHEETS_CREDS_PATH,
            scopes=["https://www.googleapis.com/auth/spreadsheets.readonly"],
        )
        gc = gspread.authorize(creds)
        sh = gc.open_by_key(sheet_id)
        ws = next((w for w in sh.worksheets() if str(w.id) == gid), sh.get_worksheet(0))
        return _normalize_columns(pd.DataFrame(ws.get_all_records()))
    except Exception as e:
        raise RuntimeError(f"Could not read Google Sheet {sheet_id}: {e}") from e


def load_amplitude(sheet_id):
    """
    Load Amplitude data from Google Sheet.
    Handles both clean sheets and sheets exported directly from Amplitude
    (which have 5 metadata rows before the header).
    """
    df = read_gsheet(sheet_id)
    df.columns = [c.strip() for c in df.columns]

    # Auto-detect Amplitude export metadata rows and skip them
    first_val = str(df.iloc[0, 0]).strip() if len(df) > 0 else ""
    if first_val.lower() in ("user", "project", "date range", "timezone", "segment"):
        url = (
            f"https://docs.google.com/spreadsheets/d/{sheet_id}"
            f"/export?format=csv&gid=0"
        )
        r = requests.get(url, allow_redirects=True, timeout=30)
        r.raise_for_status()
        df = pd.read_csv(io.StringIO(r.text), skiprows=5)
        df.columns = [c.strip() for c in df.columns]

    if df.empty or len(df.columns) < 5:
        raise RuntimeError(
            "Amplitude sheet appears empty or has fewer than 5 columns. "
            "Please populate the sheet before running this script."
        )

    # Rename to standard 5 columns regardless of source column names
    df = df.iloc[:, :5].copy()
    df.columns = ["utm_campaign", "date", "lp_views", "accounts", "delegations"]
    df["utm_campaign"] = df["utm_campaign"].fillna("").str.strip().str.lower()
    df["date"] = pd.to_datetime(df["date"], errors="coerce")
    return df.dropna(subset=["date"])


# ── Notion writer ──────────────────────────────────────────────────────────────
def get_notion_client():
    if not NOTION_TOKEN:
        print("⚠️  NOTION_TOKEN not set — Notion updates skipped")
        return None
    try:
        from notion_client import Client
        return Client(auth=NOTION_TOKEN)
    except ImportError:
        print("⚠️  notion-client not installed — run: pip install notion-client")
        return None


def update_notion_page(notion, page_id, lp_views, accounts, delegations):
    notion.pages.update(
        page_id=page_id,
        properties={
            NOTION_LP_PROP:  {"number": int(lp_views)},
            NOTION_ACC_PROP: {"number": int(accounts)},
            NOTION_DEL_PROP: {"number": int(delegations)},
        },
    )


# ── URL helpers ────────────────────────────────────────────────────────────────
def extract_utm_campaign(url):
    if pd.isna(url) or not str(url).startswith("http"):
        return ""
    try:
        qs = parse_qs(urlparse(str(url)).query)
        return qs.get("utm_campaign", [""])[0].strip().lower()
    except Exception:
        return ""


def extract_utm_content(url):
    if pd.isna(url) or not str(url).startswith("http"):
        return ""
    try:
        qs = parse_qs(urlparse(str(url)).query)
        return qs.get("utm_content", [""])[0].strip().lower()
    except Exception:
        return ""


# ── Load data ──────────────────────────────────────────────────────────────────
print("Loading Amplitude data from Google Sheets...")
amp = load_amplitude(AMPLITUDE_SHEET_ID)
print(f"  {len(amp):,} rows | {amp['date'].min().date()} → {amp['date'].max().date()}")

print("Loading Posts data from Google Sheets...")
posts = read_gsheet(POSTS_SHEET_ID, gid=POSTS_SHEET_GID)
posts.columns = posts.columns.str.strip()
print(f"  {len(posts):,} posts")

# Find the Page ID column (flexible match in case of emoji encoding variation)
page_id_col = next(
    (c for c in posts.columns if "page id" in c.lower()),
    None,
)
if page_id_col:
    print(f"  Page ID column: '{page_id_col}'")
else:
    print("  ⚠️  No 'Page ID' column found — Notion updates will be skipped")


# ── UTM resolution ─────────────────────────────────────────────────────────────
posts["_utm_content"] = posts["Influencer link Amplitude match"].apply(extract_utm_content)

amplitude_keys = set(amp["utm_campaign"].unique())
resolver = UTMResolver(CORRECTIONS_SOURCE, amplitude_keys=amplitude_keys)
posts = resolver.resolve_dataframe(posts)

posts["_post_date"] = pd.to_datetime(posts["Post date start"], errors="coerce")

# Filter to recent posts only to avoid updating the entire historical database
cutoff = pd.Timestamp.today() - pd.Timedelta(days=SYNC_LOOKBACK_DAYS)
posts = posts[posts["_post_date"] >= cutoff].reset_index(drop=True)
print(f"  {len(posts):,} posts after {SYNC_LOOKBACK_DAYS}-day filter")


# ── Attribution windows (post date + 1 day) ────────────────────────────────────
posts_sorted = (
    posts
    .sort_values(["_resolved_key", "_utm_content", "_post_date"])
    .reset_index(drop=True)
)
posts_sorted["_window_end"] = posts_sorted["_post_date"] + pd.Timedelta(days=1)


# ── Per-post Amplitude aggregation + Notion sync ──────────────────────────────
notion = get_notion_client()
results = []
notion_updated = 0
notion_errors  = 0

for _, row in posts_sorted.iterrows():
    match_key  = row["_resolved_key"]
    confidence = row["_confidence"]
    post_date  = row["_post_date"]
    window_end = row["_window_end"]

    page_id = ""
    if page_id_col:
        raw = row.get(page_id_col, "")
        page_id = "" if pd.isna(raw) else str(raw).strip()

    def val(x):
        try:
            return int(float(x))
        except Exception:
            return None

    rep_lp  = val(row.get("Landing Page Views", ""))
    rep_acc = val(row.get("Accounts Created", ""))
    rep_del = val(row.get("Delegations", ""))

    if confidence == "unmapped" or pd.isna(post_date):
        results.append({
            "Influencer": row["Influencer"],
            "Post date":  row["Post date start"],
            "page_id":    page_id or "—",
            "match_key":  match_key or "— unmapped —",
            "signal":     "unmapped",
            "amp_lp":     None, "amp_acc": None, "amp_del": None,
            "rep_lp":     rep_lp, "rep_acc": rep_acc, "rep_del": rep_del,
            "lp_diff":    "—", "acc_diff": "—", "del_diff": "—",
            "notion":     "skipped (unmapped)",
        })
        continue

    mask = (
        (amp["utm_campaign"] == match_key) &
        (amp["date"] >= post_date) &
        (amp["date"] <= window_end)
    )
    subset = amp[mask]

    # Data-aware fallback: if the resolved key has no data for this window,
    # try alternative keys in two passes:
    #   1. URL-derived utm_campaign (cheap, exact match)
    #   2. String-similarity against all keys that have data on this date
    #      (catches dual-key influencers like natashamsandhu / natasha.sandhu)
    if subset["lp_views"].sum() == 0:
        # Pass 1: URL key
        url_key = extract_utm_campaign(row.get("Influencer link Amplitude match", ""))
        if url_key and url_key != match_key:
            url_mask = (
                (amp["utm_campaign"] == url_key) &
                (amp["date"] >= post_date) &
                (amp["date"] <= window_end)
            )
            url_subset = amp[url_mask]
            if url_subset["lp_views"].sum() > 0:
                subset     = url_subset
                match_key  = url_key
                confidence = confidence + "+url_fallback"

    if subset["lp_views"].sum() == 0:
        # Pass 2: similarity search among keys that have data on this date
        import re as _re
        from difflib import SequenceMatcher
        def _clean(k): return _re.sub(r"[._\-]", "", k.lower())
        def _sim(a, b): return SequenceMatcher(None, _clean(a), _clean(b)).ratio()

        active = amp[
            (amp["date"] >= post_date) &
            (amp["date"] <= window_end) &
            (amp["lp_views"] > 0)
        ]["utm_campaign"].unique()

        best_key, best_sim, best_sub = match_key, 0.0, subset
        for candidate in active:
            if candidate == match_key:
                continue
            sim = _sim(match_key, candidate)
            if sim > best_sim:
                best_sim = sim
                best_key = candidate
                c_mask = (
                    (amp["utm_campaign"] == candidate) &
                    (amp["date"] >= post_date) &
                    (amp["date"] <= window_end)
                )
                best_sub = amp[c_mask]

        # Only accept if similarity is high enough (avoids false positives)
        if best_sim >= 0.75 and best_sub["lp_views"].sum() > 0:
            subset     = best_sub
            match_key  = best_key
            confidence = confidence + f"+similar({best_sim:.2f})"

    amp_lp   = int(subset["lp_views"].sum())
    amp_acc  = int(subset["accounts"].sum())
    amp_del  = int(subset["delegations"].sum())
    amp_days = subset["date"].nunique()

    def diff_str(rep, amp_v):
        if rep is None:
            return "—"
        d = amp_v - rep
        pct = (d / rep * 100) if rep else 0
        sign = "+" if d > 0 else ""
        return "✅" if d == 0 else f"❌ {sign}{d} ({sign}{pct:.0f}%)"

    notion_status = "—"
    if notion and page_id and page_id.lower() not in ("nan", ""):
        if amp_lp == 0 and amp_acc == 0 and amp_del == 0:
            notion_status = "skipped (no data)"
        else:
            try:
                update_notion_page(notion, page_id, amp_lp, amp_acc, amp_del)
                notion_status = "✅"
                notion_updated += 1
            except Exception as e:
                notion_status = f"❌ {e}"
                notion_errors += 1

    results.append({
        "Influencer": row["Influencer"],
        "Post date":  row["Post date start"],
        "page_id":    page_id or "—",
        "match_key":  match_key,
        "signal":     confidence,
        "window":     f"{post_date.date()} → {window_end.date()} ({amp_days}d)",
        "amp_lp":     amp_lp,  "amp_acc":  amp_acc,  "amp_del":  amp_del,
        "rep_lp":     rep_lp,  "rep_acc":  rep_acc,  "rep_del":  rep_del,
        "lp_diff":    diff_str(rep_lp, amp_lp),
        "acc_diff":   diff_str(rep_acc, amp_acc),
        "del_diff":   diff_str(rep_del, amp_del),
        "notion":     notion_status,
    })

df = pd.DataFrame(results)


# ── Summary report ─────────────────────────────────────────────────────────────
today_str = pd.Timestamp.today().strftime("%Y-%m-%d")
print("\n" + "=" * 90)
print(f"AMPLITUDE → NOTION SYNC — {today_str}")
print("=" * 90)

total     = len(df)
unmapped  = df[df["signal"] == "unmapped"]
has_data  = df[(df["signal"] != "unmapped") & (df["amp_lp"].fillna(0) > 0)]
zero_data = df[(df["signal"] != "unmapped") & (df["amp_lp"].fillna(0) == 0)]

print(f"\n  Posts processed        : {total}")
print(f"  Posts with Amplitude   : {len(has_data)}")
print(f"  Posts with zero data   : {len(zero_data)} (placeholder UTMs / no tracking)")
print(f"  Unmapped posts         : {len(unmapped)}")
if notion:
    print(f"\n  Notion pages updated   : {notion_updated}")
    if notion_errors:
        print(f"  Notion errors          : {notion_errors}")

mismatches = df[
    df["lp_diff"].str.startswith("❌", na=False) |
    df["acc_diff"].str.startswith("❌", na=False) |
    df["del_diff"].str.startswith("❌", na=False)
]
if len(mismatches):
    print(f"\n  ⚠️  {len(mismatches)} posts where reported values ≠ Amplitude:")
    for _, r in mismatches.iterrows():
        print(
            f"    {r['Influencer']} | {r['Post date']} | "
            f"LP:{r['lp_diff']}  Acc:{r['acc_diff']}  Del:{r['del_diff']}"
        )

# Save full log
out_path = "data base/amplitude_sync_log.csv"
df.to_csv(out_path, index=False)
print(f"\n  Full log saved: {out_path}")
