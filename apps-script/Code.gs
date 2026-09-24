/**
 * Annie & Sam's Birthday Treasure Hunt 2026 — backend.
 *
 * Deploy as a Web App: Execute as "Me", Who has access "Anyone".
 * This file is safe to keep in a public repo: every secret (clue text, team
 * paths, QR tokens) lives in the Google Sheet, never in this code.
 *
 * Endpoints (all return JSON):
 *   GET  ?action=ping
 *   GET  ?action=teams                      -> list of team names + captains
 *   GET  ?action=leaderboard                -> crews' progress, finish times, shared clock
 *   GET  ?action=state&team=NAME            -> team's live state + current clue
 *   POST action=join&team=NAME              -> start the team (idempotent)
 *   POST action=checkin&team=NAME&code=TOK  -> scan a location QR
 *   POST action=upload&team=NAME&mimeType=..&fileName=..&data=BASE64
 *
 * POST bodies are application/x-www-form-urlencoded (no CORS preflight).
 */

const SHEETS = {
  TEAMS: '1. Teams',
  PATHS: '2. Team Paths',
  LOCS: '3. Locations',
  APPROVALS: 'Approvals',
  LOG: 'Log',
  CONFIG: 'Config'
};

const STATUS = {
  WAITING: 'Waiting',   // not joined yet
  HUNTING: 'Hunting',   // looking for the current stop
  ARRIVED: 'Arrived',   // scanned the QR at a photo/video stop, upload unlocked
  PENDING: 'Pending',   // upload waiting for approval
  REJECTED: 'Rejected', // upload rejected, can upload again
  FINISHED: 'Finished'
};

const TEAM_COLS = ['Status', 'Current Index', 'Current Location', 'Started At', 'Finished At', 'Last Update', 'Last Cleared At', 'Selfie File ID'];
const LOC_COLS = ['QR Required', 'QR Token', 'Task Text', 'Check-in URL', 'QR Code'];
const APPROVAL_HEADERS = ['Submitted', 'Team', 'Stop #', 'Location', 'Kind', 'File', 'Preview', 'Status', 'Note to team', 'Decided', 'Upload ID'];
const MEDIA_TYPES = ['photo', 'video'];
const UPLOAD_TYPES = ['photo', 'video', 'end']; // 'end' = the crew selfie at the final stop
const DEFAULT_PAGES_URL = 'https://sdhubj.github.io/Annie-Sam-Treasure-Hunt-2026/';
const CACHE_SECONDS = 120;

/* ------------------------------------------------------------------ */
/* HTTP entry points                                                   */
/* ------------------------------------------------------------------ */

function doGet(e) { return handle_(e, false); }
function doPost(e) { return handle_(e, true); }

function handle_(e, isPost) {
  let out;
  try {
    const p = (e && e.parameter) || {};
    const action = String(p.action || 'ping');
    const writes = ['join', 'checkin', 'upload'];
    if (writes.indexOf(action) !== -1 && !isPost) throw userErr_('Use POST for ' + action + '.');

    switch (action) {
      case 'ping':    out = { ok: true, message: 'Treasure hunt API is running.' }; break;
      case 'teams':   out = { ok: true, teams: listTeams_(), captains: captains_() }; break;
      case 'leaderboard': out = leaderboard_(); break;
      case 'state':   out = getState_(p.team); break;
      case 'join':    out = join_(p.team); break;
      case 'checkin': out = checkin_(p.team, p.code); break;
      case 'upload':  out = upload_(p); break;
      default:        out = { ok: false, error: 'Unknown action.' };
    }
  } catch (err) {
    const friendly = err && err.userMessage;
    out = { ok: false, error: friendly || 'Something went wrong on our side. Try again in a moment.' };
    if (!friendly) {
      try { logRow_('', 'error', String((err && err.stack) || err)); } catch (ignored) {}
    }
  }
  return ContentService.createTextOutput(JSON.stringify(out))
    .setMimeType(ContentService.MimeType.JSON);
}

function userErr_(msg) {
  const e = new Error(msg);
  e.userMessage = msg;
  return e;
}

/* ------------------------------------------------------------------ */
/* Actions                                                             */
/* ------------------------------------------------------------------ */

function join_(team) {
  return withLock_(function () {
    const t = requireTeam_(team);
    if (t.get('Status') === STATUS.WAITING || !t.get('Status')) {
      const path = requirePath_(t.name);
      t.set({
        'Status': STATUS.HUNTING,
        'Current Index': 0,
        'Current Location': path[0],
        'Started At': new Date(),
        'Last Update': new Date()
      });
      logRow_(t.name, 'join', 'Started hunt');
    }
    return buildState_(t);
  });
}

function getState_(team) {
  const t = requireTeam_(team);
  const st = t.get('Status');
  if (st === STATUS.PENDING || st === STATUS.REJECTED) {
    resolvePending_(t.name);
    CacheService.getScriptCache().remove('leaderboard');
  }
  return buildState_(requireTeam_(team));
}

