// ============================================================
// DAILY SYNC SCRIPT — runs automatically at 8am
// Setup: select setupDailyTrigger() → Run (one time only)
// Pulls yesterday's data every morning and appends to Daily-data
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

function dailySync() {
  var yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  var dateStr = formatDate(yesterday);

  Logger.log('Daily sync: ' + dateStr);

  var allData = {};
  for (var i = 0; i < EVENTS.length; i++) {
    allData[EVENTS[i]] = fetchAmplitude(EVENTS[i], dateStr, dateStr);
  }

  var rows = buildRows(allData);
  Logger.log('Rows: ' + rows.length);

  writeRows(rows);
  Logger.log('Done.');
}

function setupDailyTrigger() {
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === 'dailySync') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('dailySync')
    .timeBased()
    .everyDays(1)
    .atHour(8)
    .create();
  Logger.log('8am daily trigger set for dailySync()');
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
