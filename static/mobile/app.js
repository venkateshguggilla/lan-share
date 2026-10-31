// LAN Share phone page: log in with the PC's password, browse shared folders, download and upload files.
'use strict';

const $ = (id) => document.getElementById(id);

function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k in el) el[k] = v;
    else el.setAttribute(k, v);
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

function icon(markup) {
  const t = document.createElement('template');
  t.innerHTML = markup; // Static icon strings only.
  return t.content.firstChild;
}

const ICONS = {
  folder: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 6.5A2.5 2.5 0 0 1 5.5 4h3.6l2 2h7.4A2.5 2.5 0 0 1 21 8.5v9a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z"/></svg>',
  file: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg>',
  upload: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 16V4M6 10l6-6 6 6M5 20h14"/></svg>',
};

function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return (v < 10 ? v.toFixed(1) : Math.round(v)) + ' ' + units[i];
}

let toastTimer;
function toast(message, kind) {
  const el = $('toast');
  el.textContent = message;
  el.className = 'toast' + (kind === 'error' ? ' error' : '');
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), kind === 'error' ? 6000 : 3000);
}

// ---------- Session ----------

function storage(kind) {
  try { return window[kind]; } catch { return null; }
}

function clientId() {
  const ls = storage('localStorage');
  let id = ls && ls.getItem('lanshare.clientId');
  if (!id) {
    id = (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2) + Date.now());
    if (ls) ls.setItem('lanshare.clientId', id);
  }
  return id;
}

function deviceLabel() {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) return /Mobile/.test(ua) ? 'Android phone' : 'Android tablet';
  return 'Web browser';
}

const state = {
  token: (storage('sessionStorage') && storage('sessionStorage').getItem('lanshare.token')) || null,
  pcName: '',
  roots: [],
  root: null,
  path: '',
  entries: [],
  readOnly: true,
  uploads: [],
};

function setToken(token) {
  state.token = token;
  const ss = storage('sessionStorage');
  if (!ss) return;
  if (token) ss.setItem('lanshare.token', token);
  else ss.removeItem('lanshare.token');
}

class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function api(method, path, body) {
  const headers = {};
  if (state.token) headers.Authorization = 'Bearer ' + state.token;
  if (body) headers['Content-Type'] = 'application/json';
  let res;
  try {
    res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined, cache: 'no-store' });
  } catch {
    throw new ApiError(0, 'Lost connection to the PC. Check that it is on and on the same Wi-Fi.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && path !== '/api/auth') sessionExpired();
    throw new ApiError(res.status, data.error || 'Error ' + res.status);
  }
  return data;
}

function sessionExpired() {
  setToken(null);
  renderLogin('Your session ended. Enter the password again.');
}

const q = (params) => new URLSearchParams(params).toString();

// ---------- Login ----------

function renderLogin(message) {
  $('logout').hidden = true;
  $('subtitle').textContent = 'Password required';
  const pw = h('input', { class: 'input', type: 'password', placeholder: 'Password', autocomplete: 'current-password' });
  const err = h('div', { class: 'error' }, message || '');
  const go = h('button', { class: 'btn', type: 'submit' }, 'Connect');
  const form = h('form', {
      class: 'login',
      onsubmit: async (ev) => {
        ev.preventDefault();
        if (!pw.value) return;
        go.disabled = true;
        go.textContent = 'Connecting…';
        err.textContent = '';
        // With the right password, the PC may ask its user to accept this phone first.
        const waiting = setTimeout(() => {
          go.textContent = 'Waiting for ' + (state.pcName || 'the PC') + ' to accept…';
        }, 1500);
        try {
          const res = await api('POST', '/api/auth', {
            password: pw.value, clientId: clientId(), clientName: deviceLabel(), kind: 'phone',
          });
          clearTimeout(waiting);
          setToken(res.token);
          await openRoots();
        } catch (e) {
          clearTimeout(waiting);
          err.textContent = e.message;
          go.disabled = false;
          go.textContent = 'Connect';
          pw.select();
        }
      },
    },
    h('h1', {}, 'Connect to ' + (state.pcName || 'this PC')),
    h('p', {}, 'Enter the password set in LAN Share on ' + (state.pcName || 'the PC') + '.'),
    pw, err, go,
  );
  $('view').replaceChildren(form);
  $('uploads').hidden = true;
  removeFab();
  pw.focus();
}

// ---------- Browsing ----------