function checkin_(team, code) {
  const loc = locationByToken_(code);
  if (!loc) throw userErr_("That code doesn't match anything. Keep hunting.");

  return withLock_(function () {
    const t = requireTeam_(team);
    const status = t.get('Status');
    if (!status || status === STATUS.WAITING) throw userErr_('Join your team first.');
    if (status === STATUS.FINISHED) {
      return withMessage_(buildState_(t), "You've already finished. Get to the bar.");
    }

    const path = requirePath_(t.name);
    const idx = t.index();
    const expected = path[idx];

    if (norm_(expected) !== norm_(loc.name)) {
      const earlier = path.slice(0, idx).map(norm_);
      if (earlier.indexOf(norm_(loc.name)) !== -1) {
        return withMessage_(buildState_(t), 'Already cleared. Your current clue is below.');
      }
      logRow_(t.name, 'wrong-checkin', loc.name + ' (expected ' + expected + ')');
      throw userErr_("Not your stop. Not yet, anyway. Keep hunting.");
    }

    if (!loc.qr) {
      return withMessage_(buildState_(t), 'No scan needed here. Upload your proof below.');
    }

    if (loc.type === 'end') {
      const done = { 'Status': STATUS.FINISHED, 'Last Update': new Date() };
      if (!(t.get('Finished At') instanceof Date)) done['Finished At'] = new Date();
      t.set(done);
      logRow_(t.name, 'finish', loc.name);
      return withMessage_(buildState_(t), 'You made it.', loc.name);
    }

    if (loc.type === 'answer') {
      advance_(t, path);
      logRow_(t.name, 'checkin', loc.name);
      return withMessage_(buildState_(requireTeam_(team)), 'Cleared: ' + loc.name, loc.name);
    }

    // Photo/video stop that needs a scan first: unlock the upload.
    if (status === STATUS.HUNTING) {
      t.set({ 'Status': STATUS.ARRIVED, 'Last Update': new Date() });
      logRow_(t.name, 'arrived', loc.name);
    }
    return withMessage_(buildState_(requireTeam_(team)), loc.task ? 'Found it. Your task is below.' : 'Found it. Upload your proof below.');
  });
}

function upload_(p) {
  const cfg = config_();
  const t = requireTeam_(p.team);
  const path = requirePath_(t.name);
  const idx = t.index();
  const loc = requireLocation_(path[idx]);

  if (!canUpload_(loc, t.get('Status'))) {
    throw userErr_(t.get('Status') === STATUS.PENDING
      ? 'Already sent. Waiting for the judges.'
      : 'No upload needed right now.');
  }

  const mime = String(p.mimeType || '');
  const wantsVideo = loc.type === 'video';
  if (wantsVideo && mime.indexOf('video/') !== 0) throw userErr_('This one needs a video.');
  if (!wantsVideo && mime.indexOf('image/') !== 0) throw userErr_(loc.type === 'end' ? 'This one needs a crew selfie (a photo).' : 'This one needs a photo.');
  const data = String(p.data || '');
  if (!data) throw userErr_('The file arrived empty. Try again.');

  const maxMb = Number(cfg.MAX_UPLOAD_MB) || 30;
  const approxBytes = Math.floor(data.length * 3 / 4);
  if (approxBytes > maxMb * 1024 * 1024) {
    throw userErr_('That file is too big. Record something shorter and try again.');
  }

  const kind = mime.indexOf('video/') === 0 ? 'video' : 'photo';
  const ext = extensionFor_(mime, p.fileName);
  const stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'HHmmss');
  const fileName = t.name + ' - Stop ' + (idx + 1) + ' - ' + loc.name + ' - ' + stamp + '.' + ext;

  const blob = Utilities.newBlob(Utilities.base64Decode(data), mime, fileName);
  const folder = teamFolder_(cfg, t.name);
  const file = folder.createFile(blob);

  if (String(cfg.PUBLIC_PREVIEWS).toUpperCase() === 'TRUE') {
    try { file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW); } catch (ignored) {}
  }

  const uploadId = Utilities.getUuid().slice(0, 8);
  const url = file.getUrl();
  const preview = kind === 'photo'
    ? '=IMAGE("https://drive.google.com/thumbnail?id=' + file.getId() + '&sz=w400")'
    : '=HYPERLINK("' + url + '","Play video")';

  const result = withLock_(function () {
    const fresh = requireTeam_(p.team);
    if (fresh.index() !== idx) throw userErr_('Your team has already moved on. Refresh.');

    const sh = sheet_(SHEETS.APPROVALS);
    sh.appendRow([new Date(), t.name, idx + 1, loc.name, kind, '=HYPERLINK("' + url + '","Open")',
      preview, 'Pending', '', '', uploadId]);
    if (kind === 'photo') sh.setRowHeight(sh.getLastRow(), 140);

    const patch = { 'Status': STATUS.PENDING, 'Last Update': new Date() };
    if (loc.type === 'end') {
      // The clock stops when the selfie lands, not when it is approved. A retake keeps the first time.
      if (!(fresh.get('Finished At') instanceof Date)) patch['Finished At'] = new Date();
      patch['Selfie File ID'] = file.getId();
    }
    fresh.set(patch);
    logRow_(t.name, 'upload', loc.name + ' (' + kind + ', ' + uploadId + ')');
    CacheService.getScriptCache().remove('leaderboard');
    return withMessage_(buildState_(requireTeam_(p.team)),
      loc.type === 'end' ? 'Clock stopped. The judges are checking your selfie.' : 'Sent. Waiting for the judges.');
  });

  notify_(cfg, t.name, idx + 1, loc.name, loc.type === 'end' ? 'crew selfie (FINISH)' : kind, url);
  return result;
}

