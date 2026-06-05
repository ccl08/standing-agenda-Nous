// ============================================================
// AffiliateSheetsSync.gs — Daily affiliate click metrics to Sheets.
//
// Pipeline:
//   1. Read UTM-Mapping tab for manual overrides (Signal 0)
//   2. Read Affiliates-data (utm_content=adaff, LP views only)
//   3. Read NotionValues — resolve each influencer via 4-signal
//      waterfall (override → UTM Handle → URL → Influencer UTM)
//   4. Build per-influencer click metrics
//   5. Write MergeData tab (full clear + rewrite)
//   6. Write UTM-Mapping tab — shows every influencer's resolution
//      status so unresolved ones are visible and can be fixed
//
// Setup: run asMCreateDailyTrigger() once from the editor.
// Requires AFF_SHEET_ID defined in AffiliateSync.gs (same project).
// ============================================================

var ASM_MERGE_SHEET_ID   = '19COFeVqjvByU1NZUVnBnuxA1_6eBToZnitGzz0mRWlA';
var ASM_NOTION_VALUES_ID = '1eFkukSGwI7E4bQFk2lolekx3abQkYKBzr3r2V8bpV6A';
var ASM_AFF_DATA_TAB     = 'Affiliates-data';
var ASM_MERGE_TAB        = 'MergeData';
var ASM_UTM_MAP_TAB      = 'UTM-Mapping';
var ASM_LIFETIME_START   = '2026-03';  // March 2026 — lifetime start

var ASM_MERGE_HEADERS = [
  'Name',
  'Status',
  'Affiliate: Unpaid Clicks',
  'Affiliate: Clicks This Month',
  'Affiliate: Clicks Previous Month',
  'Affiliate: Lifetime Clicks',
  'Affiliate: Last Payment',
  'Affiliate: Current Month'
];

// UTM-Mapping tab columns
var ASM_UTM_MAP_HEADERS = [
  'Name',
  'UTM Override',      // user fills this in to fix unresolved / wrong matches
  'Resolved Key',      // what the script resolved to (written each run)
  'Signal',            // 0=override, 1=utm_handle, 2=url, 3=influencer_utm
  'Status',            // ✓ matched | ✓ override | ✗ unresolved
  'Notion Page ID'     // UUID from I.Influencers — join key for future Notion writes
];


// ── Trigger setup (run ONCE manually) ────────────────────────
// Fires on the 1st of each month at 8am — matches the manual trigger
// already configured in the Apps Script UI.

function asMCreateMonthlyTrigger() {
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === 'affiliateSheetsSync') {
      ScriptApp.deleteTrigger(t);
    }
  });
  ScriptApp.newTrigger('affiliateSheetsSync')
    .timeBased()
    .onMonthDay(1)
    .atHour(8)
    .create();
  Logger.log('Monthly trigger created: affiliateSheetsSync() fires on the 1st of each month at 8am.');
}


// ── Entry point ───────────────────────────────────────────────

function affiliateSheetsSync() {
  var start = new Date();
  Logger.log('=== AffiliateSheetsSync start ===');

  // Step 1: load manual overrides + aliases from UTM-Mapping tab
  var utmMap    = asmLoadUtmOverrides_();
  Logger.log('UTM overrides loaded: ' + Object.keys(utmMap.overrides).length +
             ', aliases: ' + Object.keys(utmMap.aliases).length);

  // Step 2: load Amplitude data (adaff-filtered LP views) and normalise aliases
  var ampResult = asmLoadAmpData_();
  var ampData   = asmNormalizeAliases_(ampResult.data, utmMap.aliases);
  var ampKeys   = ampResult.keys;

  // Step 3: load influencers + resolve UTM keys
  var influencers = asmLoadNotionValues_(ampKeys, utmMap.overrides);
  Logger.log('Influencers loaded: ' + influencers.length);

  // Step 4 + 5: build rows and write MergeData
  var buildResult = asmBuildRows_(influencers, ampData);
  asmWriteMergeData_(buildResult.rows);

  // Step 6: write UTM-Mapping report
  asmWriteUtmMapping_(influencers);

  var secs = Math.round((new Date() - start) / 1000);
  Logger.log('=== Done: ' + buildResult.rows.length + ' rows in MergeData, ' +
    buildResult.unresolved + ' unresolved, ' + secs + 's ===');
}


