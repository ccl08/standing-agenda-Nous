// ============================================================
// NotionSync.gs — Reads Amplitude + Posts sheets, resolves
// UTM keys, and writes Landing Page Views / Accounts Created /
// Delegations to each Notion post page via REST API.
//
// Paste into the same Apps Script project as AmplitudeSync.gs.
// AmplitudeSync.gs calls notionSync() at the end of dailySync().
// ============================================================

// Store the token in Apps Script Project Settings → Script Properties (key: NOTION_TOKEN)
var NS_NOTION_TOKEN       = PropertiesService.getScriptProperties().getProperty('NOTION_TOKEN');
var NS_AMPLITUDE_SHEET_ID = '1eghadoVWL30ALoa8ieemziRJL4rcHOOTniQz40xFlW8';
var NS_POSTS_SHEET_ID     = '1dMyCjRce8kdMPacpGV-gk9T0mRhnHvh7Xwn0fQpKsJY';
var NS_POSTS_GID          = 558266150;
var NS_CORRECTIONS_ID     = '15C0ewJj7th_lFoV_fgz3UhNAQk16ddeCOf_OJYEwd0o';
var NS_LOG_GID            = 719363483;
var NS_LOG_TAB            = 'Logs-daily';
var NS_START_DATE         = '2026-06-01'; // only sync posts from this date onwards

var NS_LP_PROP  = 'Landing Page Views';
var NS_ACC_PROP = 'Accounts Created';
var NS_DEL_PROP = 'Delegations';


// ── Diagnostic ───────────────────────────────────────────────
// Run nsDebugAmplitude_() ONCE to see what dates + keys are actually
// stored in the Amplitude sheet. Tells us the root cause of date mismatches.

function debugAmplitude() {
  var amp = nsLoadAmplitude_();
  Logger.log('Total rows loaded: ' + amp.length);

  // Distinct dates present
  var dateCounts = {};
  amp.forEach(function(r) {
    dateCounts[r.dateStr] = (dateCounts[r.dateStr] || 0) + 1;
  });
  Logger.log('Distinct dates in Amplitude sheet:');
  Object.keys(dateCounts).sort().forEach(function(d) {
    Logger.log('  ' + d + ' → ' + dateCounts[d] + ' rows');
  });

  // First 5 raw rows so we can see the actual column names + values
  var ss  = SpreadsheetApp.openById(NS_AMPLITUDE_SHEET_ID);
  var ws  = ss.getSheetByName('Daily-data') || ss.getSheets()[0];
  var raw = ws.getDataRange().getValues();
  Logger.log('Sheet headers (row 1): ' + JSON.stringify(raw[0]));
  Logger.log('Row 2 raw values     : ' + JSON.stringify(raw[1]));
  Logger.log('Row 3 raw values     : ' + JSON.stringify(raw[2]));
}


// ── Smoke test ────────────────────────────────────────────────
// Run testNotionSync() from the Apps Script editor to test a single
// day's posts before running the full 180-day sync.

var NS_TEST_DATE = '2026-06-01'; // change to the post date you want to test