/* ------------------------------------------------------------------ */
/* State                                                               */
/* ------------------------------------------------------------------ */

function buildState_(t) {
  const path = requirePath_(t.name);
  const total = path.length;
  const status = t.get('Status') || STATUS.WAITING;
  const start = huntStart_();
  const base = { ok: true, team: t.name, total: total, status: status,
    serverNow: new Date().toISOString(), huntStart: start ? start.toISOString() : null };
  const fin = t.get('Finished At');
  if (fin instanceof Date) {
    base.finishedAt = fin.toISOString();
    base.elapsedMs = start ? Math.max(0, fin.getTime() - start.getTime()) : null;
    base.place = finishPlace_(t.name);
  }
  const selfie = String(t.get('Selfie File ID') || '');
  if (selfie) base.selfieUrl = 'https://drive.google.com/thumbnail?id=' + selfie + '&sz=w900';

  if (status === STATUS.WAITING) {
    base.index = 0;
    return base;
  }

  if (status === STATUS.FINISHED) {
    base.index = total;
    base.finished = true;
    return base;
  }

  const idx = t.index();
  const loc = requireLocation_(path[idx]);
  const media = UPLOAD_TYPES.indexOf(loc.type) !== -1;
  const unlocked = !loc.qr || status !== STATUS.HUNTING;

  base.index = idx;
  base.stop = {
    number: idx + 1,
    isFinal: idx === total - 1,
    type: loc.type,
    clue: loc.clue,
    needsScan: loc.qr && status === STATUS.HUNTING,
    task: media && unlocked ? loc.task : '',
    canUpload: canUpload_(loc, status),
    mediaKind: loc.type
  };

  if (status === STATUS.REJECTED) {
    const a = latestApproval_(t.name, idx + 1);
    base.rejectionNote = (a && a.note) || '';
  }
  return base;
}

function canUpload_(loc, status) {
  if (UPLOAD_TYPES.indexOf(loc.type) === -1) return false;
  if (status === STATUS.REJECTED) return true;
  if (loc.qr) return status === STATUS.ARRIVED;
  return status === STATUS.HUNTING;
}

/** Called on every poll while a team is Pending or Rejected: applies your dropdown decision.
 *  Changing a Rejected row to Approved later also moves the team on. */
function resolvePending_(teamName) {
  const t0 = requireTeam_(teamName);
  const a0 = latestApproval_(t0.name, t0.index() + 1);
  if (!a0 || a0.status === 'Pending') return;

  withLock_(function () {
    const t = requireTeam_(teamName);
    const current = t.get('Status');
    if (current !== STATUS.PENDING && current !== STATUS.REJECTED) return;
    const a = latestApproval_(t.name, t.index() + 1);
    if (!a) return;
    const stopNo = t.index() + 1;
    const path = requirePath_(t.name);
    const loc = requireLocation_(path[t.index()]);
    if (a.status === 'Approved' && loc.type === 'end') {
      t.set({ 'Status': STATUS.FINISHED, 'Last Update': new Date() });
      stampDecision_(a.row);
      logRow_(t.name, 'finish', 'Selfie approved');
    } else if (a.status === 'Approved') {
      advance_(t, path);
      stampDecision_(a.row);
      logRow_(t.name, 'approved', 'Stop ' + stopNo);
    } else if (a.status === 'Rejected' && current === STATUS.PENDING) {
      t.set({ 'Status': STATUS.REJECTED, 'Last Update': new Date() });
      stampDecision_(a.row);
      logRow_(t.name, 'rejected', 'Stop ' + stopNo);
    }
  });
}

function advance_(t, path) {
  const next = t.index() + 1;
  t.set({
    'Status': STATUS.HUNTING,
    'Current Index': next,
    'Current Location': path[next] || '',
    'Last Update': new Date(),
    'Last Cleared At': new Date()
  });
}

/** Any Approved row wins; otherwise the most recent row decides. */
function latestApproval_(teamName, stopNo) {
  const sh = sheet_(SHEETS.APPROVALS);
  const vals = sh.getDataRange().getValues();
  const h = indexHeaders_(vals[0]);
  let latest = null;
  for (let i = 1; i < vals.length; i++) {
    const r = vals[i];
    if (norm_(r[h['Team']]) !== norm_(teamName) || Number(r[h['Stop #']]) !== stopNo) continue;
    const row = { row: i + 1, status: String(r[h['Status']] || 'Pending').trim(), note: String(r[h['Note to team']] || '') };
    if (row.status === 'Approved') return row;
    latest = row;
  }
  return latest;
}

