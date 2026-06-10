// ============================================================
// Amplitude → Google Sheets Daily Sync
// Paste this entire file into Tools > Script editor in your sheet
// Then run: setupAllTriggers() once to create a single hourly trigger.
// notionSync() is chained at the end of dailySync() — no separate trigger.
// For backfill: run backfill() manually
// ============================================================

var AMPLITUDE_API_KEY    = PropertiesService.getScriptProperties().getProperty('AMPLITUDE_API_KEY');
var AMPLITUDE_SECRET_KEY = PropertiesService.getScriptProperties().getProperty('AMPLITUDE_SECRET_KEY');
var AMPLITUDE_SHEET_ID   = PropertiesService.getScriptProperties().getProperty('AMPLITUDE_SHEET_ID');
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
// then chains notionSync() so Notion stays current without a separate trigger.
function dailySync() {
  var now       = new Date();
  var yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  var dateIso   = formatDateIso(yesterday);
  var dateStr   = formatDate(yesterday);

  Logger.log('Daily sync: ' + dateIso);

  deleteRowsForDate_(dateIso);

  var allData = fetchAllAmplitude_(dateStr, dateStr);
  var rows = buildRows(allData);
  Logger.log('Built ' + rows.length + ' rows');
  appendToSheet(rows);
  Logger.log('Replaced ' + rows.length + ' rows for ' + dateIso);
  Logger.log('Amplitude → Sheets done.');

  // Chain Notion sync. A Notion failure must never mark the Amplitude sync as failed.
  try {
    notionSync();
  } catch (e) {
    Logger.log('notionSync() failed (Amplitude sync was successful): ' + e.message);
  }
}

// Re-fetches everything from the start date.
// Fetches ALL data first; only clears and writes if the full fetch succeeds.
// A mid-run Amplitude failure throws and leaves the sheet untouched.
function backfill() {
  var yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  var start = '20260601';
  var end   = formatDate(yesterday);

  Logger.log('Backfill: fetching ' + start + ' → ' + end + ' (sheet will not be touched until fetch completes)');

  var allData = fetchAllAmplitude_(start, end); // throws on any error; sheet untouched until this returns
  var rows = buildRows(allData);
  Logger.log('Built ' + rows.length + ' rows — fetch complete, clearing sheet now');

  var ss = SpreadsheetApp.openById(AMPLITUDE_SHEET_ID);
  var ws = ss.getSheetByName(SHEET_TAB);
  if (ws && ws.getLastRow() > 1) {
    ws.deleteRows(2, ws.getLastRow() - 1);
  }

  appendToSheet(rows);
  Logger.log('Backfill complete: ' + rows.length + ' rows written to ' + SHEET_TAB);
}

// ── core sync ────────────────────────────────────────────────

function syncRange(start, end) {
  Logger.log('Syncing ' + start + ' → ' + end);

  var allData = fetchAllAmplitude_(start, end);
  var rows = buildRows(allData);
  Logger.log('Built ' + rows.length + ' rows');

  appendToSheet(rows);
  Logger.log('Done');
}

// Fires all EVENTS requests in parallel via fetchAll and returns { eventName → data }.
// Throws immediately if any response is non-200, so callers can rely on all-or-nothing semantics.
function fetchAllAmplitude_(start, end) {
  var auth = Utilities.base64Encode(AMPLITUDE_API_KEY + ':' + AMPLITUDE_SECRET_KEY);

  var requests = EVENTS.map(function(eventName) {
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
    return {
      url:    'https://amplitude.com/api/2/events/segmentation?' + qs,
      method: 'get',
      headers: { Authorization: 'Basic ' + auth },
      muteHttpExceptions: true
    };
  });

  Logger.log('Firing ' + EVENTS.length + ' Amplitude requests in parallel');
  var responses = UrlFetchApp.fetchAll(requests);

  var allData = {};
  for (var i = 0; i < EVENTS.length; i++) {
    var eventName = EVENTS[i];
    var response  = responses[i];
    if (response.getResponseCode() !== 200) {
      throw new Error('Amplitude error ' + response.getResponseCode() + ' for "' + eventName + '": ' + response.getContentText());
    }
    allData[eventName] = JSON.parse(response.getContentText()).data;
  }

  return allData;
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

function setupAllTriggers() {
  // 1. Delete every existing project trigger
  var existing = ScriptApp.getProjectTriggers();
  if (existing.length === 0) {
    Logger.log('No existing triggers to delete.');
  } else {
    existing.forEach(function(t) {
      Logger.log('Deleting trigger: ' + t.getHandlerFunction() + ' (' + t.getUniqueId() + ')');
      ScriptApp.deleteTrigger(t);
    });
    Logger.log('Deleted ' + existing.length + ' trigger(s).');
  }

  // 2. Create four daily triggers for dailySync at 7am, 9am, 1pm, 8pm.
  // notionSync() is chained inside dailySync() — no separate trigger needed.
  var hours = [7, 9, 13, 20];
  hours.forEach(function(h) {
    ScriptApp.newTrigger('dailySync')
      .timeBased()
      .everyDays(1)
      .atHour(h)
      .create();
    Logger.log('Created: dailySync() at hour ' + h + '.');
  });

  Logger.log('setupAllTriggers() complete — 4 triggers created. Verify in Triggers panel (clock icon).');
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