// ── Smoke test (read-only) ────────────────────────────────────

function testAffiliateSheetsSync() {
  Logger.log('=== TEST (no write) ===');

  var utmMap      = asmLoadUtmOverrides_();
  var ampResult   = asmLoadAmpData_();
  asmNormalizeAliases_(ampResult.data, utmMap.aliases);
  var influencers = asmLoadNotionValues_(ampResult.keys, utmMap.overrides);
  var buildResult = asmBuildRows_(influencers, ampResult.data);

  Logger.log('Would write ' + buildResult.rows.length + ' rows to MergeData (' +
    buildResult.unresolved + ' unresolved)');
  Logger.log('');

  // Show resolution status for every influencer
  influencers.forEach(function(inf) {
    var signalLabel = ['—', 'utm_handle', 'url', 'influencer_utm', 'override'][inf.signal] || inf.signal;
    Logger.log(inf.status + ' | ' + inf.name +
      ' → ' + (inf.resolvedKey || 'UNRESOLVED') +
      ' [signal ' + inf.signal + ': ' + signalLabel + ']');
  });

  Logger.log('');
  buildResult.rows.forEach(function(r) {
    Logger.log(r[0] + ' | unpaid=' + r[2] + ' thisMonth=' + r[3] +
      ' prevMonth=' + r[4] + ' lifetime=' + r[5]);
  });
}


// ── UTM-Mapping reader (Signal 0 — manual overrides) ─────────

function asmLoadUtmOverrides_() {
  // Reads UTM-Mapping tab. Col B = UTM Override (may contain aliases separated by " or " or ",").
  // Col C = Resolved Key (canonical). Returns { overrides: {name→canonical}, aliases: {alias→canonical} }.
  var overrides = {}, aliases = {};
  try {
    var ss    = SpreadsheetApp.openById(ASM_MERGE_SHEET_ID);
    var sheet = ss.getSheetByName(ASM_UTM_MAP_TAB);
    if (!sheet) return { overrides: overrides, aliases: aliases };

    var raw     = sheet.getDataRange().getValues();
    var headers = raw[0].map(function(h) { return String(h).trim().toLowerCase(); });
    var colName = headers.indexOf('name');
    var colOver = headers.indexOf('utm override');
    var colKey  = headers.indexOf('resolved key');
    if (colName === -1) return { overrides: overrides, aliases: aliases };

    for (var i = 1; i < raw.length; i++) {
      var name      = String(raw[i][colName] || '').trim();
      var overRaw   = colOver !== -1 ? String(raw[i][colOver] || '').trim().toLowerCase() : '';
      var canonical = colKey  !== -1 ? String(raw[i][colKey]  || '').trim().toLowerCase() : overRaw;
      if (!name || !canonical) continue;

      overrides[name.toLowerCase()] = canonical;

      // Parse col B aliases: "savy.spender or thesavvyspenderofficial" → alias map
      if (overRaw) {
        overRaw.split(/\s+or\s+|,/).forEach(function(alias) {
          alias = alias.trim();
          if (alias && alias !== canonical) aliases[alias] = canonical;
        });
      }
    }
  } catch (e) {
    Logger.log('UTM-Mapping read error (non-fatal): ' + e.message);
  }
  return { overrides: overrides, aliases: aliases };
}


// ── UTM-Mapping writer (resolution report) ───────────────────