function testNotionSync() {
  Logger.log('=== TEST: posts from ' + NS_TEST_DATE + ' ===');

  var amp   = nsLoadAmplitude_();
  var posts  = nsLoadPosts_();
  var corr   = nsLoadCorrections_();

  Logger.log('Amplitude rows : ' + amp.length);
  Logger.log('All posts loaded: ' + posts.length);

  var testPosts = posts.filter(function(p) {
    return nsFmtDate_(p.postDate) === NS_TEST_DATE;
  });

  Logger.log('Posts on ' + NS_TEST_DATE + ': ' + testPosts.length);
  if (testPosts.length === 0) {
    Logger.log('No posts found for this date. Check the Posts sheet or adjust NS_TEST_DATE.');
    return;
  }

  var logs = [];
  var runTime = new Date();

  testPosts.forEach(function(post) {
    Logger.log('--- ' + post.influencer + ' ---');
    try {
      var key = nsResolveKey_(post, corr, amp);
      Logger.log('  Key    : ' + (key || 'UNRESOLVED'));
      if (!key) {
        logs.push([runTime, 'unresolved', post.influencer]);
        return;
      }

      var m = nsSum_(amp, key, NS_TEST_DATE);

      if (m.lp === 0) {
        var urlKey = nsExtractUtm_(post.ampMatchUrl);
        if (urlKey && urlKey !== key) {
          var m2 = nsSum_(amp, urlKey, NS_TEST_DATE);
          if (m2.lp > 0) { m = m2; key = urlKey; Logger.log('  → URL fallback: ' + key); }
        }
      }

      if (m.lp === 0) {
        var fb = nsSimilarityFallback_(key, amp, NS_TEST_DATE);
        if (fb) { m = fb.metrics; key = fb.key; Logger.log('  → Similarity fallback: ' + key); }
      }

      Logger.log('  Metrics: LP=' + m.lp + ' Acc=' + m.acc + ' Del=' + m.del);
      Logger.log('  Page ID: ' + post.pageId);

      if (m.lp === 0 && m.acc === 0 && m.del === 0) {
        Logger.log('  Status : skipped (no data)');
        logs.push([runTime, 'no data', post.influencer]);
        return;
      }

      nsUpdateNotionPage_(post.pageId, m.lp, m.acc, m.del);
      Logger.log('  Status : ✅ written to Notion');
      logs.push([runTime, '✅ matched LP=' + m.lp + ' Acc=' + m.acc + ' Del=' + m.del, post.influencer]);

    } catch (e) {
      Logger.log('  Status : ❌ ' + e.message);
      logs.push([runTime, '❌ ' + e.message.substring(0, 120), post.influencer]);
    }
  });

  nsWriteLog_(logs);
  Logger.log('=== TEST complete — check Logs-daily sheet for results ===');
}


// ── Two-day window dry-run test ───────────────────────────────
// Run testTwoDayWindow() to preview what notionSync() would write
// using the 2-day attribution window. Nothing is written to Notion.
// Set NS_TEST_POST_DATE to the story's post date (not today or tomorrow).

var NS_TEST_POST_DATE = '2026-06-03'; // post date to test

function testTwoDayWindow() {
  var p        = NS_TEST_POST_DATE.split('-');
  var postDate = new Date(+p[0], +p[1] - 1, +p[2]);
  var nextDay  = new Date(+p[0], +p[1] - 1, +p[2] + 1);
  var dateWindow = [NS_TEST_POST_DATE, nsFmtDate_(nextDay)];

  Logger.log('=== DRY RUN: 2-day window for posts on ' + NS_TEST_POST_DATE + ' ===');
  Logger.log('Date window: ' + dateWindow.join(' + '));

  var amp  = nsLoadAmplitude_();
  var posts = nsLoadPosts_();
  var corr  = nsLoadCorrections_();

  Logger.log('Amplitude rows : ' + amp.length);

  // Show which dates are actually present in the Amplitude sheet for this window
  var windowCounts = {};
  dateWindow.forEach(function(d) {
    windowCounts[d] = amp.filter(function(r) { return r.dateStr === d; }).length;
  });
  Logger.log('Amplitude rows in window: ' + JSON.stringify(windowCounts));

  var testPosts = posts.filter(function(post) {
    return nsFmtDate_(post.postDate) === NS_TEST_POST_DATE;
  });

  Logger.log('Posts on ' + NS_TEST_POST_DATE + ': ' + testPosts.length);
  if (testPosts.length === 0) {
    Logger.log('No posts found. Adjust NS_TEST_POST_DATE or check the Posts sheet.');
    return;
  }

  var logs = [];
  var runTime = new Date();

  testPosts.forEach(function(post) {
    Logger.log('--- ' + post.influencer + ' ---');
    try {
      var key = nsResolveKey_(post, corr, amp);
      Logger.log('  Key      : ' + (key || 'UNRESOLVED'));
      if (!key) {
        logs.push([runTime, 'DRY RUN unresolved', post.influencer]);
        return;
      }

      var m = nsSumWindow_(amp, key, dateWindow);

      if (m.lp === 0) {
        var urlKey = nsExtractUtm_(post.ampMatchUrl);
        if (urlKey && urlKey !== key) {
          var m2 = nsSumWindow_(amp, urlKey, dateWindow);
          if (m2.lp > 0) { m = m2; key = urlKey; Logger.log('  → URL fallback: ' + key); }
        }
      }

      if (m.lp === 0) {
        var fb = nsSimilarityFallback_(key, amp, dateWindow);
        if (fb) { m = fb.metrics; key = fb.key; Logger.log('  → Similarity fallback: ' + key); }
      }

      // For comparison: show single-day totals alongside the 2-day total
      var d0 = nsSum_(amp, key, dateWindow[0]);
      var d1 = nsSum_(amp, key, dateWindow[1]);
      Logger.log('  Day 1 (' + dateWindow[0] + '): LP=' + d0.lp + ' Acc=' + d0.acc + ' Del=' + d0.del);
      Logger.log('  Day 2 (' + dateWindow[1] + '): LP=' + d1.lp + ' Acc=' + d1.acc + ' Del=' + d1.del);
      Logger.log('  2-day total          : LP=' + m.lp  + ' Acc=' + m.acc  + ' Del=' + m.del);
      Logger.log('  Page ID  : ' + post.pageId);

      if (m.lp === 0 && m.acc === 0 && m.del === 0) {
        Logger.log('  Status   : would SKIP (no data in window)');
        logs.push([runTime, 'DRY RUN no data', post.influencer]);
        return;
      }

      Logger.log('  Status   : would WRITE LP=' + m.lp + ' Acc=' + m.acc + ' Del=' + m.del + ' (not sent)');
      logs.push([runTime, 'DRY RUN LP=' + m.lp + ' Acc=' + m.acc + ' Del=' + m.del, post.influencer]);

    } catch (e) {
      Logger.log('  Status   : ❌ ' + e.message);
      logs.push([runTime, 'DRY RUN ERR ' + e.message.substring(0, 100), post.influencer]);
    }
  });

  nsWriteLog_(logs);
  Logger.log('=== DRY RUN complete — nothing written to Notion ===');
}


