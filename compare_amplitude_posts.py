import pandas as pd
from urllib.parse import urlparse, parse_qs
from utm_resolver import UTMResolver, SHEETS_CREDS_PATH

# ── Load data ──────────────────────────────────────────────────────────────
amp = pd.read_csv(
    "data base/amplitude_march_may_2026.csv",
    skiprows=5,
    parse_dates=["date"],
)
amp.columns = ["utm_campaign", "date", "lp_views", "accounts", "delegations"]
amp["utm_campaign"] = amp["utm_campaign"].fillna("").str.strip().str.lower()
amp["date"] = pd.to_datetime(amp["date"])

posts = pd.read_csv("data base/March-May 2026 Posts.csv")
posts.columns = posts.columns.str.strip()

# ── Extract utm_campaign from the Amplitude match URL ─────────────────────
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

posts["_utm_content"] = posts["Influencer link Amplitude match"].apply(extract_utm_content)

CORRECTIONS_SOURCE = (
    "https://docs.google.com/spreadsheets/d/"
    "15C0ewJj7th_lFoV_fgz3UhNAQk16ddeCOf_OJYEwd0o/edit?gid=0#gid=0"
)

amplitude_keys = set(amp["utm_campaign"].unique())
resolver = UTMResolver(CORRECTIONS_SOURCE, amplitude_keys=amplitude_keys)
posts = resolver.resolve_dataframe(posts)

# ── Parse post date ───────────────────────────────────────────────────────
posts["_post_date"] = pd.to_datetime(posts["Post date start"], errors="coerce")

# ── Sort posts so we can compute per-post windows ────────────────────────
posts_sorted = posts.sort_values(["_resolved_key", "_utm_content", "_post_date"]).reset_index(drop=True)

# Compute window end: start of the NEXT post for the same campaign, or end of May
def compute_windows(df):
    df = df.copy()
    df["_window_end"] = pd.NaT
    for idx, row in df.iterrows():
        same_campaign = df[
            (df["_resolved_key"] == row["_resolved_key"]) &
            (df["_post_date"] > row["_post_date"])
        ]
        if len(same_campaign) > 0:
            df.at[idx, "_window_end"] = same_campaign["_post_date"].min() - pd.Timedelta(days=1)
        else:
            df.at[idx, "_window_end"] = pd.Timestamp("2026-05-31")
    return df

posts_sorted = compute_windows(posts_sorted)

# ── Aggregate Amplitude for each post window ─────────────────────────────
results = []

for _, row in posts_sorted.iterrows():
    match_key   = row["_resolved_key"]
    signal_used = row["_signal_used"]
    confidence  = row["_confidence"]
    post_date   = row["_post_date"]
    window_end  = row["_window_end"]

    reported_lp  = row.get("Landing Page Views", "")
    reported_acc = row.get("Accounts Created", "")
    reported_del = row.get("Delegations", "")

    if confidence == "unmapped" or pd.isna(post_date):
        notes = "unmapped" if confidence == "unmapped" else "No date"
        results.append({
            "Influencer":       row["Influencer"],
            "Post date":        row["Post date start"],
            "utm_content":      row["_utm_content"],
            "match_key":        match_key or "— unmapped —",
            "signal_used":      "unmapped",
            "window":           "N/A",
            "amp_lp_views":     None,
            "amp_accounts":     None,
            "amp_delegations":  None,
            "rep_lp_views":     reported_lp,
            "rep_accounts":     reported_acc,
            "rep_delegations":  reported_del,
            "lp_match":         "—",
            "acc_match":        "—",
            "del_match":        "—",
            "notes":            notes,
        })
        continue

    # Filter Amplitude rows for this campaign + date window
    mask = (
        (amp["utm_campaign"] == match_key) &
        (amp["date"] >= post_date) &
        (amp["date"] <= window_end)
    )
    subset = amp[mask]

    amp_lp  = subset["lp_views"].sum()
    amp_acc = subset["accounts"].sum()
    amp_del = subset["delegations"].sum()
    amp_days = subset["date"].nunique()

    def val(x):
        try: return int(float(x))
        except: return None

    rlp  = val(reported_lp)
    racc = val(reported_acc)
    rdel = val(reported_del)

    def match_status(rep, amp_v):
        if rep is None: return "—"
        if amp_v == rep: return "✅"
        diff = amp_v - rep
        pct  = (diff / rep * 100) if rep else 0
        sign = "+" if diff > 0 else ""
        return f"❌ amp={amp_v} rep={rep} ({sign}{diff}, {sign}{pct:.0f}%)"

    results.append({
        "Influencer":       row["Influencer"],
        "Post date":        row["Post date start"],
        "utm_content":      row["_utm_content"],
        "match_key":        match_key,
        "signal_used":      signal_used,
        "window":           f"{post_date.date()} → {window_end.date()} ({amp_days}d, {len(subset)} rows)",
        "amp_lp_views":     int(amp_lp),
        "amp_accounts":     int(amp_acc),
        "amp_delegations":  int(amp_del),
        "rep_lp_views":     rlp,
        "rep_accounts":     racc,
        "rep_delegations":  rdel,
        "lp_match":         match_status(rlp, int(amp_lp)),
        "acc_match":        match_status(racc, int(amp_acc)),
        "del_match":        match_status(rdel, int(amp_del)),
        "notes":            "no Amplitude rows" if len(subset) == 0 else "",
    })

