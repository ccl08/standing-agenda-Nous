// ============================================================
// AffiliateNotionSync.gs — Monthly affiliate click sync.
//
// Runs on the 1st of each month. Reads the previous month's
// affiliate LP totals from the Affiliates-data sheet (written by
// AffiliateSync.gs), matches each utm_campaign to an influencer
// in the I.Influencers Notion database, and writes the total to
// the "Affiliate: Clicks Previous Month" property on their page.
//
// Setup: run ansCreateMonthlyTrigger() once from the Apps Script
// editor to register the 1st-of-month trigger.
//
// Shares ns_ helpers from NotionSync.gs (same project).
// Does NOT touch AmplitudeSync.gs, NotionSync.gs, or AffiliateSync.gs.
// ============================================================

var ANS_INFLUENCERS_DB_ID = '1f8e4fd0-8136-802e-90b6-dfdc8e1fa7b5';
var ANS_AFF_DATA_TAB      = 'Affiliates-data'; // written by AffiliateSync.gs
var ANS_LIFETIME_START    = '2026-03';         // first month included in Lifetime Clicks
var ANS_PREV_MONTH_PROP   = 'Affiliate: Clicks Previous Month';
var ANS_LIFETIME_PROP     = 'Affiliate: Lifetime Clicks';
var ANS_BACKFILL_MONTH    = '2026-05';         // change to target month, then run ansBackfill()


// ── Trigger setup (run ONCE manually) ────────────────────────

function ansCreateMonthlyTrigger() {
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === 'affiliateNotionSync') {
      ScriptApp.deleteTrigger(t);
    }
  });
  ScriptApp.newTrigger('affiliateNotionSync')
    .timeBased()
    .onMonthDay(1)
    .atHour(7)
    .create();
  Logger.log('Monthly trigger created: affiliateNotionSync() fires on the 1st of each month at 7am.');
}


// ── Entry point ───────────────────────────────────────────────

function affiliateNotionSync() {
  var prev     = ansGetPrevMonth_();
  var lifeStart = ansParseYearMonth_(ANS_LIFETIME_START);
  Logger.log('=== AffiliateNotionSync: syncing ' + prev.label +
    ' | lifetime from ' + ANS_LIFETIME_START + ' ===');

  // 1. Previous month totals  (e.g. April when running May 1)
  var prevData = ansLoadAffiliateDataRange_(prev.year, prev.month, prev.year, prev.month);
  // 2. Lifetime totals from ANS_LIFETIME_START through previous month
  var lifeData = ansLoadAffiliateDataRange_(lifeStart.year, lifeStart.month, prev.year, prev.month);

  Logger.log('Campaigns with prev-month data : ' + Object.keys(prevData).length);
  Logger.log('Campaigns with lifetime data   : ' + Object.keys(lifeData).length);

  if (Object.keys(prevData).length === 0 && Object.keys(lifeData).length === 0) {
    Logger.log('No affiliate data found — aborting.');
    return;
  }

  // 3. Load all influencers from Notion (name + pageId)
  var influencers = ansLoadInfluencers_();
  Logger.log('Influencers loaded: ' + influencers.length);

  // Use the union of campaign keys from both datasets for matching
  var allCampaigns = Object.keys(
    Object.assign({}, prevData, lifeData)
  );

  var updated = 0, skipped = 0, errors = 0;

  influencers.forEach(function(inf) {
    try {
      var campaign = ansFindAffiliateCampaign_(inf.name, allCampaigns);
      if (!campaign) {
        skipped++;
        return;
      }

      var prevClicks = prevData[campaign] || 0;
      var lifeClicks = lifeData[campaign] || 0;

      if (prevClicks === 0 && lifeClicks === 0) {
        skipped++;
        return;
      }

      ansUpdateInfluencerPage_(inf.pageId, prevClicks, lifeClicks);
      Logger.log('✓ ' + inf.name + ' | prev=' + prevClicks + ' lifetime=' + lifeClicks +
        ' [' + campaign + ']');
      updated++;

    } catch (e) {
      Logger.log('✗ ' + inf.name + ' | ' + e.message);
      errors++;
    }
  });

  Logger.log('=== Done: updated=' + updated + ' skipped=' + skipped + ' errors=' + errors + ' ===');
}


// ── Smoke test ────────────────────────────────────────────────