// ── Entry point ───────────────────────────────────────────────

function notionSync() {
  Logger.log('=== NotionSync start ===');

  var amp  = nsLoadAmplitude_();
  var posts = nsLoadPosts_();
  var corr  = nsLoadCorrections_();

  Logger.log('Amplitude rows : ' + amp.length);
  Logger.log('Posts in window: ' + posts.length);
  Logger.log('Corrections    : ' + Object.keys(corr).length);

  // Process posts from the last 2 days. A story posted on day D is still live on day D+1,
  // so we run on both days to capture the full cumulative total and overwrite with the latest.
  var now        = new Date();
  var yesterday  = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  var twoDaysAgo = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 2);
  posts = posts.filter(function(p) {
    var d = new Date(p.postDate.getFullYear(), p.postDate.getMonth(), p.postDate.getDate());
    return d.getTime() === yesterday.getTime() || d.getTime() === twoDaysAgo.getTime();
  });

  Logger.log('Posts in 2-day window: ' + posts.length +
    ' (' + nsFmtDate_(twoDaysAgo) + ' + ' + nsFmtDate_(yesterday) + ')');

  var updated = 0, skipped = 0, errors = 0;
  var logs    = [];
  var runTime = new Date();

  posts.forEach(function(post) {
    try {
      // Build the 2-day date window for this post: post date + the following day,
      // capped at yesterday so today's incomplete data is never included.
      var postDateStr  = nsFmtDate_(post.postDate);
      var nextDay      = new Date(post.postDate.getFullYear(), post.postDate.getMonth(), post.postDate.getDate() + 1);
      if (nextDay > yesterday) nextDay = yesterday;
      var nextDateStr  = nsFmtDate_(nextDay);
      var dateWindow   = postDateStr === nextDateStr ? [postDateStr] : [postDateStr, nextDateStr];

      var key = nsResolveKey_(post, corr, amp);
      if (!key) {
        skipped++;
        logs.push([runTime, 'unresolved', post.influencer]);
        return;
      }

      var m = nsSumWindow_(amp, key, dateWindow);

      // Pass 1: URL-derived utm_campaign
      if (m.lp === 0) {
        var urlKey = nsExtractUtm_(post.ampMatchUrl);
        if (urlKey && urlKey !== key) {
          var m2 = nsSumWindow_(amp, urlKey, dateWindow);
          if (m2.lp > 0) { m = m2; key = urlKey; }
        }
      }

      // Pass 2: string similarity against active keys
      if (m.lp === 0) {
        var fb = nsSimilarityFallback_(key, amp, dateWindow);
        if (fb) { m = fb.metrics; key = fb.key; }
      }

      // Zero-write protection — never overwrite existing Notion data with 0/0/0
      if (m.lp === 0 && m.acc === 0 && m.del === 0) {
        skipped++;
        logs.push([runTime, 'no data', post.influencer]);
        return;
      }

      nsUpdateNotionPage_(post.pageId, m.lp, m.acc, m.del);
      Logger.log('✓ ' + post.influencer + ' | ' + dateWindow.join('+') +
        ' | LP=' + m.lp + ' Acc=' + m.acc + ' Del=' + m.del + ' [' + key + ']');
      logs.push([runTime, '✅ matched LP=' + m.lp + ' Acc=' + m.acc + ' Del=' + m.del, post.influencer]);
      updated++;

    } catch (e) {
      Logger.log('✗ ' + post.influencer + ' | ' + post.rawDate + ' | ' + e.message);
      logs.push([runTime, '❌ ' + e.message.substring(0, 120), post.influencer]);
      errors++;
    }
  });

  Logger.log('=== Done: updated=' + updated + ' skipped=' + skipped + ' errors=' + errors + ' ===');
  nsWriteLog_(logs);
}


