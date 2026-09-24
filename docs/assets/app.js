/* Shared helpers for the treasure hunt pages. */
(function () {
  const cfg = window.HUNT_CONFIG || {};
  const TEAM_KEY = 'hunt2026.team';
  const PENDING_CODE_KEY = 'hunt2026.pendingCode';
  const FLASH_KEY = 'hunt2026.flash';
  const SWITCH_KEY = 'hunt2026.switchesUsed';
  const MAX_SWITCHES = 1;

  function apiReady() {
    return cfg.API_URL && cfg.API_URL.indexOf('PASTE_') !== 0;
  }

  async function parse(res) {
    let data;
    try { data = await res.json(); } catch (e) { throw new Error('The server sent something unexpected. Try again.'); }
    if (!data.ok) throw new Error(data.error || 'Something went wrong.');
    return data;
  }

  // GET: no custom headers, so no CORS preflight.
  async function get(action, params) {
    if (!apiReady()) throw new Error('The hunt is not connected yet (API_URL missing in assets/config.js).');
    const url = new URL(cfg.API_URL);
    url.searchParams.set('action', action);
    Object.keys(params || {}).forEach(function (k) { url.searchParams.set(k, params[k]); });
    url.searchParams.set('_', Date.now());
    const res = await fetch(url.toString(), { method: 'GET', cache: 'no-store' });
    return parse(res);
  }

  // POST: URL-encoded body is a "simple" request, so no CORS preflight.
  async function post(action, params) {
    if (!apiReady()) throw new Error('The hunt is not connected yet (API_URL missing in assets/config.js).');
    const body = new URLSearchParams(Object.assign({ action: action }, params || {}));
    const res = await fetch(cfg.API_URL, { method: 'POST', body: body });
    return parse(res);
  }

  function getTeam() { try { return localStorage.getItem(TEAM_KEY) || ''; } catch (e) { return ''; } }
  function setTeam(t) { try { localStorage.setItem(TEAM_KEY, t); } catch (e) {} }
  function clearTeam() { try { localStorage.removeItem(TEAM_KEY); } catch (e) {} }

  function setPendingCode(c) { try { localStorage.setItem(PENDING_CODE_KEY, c); } catch (e) {} }
  function takePendingCode() {
    try {
      const c = localStorage.getItem(PENDING_CODE_KEY) || '';
      localStorage.removeItem(PENDING_CODE_KEY);
      return c;
    } catch (e) { return ''; }
  }

  function switchesLeft() {
    try { return Math.max(0, MAX_SWITCHES - (Number(localStorage.getItem(SWITCH_KEY)) || 0)); } catch (e) { return 0; }
  }
  function useSwitch() {
    try { localStorage.setItem(SWITCH_KEY, String((Number(localStorage.getItem(SWITCH_KEY)) || 0) + 1)); } catch (e) {}
  }

  /* ---------- clock ---------- */

  function fmtClock(ms) {
    if (ms == null || isNaN(ms)) return '0:00:00';
    const t = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
    return h + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
  }

  // Ticks a running clock from the shared hunt start, corrected for the phone's clock drift.
  let clockTimer = null;
  function runClock(node, huntStartIso, serverNowIso) {
    clearInterval(clockTimer);
    if (!huntStartIso) { node.textContent = '0:00:00'; return; }
    const skew = serverNowIso ? new Date(serverNowIso).getTime() - Date.now() : 0;
    const start = new Date(huntStartIso).getTime();
    const tick = function () { node.textContent = fmtClock(Date.now() + skew - start); };
    tick();
    clockTimer = setInterval(tick, 1000);
  }

  function setFlash(msg, kind) { try { sessionStorage.setItem(FLASH_KEY, JSON.stringify({ msg: msg, kind: kind || 'ok' })); } catch (e) {} }
  function takeFlash() {
    try {
      const raw = sessionStorage.getItem(FLASH_KEY);
      sessionStorage.removeItem(FLASH_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }

  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === 'class') node.className = attrs[k];
      else if (k === 'text') node.textContent = attrs[k];
      else if (k.indexOf('on') === 0) node.addEventListener(k.slice(2), attrs[k]);
      else if (attrs[k] !== false && attrs[k] != null) node.setAttribute(k, attrs[k] === true ? '' : attrs[k]);
    });
    (children || []).forEach(function (c) { if (c) node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return node;
  }

  function ordinal(n) {
    const s = ['th', 'st', 'nd', 'rd'], v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  }

  function renderDots(container, index, total, finished) {
    container.innerHTML = '';
    for (let i = 0; i < total; i++) {
      let cls = 'dot';
      if (finished || i < index) cls += ' done';
      else if (i === index) cls += ' current';
      if (i === total - 1) cls += ' final';
      container.appendChild(el('span', { class: cls }));
    }
    const done = finished ? total : index;
    container.setAttribute('aria-label', done + ' of ' + total + ' stops cleared');
  }

  /* ---------- media ---------- */

  function readAsBase64(blob) {
    return new Promise(function (resolve, reject) {
      const r = new FileReader();
      r.onload = function () { resolve(String(r.result).split(',')[1] || ''); };
      r.onerror = function () { reject(new Error('Could not read that file.')); };
      r.readAsDataURL(blob);
    });
  }

  // Downscale photos so uploads are quick on park signal. Falls back to the original.
  function compressImage(file, maxDim, quality) {
    maxDim = maxDim || 1600;
    quality = quality || 0.82;
    return new Promise(function (resolve) {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = function () {
        try {
          const scale = Math.min(1, maxDim / Math.max(img.naturalWidth, img.naturalHeight));
          const w = Math.round(img.naturalWidth * scale);
          const h = Math.round(img.naturalHeight * scale);
          const canvas = document.createElement('canvas');
          canvas.width = w; canvas.height = h;
          canvas.getContext('2d').drawImage(img, 0, 0, w, h);
          canvas.toBlob(function (blob) {
            URL.revokeObjectURL(url);
            resolve(blob && blob.size < file.size ? { blob: blob, type: 'image/jpeg', name: 'photo.jpg' } : { blob: file, type: file.type, name: file.name });
          }, 'image/jpeg', quality);
        } catch (e) {
          URL.revokeObjectURL(url);
          resolve({ blob: file, type: file.type, name: file.name });
        }
      };
      img.onerror = function () { URL.revokeObjectURL(url); resolve({ blob: file, type: file.type, name: file.name }); };
      img.src = url;
    });
  }

  async function prepareUpload(file, kind) {
    const maxMb = cfg.MAX_UPLOAD_MB || 30;
    let out = { blob: file, type: file.type || '', name: file.name || 'upload' };
    if (/^image\//.test(out.type)) out = await compressImage(file);
    if (!/^(image|video)\//.test(out.type)) throw new Error('That file is not a photo or video.');
    if (kind === 'video' && !/^video\//.test(out.type)) throw new Error('This one needs a video.');
    if (kind !== 'video' && !/^image\//.test(out.type)) throw new Error('This one needs a photo.');
    if (out.blob.size > maxMb * 1024 * 1024) {
      throw new Error('That file is ' + (out.blob.size / 1048576).toFixed(0) + 'MB. The limit is ' + maxMb + 'MB. Record something shorter and try again.');
    }
    return { mimeType: out.type, fileName: out.name, data: await readAsBase64(out.blob) };
  }

  window.Hunt = {
    cfg: cfg, get: get, post: post,
    getTeam: getTeam, setTeam: setTeam, clearTeam: clearTeam,
    setPendingCode: setPendingCode, takePendingCode: takePendingCode,
    setFlash: setFlash, takeFlash: takeFlash,
    switchesLeft: switchesLeft, useSwitch: useSwitch,
    fmtClock: fmtClock, runClock: runClock, ordinal: ordinal,
    el: el, renderDots: renderDots, prepareUpload: prepareUpload
  };
})();