async function openRoots() {
  const res = await api('GET', '/api/roots');
  state.roots = res.roots;
  state.root = null;
  state.path = '';
  state.entries = res.roots.map((r) => ({ name: r.name, isDir: true, size: 0, mtime: 0, rootId: r.id }));
  state.readOnly = true;
  renderBrowser();
}

async function openFolder(root, path) {
  try {
    const res = await api('GET', '/api/list?' + q({ root: root.id, path }));
    Object.assign(state, { root, path, entries: res.entries, readOnly: !!res.readOnly });
    renderBrowser();
    window.scrollTo(0, 0);
  } catch (e) {
    if (e.status !== 401) toast(e.message, 'error');
  }
}

function goUp() {
  if (!state.root) return;
  if (!state.path) return openRoots();
  openFolder(state.root, state.path.split('/').slice(0, -1).join('/'));
}

async function download(entry) {
  try {
    const path = state.path ? state.path + '/' + entry.name : entry.name;
    const res = await api('POST', '/api/ticket?' + q({ root: state.root.id, path }));
    const a = h('a', { href: res.url, download: entry.name });
    document.body.append(a);
    a.click();
    a.remove();
    toast('Downloading ' + entry.name);
  } catch (e) {
    if (e.status !== 401) toast(e.message, 'error');
  }
}

function renderBrowser() {
  $('logout').hidden = false;
  $('subtitle').textContent = state.root ? (state.readOnly ? 'Read only · tap a file to download' : 'Tap a file to download') : 'Shared folders';

  const crumbs = h('nav', { class: 'crumbs' });
  const addCrumb = (label, go, current) => {
    if (crumbs.childElementCount) crumbs.append(h('span', { class: 'crumb-sep' }, '›'));
    crumbs.append(h('button', { class: 'crumb' + (current ? ' current' : ''), onclick: go }, label));
  };
  addCrumb('Shared', openRoots, !state.root);
  if (state.root) {
    const root = state.root;
    const parts = state.path.split('/').filter(Boolean);
    addCrumb(root.name, () => openFolder(root, ''), !parts.length);
    parts.forEach((part, i) => {
      const target = parts.slice(0, i + 1).join('/');
      addCrumb(part, () => openFolder(root, target), i === parts.length - 1);
    });
  }

  const list = h('div', { class: 'list' });
  if (!state.entries.length) {
    list.append(h('div', { class: 'empty' }, state.root ? 'This folder is empty' : 'This PC has not shared any folders yet.'));
  }
  if (state.root) list.append(h('button', { class: 'item', onclick: goUp },
    h('span', { class: 'icon folder' }, icon(ICONS.folder)), h('span', { class: 'text' }, h('div', { class: 'name' }, '..'))));
  for (const e of state.entries) {
    const meta = e.isDir ? (state.root ? 'Folder' : (state.roots.find((r) => r.id === e.rootId) || {}).readOnly ? 'Read only' : 'Read & write')
      : formatSize(e.size) + ' · ' + new Date(e.mtime).toLocaleDateString();
    list.append(h('button', {
        class: 'item',
        onclick: () => {
          if (!state.root) return openFolder(state.roots.find((r) => r.id === e.rootId), '');
          if (e.isDir) return openFolder(state.root, state.path ? state.path + '/' + e.name : e.name);
          download(e);
        },
      },
      h('span', { class: 'icon ' + (e.isDir ? 'folder' : 'file') }, icon(e.isDir ? ICONS.folder : ICONS.file)),
      h('span', { class: 'text' }, h('div', { class: 'name' }, e.name), h('div', { class: 'meta' }, meta)),
      e.isDir ? null : h('span', { class: 'action' }, 'Save'),
    ));
  }

  const notice = state.root && state.readOnly
    ? h('div', { class: 'notice' },
        `${state.pcName} shares "${state.root.name}" as read-only, so you can download but not upload here. ` +
        `To upload, open Settings on ${state.pcName} and set this folder to Read & write.`)
    : null;

  $('view').replaceChildren(crumbs, notice || '', list);
  renderFab();
}

// ---------- Uploads ----------

function removeFab() {
  const fab = document.querySelector('.fab');
  if (fab) fab.remove();
}

function renderFab() {
  removeFab();
  if (!state.root || state.readOnly) return;
  document.body.append(h('button', { class: 'fab', onclick: () => $('file-input').click() }, icon(ICONS.upload), 'Upload'));
}