function stampDecision_(row) {
  const sh = sheet_(SHEETS.APPROVALS);
  const col = APPROVAL_HEADERS.indexOf('Decided') + 1;
  if (!sh.getRange(row, col).getValue()) sh.getRange(row, col).setValue(new Date());
}

function finishPlace_(teamName) {
  const sh = sheet_(SHEETS.TEAMS);
  const vals = sh.getDataRange().getValues();
  const h = indexHeaders_(vals[0]);
  let mine = null;
  const times = [];
  for (let i = 1; i < vals.length; i++) {
    const f = vals[i][h['Finished At']];
    if (!(f instanceof Date)) continue;
    times.push(f.getTime());
    if (norm_(vals[i][h['Team Name']]) === norm_(teamName)) mine = f.getTime();
  }
  if (mine === null) return null;
  return times.filter(function (x) { return x < mine; }).length + 1;
}

function withMessage_(state, message, cleared) {
  state.message = message;
  if (cleared) state.cleared = cleared;
  return state;
}

/* ------------------------------------------------------------------ */
/* Sheet access                                                        */
/* ------------------------------------------------------------------ */

function ss_() { return SpreadsheetApp.getActiveSpreadsheet(); }

function sheet_(name) {
  const s = ss_().getSheetByName(name);
  if (!s) throw new Error('Missing sheet tab: ' + name);
  return s;
}

function norm_(s) { return String(s == null ? '' : s).trim().toUpperCase(); }

function indexHeaders_(row) {
  const m = {};
  row.forEach(function (v, i) { if (v !== '' && m[String(v).trim()] === undefined) m[String(v).trim()] = i; });
  return m;
}

/** Finds a header by exact name, or by prefix (e.g. "Clue Text"). */
function findCol_(h, name) {
  if (h[name] !== undefined) return h[name];
  const key = Object.keys(h).filter(function (k) { return k.toUpperCase().indexOf(name.toUpperCase()) === 0; })[0];
  return key === undefined ? -1 : h[key];
}

function listTeams_() {
  const vals = sheet_(SHEETS.TEAMS).getDataRange().getValues();
  const col = indexHeaders_(vals[0])['Team Name'];
  return vals.slice(1).map(function (r) { return String(r[col] || '').trim(); }).filter(String);
}

function requireTeam_(team) {
  if (!team) throw userErr_('Pick your team first.');
  const sh = sheet_(SHEETS.TEAMS);
  const vals = sh.getDataRange().getValues();
  const h = indexHeaders_(vals[0]);
  for (let i = 1; i < vals.length; i++) {
    if (norm_(vals[i][h['Team Name']]) !== norm_(team)) continue;
    const rowNum = i + 1;
    const data = vals[i];
    return {
      name: String(data[h['Team Name']]).trim(),
      get: function (col) { return h[col] === undefined ? '' : data[h[col]]; },
      index: function () { return Number(data[h['Current Index']]) || 0; },
      set: function (patch) {
        Object.keys(patch).forEach(function (col) {
          if (h[col] === undefined) throw new Error('Teams sheet is missing column: ' + col + '. Run setup().');
          sh.getRange(rowNum, h[col] + 1).setValue(patch[col]);
          data[h[col]] = patch[col];
        });
      }
    };
  }
  throw userErr_("We don't know that team. Go back to the start page and pick again.");
}

function paths_() {
  return cached_('paths', function () {
    const vals = sheet_(SHEETS.PATHS).getDataRange().getValues();
    const out = {};
    for (let i = 1; i < vals.length; i++) {
      const r = vals[i];
      const team = norm_(r[0]);
      // Skip blank rows and the numeric helper grid further down the tab.
      if (!team || out[team] || typeof r[1] !== 'string' || !r[1].trim()) continue;
      const stops = r.slice(1, 9).map(function (s) { return String(s).trim(); }).filter(String);
      out[team] = stops;
    }
    return out;
  });
}

function requirePath_(teamName) {
  const p = paths_()[norm_(teamName)];
  if (!p || !p.length) throw new Error('No path found for team ' + teamName);
  return p;
}

function locations_() {
  return cached_('locs', function () {
    const vals = sheet_(SHEETS.LOCS).getDataRange().getValues();
    const h = indexHeaders_(vals[0]);
    const c = {
      name: findCol_(h, 'Location Name'),
      clue: findCol_(h, 'Clue Text'),
      type: findCol_(h, 'Validation Type'),
      qr: findCol_(h, 'QR Required'),
      token: findCol_(h, 'QR Token'),
      task: findCol_(h, 'Task Text')
    };
    const out = {};
    vals.slice(1).forEach(function (r) {
      const name = String(r[c.name] || '').trim();
      if (!name) return;
      out[norm_(name)] = {
        name: name,
        clue: String(r[c.clue] || ''),
        type: String(r[c.type] || 'answer').trim().toLowerCase(),
        qr: c.qr !== -1 && norm_(r[c.qr]) === 'YES',
        token: c.token !== -1 ? String(r[c.token] || '').trim() : '',
        task: c.task !== -1 ? String(r[c.task] || '') : ''
      };
    });
    return out;
  });
}

