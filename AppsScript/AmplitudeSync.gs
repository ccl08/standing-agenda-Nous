// ============================================================
// Amplitude → Google Sheets Daily Sync
// Paste this entire file into Tools > Script editor in your sheet
// Then run: setupDailyTrigger() once to schedule 8am daily
// For backfill: run backfill() manually
// ============================================================

var AMPLITUDE_API_KEY    = '6d32ffa2d1954f01a262fcdbb0a3e7b1';
var AMPLITUDE_SECRET_KEY = '716dfa8ea6e2aa4a4e8cef3cdf3b6fb3';
var AMPLITUDE_SHEET_ID   = '1eghadoVWL30ALoa8ieemziRJL4rcHOOTniQz40xFlW8';
var SHEET_TAB            = 'Daily-data';

var EVENTS = [
  'Viewed Marketing Site Landing Page',
  'G_account_created',
  'G_delegation_enabled'
];

// Maps Amplitude event names → sheet column names (must match what NotionSync reads)
var EVENT_COL = {
  'Viewed Marketing Site Landing Page': 'Viewed Landing Page',
  'G_account_created':                  'Accounts Created',
  'G_delegation_enabled':               'Delegations'
};

var FILTERS = JSON.stringify([
  { prop: 'gp:utm_medium', op: 'is', values: ['Influencers'] }
]);

// ── entry points ─────────────────────────────────────────────

// Runs hourly. Always replaces yesterday's rows with the latest Amplitude data,
// then triggers NotionSync so Notion stays current.
function dailySync() {
  var now       = new Date();
  var yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  var dateIso   = formatDateIso(yesterday);
  var dateStr   = formatDate(yesterday);

  Logger.log('Daily sync: ' + dateIso);

  deleteRowsForDate_(dateIso);

  var allData = {};
  for (var i = 0; i < EVENTS.length; i++) {
    Logger.log('Fetching: ' + EVENTS[i]);
    allData[EVENTS[i]] = fetchAmplitude(EVENTS[i], dateStr, dateStr);
  }
  var rows = buildRows(allData);
  Logger.log('Built ' + rows.length + ' rows');
  appendToSheet(rows);
  Logger.log('Replaced ' + rows.length + ' rows for ' + dateIso);
  Logger.log('Amplitude → Sheets done.');
}

// Clears the sheet and re-fetches everything from the start date.
function backfill() {
  var ss = SpreadsheetApp.openById(AMPLITUDE_SHEET_ID);
  var ws = ss.getSheetByName(SHEET_TAB);
  if (ws && ws.getLastRow() > 1) {
    ws.deleteRows(2, ws.getLastRow() - 1);
    Logger.log('Cleared existing data rows');
  }

  var yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  syncRange('20260601', formatDate(yesterday));
}

// ── core sync ────────────────────────────────────────────────

function syncRange(start, end) {
  Logger.log('Syncing ' + start + ' → ' + end);

  var allData = {};
  for (var i = 0; i < EVENTS.length; i++) {
    Logger.log('Fetching: ' + EVENTS[i]);
    allData[EVENTS[i]] = fetchAmplitude(EVENTS[i], start, end);
  }

  var rows = buildRows(allData);
  Logger.log('Built ' + rows.length + ' rows');

  appendToSheet(rows);
  Logger.log('Done');
}

function fetchAmplitude(eventName, start, end) {
  var auth = Utilities.base64Encode(AMPLITUDE_API_KEY + ':' + AMPLITUDE_SECRET_KEY);

  var params = {
    e:     JSON.stringify({ event_type: eventName }),
    s:     FILTERS,
    g:     'gp:utm_campaign',
    start: start,
    end:   end,
    m:     'uniques',
    i:     '1'
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
    throw new Error('Amplitude error ' + response.getResponseCode() + ' for "' + eventName + '": ' + response.getContentText());
  }

  return JSON.parse(response.getContentText()).data;
}

function buildRows(allData) {
  var combined = {};

  EVENTS.forEach(function(eventName) {
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
            utm_Campaign:         campaign,
            Date:                 xValues[j],
            'Viewed Landing Page': 0,
            'Accounts Created':   0,
            'Delegations':        0
          };
        }
        combined[key][EVENT_COL[eventName]] = counts[j] || 0;
      }
    }
  });

  return Object.keys(combined).map(function(k) { return combined[k]; });
}

// Appends rows to the sheet. Creates the header row if the sheet is empty.
function appendToSheet(rows) {
  var ss = SpreadsheetApp.openById(AMPLITUDE_SHEET_ID);
  var ws = ss.getSheetByName(SHEET_TAB);
  if (!ws) ws = ss.insertSheet(SHEET_TAB);

  var headers = [
    'utm_Campaign', 'Date',
    'Viewed Landing Page', 'Accounts Created', 'Delegations'
  ];

  if (ws.getLastRow() === 0) ws.appendRow(headers);

  var values = rows.map(function(row) {
    return headers.map(function(h) { return row[h] || 0; });
  });

  if (values.length > 0) {
    ws.getRange(ws.getLastRow() + 1, 1, values.length, headers.length).setValues(values);
  }
}

// Deletes all rows for the given dateIso from the sheet.
function deleteRowsForDate_(dateIso) {
  var ss = SpreadsheetApp.openById(AMPLITUDE_SHEET_ID);
  var ws = ss.getSheetByName(SHEET_TAB);
  if (!ws || ws.getLastRow() < 2) return;

  var allVals  = ws.getDataRange().getValues();
  var toDelete = [];
  for (var i = 1; i < allVals.length; i++) {
    var cellVal = allVals[i][1]; // Date is column index 1
    var cellStr = cellVal instanceof Date ? formatDateIso(cellVal) : String(cellVal).trim();
    if (cellStr === dateIso) toDelete.push(i + 1);
  }
  for (var j = toDelete.length - 1; j >= 0; j--) {
    ws.deleteRow(toDelete[j]);
  }
  if (toDelete.length > 0) Logger.log('Deleted ' + toDelete.length + ' rows for ' + dateIso);
}

// ── trigger setup ─────────────────────────────────────────────

function setupDailyTrigger() {
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === 'dailySync') ScriptApp.deleteTrigger(t);
  });

  ScriptApp.newTrigger('dailySync')
    .timeBased()
    .everyDays(1)
    .atHour(8)
    .create();

  Logger.log('Trigger set for dailySync() at 8am daily');
}

// ── helpers ───────────────────────────────────────────────────

function formatDate(d) {
  var y  = d.getFullYear();
  var m  = String(d.getMonth() + 1).padStart(2, '0');
  var dd = String(d.getDate()).padStart(2, '0');
  return '' + y + m + dd;
}

function formatDateIso(d) {
  var y  = d.getFullYear();
  var m  = String(d.getMonth() + 1).padStart(2, '0');
  var dd = String(d.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + dd;
}
