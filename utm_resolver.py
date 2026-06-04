import re
import pandas as pd
from urllib.parse import urlparse, parse_qs


def extract_utm_campaign(url):
    if pd.isna(url) or not str(url).startswith("http"):
        return ""
    try:
        qs = parse_qs(urlparse(str(url)).query)
        return qs.get("utm_campaign", [""])[0].strip().lower()
    except Exception:
        return ""


def _str(val):
    if val is None:
        return ""
    if isinstance(val, float) and pd.isna(val):
        return ""
    s = str(val).strip()
    return "" if s.lower() == "nan" else s


SHEETS_CREDS_PATH = (
    "/Users/chriscespedes/Documents/Slack-Alerts/influencers/data/google_service_account.json"
)


def _load_corrections(source):
    """Load the correction map from a local CSV path or a Google Sheets URL."""
    if not (isinstance(source, str) and "docs.google.com/spreadsheets" in source):
        return pd.read_csv(source)

    m = re.search(r"/d/([a-zA-Z0-9_-]+)", source)
    if not m:
        raise ValueError(f"Cannot parse sheet ID from URL: {source}")
    sheet_id = m.group(1)
    gid_m = re.search(r"gid=(\d+)", source)
    gid = gid_m.group(1) if gid_m else "0"

    # Try public CSV export first (works when sheet is 'Anyone with the link can view')
    csv_url = (
        f"https://docs.google.com/spreadsheets/d/{sheet_id}"
        f"/export?format=csv&gid={gid}"
    )
    try:
        return pd.read_csv(csv_url)
    except Exception:
        pass

    # Fall back to service account auth
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
        data = ws.get_all_records()
        return pd.DataFrame(data)
    except Exception as e:
        raise RuntimeError(
            f"Could not read correction map from Google Sheets (tried public export and service account).\n"
            f"Error: {e}"
        ) from e


class UTMResolver:
    """
    Resolves the correct Amplitude utm_campaign key for a row from the Posts CSV.

    4-signal waterfall (first match wins):
      1.  correction_map[influencer]   — override table keyed by influencer name (highest trust)
      2a. UTM Match Key field          — manually curated per-post override
      2b. url utm_campaign             — if it directly exists in Amplitude (requires amplitude_keys)
      3.  Influencer UTM (rollup)      — designed for blank-URL cases
      4.  ref_IG Handle                — last resort, strips leading @ and _
      →   (None, 0, "unmapped")        — never silently returns zero

    Returns (amplitude_key, signal_number, confidence) per row.
    """

    def __init__(self, corrections_path, amplitude_keys=None):
        corrections = _load_corrections(corrections_path)
        corrections["influencer_name"] = corrections["influencer_name"].str.strip()
        corrections["amplitude_key"] = corrections["amplitude_key"].str.strip()
        self.name_map = dict(zip(corrections["influencer_name"], corrections["amplitude_key"]))
        self.amplitude_keys = set(amplitude_keys) if amplitude_keys is not None else None

    def resolve(self, row):
        # Signal 1: correction map keyed by influencer name (confirmed entries win first)
        influencer = _str(row.get("Influencer", ""))
        if influencer in self.name_map:
            return (self.name_map[influencer], 1, "correction_map")

        # Signal 2a: UTM Match Key field (manually curated override for non-map cases)
        s2 = _str(row.get("UTM Match Key", "")).lower()
        if s2:
            return (s2, 2, "explicit")

        # Signal 2b: URL utm_campaign validated against known Amplitude keys
        url_key = extract_utm_campaign(row.get("Influencer link Amplitude match", ""))
        if url_key and self.amplitude_keys is not None and url_key in self.amplitude_keys:
            return (url_key, 2, "url_direct")

        # Signal 3: Influencer UTM (rollup) — fall back to raw UTM when rollup is blank
        s3 = _str(row.get("Influencer UTM (rollup)", "")).lower().lstrip("@")
        if not s3:
            s3 = _str(row.get("Influencer UTM", "")).lower().lstrip("@")
        if s3:
            return (s3, 3, "utm_rollup")

        # Signal 4: ref_IG Handle — strip @, leading/trailing _
        s4 = _str(row.get("ref_IG Handle", "")).lower().lstrip("@").strip("_")
        if s4:
            return (s4, 4, "ig_handle")

        return (None, 0, "unmapped")

    def resolve_dataframe(self, posts_df):
        df = posts_df.copy()
        resolved = [self.resolve(row) for _, row in df.iterrows()]
        df["_resolved_key"] = [r[0] for r in resolved]
        df["_signal_used"]  = [r[1] for r in resolved]
        df["_confidence"]   = [r[2] for r in resolved]
        return df

    def get_unmapped(self, posts_df):
        return [
            posts_df.iloc[i]["Influencer"]
            for i, (key, _, _) in enumerate(
                self.resolve(row) for _, row in posts_df.iterrows()
            )
            if key is None
        ]