function requireLocation_(name) {
  const l = locations_()[norm_(name)];
  if (!l) throw new Error('Location not found in Locations tab: ' + name);
  return l;
}

function locationByToken_(code) {
  const c = String(code || '').trim();
  if (!c) return null;
  const all = locations_();
  const key = Object.keys(all).filter(function (k) { return all[k].token && all[k].token === c; })[0];
  return key ? all[key] : null;
}

function config_() {
  return cached_('config', function () {
    const vals = sheet_(SHEETS.CONFIG).getDataRange().getValues();
    const cfg = {};
    vals.slice(1).forEach(function (r) { if (r[0]) cfg[String(r[0]).trim()] = r[1]; });
    return cfg;
  });
}

function cached_(key, fn) {
  const cache = CacheService.getScriptCache();
  const hit = cache.get(key);
  if (hit) return JSON.parse(hit);
  const val = fn();
  cache.put(key, JSON.stringify(val), CACHE_SECONDS);
  return val;
}

function clearCache() {
  CacheService.getScriptCache().removeAll(['paths', 'locs', 'config']);
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try { return fn(); } finally { lock.releaseLock(); }
}

function logRow_(team, action, detail) {
  const sh = ss_().getSheetByName(SHEETS.LOG);
  if (sh) sh.appendRow([new Date(), team, action, detail]);
}

/* ------------------------------------------------------------------ */
/* Drive + email                                                       */
/* ------------------------------------------------------------------ */

function teamFolder_(cfg, teamName) {
  const root = DriveApp.getFolderById(String(cfg.DRIVE_FOLDER_ID));
  const it = root.getFoldersByName(teamName);
  return it.hasNext() ? it.next() : root.createFolder(teamName);
}

function extensionFor_(mime, fileName) {
  const fromName = String(fileName || '').split('.').pop();
  if (fromName && fromName.length <= 5 && fromName !== fileName) return fromName.toLowerCase();
  const map = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/heic': 'heic', 'image/webp': 'webp',
    'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm' };
  return map[mime] || 'bin';
}

function notify_(cfg, team, stopNo, locName, kind, url) {
  const to = String(cfg.NOTIFY_EMAIL || '').trim();
  if (!to) return;
  try {
    const sheetUrl = ss_().getUrl() + '#gid=' + sheet_(SHEETS.APPROVALS).getSheetId();
    MailApp.sendEmail({
      to: to,
      subject: '[Hunt] ' + team + ' sent a ' + kind + ' — stop ' + stopNo + ' (' + locName + ')',
      htmlBody: '<p><b>' + team + '</b> uploaded a ' + kind + ' for stop ' + stopNo + ' (' + locName + ').</p>' +
        '<p><a href="' + url + '">Open the ' + kind + '</a></p>' +
        '<p><a href="' + sheetUrl + '">Approve or reject in the Approvals tab</a></p>'
    });
  } catch (err) {
    logRow_(team, 'email-failed', String(err));
  }
}

/* ------------------------------------------------------------------ */
/* One-time setup and admin tools (run from the editor or the menu)    */
/* ------------------------------------------------------------------ */

function onOpen() {
  SpreadsheetApp.getUi().createMenu('Treasure Hunt')
    .addItem('Run setup (safe to re-run)', 'setup')
    .addItem('Refresh QR links', 'refreshQrLinks')
    .addItem('Apply stop settings (v2: selfie finish)', 'applyStopSettings')
    .addItem('Clear cache (after editing clues/paths)', 'clearCache')
    .addSeparator()
    .addItem('Reset ALL progress (testing only)', 'resetAllProgressWithConfirm')
    .addToUi();
}

