#!/usr/bin/env python3
"""
Daily Amplitude → Google Sheets pipeline

Events:  Viewed Marketing Site Landing Page | G_account_created | G_delegation_enabled
Filters: utm_medium = Influencers  AND  utm_content != adaff
Group:   utm_campaign + date

Usage:
  python amplitude_to_sheets.py              # yesterday (daily cron)
  python amplitude_to_sheets.py --backfill   # May 1 2026 → today
  python amplitude_to_sheets.py --csv        # print CSV (no Sheets needed)

Google Sheets setup (one-time):
  1. Create a Google Cloud project, enable Sheets API
  2. Create a Service Account → download JSON key → save as service_account.json here
  3. Share your sheet with the service account email
  4. Set GOOGLE_SHEET_ID in .env
"""

import os, sys, json, base64, csv
from io import StringIO
from datetime import datetime, timedelta

import requests

try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

AMPLITUDE_API_KEY  = os.environ["AMPLITUDE_API_KEY"]
AMPLITUDE_SECRET   = os.environ["AMPLITUDE_SECRET_KEY"]
GOOGLE_SHEET_ID    = os.environ.get("GOOGLE_SHEET_ID", "")
SHEET_TAB          = os.environ.get("SHEET_TAB", "Sheet1")

EVENTS = [
    "Viewed Marketing Site Landing Page",
    "G_account_created",
    "G_delegation_enabled",
]

COLUMNS = [
    "utm_Campaign",
    "date",
    "Viewed Marketing Site Landing Page",
    "G_account_created",
    "G_delegation_enabled",
]


def _auth():
    token = base64.b64encode(f"{AMPLITUDE_API_KEY}:{AMPLITUDE_SECRET}".encode()).decode()
    return {"Authorization": f"Basic {token}"}


def fetch_event(event_name: str, start: str, end: str) -> dict:
    resp = requests.get(
        "https://amplitude.com/api/2/events/segmentation",
        params={
            "e": json.dumps({"event_type": event_name}),
            "s": json.dumps([
                {"prop": "gp:utm_medium",  "op": "is",     "values": ["Influencers"]},
                {"prop": "gp:utm_content", "op": "is not", "values": ["adaff"]},
            ]),
            "g": "gp:utm_campaign",
            "start": start,
            "end":   end,
            "m":     "totals",
            "i":     1,
        },
        headers=_auth(),
        timeout=30,
    )
    resp.raise_for_status()
    return resp.json()["data"]


def build_rows(all_data: dict) -> list:
    combined: dict = {}
    for event_name, data in all_data.items():
        labels  = data.get("seriesLabels", [])
        series  = data.get("series", [])
        x_vals  = data.get("xValues", [])
        for i, label in enumerate(labels):
            campaign = label[0] if isinstance(label, list) else label
            counts   = series[i] if i < len(series) else []
            for j, date in enumerate(x_vals):
                key = (campaign, date)
                if key not in combined:
                    combined[key] = {c: 0 for c in COLUMNS}
                    combined[key]["utm_Campaign"] = campaign
                    combined[key]["date"]         = date
                combined[key][event_name] = counts[j] if j < len(counts) else 0
    return sorted(combined.values(), key=lambda r: (r["date"], r["utm_Campaign"]))


def upsert_to_sheets(rows: list, date_str: str) -> None:
    """Write rows for date_str, replacing any existing rows for that date."""
    import gspread
    from google.oauth2.service_account import Credentials

    creds = Credentials.from_service_account_file(
        "service_account.json",
        scopes=["https://www.googleapis.com/auth/spreadsheets"],
    )
    gc = gspread.authorize(creds)
    ws = gc.open_by_key(GOOGLE_SHEET_ID).worksheet(SHEET_TAB)

    all_vals = ws.get_all_values()
    if not all_vals:
        ws.append_row(COLUMNS)
    else:
        header = all_vals[0]
        date_col = header.index("date") if "date" in header else 1
        to_delete = [
            i + 1
            for i, row in enumerate(all_vals[1:], start=1)
            if len(row) > date_col and row[date_col] == date_str
        ]
        for row_idx in reversed(to_delete):
            ws.delete_rows(row_idx)

    for row in rows:
        ws.append_row([row[c] for c in COLUMNS])

    print(f"Upserted {len(rows)} rows for {date_str} ({GOOGLE_SHEET_ID})", file=sys.stderr)


def daily_sync() -> None:
    """Fetch today's partial data — safe to call at 8am, 1pm, and 3pm."""
    today     = datetime.now().strftime("%Y%m%d")
    today_iso = datetime.now().strftime("%Y-%m-%d")

    print(f"Daily sync (today): {today_iso}", file=sys.stderr)

    all_data: dict = {}
    for event in EVENTS:
        print(f"  Fetching '{event}' ...", file=sys.stderr)
        all_data[event] = fetch_event(event, today, today)

    rows = build_rows(all_data)
    print(f"  → {len(rows)} rows", file=sys.stderr)

    if GOOGLE_SHEET_ID:
        upsert_to_sheets(rows, today_iso)
    else:
        print_csv(rows)


def write_to_sheets(rows: list) -> None:
    import gspread
    from google.oauth2.service_account import Credentials

    creds = Credentials.from_service_account_file(
        "service_account.json",
        scopes=["https://www.googleapis.com/auth/spreadsheets"],
    )
    gc = gspread.authorize(creds)
    ws = gc.open_by_key(GOOGLE_SHEET_ID).worksheet(SHEET_TAB)

    if not ws.get_all_values():
        ws.append_row(COLUMNS)

    for row in rows:
        ws.append_row([row[c] for c in COLUMNS])

    print(f"Wrote {len(rows)} rows to Google Sheets ({GOOGLE_SHEET_ID})")


def print_csv(rows: list) -> None:
    out = StringIO()
    w   = csv.DictWriter(out, fieldnames=COLUMNS)
    w.writeheader()
    w.writerows(rows)
    print(out.getvalue(), end="")


def _arg(flag: str) -> str | None:
    for i, a in enumerate(sys.argv):
        if a == flag and i + 1 < len(sys.argv):
            return sys.argv[i + 1]
    return None


def main() -> None:
    if "--daily-sync" in sys.argv:
        daily_sync()
        return

    backfill  = "--backfill" in sys.argv
    csv_mode  = "--csv" in sys.argv or not GOOGLE_SHEET_ID
    arg_start = _arg("--start")
    arg_end   = _arg("--end")

    if arg_start and arg_end:
        start = arg_start
        end   = arg_end
        print(f"Custom range: {start} → {end}", file=sys.stderr)
    elif backfill:
        start = "20260501"
        end   = datetime.now().strftime("%Y%m%d")
        print(f"Backfill: {start} → {end}", file=sys.stderr)
    else:
        d     = (datetime.now() - timedelta(days=1)).strftime("%Y%m%d")
        start = end = d
        print(f"Daily: {d}", file=sys.stderr)

    all_data: dict = {}
    for event in EVENTS:
        print(f"  Fetching '{event}' ...", file=sys.stderr)
        all_data[event] = fetch_event(event, start, end)

    rows = build_rows(all_data)
    print(f"  → {len(rows)} rows", file=sys.stderr)

    if csv_mode:
        print_csv(rows)
    else:
        write_to_sheets(rows)


if __name__ == "__main__":
    main()