// ── Data loaders ──────────────────────────────────────────────

function nsLoadAmplitude_() {
  var ss  = SpreadsheetApp.openById(NS_AMPLITUDE_SHEET_ID);
  var ws  = ss.getSheetByName('Daily-data') || ss.getSheets()[0];
  var raw = ws.getDataRange().getValues();
  if (raw.length < 2) return [];

  var headers = raw[0].map(function(h) { return nsNorm_(String(h)); });
  var rows    = [];

  for (var i = 1; i < raw.length; i++) {
    var r = {};
    headers.forEach(function(h, j) { r[h] = raw[i][j]; });

    // The sheet has multiple ranges; right-side columns (utm_Campaign/Date/Viewed Landing Page/
    // Accounts Created/Delegations) win on duplicate headers and hold the daily per-influencer data.
    var d = r['Date'] instanceof Date ? r['Date'] : nsParseDate_(r['Date']);
    if (!d) continue;

    var campaign = String(r['utm_Campaign'] || r['utm_campaign'] || '').trim().toLowerCase();
    if (!campaign) continue;

    rows.push({
      utm_campaign: campaign,
      dateStr: nsFmtDate_(d),
      lp:   Number(r['Viewed Landing Page'] || 0),
      acc:  Number(r['Accounts Created']    || 0),
      del:  Number(r['Delegations']         || 0)
    });
  }

  // Deduplicate by utm_campaign+date — Daily-data sheet may contain duplicate rows
  var seen = {}, deduped = [];
  rows.forEach(function(r) {
    var k = r.utm_campaign + '||' + r.dateStr;
    if (!seen[k]) { seen[k] = true; deduped.push(r); }
  });
  return deduped;
}