function testAffiliateNotionSync() {
  var prev      = ansGetPrevMonth_();
  var lifeStart = ansParseYearMonth_(ANS_LIFETIME_START);
  Logger.log('=== TEST: prev=' + prev.label + ' | lifetime from ' + ANS_LIFETIME_START + ' ===');

  var prevData    = ansLoadAffiliateDataRange_(prev.year, prev.month, prev.year, prev.month);
  var lifeData    = ansLoadAffiliateDataRange_(lifeStart.year, lifeStart.month, prev.year, prev.month);
  var influencers = ansLoadInfluencers_();
  var allCampaigns = Object.keys(Object.assign({}, prevData, lifeData));

  Logger.log('Campaigns (prev month) : ' + Object.keys(prevData).length);
  Logger.log('Campaigns (lifetime)   : ' + Object.keys(lifeData).length);
  Logger.log('Influencers in Notion  : ' + influencers.length);
  Logger.log('');

  influencers.forEach(function(inf) {
    var campaign   = ansFindAffiliateCampaign_(inf.name, allCampaigns);
    var prevClicks = campaign ? (prevData[campaign] || 0) : null;
    var lifeClicks = campaign ? (lifeData[campaign] || 0) : null;
    Logger.log(
      inf.name + ' → ' +
      (campaign
        ? campaign + ' | prev=' + prevClicks + ' lifetime=' + lifeClicks
        : 'NO MATCH')
    );
  });
}


// ── Data loaders ──────────────────────────────────────────────

function ansLoadAffiliateDataRange_(fromYear, fromMonth, toYear, toMonth) {
  // Returns { utmCampaign: lpTotal } summed across all months in the range.
  // Reads from the Affiliates-data tab (written by AffiliateSync.gs).
  var ss = SpreadsheetApp.openById(AFF_SHEET_ID); // separate affiliate sheet, defined in AffiliateSync.gs
  var ws = ss.getSheetByName(ANS_AFF_DATA_TAB);
  if (!ws) {
    Logger.log('Tab "' + ANS_AFF_DATA_TAB + '" not found.');
    return {};
  }

  var raw     = ws.getDataRange().getValues();
  var headers = raw[0].map(function(h) { return String(h).trim().toLowerCase(); });

  var colCampaign = headers.indexOf('utm_campaign');
  var colDate     = headers.indexOf('date');
  var colLp       = headers.indexOf('viewed marketing site landing page');

  if (colCampaign === -1) colCampaign = 0;
  if (colDate     === -1) colDate     = 1;
  if (colLp       === -1) colLp       = 2;

  // Convert from/to into comparable integer: YYYYMM
  var fromYM = fromYear * 100 + fromMonth;
  var toYM   = toYear   * 100 + toMonth;

  var totals = {};

  for (var i = 1; i < raw.length; i++) {
    var campaign = String(raw[i][colCampaign] || '').trim().toLowerCase();
    if (!campaign) continue;

    var d = ansParseDate_(raw[i][colDate]);
    if (!d) continue;

    var rowYM = d.getFullYear() * 100 + (d.getMonth() + 1);
    if (rowYM < fromYM || rowYM > toYM) continue;

    var lp = Number(raw[i][colLp] || 0);
    totals[campaign] = (totals[campaign] || 0) + lp;
  }

  return totals;
}

function ansLoadInfluencers_() {
  // Queries the I.Influencers Notion database and returns [{name, pageId}].
  // Paginates automatically — handles any number of influencers (100 per page).
  var influencers = [];
  var cursor      = null;
  var page        = 0;
  var MAX_PAGES   = 50; // safety cap: 50 × 100 = 5,000 influencers max

  do {
    page++;
    var body = { page_size: 100 };
    if (cursor) body.start_cursor = cursor;

    var res = UrlFetchApp.fetch(
      'https://api.notion.com/v1/databases/' + ANS_INFLUENCERS_DB_ID + '/query',
      {
        method:  'post',
        headers: {
          'Authorization':  'Bearer ' + NS_NOTION_TOKEN,
          'Notion-Version': '2022-06-28',
          'Content-Type':   'application/json'
        },
        payload:            JSON.stringify(body),
        muteHttpExceptions: true
      }
    );

    if (res.getResponseCode() !== 200) {
      Logger.log('Notion DB query error (page ' + page + '): ' +
        res.getResponseCode() + ' ' + res.getContentText().substring(0, 200));
      break;
    }

    var data = JSON.parse(res.getContentText());

    (data.results || []).forEach(function(p) {
      var nameProp = p.properties['Name'] || p.properties['name'];
      var name = '';
      if (nameProp && nameProp.title && nameProp.title.length > 0) {
        name = nameProp.title[0].plain_text || '';
      }
      if (name && p.id) influencers.push({ name: name.trim(), pageId: p.id });
    });

    Logger.log('  Loaded page ' + page + ' (' + influencers.length + ' total so far)');
    cursor = data.has_more ? data.next_cursor : null;

  } while (cursor && page < MAX_PAGES);

  if (page >= MAX_PAGES && cursor) {
    Logger.log('Warning: hit MAX_PAGES (' + MAX_PAGES + ') — increase cap if needed.');
  }

  Logger.log('Influencers loaded: ' + influencers.length + ' across ' + page + ' page(s)');
  return influencers;
}


