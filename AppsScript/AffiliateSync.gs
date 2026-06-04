// ============================================================
// Amplitude → Google Sheets Monthly Sync (Affiliates)
// Filters: utm_campaign = influencers AND utm_content = adaff
// Interval: monthly (i=30)
//
// To load history: run affBackfill() once manually
// To keep current month fresh: run affMonthlySync() on a schedule
// ============================================================

var AFF_API_KEY    = '6d32ffa2d1954f01a262fcdbb0a3e7b1';
var AFF_SECRET_KEY = '716dfa8ea6e2aa4a4e8cef3cdf3b6fb3';
var AFF_SHEET_ID   = '19COFeVqjvByU1NZUVnBnuxA1_6eBToZnitGzz0mRWlA';
var AFF_SHEET_TAB  = 'Affiliates-data';
var AFF_START_DATE = '20260301';  // March 2026 — lifetime start

var AFF_EVENTS = [
  'Viewed Marketing Site Landing Page',
  'G_account_created',
  'G_delegation_enabled'
];

var AFF_FILTERS = JSON.stringify([
  { prop: 'gp:utm_content', op: 'is', values: ['adaff'] }
]);

// ── entry points ─────────────────────────────────────────────

// Run on a schedule (e.g. weekly) to refresh current-month totals
function affMonthlySync() {
  var today   = new Date();
  var dateStr = affFormatDate(today);
  Logger.log('Affiliate monthly sync up to: ' + dateStr);
  affSyncRange(AFF_START_DATE, dateStr);
}

// Run once manually to load all data from May 2026 to yesterday
function affBackfill() {
  var yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  affSyncRange(AFF_START_DATE, affFormatDate(yesterday));
}

// One-off: load May 2026 only (full calendar month, already complete)
function affBackfillMay2026() {
  Logger.log('Backfill: May 2026 only');
  affSyncRange('20260501', '20260531');
}

// ── core sync ────────────────────────────────────────────────

function affSyncRange(start, end) {
  Logger.log('Syncing affiliates ' + start + ' → ' + end);

  var allData = {};
  for (var i = 0; i < AFF_EVENTS.length; i++) {
    Logger.log('Fetching: ' + AFF_EVENTS[i]);
    allData[AFF_EVENTS[i]] = affFetchAmplitude(AFF_EVENTS[i], start, end);
  }

  var rows = affBuildRows(allData);
  Logger.log('Built ' + rows.length + ' rows');

  affWriteToSheet(rows);
  Logger.log('Done');
}

function affFetchAmplitude(eventName, start, end) {
  var auth = Utilities.base64Encode(AFF_API_KEY + ':' + AFF_SECRET_KEY);

  var params = {
    e:     JSON.stringify({ event_type: eventName }),
    s:     AFF_FILTERS,
    g:     'gp:utm_campaign',
    start: start,
    end:   end,
    m:     'totals',
    i:     '30'  // monthly buckets
  };

  var qs = Object.keys(params)
    .map(function(k) { return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]); })
    .join('&');

  var response = UrlFetchApp.fetch(
    'https://amplitude.com/api/2/events/segmentation?' + qs,
    {
      method: 'get',
      headers: { Authorization: 'Basic ' + auth },
      muteHttpExceptions: true
    }
  );

  if (response.getResponseCode() !== 200) {
    throw new Error(
      'Amplitude error ' + response.getResponseCode() +
      ' for "' + eventName + '": ' + response.getContentText()
    );
  }

  return JSON.parse(response.getContentText()).data;
}

function affBuildRows(allData) {
  var combined = {};

  AFF_EVENTS.forEach(function(eventName) {
    var data    = allData[eventName];
    var labels  = data.seriesLabels || [];
    var series  = data.series       || [];
    var xValues = data.xValues      || [];

    for (var i = 0; i < labels.length; i++) {
      var campaign = Array.isArray(labels[i]) ? labels[i][0] : labels[i];
      var counts   = series[i] || [];

      for (var j = 0; j < xValues.length; j++) {
        var key = campaign + '||' + xValues[j];
        if (!combined[key]) {
          combined[key] = {
            utm_Campaign: campaign,
            date:         xValues[j],
            'Viewed Marketing Site Landing Page': 0,
            G_account_created:    0,
            G_delegation_enabled: 0
          };
        }
        combined[key][eventName] = counts[j] || 0;
      }
    }
  });

  return Object.keys(combined).map(function(k) { return combined[k]; });
}

// Full clear-and-rewrite: safe for monthly data (small dataset, always fresh)
function affWriteToSheet(rows) {
  var ss = SpreadsheetApp.openById(AFF_SHEET_ID);
  var ws = ss.getSheetByName(AFF_SHEET_TAB);
  if (!ws) ws = ss.insertSheet(AFF_SHEET_TAB);

  ws.clearContents();

  var headers = [
    'utm_Campaign', 'date',
    'Viewed Marketing Site Landing Page',
    'G_account_created', 'G_delegation_enabled'
  ];

  ws.appendRow(headers);

  var values = rows.map(function(row) {
    return headers.map(function(h) { return row[h] || 0; });
  });

  if (values.length > 0) {
    ws.getRange(2, 1, values.length, headers.length).setValues(values);
  }

  Logger.log('Wrote ' + values.length + ' rows to ' + AFF_SHEET_TAB);
}

// ── helpers ───────────────────────────────────────────────────

function affFormatDate(d) {
  var y  = d.getFullYear();
  var m  = String(d.getMonth() + 1).padStart(2, '0');
  var dd = String(d.getDate()).padStart(2, '0');
  return '' + y + m + dd;
}