function nsLoadPosts_() {
  var ss     = SpreadsheetApp.openById(NS_POSTS_SHEET_ID);
  var sheets = ss.getSheets();
  var ws     = sheets[0];
  for (var i = 0; i < sheets.length; i++) {
    if (sheets[i].getSheetId() === NS_POSTS_GID) { ws = sheets[i]; break; }
  }

  var raw     = ws.getDataRange().getValues();
  var headers = raw[0].map(function(h) { return nsNorm_(String(h)); });

  var p = NS_START_DATE.split('-');
  var cutoff = new Date(+p[0], +p[1] - 1, +p[2]); // local midnight, not UTC

  var now = new Date();
  var today = new Date(now.getFullYear(), now.getMonth(), now.getDate()); // today local midnight

  var posts = [];

  for (var i = 1; i < raw.length; i++) {
    var r = {};
    headers.forEach(function(h, j) { r[h] = raw[i][j]; });

    var pd = r['Post date start'] instanceof Date
      ? r['Post date start']
      : new Date(r['Post date start']);
    if (isNaN(pd.getTime()) || pd < cutoff || pd >= today) continue; // skip today and future

    // Page ID — strip any stray non-ASCII characters from the value
    var pageId = String(r['Page ID'] || '').replace(/[^\x00-\x7F\-]/g, '').trim();
    if (!pageId || pageId.toLowerCase() === 'nan') continue;

    posts.push({
      influencer:  String(r['Influencer']                        || ''),
      rawDate:     r['Post date start'],
      postDate:    pd,
      pageId:      pageId,
      ampMatchUrl: String(r['Influencer link Amplitude match']   || ''),
      utmMatchKey: String(r['UTM Match Key']                     || '').toLowerCase().trim(),
      utmRollup:   String(r['Influencer UTM (rollup)']           || '').toLowerCase().replace(/^@/, '').trim(),
      utmRaw:      String(r['Influencer UTM']                    || '').toLowerCase().replace(/^@/, '').trim(),
      igHandle:    String(r['ref_IG Handle']                     || '').toLowerCase().replace(/^@/, '').replace(/^_|_$/g, '').trim()
    });
  }
  return posts;
}

function nsLoadCorrections_() {
  var url = 'https://docs.google.com/spreadsheets/d/' + NS_CORRECTIONS_ID + '/export?format=csv&gid=0';
  var res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) {
    Logger.log('Corrections sheet unavailable (' + res.getResponseCode() + ') — continuing without it');
    return {};
  }
  var rows = Utilities.parseCsv(res.getContentText());
  var map  = {};
  for (var i = 1; i < rows.length; i++) {
    var name = (rows[i][0] || '').trim();
    var key  = (rows[i][1] || '').trim().toLowerCase();
    if (name && key) map[name] = key;
  }
  return map;
}


// ── UTM resolution (4-signal waterfall) ───────────────────────

function nsResolveKey_(post, corrections, amp) {
  // 1. Correction map (highest trust)
  if (corrections[post.influencer]) return corrections[post.influencer];

  // 2a. Explicit UTM Match Key
  if (post.utmMatchKey) return post.utmMatchKey;

  // 2b. URL utm_campaign validated against known Amplitude keys
  var urlKey = nsExtractUtm_(post.ampMatchUrl);
  if (urlKey) {
    for (var i = 0; i < amp.length; i++) {
      if (amp[i].utm_campaign === urlKey) return urlKey;
    }
  }

  // 3. Influencer UTM rollup — fall back to raw UTM when rollup is blank
  var utmKey = post.utmRollup || post.utmRaw;
  if (utmKey) return utmKey;

  // 4. IG Handle
  if (post.igHandle) return post.igHandle;

  return null;
}


// ── Amplitude aggregation ─────────────────────────────────────

function nsSum_(amp, key, dateStr) {
  return nsSumWindow_(amp, key, [dateStr]);
}

// Sums metrics for a key across all dates in the dateStrs array.
function nsSumWindow_(amp, key, dateStrs) {
  var lp = 0, acc = 0, del = 0;
  for (var i = 0; i < amp.length; i++) {
    var r = amp[i];
    if (r.utm_campaign === key && dateStrs.indexOf(r.dateStr) !== -1) {
      lp  += r.lp;
      acc += r.acc;
      del += r.del;
    }
  }
  return { lp: lp, acc: acc, del: del };
}

// dateStrs can be a string (single date) or array of date strings.
function nsSimilarityFallback_(key, amp, dateStrs) {
  if (typeof dateStrs === 'string') dateStrs = [dateStrs];
  var active = {};
  for (var i = 0; i < amp.length; i++) {
    var r = amp[i];
    if (dateStrs.indexOf(r.dateStr) !== -1 && r.lp > 0) {
      active[r.utm_campaign] = true;
    }
  }

  var bestKey = null, bestSim = 0;
  Object.keys(active).forEach(function(candidate) {
    if (candidate === key) return;
    var s = nsStrSim_(key, candidate);
    if (s > bestSim) { bestSim = s; bestKey = candidate; }
  });

  if (bestSim >= 0.75 && bestKey) {
    var m = nsSumWindow_(amp, bestKey, dateStrs);
    if (m.lp > 0) return { key: bestKey, metrics: m };
  }
  return null;
}


