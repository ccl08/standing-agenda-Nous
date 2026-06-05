// ============================================================
// AffiliateLPReport.gs — Daily per-influencer landing page report.
//
// Joins:
//   • Affiliates-data tab  — LP views per UTM per day (Amplitude)
//   • UTM-Mapping tab      — canonical UTM key + Page ID per influencer
//   • NotionValues sheet   — Influencer Email, Agent Email, Referral Link
//
// Output tab: Supabase
// Columns: Name | Date | Page ID | Viewed LP | Ref Link |
//          UTM Final | Influencer Email | Agent Email
//
// Run testAffiliateLPReport() first — read-only, logs output.
// Run affiliateLPReport() to write to the sheet.
// ============================================================

var ALR_SHEET_ID          = '19COFeVqjvByU1NZUVnBnuxA1_6eBToZnitGzz0mRWlA';
var ALR_NOTION_VALUES_ID  = '1eFkukSGwI7E4bQFk2lolekx3abQkYKBzr3r2V8bpV6A';
var ALR_UTM_TAB           = 'UTM-Mapping';
var ALR_AFF_TAB           = 'Affiliates-daily-data';
var ALR_OUTPUT_TAB        = 'Supabase';

var ALR_HEADERS = [
  'Name',
  'Date',
  'Page ID',
  'Viewed Marketing Site Landing Page',
  'ref_Affiliate link',
  'UTM Final',
  'Influencer Email',
  'Agent Email'
];


// ── Entry point ───────────────────────────────────────────────

function affiliateLPReport() {
  var result = alrBuildReport_();
  alrWriteReport_(result.rows);
  Logger.log('Done: ' + result.rows.length + ' rows → ' + ALR_OUTPUT_TAB +
    ' (' + result.unmatched + ' unmatched UTMs skipped)');
}


// ── Smoke test (read-only) ────────────────────────────────────

function testAffiliateLPReport() {
  Logger.log('=== TEST (no write) ===');
  var result = alrBuildReport_();

  Logger.log('Rows: ' + result.rows.length + ' | Unmatched UTMs: ' + result.unmatched);
  Logger.log('');

  result.rows.slice(0, 30).forEach(function(r) {
    Logger.log(r[0] + ' | ' + r[1] + ' | lp=' + r[3] + ' | utm=' + r[5] +
      ' | inf=' + r[6] + ' | agent=' + r[7]);
  });

  if (result.unmatchedKeys.length) {
    Logger.log('');
    Logger.log('Unmatched UTM keys (not in UTM-Mapping):');
    result.unmatchedKeys.forEach(function(k) { Logger.log('  ' + k); });
  }
}


// ── Core builder ─────────────────────────────────────────────

function alrBuildReport_() {
  var utmMap    = alrLoadUtmMap_();
  var notionMeta = alrLoadNotionMeta_();
  var ampRows   = alrLoadAmpData_();

  var rows          = [];
  var unmatched     = 0;
  var unmatchedKeys = {};

  ampRows.forEach(function(row) {
    var utmEntry = utmMap[row.utm];
    if (!utmEntry) {
      unmatched++;
      unmatchedKeys[row.utm] = true;
      return;
    }

    var meta = notionMeta[utmEntry.pageId] || {};

    rows.push([
      utmEntry.name,
      row.date,
      utmEntry.pageId,
      row.lp,
      meta.refLink        || '',
      row.utm,
      meta.influencerEmail || '',
      meta.agentEmail      || ''
    ]);
  });

  // Sort by date desc, then name asc
  rows.sort(function(a, b) {
    return b[1] > a[1] ? 1 : b[1] < a[1] ? -1 : a[0].localeCompare(b[0]);
  });

  return {
    rows:          rows,
    unmatched:     unmatched,
    unmatchedKeys: Object.keys(unmatchedKeys)
  };
}


// ── UTM-Mapping loader ────────────────────────────────────────
// Returns { canonical_utm → { name, pageId } }
// Also maps aliases from col B (UTM Override) to the same entry.