$('file-input').addEventListener('change', (ev) => {
  const files = [...ev.target.files];
  ev.target.value = '';
  if (!files.length || !state.root) return;
  for (const file of files) {
    state.uploads.push({ file, root: state.root, path: state.path, sent: 0, status: 'queued', error: '', xhr: null });
  }
  renderUploads();
  pumpUploads();
});

let uploading = false;
async function pumpUploads() {
  if (uploading) return;
  uploading = true;
  let u;
  while ((u = state.uploads.find((x) => x.status === 'queued'))) {
    u.status = 'active';
    renderUploads();
    try {
      await sendFile(u);
      u.status = 'done';
      if (state.root && state.root.id === u.root.id && state.path === u.path) openFolder(state.root, state.path);
    } catch (e) {
      u.status = u.status === 'cancelled' ? 'cancelled' : 'error';
      u.error = e.message;
      if (e.status === 401) { uploading = false; return sessionExpired(); }
    }
    renderUploads();
  }
  uploading = false;
}

function sendFile(u) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    u.xhr = xhr;
    xhr.open('PUT', '/api/upload?' + q({ root: u.root.id, path: u.path, name: u.file.name }));
    xhr.setRequestHeader('Authorization', 'Bearer ' + state.token);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    let last = 0;
    xhr.upload.onprogress = (ev) => {
      u.sent = ev.loaded;
      if (Date.now() - last > 200) { last = Date.now(); renderUploads(); }
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) return resolve();
      let msg = 'Upload failed (' + xhr.status + ')';
      try { msg = JSON.parse(xhr.responseText).error || msg; } catch {}
      reject(new ApiError(xhr.status, msg));
    };
    xhr.onerror = () => reject(new ApiError(0, 'Connection lost during upload'));
    xhr.onabort = () => reject(new ApiError(0, 'Cancelled'));
    xhr.send(u.file);
  });
}

function renderUploads() {
  const box = $('uploads');
  if (!state.uploads.length) { box.hidden = true; return; }
  box.hidden = false;
  const active = state.uploads.filter((u) => u.status === 'queued' || u.status === 'active').length;
  box.replaceChildren(
    h('div', { class: 'uploads-head' },
      h('span', {}, active ? `Uploading ${active} file${active > 1 ? 's' : ''}…` : 'Uploads finished'),
      h('button', {
        class: 'link-btn',
        hidden: !!active,
        onclick: () => {
          state.uploads = state.uploads.filter((u) => u.status === 'queued' || u.status === 'active');
          renderUploads();
        },
      }, 'Close')),
    ...state.uploads.slice().reverse().map((u) => {
      const total = u.file.size;
      const pct = u.status === 'done' ? 100 : total ? Math.min(100, (u.sent / total) * 100) : 0;
      let stat = 'Waiting';
      if (u.status === 'active') stat = formatSize(u.sent) + ' / ' + formatSize(total);
      if (u.status === 'done') stat = 'Done';
      if (u.status === 'error') stat = u.error;
      if (u.status === 'cancelled') stat = 'Cancelled';
      return h('div', { class: 'upload ' + u.status },
        h('div', { class: 'row' },
          h('span', { class: 'uname' }, u.file.name),
          u.status === 'active' || u.status === 'queued'
            ? h('button', { class: 'link-btn', onclick: () => {
                if (u.xhr) u.xhr.abort();
                u.status = 'cancelled';
                renderUploads();
              } }, 'Cancel')
            : null),
        h('div', { class: 'ustat' }, stat),
        h('div', { class: 'bar' }, h('div', { style: 'width:' + pct + '%' })));
    }),
  );
}

window.addEventListener('beforeunload', (ev) => {
  if (state.uploads.some((u) => u.status === 'active' || u.status === 'queued')) ev.preventDefault();
});

// ---------- Startup ----------

$('logout').addEventListener('click', async () => {
  try { await api('POST', '/api/logout'); } catch {}
  setToken(null);
  renderLogin('');
});

(async function init() {
  try {
    const info = await api('GET', '/api/info');
    state.pcName = info.name;
    $('pc-name').textContent = info.name;
    document.title = info.name + ' · LAN Share';
  } catch (e) {
    $('subtitle').textContent = 'Not reachable';
    $('view').replaceChildren(h('div', { class: 'empty' }, e.message));
    return;
  }
  if (state.token) {
    try {
      await openRoots();
      return;
    } catch {
      setToken(null);
    }
  }
  renderLogin('');
})();