// ── Matching ──────────────────────────────────────────────────

function ansFindAffiliateCampaign_(influencerName, campaigns) {
  // Normalises the influencer name and each campaign key to bare
  // alphanumeric, then returns the best match at ≥ 0.80 similarity.
  var nameNorm = ansAlpha_(influencerName);
  var bestKey  = null, bestScore = 0;

  campaigns.forEach(function(campaign) {
    var campNorm = ansAlpha_(campaign);
    if (!campNorm) return;

    var score;
    if (campNorm === nameNorm) {
      score = 1.0;
    } else {
      var longer  = nameNorm.length >= campNorm.length ? nameNorm : campNorm;
      var shorter = nameNorm.length >= campNorm.length ? campNorm : nameNorm;
      score = longer.length > 0
        ? (longer.length - nsEditDist_(longer, shorter)) / longer.length
        : 0;
    }

    if (score > bestScore && score >= 0.80) {
      bestScore = score;
      bestKey   = campaign;
    }
  });

  return bestKey;
}


// ── Notion writer ─────────────────────────────────────────────

function ansUpdateInfluencerPage_(pageId, prevClicks, lifeClicks) {
  var payload = { properties: {} };
  payload.properties[ANS_PREV_MONTH_PROP] = { number: prevClicks };
  payload.properties[ANS_LIFETIME_PROP]   = { number: lifeClicks };

  var opts = {
    method:  'patch',
    headers: {
      'Authorization':  'Bearer ' + NS_NOTION_TOKEN,
      'Notion-Version': '2022-06-28',
      'Content-Type':   'application/json'
    },
    payload:            JSON.stringify(payload),
    muteHttpExceptions: true
  };

  Utilities.sleep(350); // stay under Notion's ~3 req/s rate limit

  var res  = UrlFetchApp.fetch('https://api.notion.com/v1/pages/' + pageId, opts);
  var code = res.getResponseCode();

  if (code === 429) {
    Utilities.sleep(10000);
    res  = UrlFetchApp.fetch('https://api.notion.com/v1/pages/' + pageId, opts);
    code = res.getResponseCode();
  }

  if (code !== 200) {
    throw new Error('HTTP ' + code + ': ' + res.getContentText().substring(0, 300));
  }
}


// ── Helpers ───────────────────────────────────────────────────

function ansGetPrevMonth_() {
  var now   = new Date();
  var month = now.getMonth(); // 0-based; this is the PREVIOUS month (Jan=0)
  var year  = now.getFullYear();
  if (month === 0) { month = 12; year--; }
  var label = year + '-' + String(month).padStart(2, '0');
  return { year: year, month: month, label: label };
}

function ansParseDate_(val) {
  if (val instanceof Date) return isNaN(val.getTime()) ? null : val;
  var s = String(val).trim();
  if (!s) return null;
  // Handle YYYYMMDD format from Amplitude (e.g. "20260601")
  if (/^\d{8}$/.test(s)) {
    s = s.slice(0, 4) + '-' + s.slice(4, 6) + '-' + s.slice(6, 8);
  }
  var d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

function ansParseYearMonth_(ym) {
  // Parses 'YYYY-MM' into { year, month } (month is 1-based).
  var parts = String(ym).split('-');
  return { year: parseInt(parts[0], 10), month: parseInt(parts[1], 10) };
}

function ansAlpha_(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
}