function alrLoadUtmMap_() {
  var ss    = SpreadsheetApp.openById(ALR_SHEET_ID);
  var sheet = ss.getSheetByName(ALR_UTM_TAB);
  if (!sheet) {
    Logger.log('UTM-Mapping tab not found');
    return {};
  }

  var raw     = sheet.getDataRange().getValues();
  var headers = raw[0].map(function(h) { return String(h).trim().toLowerCase(); });

  var colName   = headers.indexOf('name');
  var colOver   = headers.indexOf('utm override');
  var colKey    = headers.indexOf('resolved key');
  var colPageId = headers.indexOf('notion page id');

  var map = {};

  for (var i = 1; i < raw.length; i++) {
    var canonical = colKey  !== -1 ? String(raw[i][colKey]  || '').trim().toLowerCase() : '';
    var overRaw   = colOver !== -1 ? String(raw[i][colOver] || '').trim().toLowerCase() : '';

    if (!canonical && overRaw) canonical = overRaw.split(/\s+or\s+|,/)[0].trim();
    if (!canonical) continue;

    var entry = {
      name:   colName   !== -1 ? String(raw[i][colName]   || '').trim() : '',
      pageId: colPageId !== -1 ? String(raw[i][colPageId] || '').trim() : ''
    };

    map[canonical] = entry;

    // Map aliases so both UTMs resolve to the same entry
    if (overRaw) {
      overRaw.split(/\s+or\s+|,/).forEach(function(alias) {
        alias = alias.trim();
        if (alias && alias !== canonical) map[alias] = entry;
      });
    }
  }

  Logger.log('UTM-Mapping loaded: ' + Object.keys(map).length + ' keys');
  return map;
}


// ── NotionValues metadata loader ──────────────────────────────
// Reads Influencer Email, Agent Email, and ref_Affiliate link from
// the NotionValues sheet. Returns { pageId → metadata }.

function alrLoadNotionMeta_() {
  var ss  = SpreadsheetApp.openById(ALR_NOTION_VALUES_ID);
  var ws  = ss.getSheets()[0];
  var raw = ws.getDataRange().getValues();

  var headers = raw[0].map(function(h) { return String(h).trim().toLowerCase(); });

  var colPageId  = headers.indexOf('page id');
  var colInfEm   = headers.indexOf('influencer email');
  var colAgentEm = headers.indexOf('agent email');
  var colRefLink = headers.indexOf('ref_affiliate link');

  var meta = {};

  for (var i = 1; i < raw.length; i++) {
    var pageId = colPageId !== -1 ? String(raw[i][colPageId] || '').trim() : '';
    if (!pageId) continue;

    meta[pageId] = {
      influencerEmail: colInfEm   !== -1 ? String(raw[i][colInfEm]   || '').trim() : '',
      agentEmail:      colAgentEm !== -1 ? String(raw[i][colAgentEm] || '').trim() : '',
      refLink:         colRefLink !== -1 ? String(raw[i][colRefLink]  || '').trim() : ''
    };
  }

  Logger.log('NotionValues meta loaded: ' + Object.keys(meta).length + ' entries');
  return meta;
}


// ── Amplitude data loader ─────────────────────────────────────

function alrLoadAmpData_() {
  var ss = SpreadsheetApp.openById(ALR_SHEET_ID);
  var ws = ss.getSheetByName(ALR_AFF_TAB);
  if (!ws) {
    Logger.log('Tab "' + ALR_AFF_TAB + '" not found');
    return [];
  }

  var raw     = ws.getDataRange().getValues();
  var headers = raw[0].map(function(h) { return String(h).trim().toLowerCase(); });

  var colUtm  = headers.indexOf('utm_campaign');
  var colDate = headers.indexOf('date');
  var colLp   = headers.indexOf('viewed marketing site landing page');

  if (colUtm  === -1) colUtm  = 0;
  if (colDate === -1) colDate = 1;
  if (colLp   === -1) colLp   = 2;

  var rows = [];
  for (var i = 1; i < raw.length; i++) {
    var utm = String(raw[i][colUtm] || '').trim().toLowerCase();
    if (!utm) continue;

    var lp = Number(raw[i][colLp] || 0);
    if (lp === 0) continue;

    var d = raw[i][colDate];
    var dateStr = d instanceof Date ? alrFmtDate_(d) : String(d).trim();

    rows.push({ utm: utm, date: dateStr, lp: lp });
  }

  // Deduplicate by utm+date — source tab may have duplicate rows
  var seen = {}, deduped = [];
  rows.forEach(function(r) {
    var key = r.utm + '||' + r.date;
    if (!seen[key]) { seen[key] = true; deduped.push(r); }
  });

  Logger.log('Affiliates-data loaded: ' + deduped.length + ' rows (deduped from ' + rows.length + ')');
  return deduped;
}


// ── Report writer ─────────────────────────────────────────────

function alrWriteReport_(rows) {
  var ss    = SpreadsheetApp.openById(ALR_SHEET_ID);
  var sheet = ss.getSheetByName(ALR_OUTPUT_TAB);
  if (!sheet) sheet = ss.insertSheet(ALR_OUTPUT_TAB);

  sheet.clearContents();
  var allRows = [ALR_HEADERS].concat(rows);
  sheet.getRange(1, 1, allRows.length, ALR_HEADERS.length).setValues(allRows);
  Logger.log('Written: ' + rows.length + ' rows to ' + ALR_OUTPUT_TAB);
}


// ── Helper ────────────────────────────────────────────────────

function alrFmtDate_(d) {
  return d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0');
}
