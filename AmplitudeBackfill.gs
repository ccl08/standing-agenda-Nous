// ============================================================
// BACKFILL SCRIPT — run once manually
// In Apps Script: select backfill() → Run
// Pulls May 1 2026 → yesterday, appends to Daily-data tab
// ============================================================

var API_KEY    = '6d32ffa2d1954f01a262fcdbb0a3e7b1';
var API_SECRET = '716dfa8ea6e2aa4a4e8cef3cdf3b6fb3';
var TAB_NAME   = 'Daily-data';

var EVENTS = [
  'Viewed Marketing Site Landing Page',
  'G_account_created',
  'G_delegation_enabled'
];

var FILTERS = JSON.stringify([
  { prop: 'gp:utm_medium',  op: 'is',     values: ['Influencers'] },
  { prop: 'gp:utm_content', op: 'is not', values: ['adaff'] }
]);

var HEADERS = [
  'utm_Campaign', 'date',
  'Viewed Marketing Site Landing Page',
  'G_account_created', 'G_delegation_enabled'
];

function backfill() {
  var yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  var start = '20260301';
  var end   = formatDate(yesterday);

  Logger.log('Backfill: ' + start + ' → ' + end);

  var allData = {};
  for (var i = 0; i < EVENTS.length; i++) {
    Logger.log('Fetching: ' + EVENTS[i]);
    allData[EVENTS[i]] = fetchAmplitude(EVENTS[i], start, end);
  }

  var rows = buildRows(allData);
  Logger.log('Rows to write: ' + rows.length);

  writeRows(rows);
  Logger.log('Backfill complete.');
}

function fetchAmplitude(eventName, start, end) {
  var auth = Utilities.base64Encode(API_KEY + ':' + API_SECRET);
  var params = {
    e: JSON.stringify({ event_type: eventName }),
    s: FILTERS,
    g: 'gp:utm_campaign',
    start: start, end: end,
    m: 'totals', i: '1'
  };
  var qs = Object.keys(params)
    .map(function(k) { return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]); })
    .join('&');
  var resp = UrlFetchApp.fetch(
    'https://amplitude.com/api/2/events/segmentation?' + qs,
    { headers: { Authorization: 'Basic ' + auth }, muteHttpExceptions: true }
  );
  if (resp.getResponseCode() !== 200) {
    throw new Error('Amplitude ' + resp.getResponseCode() + ' — ' + resp.getContentText());
  }
  return JSON.parse(resp.getContentText()).data;
}

function buildRows(allData) {
  var combined = {};
  EVENTS.forEach(function(ev) {
    var d = allData[ev];
    var labels = d.seriesLabels || [], series = d.series || [], xValues = d.xValues || [];
    for (var i = 0; i < labels.length; i++) {
      var campaign = Array.isArray(labels[i]) ? labels[i][0] : labels[i];
      var counts   = series[i] || [];
      for (var j = 0; j < xValues.length; j++) {
        var key = campaign + '||' + xValues[j];
        if (!combined[key]) {
          combined[key] = { utm_Campaign: campaign, date: xValues[j],
            'Viewed Marketing Site Landing Page': 0, G_account_created: 0, G_delegation_enabled: 0 };
        }
        combined[key][ev] = counts[j] || 0;
      }
    }
  });
  return Object.keys(combined).map(function(k) { return combined[k]; });
}

function writeRows(rows) {
  var ws = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(TAB_NAME);
  if (!ws) ws = SpreadsheetApp.getActiveSpreadsheet().insertSheet(TAB_NAME);
  if (ws.getLastRow() === 0) ws.appendRow(HEADERS);
  var values = rows.map(function(row) {
    return HEADERS.map(function(h) { return row[h] !== undefined ? row[h] : 0; });
  });
  if (values.length > 0) {
    ws.getRange(ws.getLastRow() + 1, 1, values.length, HEADERS.length).setValues(values);
  }
  Logger.log('Wrote ' + values.length + ' rows to ' + TAB_NAME);
}

function formatDate(d) {
  return '' + d.getFullYear()
    + String(d.getMonth() + 1).padStart(2, '0')
    + String(d.getDate()).padStart(2, '0');
}
