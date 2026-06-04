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

var FILTERS = JSON.stringify([
  { prop: 'gp:utm_medium',  op: 'is',     values: ['Influencers'] },
  { prop: 'gp:utm_content', op: 'is not', values: ['adaff'] }
]);

// ── entry points ─────────────────────────────────────────────

function dailySync() {
  var today    = new Date();
  var dateStr  = formatDate(today);
  var dateIso  = formatDateIso(today);

  Logger.log('Daily sync (today): ' + dateIso);

  var allData = {};
  for (var i = 0; i < EVENTS.length; i++) {
    Logger.log('Fetching: ' + EVENTS[i]);
    allData[EVENTS[i]] = fetchAmplitude(EVENTS[i], dateStr, dateStr);
  }

  var rows = buildRows(allData);
  Logger.log('Built ' + rows.length + ' rows');

  upsertToSheet(rows, dateIso);
  Logger.log('Amplitude → Sheets done. Starting Notion sync...');
  notionSync();
}

function backfill() {
  var yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  syncRange('20260501', formatDate(yesterday));
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

  writeToSheet(rows);
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
    m:     'totals',
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

function upsertToSheet(rows, dateIso) {
  var ss = SpreadsheetApp.openById(AMPLITUDE_SHEET_ID);
  var ws = ss.getSheetByName(SHEET_TAB);
  if (!ws) ws = ss.insertSheet(SHEET_TAB);

  var headers = [
    'utm_Campaign', 'date',
    'Viewed Marketing Site Landing Page',
    'G_account_created', 'G_delegation_enabled'
  ];

  if (ws.getLastRow() === 0) {
    ws.appendRow(headers);
  } else {
    var allVals   = ws.getDataRange().getValues();
    var dateColIdx = allVals[0].indexOf('date');
    var toDelete  = [];
    for (var i = 1; i < allVals.length; i++) {
      var cellVal = allVals[i][dateColIdx];
      var cellStr = cellVal instanceof Date ? formatDateIso(cellVal) : String(cellVal);
      if (cellStr === dateIso) toDelete.push(i + 1);
    }
    for (var j = toDelete.length - 1; j >= 0; j--) {
      ws.deleteRow(toDelete[j]);
    }
  }

  var values = rows.map(function(row) {
    return headers.map(function(h) { return row[h] || 0; });
  });
  if (values.length > 0) {
    ws.getRange(ws.getLastRow() + 1, 1, values.length, headers.length).setValues(values);
  }
  Logger.log('Upserted ' + values.length + ' rows for ' + dateIso + ' to ' + SHEET_TAB);
}

function writeToSheet(rows) {
  var ss = SpreadsheetApp.openById(AMPLITUDE_SHEET_ID);
  var ws = ss.getSheetByName(SHEET_TAB);

  if (!ws) {
    ws = ss.insertSheet(SHEET_TAB);
  }

  var headers = [
    'utm_Campaign', 'date',
    'Viewed Marketing Site Landing Page',
    'G_account_created', 'G_delegation_enabled'
  ];

  if (ws.getLastRow() === 0) {
    ws.appendRow(headers);
  }

  var values = rows.map(function(row) {
    return headers.map(function(h) { return row[h] || 0; });
  });

  if (values.length > 0) {
    ws.getRange(ws.getLastRow() + 1, 1, values.length, headers.length)
      .setValues(values);
  }

  Logger.log('Wrote ' + values.length + ' rows to ' + SHEET_TAB);
}

// ── trigger setup ─────────────────────────────────────────────

function setupDailyTrigger() {
  // Delete any existing triggers for this script
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === 'dailySync') {
      ScriptApp.deleteTrigger(t);
    }
  });

  [8, 13, 15].forEach(function(hour) {
    ScriptApp.newTrigger('dailySync')
      .timeBased()
      .everyDays(1)
      .atHour(hour)
      .create();
  });

  Logger.log('Triggers set for dailySync() at 8am, 1pm, 3pm');
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