function asmWriteUtmMapping_(influencers) {
  var ss    = SpreadsheetApp.openById(ASM_MERGE_SHEET_ID);
  var sheet = ss.getSheetByName(ASM_UTM_MAP_TAB);
  if (!sheet) {
    sheet = ss.insertSheet(ASM_UTM_MAP_TAB);
  }

  // Preserve existing UTM Override values — read them before clearing
  var existingOverrides = {};
  var existing = sheet.getDataRange().getValues();
  if (existing.length > 1) {
    var eHeaders = existing[0].map(function(h) { return String(h).trim().toLowerCase(); });
    var eColName = eHeaders.indexOf('name');
    var eColOver = eHeaders.indexOf('utm override');
    if (eColName !== -1 && eColOver !== -1) {
      for (var i = 1; i < existing.length; i++) {
        var n = String(existing[i][eColName] || '').trim().toLowerCase();
        var o = String(existing[i][eColOver] || '').trim();
        if (n && o) existingOverrides[n] = o;
      }
    }
  }

  var rows = influencers.map(function(inf) {
    var override = existingOverrides[inf.name.toLowerCase()] || '';
    var signalLabel = ['—', 'utm_handle', 'url', 'influencer_utm'][inf.signal] || '—';
    var status;
    if (inf.signal === 0 && inf.resolvedKey) {
      status = '✓ override';
      signalLabel = 'override';
    } else if (inf.resolvedKey) {
      status = '✓ matched';
    } else {
      status = '✗ unresolved';
    }
    return [inf.name, override, inf.resolvedKey || '', signalLabel, status, inf.pageId || ''];
  });

  sheet.clearContents();
  var allRows = [ASM_UTM_MAP_HEADERS].concat(rows);
  sheet.getRange(1, 1, allRows.length, ASM_UTM_MAP_HEADERS.length).setValues(allRows);

  // Highlight unresolved rows in light red so they stand out
  for (var i = 0; i < rows.length; i++) {
    if (rows[i][4] === '✗ unresolved') {
      sheet.getRange(i + 2, 1, 1, ASM_UTM_MAP_HEADERS.length)
        .setBackground('#fce8e6');
    } else {
      sheet.getRange(i + 2, 1, 1, ASM_UTM_MAP_HEADERS.length)
        .setBackground(null);
    }
  }

  var unresolved = rows.filter(function(r) { return r[4] === '✗ unresolved'; }).length;
  Logger.log('UTM-Mapping written: ' + rows.length + ' rows, ' + unresolved + ' unresolved (highlighted red)');
}


// ── Alias normalisation ───────────────────────────────────────
// Rewrites aliased utm_campaign keys in the raw data map to their canonical form
// so both UTMs are summed together under the same key.
function asmNormalizeAliases_(data, aliases) {
  Object.keys(aliases).forEach(function(alias) {
    if (!data[alias]) return;
    var canonical = aliases[alias];
    if (!data[canonical]) data[canonical] = {};
    Object.keys(data[alias]).forEach(function(ym) {
      data[canonical][ym] = (data[canonical][ym] || 0) + data[alias][ym];
    });
    delete data[alias];
  });
  return data;
}


// ── Amplitude data reader ─────────────────────────────────────

function asmLoadAmpData_() {
  var ss = SpreadsheetApp.openById(AFF_SHEET_ID);
  var ws = ss.getSheetByName(ASM_AFF_DATA_TAB);
  if (!ws) {
    Logger.log('Tab "' + ASM_AFF_DATA_TAB + '" not found in AFF_SHEET_ID.');
    return { data: {}, keys: {} };
  }

  var raw     = ws.getDataRange().getValues();
  var headers = raw[0].map(function(h) { return String(h).trim().toLowerCase(); });

  var colCampaign = headers.indexOf('utm_campaign');
  var colContent  = headers.indexOf('utm_content');
  var colDate     = headers.indexOf('date');
  var colLp       = headers.indexOf('viewed marketing site landing page');

  if (colCampaign === -1) colCampaign = 0;
  if (colDate     === -1) colDate     = 1;
  if (colLp       === -1) colLp       = 2;

  var lifeStart = asmParseYearMonth_(ASM_LIFETIME_START);
  var fromYM    = lifeStart.year * 100 + lifeStart.month;

  var data = {}, keys = {}, total = 0, counted = 0;

  for (var i = 1; i < raw.length; i++) {
    total++;
    var campaign = String(raw[i][colCampaign] || '').trim().toLowerCase();
    if (!campaign) continue;

    // Only count adaff traffic.
    // AffiliateSync.gs already filters utm_content=adaff at the Amplitude API
    // level, so the Affiliates-data tab has no utm_content column — all rows
    // are already adaff. If the column IS present, apply the filter explicitly.
    if (colContent !== -1) {
      var content = String(raw[i][colContent] || '').trim().toLowerCase();
      if (content !== 'adaff') continue;
    }

    var d = asmParseDate_(raw[i][colDate]);
    if (!d) continue;
    var rowYM = d.getFullYear() * 100 + (d.getMonth() + 1);
    if (rowYM < fromYM) continue;

    var lp = Number(raw[i][colLp] || 0);
    var ym = String(rowYM);
    if (!data[campaign]) data[campaign] = {};
    data[campaign][ym] = (data[campaign][ym] || 0) + lp;
    keys[campaign] = true;
    counted++;
  }

  Logger.log('Amplitude: ' + total + ' rows read, ' + counted +
    ' adaff rows, ' + Object.keys(keys).length + ' campaigns');
  return { data: data, keys: keys };
}