df = pd.DataFrame(results)

# ── Print full report ─────────────────────────────────────────────────────
pd.set_option("display.max_colwidth", 80)
pd.set_option("display.max_rows", 400)

print("=" * 110)
print("AMPLITUDE vs POSTS COMPARISON — May 2026")
print("=" * 110)

# Summary: mismatches only
mismatches = df[
    df["lp_match"].str.startswith("❌") |
    df["acc_match"].str.startswith("❌") |
    df["del_match"].str.startswith("❌")
]
print(f"\n🔴 Rows with mismatches: {len(mismatches)} / {len(df)} total posts\n")

print("\n── MISMATCHES ──────────────────────────────────────────────────────────────")
for _, r in mismatches.iterrows():
    print(f"\n  {r['Influencer']} | {r['Post date']} | content={r['utm_content']} | key={r['match_key']}")
    print(f"    Window : {r['window']}")
    print(f"    LP     : {r['lp_match']}")
    print(f"    Accts  : {r['acc_match']}")
    print(f"    Dels   : {r['del_match']}")

print("\n── NO AMPLITUDE DATA ────────────────────────────────────────────────────────")
no_data = df[df["notes"] == "no Amplitude rows"]
for _, r in no_data.iterrows():
    print(f"  {r['Influencer']} | {r['Post date']} | key={r['match_key']}")

print("\n── UNMAPPED INFLUENCERS (no key resolved — needs correction map entry) ─────")
unmapped = df[df["notes"] == "unmapped"]
if len(unmapped) == 0:
    print("  ✅ All influencers resolved to an Amplitude key")
else:
    for _, r in unmapped.iterrows():
        print(f"  ⚠️  {r['Influencer']} | {r['Post date']}")

print("\n── MATCHES (✅ all fields) ──────────────────────────────────────────────────")
matches = df[
    (df["lp_match"] == "✅") & (df["acc_match"] == "✅") & (df["del_match"] == "✅")
]
for _, r in matches.iterrows():
    print(f"  {r['Influencer']} | {r['Post date']} | content={r['utm_content']}")

# ── Specific spot-checks mentioned by user ───────────────────────────────
print("\n\n" + "=" * 110)
print("SPOT CHECKS (user-specified cases)")
print("=" * 110)

spot_cases = [
    ("ayupwithmads", "Maddie Ball"),
    ("martinasmark",  "Martina"),
]
for campaign, label in spot_cases:
    amp_rows = amp[amp["utm_campaign"] == campaign].sort_values("date")
    print(f"\n▶ {label} — utm_campaign={campaign}")
    print(f"  Amplitude date range: {amp_rows['date'].min().date()} → {amp_rows['date'].max().date()} ({len(amp_rows)} rows)")
    print(f"  Total LP views: {amp_rows['lp_views'].sum()}, Accounts: {amp_rows['accounts'].sum()}, Dels: {amp_rows['delegations'].sum()}")
    print(f"  Daily breakdown:")
    for _, ar in amp_rows.iterrows():
        print(f"    {ar['date'].date()}  LP={ar['lp_views']}  Acc={ar['accounts']}  Del={ar['delegations']}")
    post_rows = posts_sorted[posts_sorted["_resolved_key"] == campaign]
    print(f"  Posts CSV rows for this campaign:")
    for _, pr in post_rows.iterrows():
        print(f"    {pr['Post date start']} | content={pr['_utm_content']} | window={pr['_window_end'].date() if pd.notna(pr['_window_end']) else 'N/A'}")
        print(f"      Reported: LP={pr['Landing Page Views']} Acc={pr['Accounts Created']} Del={pr['Delegations']}")

# ── Save full comparison to CSV ───────────────────────────────────────────
out_path = "data base/amplitude_vs_posts_comparison.csv"
df.to_csv(out_path, index=False)
print(f"\n\nFull comparison saved to: {out_path}")