// ── Notion writer ─────────────────────────────────────────────

function nsUpdateNotionPage_(pageId, lp, acc, del) {
  var payload = { properties: {} };
  payload.properties[NS_LP_PROP]  = { number: lp };
  payload.properties[NS_ACC_PROP] = { number: acc };
  payload.properties[NS_DEL_PROP] = { number: del };

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

  // Stay under Notion's ~3 req/s rate limit
  Utilities.sleep(350);

  var res  = UrlFetchApp.fetch('https://api.notion.com/v1/pages/' + pageId, opts);
  var code = res.getResponseCode();

  // One retry on 429 (rate-limited) after a 10-second back-off
  if (code === 429) {
    Utilities.sleep(10000);
    res  = UrlFetchApp.fetch('https://api.notion.com/v1/pages/' + pageId, opts);
    code = res.getResponseCode();
  }

  if (code !== 200) {
    throw new Error('HTTP ' + code + ': ' + res.getContentText().substring(0, 300));
  }
}


// ── Log writer ────────────────────────────────────────────────

function nsWriteLog_(logs) {
  if (!logs || logs.length === 0) return;

  try {
    var ss     = SpreadsheetApp.openById(NS_CORRECTIONS_ID);
    var sheets = ss.getSheets();
    var ws     = null;
    for (var i = 0; i < sheets.length; i++) {
      if (sheets[i].getSheetId() === NS_LOG_GID) { ws = sheets[i]; break; }
    }
    if (!ws) ws = ss.getSheetByName(NS_LOG_TAB);
    if (!ws) { Logger.log('Log sheet not found — skipping log write'); return; }

    var headers = ['Date', 'Comment', 'Influencer'];
    if (ws.getLastRow() === 0) ws.appendRow(headers);

    ws.getRange(ws.getLastRow() + 1, 1, logs.length, headers.length).setValues(logs);
    Logger.log('Log written: ' + logs.length + ' rows → ' + NS_LOG_TAB);
  } catch (e) {
    Logger.log('Could not write log: ' + e.message);
  }
}


// ── Helpers ───────────────────────────────────────────────────

function nsParseDate_(val) {
  var s = String(val).trim();
  // Amplitude stores dates as YYYYMMDD (no separators); convert before parsing
  if (/^\d{8}$/.test(s)) s = s.slice(0,4) + '-' + s.slice(4,6) + '-' + s.slice(6,8);
  var d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

function nsExtractUtm_(url) {
  if (!url || !/^https?:\/\//.test(url)) return '';
  var m = url.match(/[?&]utm_campaign=([^&]+)/);
  return m ? decodeURIComponent(m[1]).trim().toLowerCase() : '';
}

function nsNorm_(col) {
  return col
    .replace(/^[^\x00-\x7F]+\s*/, '')
    .replace('Influencer Link Amplitud match', 'Influencer link Amplitude match')
    .trim();
}

function nsStrSim_(a, b) {
  a = a.replace(/[._\-]/g, '').toLowerCase();
  b = b.replace(/[._\-]/g, '').toLowerCase();
  if (a === b) return 1.0;
  var longer  = a.length >= b.length ? a : b;
  var shorter = a.length >= b.length ? b : a;
  if (longer.length === 0) return 1.0;
  return (longer.length - nsEditDist_(longer, shorter)) / longer.length;
}

function nsEditDist_(s1, s2) {
  var dp = [];
  for (var i = 0; i <= s1.length; i++) { dp[i] = [i]; }
  for (var j = 0; j <= s2.length; j++) { dp[0][j] = j; }
  for (var i = 1; i <= s1.length; i++) {
    for (var j = 1; j <= s2.length; j++) {
      dp[i][j] = s1[i-1] === s2[j-1]
        ? dp[i-1][j-1]
        : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
    }
  }
  return dp[s1.length][s2.length];
}

function nsFmtDate_(d) {
  return d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0');
}