// ── NotionValues reader ───────────────────────────────────────

function asmLoadNotionValues_(ampKeys, overrides) {
  var ss = SpreadsheetApp.openById(ASM_NOTION_VALUES_ID);
  var ws = ss.getSheets()[0];
  var raw     = ws.getDataRange().getValues();
  var headers = raw[0].map(function(h) { return String(h).trim().toLowerCase(); });

  Logger.log('NotionValues headers sample: ' + headers.slice(0, 15).join(' | '));

  var colPageId    = headers.indexOf('page id');
  var colName      = headers.indexOf('name');
  var colStatus    = headers.indexOf('status');
  var colUtmHandle = headers.indexOf('utm handle');
  var colInflLink  = headers.indexOf('influencer link amplitud match');
  var colInflUtm   = headers.indexOf('influencer utm');
  var colLastPay   = headers.indexOf('affiliate: last payment start');

  var influencers = [];

  for (var i = 1; i < raw.length; i++) {
    var status = String(raw[i][colStatus] || '').trim();
    if (status.indexOf('Affiliate') === -1) continue;

    var name = colName !== -1 ? String(raw[i][colName] || '').trim() : '';

    var resolvedKey = null;
    var signal      = 0;

    // Signal 0: manual override from UTM-Mapping tab (highest priority)
    var manualKey = overrides[name.toLowerCase()];
    if (manualKey) {
      resolvedKey = manualKey;
      signal = 0;
    }

    // Signal 1: UTM Handle — validated against known amplitude keys
    if (!resolvedKey && colUtmHandle !== -1) {
      var h = String(raw[i][colUtmHandle] || '').trim().toLowerCase();
      if (h && ampKeys[h]) {
        resolvedKey = h;
        signal = 1;
      }
    }

    // Signal 2: Extract utm_campaign from URL — validated
    if (!resolvedKey && colInflLink !== -1) {
      var url       = String(raw[i][colInflLink] || '').trim();
      var extracted = asmExtractUtmCampaign_(url);
      if (extracted && ampKeys[extracted]) {
        resolvedKey = extracted;
        signal = 2;
      }
    }

    // Signal 3: Influencer UTM — fallback, no amplitude-key validation
    if (!resolvedKey && colInflUtm !== -1) {
      var utm = String(raw[i][colInflUtm] || '').trim().toLowerCase();
      if (utm) {
        resolvedKey = utm;
        signal = 3;
      }
    }

    var lastPayment = null;
    if (colLastPay !== -1) {
      lastPayment = asmParseDate_(raw[i][colLastPay]);
    }

    var pageId = colPageId !== -1 ? String(raw[i][colPageId] || '').trim() : '';

    influencers.push({
      name:        name,
      status:      status,
      resolvedKey: resolvedKey,
      signal:      signal,
      lastPayment: lastPayment,
      pageId:      pageId
    });
  }

  return influencers;
}


// ── Row builder ───────────────────────────────────────────────