function setup() {
  const ss = ss_();
  [SHEETS.TEAMS, SHEETS.PATHS, SHEETS.LOCS].forEach(function (n) {
    if (!ss.getSheetByName(n)) throw new Error('Tab "' + n + '" not found. Keep the original tab names from the workbook.');
  });

  // Config tab
  let cfgSheet = ss.getSheetByName(SHEETS.CONFIG);
  if (!cfgSheet) cfgSheet = ss.insertSheet(SHEETS.CONFIG);
  const defaults = [
    ['Key', 'Value', 'What it does'],
    ['PAGES_BASE_URL', DEFAULT_PAGES_URL, 'Your GitHub Pages address, ending in /. QR links are built from this.'],
    ['DRIVE_FOLDER_ID', '', 'Drive folder for uploads. Created automatically by setup.'],
    ['NOTIFY_EMAIL', Session.getEffectiveUser().getEmail(), 'Gets an email for every upload. Leave blank to switch off.'],
    ['MAX_UPLOAD_MB', 30, 'Largest upload accepted (raw file size). Keep at 30 or below.'],
    ['PUBLIC_PREVIEWS', 'TRUE', 'TRUE = uploads are viewable by link, so photo previews show in the Approvals tab.'],
    ['START_QR', '', 'Print this for Pub on the Park. It opens the join page.']
  ];
  const existing = cfgSheet.getDataRange().getValues();
  const have = {};
  existing.forEach(function (r) { if (r[0]) have[String(r[0]).trim()] = true; });
  if (!have['Key']) cfgSheet.getRange(1, 1, 1, 3).setValues([defaults[0]]).setFontWeight('bold');
  defaults.slice(1).forEach(function (r) { if (!have[r[0]]) cfgSheet.appendRow(r); });
  cfgSheet.setColumnWidth(1, 170); cfgSheet.setColumnWidth(2, 360); cfgSheet.setColumnWidth(3, 420);
  clearCache();

  let cfg = config_();
  if (!cfg.DRIVE_FOLDER_ID) {
    const folder = DriveApp.createFolder("Annie & Sam's Treasure Hunt 2026 — Uploads");
    setConfig_('DRIVE_FOLDER_ID', folder.getId());
  }

  // Teams tab
  const teams = sheet_(SHEETS.TEAMS);
  ensureHeaders_(teams, TEAM_COLS);
  const tv = teams.getDataRange().getValues();
  const th = indexHeaders_(tv[0]);
  for (let i = 1; i < tv.length; i++) {
    if (!String(tv[i][th['Team Name']] || '').trim()) continue;
    if (!tv[i][th['Status']]) teams.getRange(i + 1, th['Status'] + 1).setValue(STATUS.WAITING);
    if (tv[i][th['Current Index']] === '') teams.getRange(i + 1, th['Current Index'] + 1).setValue(0);
  }

  // Locations tab
  const locs = sheet_(SHEETS.LOCS);
  ensureHeaders_(locs, LOC_COLS);
  const lv = locs.getDataRange().getValues();
  const lh = indexHeaders_(lv[0]);
  const nameCol = findCol_(lh, 'Location Name');
  const typeCol = findCol_(lh, 'Validation Type');
  for (let i = 1; i < lv.length; i++) {
    const name = String(lv[i][nameCol] || '').trim();
    if (!name) continue;
    const row = i + 1;
    let type = String(lv[i][typeCol] || '').trim().toLowerCase();
    if (!type) { type = 'answer'; }
    locs.getRange(row, typeCol + 1).setValue(type);

    if (!lv[i][lh['QR Required']]) {
      const needsQr = type === 'answer' || /basketball|saint monday/i.test(name);
      locs.getRange(row, lh['QR Required'] + 1).setValue(needsQr ? 'YES' : 'NO');
    }
    if (!lv[i][lh['Task Text']] && /basketball/i.test(name)) {
      locs.getRange(row, lh['Task Text'] + 1).setValue(
        'Drop it like the billboard 100.\nGet everyone in the band and send a pic for your next clue.');
    }
    if (!lv[i][lh['QR Token']]) {
      locs.getRange(row, lh['QR Token'] + 1).setValue(newToken_());
    }
  }
  locs.getRange(2, findCol_(lh, 'Clue Text') + 1, Math.max(lv.length - 1, 1), 1).setWrap(true);

  // Approvals tab
  let ap = ss.getSheetByName(SHEETS.APPROVALS);
  if (!ap) ap = ss.insertSheet(SHEETS.APPROVALS);
  ap.getRange(1, 1, 1, APPROVAL_HEADERS.length).setValues([APPROVAL_HEADERS]).setFontWeight('bold');
  ap.setFrozenRows(1);
  ap.setColumnWidth(APPROVAL_HEADERS.indexOf('Preview') + 1, 220);
  const statusCol = APPROVAL_HEADERS.indexOf('Status') + 1;
  const statusRange = ap.getRange(2, statusCol, 999, 1);
  statusRange.setDataValidation(SpreadsheetApp.newDataValidation()
    .requireValueInList(['Pending', 'Approved', 'Rejected'], true).setAllowInvalid(false).build());
  ap.setConditionalFormatRules([
    SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('Pending').setBackground('#fde68a').setRanges([statusRange]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('Approved').setBackground('#bbf7d0').setRanges([statusRange]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('Rejected').setBackground('#fecdd3').setRanges([statusRange]).build()
  ]);

  // Log tab
  let lg = ss.getSheetByName(SHEETS.LOG);
  if (!lg) lg = ss.insertSheet(SHEETS.LOG);
  lg.getRange(1, 1, 1, 4).setValues([['Time', 'Team', 'Action', 'Detail']]).setFontWeight('bold');
  lg.setFrozenRows(1);

  clearCache();
  refreshQrLinks();
  const problems = validatePaths_();
  const msg = problems.length ? 'Setup done, but check these:\n' + problems.join('\n') : 'Setup done. Paths and locations check out.';
  console.log(msg);
  return msg;
}

function refreshQrLinks() {
  clearCache();
  const cfg = config_();
  let base = String(cfg.PAGES_BASE_URL || DEFAULT_PAGES_URL).trim();
  if (base.slice(-1) !== '/') base += '/';

  const locs = sheet_(SHEETS.LOCS);
  const lv = locs.getDataRange().getValues();
  const lh = indexHeaders_(lv[0]);
  for (let i = 1; i < lv.length; i++) {
    const token = String(lv[i][lh['QR Token']] || '').trim();
    const needsQr = norm_(lv[i][lh['QR Required']]) === 'YES';
    const url = token && needsQr ? base + 'checkin.html?c=' + encodeURIComponent(token) : '';
    locs.getRange(i + 1, lh['Check-in URL'] + 1).setValue(url || (needsQr ? '' : 'No QR needed'));
    locs.getRange(i + 1, lh['QR Code'] + 1).setFormula(url ? qrFormula_(url) : '');
    if (url) locs.setRowHeight(i + 1, 160);
  }
  locs.setColumnWidth(lh['QR Code'] + 1, 170);

  const cfgSheet = sheet_(SHEETS.CONFIG);
  const cv = cfgSheet.getDataRange().getValues();
  for (let i = 1; i < cv.length; i++) {
    if (String(cv[i][0]).trim() === 'START_QR') {
      cfgSheet.getRange(i + 1, 2).setFormula(qrFormula_(base));
      cfgSheet.setRowHeight(i + 1, 160);
    }
  }
  clearCache();
}

function resetAllProgressWithConfirm() {
  const ui = SpreadsheetApp.getUi();
  const r = ui.alert('Reset all progress?', 'Every team goes back to the start and the Approvals and Log tabs are cleared. Uploaded files stay in Drive.', ui.ButtonSet.YES_NO);
  if (r === ui.Button.YES) resetAllProgress();
}

function resetAllProgress() {
  withLock_(function () {
    const teams = sheet_(SHEETS.TEAMS);
    const tv = teams.getDataRange().getValues();
    const th = indexHeaders_(tv[0]);
    for (let i = 1; i < tv.length; i++) {
      if (!String(tv[i][th['Team Name']] || '').trim()) continue;
      const row = i + 1;
      teams.getRange(row, th['Status'] + 1).setValue(STATUS.WAITING);
      teams.getRange(row, th['Current Index'] + 1).setValue(0);
      ['Current Location', 'Started At', 'Finished At', 'Last Update', 'Last Cleared At', 'Selfie File ID'].forEach(function (c) {
        if (th[c] === undefined) return;
        teams.getRange(row, th[c] + 1).setValue('');
      });
    }
    [SHEETS.APPROVALS, SHEETS.LOG].forEach(function (n) {
      const sh = ss_().getSheetByName(n);
      if (sh && sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, sh.getLastColumn()).clearContent();
    });
  });
  clearCache();
}

function ensureHeaders_(sh, cols) {
  const lastCol = Math.max(sh.getLastColumn(), 1);
  const header = sh.getRange(1, 1, 1, lastCol).getValues()[0].map(function (v) { return String(v).trim(); });
  let next = lastCol + 1;
  // Ignore trailing empty header cells when appending.
  while (next > 1 && header[next - 2] === '') next--;
  cols.forEach(function (c) {
    if (header.indexOf(c) === -1) {
      sh.getRange(1, next).setValue(c).setFontWeight('bold');
      header[next - 1] = c;
      next++;
    }
  });
}

function setConfig_(key, value) {
  const sh = sheet_(SHEETS.CONFIG);
  const vals = sh.getDataRange().getValues();
  for (let i = 1; i < vals.length; i++) {
    if (String(vals[i][0]).trim() === key) { sh.getRange(i + 1, 2).setValue(value); clearCache(); return; }
  }
  sh.appendRow([key, value, '']);
  clearCache();
}

function newToken_() {
  return Utilities.getUuid().replace(/-/g, '').slice(0, 10);
}

function qrFormula_(url) {
  return '=IMAGE("https://api.qrserver.com/v1/create-qr-code/?size=400x400&margin=10&data=' + encodeURIComponent(url) + '")';
}

function validatePaths_() {
  const problems = [];
  const locs = locations_();
  const paths = paths_();
  listTeams_().forEach(function (team) {
    const p = paths[norm_(team)];
    if (!p) { problems.push('No path for ' + team); return; }
    p.forEach(function (stop) {
      if (!locs[norm_(stop)]) problems.push(team + ': "' + stop + '" is not in the Locations tab');
    });
    const last = locs[norm_(p[p.length - 1])];
    if (last && last.type !== 'end') problems.push(team + ': last stop is not the "end" location');
  });
  return problems;
}

/* ------------------------------------------------------------------ */
/* Leaderboard and shared clock                                        */
/* ------------------------------------------------------------------ */

/** The shared clock starts when the first crew taps Start hunting. */
function huntStart_() {
  const vals = sheet_(SHEETS.TEAMS).getDataRange().getValues();
  const h = indexHeaders_(vals[0]);
  let min = null;
  for (let i = 1; i < vals.length; i++) {
    const v = vals[i][h['Started At']];
    if (v instanceof Date && (min === null || v < min)) min = v;
  }
  return min;
}

function captains_() {
  const vals = sheet_(SHEETS.TEAMS).getDataRange().getValues();
  const h = indexHeaders_(vals[0]);
  const out = {};
  if (h['Captain'] === undefined) return out;
  for (let i = 1; i < vals.length; i++) {
    const name = String(vals[i][h['Team Name']] || '').trim();
    if (name) out[name] = String(vals[i][h['Captain']] || '').trim();
  }
  return out;
}

function leaderboard_() {
  const cache = CacheService.getScriptCache();
  const hit = cache.get('leaderboard');
  if (hit) {
    const data = JSON.parse(hit);
    data.serverNow = new Date().toISOString();
    return data;
  }
  const vals = sheet_(SHEETS.TEAMS).getDataRange().getValues();
  const h = indexHeaders_(vals[0]);
  const paths = paths_();
  const start = huntStart_();
  const rows = [];
  for (let i = 1; i < vals.length; i++) {
    const r = vals[i];
    const name = String(r[h['Team Name']] || '').trim();
    if (!name) continue;
    const path = paths[norm_(name)] || [];
    const status = String(r[h['Status']] || STATUS.WAITING);
    const fin = r[h['Finished At']];
    const lastCleared = h['Last Cleared At'] !== undefined ? r[h['Last Cleared At']] : '';
    const idx = Number(r[h['Current Index']]) || 0;
    const finishedAt = fin instanceof Date ? fin : null;
    rows.push({
      team: name,
      total: path.length,
      cleared: finishedAt ? path.length : (status === STATUS.WAITING ? 0 : idx),
      status: status,
      finished: status === STATUS.FINISHED,
      checking: !!finishedAt && status !== STATUS.FINISHED,
      finishedAt: finishedAt ? finishedAt.toISOString() : null,
      elapsedMs: finishedAt && start ? Math.max(0, finishedAt.getTime() - start.getTime()) : null,
      _last: lastCleared instanceof Date ? lastCleared.getTime() : Number.MAX_SAFE_INTEGER
    });
  }
  rows.sort(function (a, b) {
    if (a.finishedAt && b.finishedAt) return a.finishedAt < b.finishedAt ? -1 : 1;
    if (a.finishedAt) return -1;
    if (b.finishedAt) return 1;
    if (b.cleared !== a.cleared) return b.cleared - a.cleared;
    return a._last - b._last; // same count: whoever got there first ranks higher
  });
  rows.forEach(function (r, i) { r.rank = i + 1; delete r._last; });
  const out = { ok: true, huntStart: start ? start.toISOString() : null, serverNow: new Date().toISOString(), teams: rows };
  cache.put('leaderboard', JSON.stringify(out), 10);
  return out;
}

/* ------------------------------------------------------------------ */
/* v2 stop settings: run once from the Treasure Hunt menu              */
/* ------------------------------------------------------------------ */

/**
 * Album cover (Basketball Court) = photo, bubblegum (So Local) = video,
 * Saint Monday = the bartender's QR clears it,
 * The Perseverance = crew selfie finish (no QR).
 */
function applyStopSettings() {
  const locs = sheet_(SHEETS.LOCS);
  ensureHeaders_(locs, LOC_COLS);
  ensureHeaders_(sheet_(SHEETS.TEAMS), TEAM_COLS);
  const lv = locs.getDataRange().getValues();
  const lh = indexHeaders_(lv[0]);
  const nameCol = findCol_(lh, 'Location Name');
  const typeCol = findCol_(lh, 'Validation Type');
  const rules = [
    { match: /so local/i, type: 'video', qr: 'NO' },
    { match: /basketball/i, type: 'photo', qr: 'YES' },
    { match: /saint monday/i, type: 'answer', qr: 'YES' },
    { match: /perseverance/i, type: 'end', qr: 'NO',
      task: 'One selfie. Whole crew in it. Banana hat on the captain.\nThe clock stops when it lands.' }
  ];
  for (let i = 1; i < lv.length; i++) {
    const name = String(lv[i][nameCol] || '');
    const rule = rules.filter(function (r) { return r.match.test(name); })[0];
    if (!rule) continue;
    locs.getRange(i + 1, typeCol + 1).setValue(rule.type);
    locs.getRange(i + 1, lh['QR Required'] + 1).setValue(rule.qr);
    if (rule.task) locs.getRange(i + 1, lh['Task Text'] + 1).setValue(rule.task);
    if (!lv[i][lh['QR Token']]) locs.getRange(i + 1, lh['QR Token'] + 1).setValue(newToken_());
  }
  refreshQrLinks();
  clearCache();
  CacheService.getScriptCache().remove('leaderboard');
  const problems = validatePaths_();
  const msg = problems.length ? 'Applied, but check: ' + problems.join('; ') : 'Stop settings applied.';
  console.log(msg);
  return msg;
}