function asmBuildRows_(influencers, ampData) {
  // "This Month"  = last complete calendar month  (May when running in June)
  // "Prev Month"  = two calendar months ago       (April when running in June)
  // "Current Month" label = last complete month name
  var thisYM       = asmGetThisMonthYM_();
  var prevYM       = asmGetPrevMonthYM_();
  var currentLabel = asmYmToMonthName_(thisYM);
  var rows         = [];
  var unresolved   = 0;

  influencers.forEach(function(inf) {
    if (!inf.resolvedKey) unresolved++;
    var buckets = (inf.resolvedKey && ampData[inf.resolvedKey]) || {};

    var clicksThis = buckets[String(thisYM)] || 0;
    var clicksPrev = buckets[String(prevYM)] || 0;
    var lifetime   = 0;
    Object.keys(buckets).forEach(function(ym) { lifetime += buckets[ym]; });

    // Unpaid formula (mirrors Notion formula):
    // if thisMonth >= 10 → thisMonth
    // else if (thisMonth + prevMonth) >= 10 → thisMonth + prevMonth
    // else → 0
    var unpaid;
    if (clicksThis >= 10) {
      unpaid = clicksThis;
    } else if ((clicksThis + clicksPrev) >= 10) {
      unpaid = clicksThis + clicksPrev;
    } else {
      unpaid = 0;
    }

    var lastPayLabel = inf.lastPayment
      ? Utilities.formatDate(inf.lastPayment, Session.getScriptTimeZone(), 'MMM yyyy')
      : '';

    rows.push([inf.name, inf.status, unpaid, clicksThis, clicksPrev, lifetime, lastPayLabel, currentLabel]);
  });

  return { rows: rows, unresolved: unresolved };
}


// ── MergeData writer ──────────────────────────────────────────

function asmWriteMergeData_(rows) {
  var ss    = SpreadsheetApp.openById(ASM_MERGE_SHEET_ID);
  var sheet = ss.getSheetByName(ASM_MERGE_TAB);
  if (!sheet) sheet = ss.insertSheet(ASM_MERGE_TAB);

  sheet.clearContents();
  var allRows = [ASM_MERGE_HEADERS].concat(rows);
  sheet.getRange(1, 1, allRows.length, ASM_MERGE_HEADERS.length).setValues(allRows);
  Logger.log('MergeData written: ' + rows.length + ' data rows + header');
}


// ── Helpers ───────────────────────────────────────────────────

function asmGetThisMonthYM_() {
  // "This Month" = last complete calendar month (May when running in June)
  return asmShiftMonthYM_(new Date(), -1);
}

function asmGetPrevMonthYM_() {
  // "Previous Month" = two calendar months ago (April when running in June)
  return asmShiftMonthYM_(new Date(), -2);
}

function asmShiftMonthYM_(date, delta) {
  var year  = date.getFullYear();
  var month = (date.getMonth() + 1) + delta; // 1-based + delta
  while (month <= 0)  { month += 12; year--; }
  while (month > 12)  { month -= 12; year++; }
  return year * 100 + month;
}

function asmYmToMonthName_(ym) {
  var names = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return names[(ym % 100) - 1] || String(ym);
}

function asmParseDate_(val) {
  if (val instanceof Date) return isNaN(val.getTime()) ? null : val;
  var s = String(val).trim();
  if (!s) return null;
  if (/^\d{8}$/.test(s)) s = s.slice(0,4) + '-' + s.slice(4,6) + '-' + s.slice(6,8);
  var d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

function asmParseYearMonth_(ym) {
  var p = String(ym).split('-');
  return { year: parseInt(p[0], 10), month: parseInt(p[1], 10) };
}

function asmExtractUtmCampaign_(url) {
  // Mirrors extract_utm_campaign() in utm_resolver.py
  if (!url || url.indexOf('http') !== 0) return '';
  try {
    var qs = url.split('?')[1] || '';
    var params = qs.split('&');
    for (var i = 0; i < params.length; i++) {
      var pair = params[i].split('=');
      if (pair[0] === 'utm_campaign') {
        return decodeURIComponent(pair[1] || '').trim().toLowerCase();
      }
    }
  } catch (e) { /* ignore malformed URLs */ }
  return '';
}
