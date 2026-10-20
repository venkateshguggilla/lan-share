// Renderer: device list, two-pane explorer, transfers and dialogs. Plain DOM, no framework.
import type { Api } from '../shared/api';
import type {
  AppInfo, Device, FileEntry, IncomingSession, RemoteItem, RemoteRoot, Settings, SharedFolder, Transfer,
} from '../shared/types';

const api = (window as unknown as { api: Api }).api;

// ---------- DOM helpers ----------

type Child = Node | string | null | undefined | false;

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Record<string, unknown> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v as EventListener);
    else if (k === 'class') el.className = String(v);
    else if (k in el && k !== 'list') (el as any)[k] = v;
    else el.setAttribute(k, String(v));
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

function svg(markup: string): SVGElement {
  const t = document.createElement('template');
  t.innerHTML = markup.trim(); // Only ever called with the static icon strings below.
  return t.content.firstChild as SVGElement;
}

const ICONS = {
  folder: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 6.5A2.5 2.5 0 0 1 5.5 4h3.6l2 2h7.4A2.5 2.5 0 0 1 21 8.5v9a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z"/></svg>',
  file: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg>',
  drive: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3" y="7" width="18" height="10" rx="2"/><circle cx="17" cy="12" r="1" fill="currentColor"/></svg>',
  pc: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/></svg>',
  lock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>',
  unlock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 7.5-2"/></svg>',
  up: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 19V5M5 12l7-7 7 7"/></svg>',
  refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"/></svg>',
  home: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 11l8-7 8 7v9h-5v-6H9v6H4z"/></svg>',
  gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
  warning: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M12 3 2 20h20z"/><path d="M12 10v4M12 17v.5"/></svg>',
  close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  down: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12l7 7 7-7"/></svg>',
  upArrow: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 19V5M5 12l7-7 7 7"/></svg>',
};

const $ = (id: string) => document.getElementById(id)!;

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

function formatDate(ms: number): string {
  if (!ms) return '';
  return new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function errorMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.replace(/^Error invoking remote method '[^']+': (\w*Error: )?/, '');
}

function toast(message: string, kind: 'info' | 'error' = 'info'): void {
  const el = h('div', { class: `toast ${kind}` }, message);
  $('toasts').append(el);
  setTimeout(() => el.remove(), kind === 'error' ? 6000 : 3500);
}

// ---------- State ----------

interface PaneState {
  entries: FileEntry[];
  selected: Set<string>;
  anchor: string | null;
  loading: boolean;
  error: string | null;
}

const newPane = (): PaneState => ({ entries: [], selected: new Set(), anchor: null, loading: false, error: null });

const state = {
  info: null as AppInfo | null,
  settings: null as Settings | null,
  devices: [] as Device[],
  transfers: [] as Transfer[],
  sessions: [] as IncomingSession[],
  transfersCollapsed: false,
  local: { ...newPane(), path: '' },
  remote: {
    ...newPane(),
    deviceId: null as string | null,
    roots: [] as RemoteRoot[],
    root: null as RemoteRoot | null,
    path: '',
    readOnly: false,
  },
};

let dragSource: 'local' | 'remote' | null = null;

// ---------- Local paths ----------

const isWin = navigator.userAgent.includes('Windows');
const SEP = isWin ? '\\' : '/';

function localJoin(dir: string, name: string): string {
  if (!dir) return name; // Drive root like "C:\".
  return dir.endsWith(SEP) ? dir + name : dir + SEP + name;
}

function localParent(p: string): string {
  if (!p) return '';
  const trimmed = p.endsWith(SEP) && p.length > 3 ? p.slice(0, -1) : p;
  if (isWin && /^[A-Za-z]:\\?$/.test(trimmed)) return '';
  if (!isWin && trimmed === '/') return '';
  const idx = trimmed.lastIndexOf(SEP);
  if (idx < 0) return '';
  const parent = trimmed.slice(0, idx);
  if (isWin && /^[A-Za-z]:$/.test(parent)) return parent + '\\';
  return parent || '/';
}

function localCrumbs(p: string): { label: string; path: string }[] {
  const crumbs = [{ label: 'This PC', path: '' }];
  if (!p) return crumbs;
  if (isWin) {
    const [drive, ...rest] = p.split('\\').filter(Boolean);
    let acc = drive + '\\';
    crumbs.push({ label: drive, path: acc });
    for (const part of rest) {
      acc = localJoin(acc, part);
      crumbs.push({ label: part, path: acc });
    }
  } else {
    let acc = '/';
    crumbs.push({ label: '/', path: '/' });
    for (const part of p.split('/').filter(Boolean)) {
      acc = localJoin(acc, part);
      crumbs.push({ label: part, path: acc });
    }
  }
  return crumbs;
}

// ---------- Loading ----------

async function loadLocal(path: string): Promise<void> {
  state.local.loading = true;
  renderLocal();
  try {
    const { entries } = await api.localList(path);
    Object.assign(state.local, { path, entries, selected: new Set(), anchor: null, error: null });
  } catch (err) {
    state.local.error = errorMessage(err);
    toast(state.local.error, 'error');
  } finally {
    state.local.loading = false;
    renderLocal();
    renderActions();
  }
}

async function loadRemote(root: RemoteRoot | null, path: string): Promise<void> {
  const r = state.remote;
  const deviceId = r.deviceId;
  if (!deviceId) return;
  r.loading = true;
  renderRemote();
  try {
    if (!root) {
      const roots = await api.remoteRoots(deviceId);
      if (r.deviceId !== deviceId) return;
      Object.assign(r, {
        roots, root: null, path: '', readOnly: true, error: null,
        entries: roots.map((x) => ({ name: x.name, isDir: true, size: 0, mtime: 0 })),
      });
    } else {
      const res = await api.remoteList(deviceId, root.id, path);
      if (r.deviceId !== deviceId) return;
      Object.assign(r, { root, path, entries: res.entries, readOnly: !!res.readOnly, error: null });
    }
    r.selected = new Set();
    r.anchor = null;
  } catch (err) {
    r.error = errorMessage(err);
    toast(r.error, 'error');
  } finally {
    r.loading = false;
    renderRemote();
    renderActions();
  }
}

// ---------- Rendering: sidebar ----------

function renderThisPc(): void {
  const info = state.info;
  if (!info) return;
  let badge: HTMLElement;
  if (!info.hasPassword) badge = h('span', { class: 'badge warn' }, 'Set a password to share');
  else if (!info.serverRunning) badge = h('span', { class: 'badge off' }, 'Not accepting connections');
  else badge = h('span', { class: 'badge ok' }, 'Accepting connections');
  const addr = info.addresses.length ? info.addresses.join(', ') : 'No network';
  $('this-pc').replaceChildren(
    h('div', { class: 'pane-sub' }, 'This PC'),
    h('div', { class: 'name' }, info.deviceName),
    h('div', { class: 'meta' }, info.port ? `${addr} · port ${info.port}` : addr),
    badge,
  );
}

function renderNetworkWarning(): void {
  const nets = state.info?.publicNetworks ?? [];
  const el = $('net-warning');
  if (!nets.length) {
    el.replaceChildren();
    return;
  }
  const names = nets.map((n) => `"${n.name}"`).join(', ');
  el.replaceChildren(
    h('div', { class: 'warning-card', role: 'alert' },
      h('div', { class: 'warning-title' }, svg(ICONS.warning), "Other PCs can't connect"),
      h('div', {}, `Your network ${names} is set to Public, so Windows Firewall blocks LAN Share.`),
      h('button', { class: 'btn small', onclick: networkHelpDialog }, 'How to fix'),
    ),
  );
}

function networkHelpDialog(): void {
  const nets = state.info?.publicNetworks ?? [];
  const name = nets[0]?.name ?? 'your network';
  modal((close) => [
    h('h2', {}, 'Set your network to Private'),
    h('p', { class: 'lead' },
      `Windows treats "${name}" as a public network (like café Wi-Fi) and blocks incoming connections. ` +
      'Change it to Private if this is your home or office network that you trust.'),
    h('ol', { class: 'steps' },
      h('li', {}, 'Click Open network settings below.'),
      h('li', {}, `Click Properties under "${name}" (or click the network name).`),
      h('li', {}, 'Under Network profile type, choose Private network.'),
    ),
    h('p', { class: 'hint' }, 'Do this on every PC you want to connect. This warning disappears by itself once the change is made.'),
    h('div', { class: 'modal-actions' },
      h('button', { class: 'btn', onclick: close }, 'Close'),
      h('button', { class: 'btn primary', onclick: () => api.openNetworkSettings() }, 'Open network settings'),
    ),
  ]);
}

function renderDevices(): void {
  const list = $('device-list');
  if (!state.devices.length) {
    list.replaceChildren(
      h('li', { class: 'empty-devices' },
        'Looking for other PCs running LAN Share… Make sure they are on the same Wi-Fi/LAN and that Windows Firewall allows LAN Share on private networks.'),
    );
    return;
  }
  list.replaceChildren(
    ...state.devices.map((d) =>
      h('li', {
          class: `device${state.remote.deviceId === d.id ? ' active' : ''}`,
          title: `${d.name} (${d.host}:${d.port})`,
          onclick: () => openDevice(d),
        },
        h('span', { class: 'pc-icon' }, svg(ICONS.pc)),
        h('div', { class: 'info' },
          h('div', { class: 'name' }, d.name),
          h('div', { class: 'host' }, d.host + (d.manual ? ' · added manually' : '')),
        ),
        h('span', { class: `state${d.connected ? ' connected' : ''}`, title: d.connected ? 'Connected' : 'Password required' },
          svg(d.connected ? ICONS.unlock : ICONS.lock)),
      ),
    ),
  );
}

// ---------- Rendering: file panes ----------

function fileList(
  side: 'local' | 'remote',
  pane: PaneState,
  iconFor: (e: FileEntry) => string,
  onOpen: (e: FileEntry) => void,
  showMeta: boolean,
): HTMLElement {
  const container = h('div', { class: 'file-list' });
  container.append(h('div', { class: 'file-head' }, h('span', {}, 'Name'), h('span', { class: 'num' }, showMeta ? 'Size' : ''),
    h('span', { class: 'num' }, showMeta ? 'Modified' : '')));
  const names = pane.entries.map((e) => e.name);
  const rows = new Map<string, HTMLElement>();
  // Selection changes only toggle classes; re-rendering would reset the scroll and break double-click.
  const paintSelection = () => {
    for (const [name, row] of rows) row.classList.toggle('selected', pane.selected.has(name));
    renderActions();
  };

  for (const e of pane.entries) {
    const row = h('div', {
        class: `file-row${pane.selected.has(e.name) ? ' selected' : ''}`,
        draggable: 'true',
        onclick: (ev: MouseEvent) => {
          selectRow(pane, names, e.name, ev);
          paintSelection();
        },
        ondblclick: () => onOpen(e),
        ondragstart: (ev: DragEvent) => {
          if (!pane.selected.has(e.name)) {
            pane.selected = new Set([e.name]);
            pane.anchor = e.name;
            paintSelection();
          }
          dragSource = side;
          ev.dataTransfer?.setData('text/plain', 'lanshare');
          if (ev.dataTransfer) ev.dataTransfer.effectAllowed = 'copy';
        },
        ondragend: () => (dragSource = null),
      },
      h('div', { class: 'file-name' }, h('span', { class: iconFor(e) }, svg((ICONS as any)[iconFor(e)])), h('span', {}, e.name)),
      h('span', { class: 'num' }, showMeta && !e.isDir ? formatSize(e.size) : ''),
      h('span', { class: 'num' }, showMeta ? formatDate(e.mtime) : ''),
    );
    rows.set(e.name, row);
    container.append(row);
  }
  if (!pane.entries.length && !pane.loading) {
    container.append(h('div', { class: 'placeholder' }, pane.error ?? 'This folder is empty'));
  }
  container.addEventListener('click', (ev) => {
    if (ev.target === container) {
      pane.selected.clear();
      paintSelection();
    }
  });
  return container;
}

/** Re-renders a pane, keeping the file list's scroll position when it still shows the same folder. */
function renderKeepingScroll(paneEl: HTMLElement, location: string, render: () => void): void {
  const old = paneEl.querySelector<HTMLElement>('.file-list');
  const scrollTop = old && paneEl.dataset.location === location ? old.scrollTop : 0;
  render();
  paneEl.dataset.location = location;
  const list = paneEl.querySelector<HTMLElement>('.file-list');
  if (list) list.scrollTop = scrollTop;
}

function selectRow(pane: PaneState, names: string[], name: string, ev: MouseEvent): void {
  if (ev.shiftKey && pane.anchor) {
    const a = names.indexOf(pane.anchor);
    const b = names.indexOf(name);
    pane.selected = new Set(names.slice(Math.min(a, b), Math.max(a, b) + 1));
  } else if (ev.ctrlKey || ev.metaKey) {
    pane.selected.has(name) ? pane.selected.delete(name) : pane.selected.add(name);
    pane.anchor = name;
  } else {
    pane.selected = new Set([name]);
    pane.anchor = name;
  }
}

function crumbBar(crumbs: { label: string; go: () => void }[]): HTMLElement {
  const bar = h('div', { class: 'crumbs' });
  crumbs.forEach((c, i) => {
    if (i) bar.append(h('span', { class: 'crumb-sep' }, '›'));
    bar.append(h('button', { class: 'crumb', onclick: c.go }, c.label));
  });
  return bar;
}

function iconButton(icon: string, title: string, onclick: () => void, disabled = false): HTMLButtonElement {
  return h('button', { class: 'icon-btn', title, onclick, disabled }, svg(icon));
}

function renderLocal(): void {
  const l = state.local;
  const pane = $('local-pane');
  renderKeepingScroll(pane, l.path, () => pane.replaceChildren(
    h('div', { class: 'pane-header' },
      h('div', { class: 'pane-title' }, 'This PC'),
      h('div', { class: 'pane-sub' }, state.info?.deviceName ?? ''),
    ),
    h('div', { class: 'toolbar' },
      iconButton(ICONS.up, 'Up', () => loadLocal(localParent(l.path)), !l.path),
      iconButton(ICONS.home, 'Home folder', async () => loadLocal(await api.localHome())),
      iconButton(ICONS.refresh, 'Refresh', () => loadLocal(l.path)),
      crumbBar(localCrumbs(l.path).map((c) => ({ label: c.label, go: () => loadLocal(c.path) }))),
    ),
    fileList('local', l, (e) => (!l.path ? 'drive' : e.isDir ? 'folder' : 'file'), (e) => {
      const full = localJoin(l.path, e.name);
      if (e.isDir) loadLocal(full);
      else api.openLocal(full);
    }, !!l.path),
  ));
}

function renderRemote(): void {
  const r = state.remote;
  const pane = $('remote-pane');
  const device = state.devices.find((d) => d.id === r.deviceId);

  if (!r.deviceId) {
    pane.replaceChildren(
      h('div', { class: 'placeholder' },
        svg(ICONS.pc),
        h('div', { class: 'big' }, 'No PC connected'),
        h('div', {}, 'Pick a PC from the list on the left and enter its password to browse its shared folders.'),
      ),
    );
    return;
  }

  const crumbs: { label: string; go: () => void }[] = [{ label: 'Shared folders', go: () => loadRemote(null, '') }];
  if (r.root) {
    const root = r.root;
    crumbs.push({ label: root.name, go: () => loadRemote(root, '') });
    let acc = '';
    for (const part of r.path.split('/').filter(Boolean)) {
      acc = acc ? `${acc}/${part}` : part;
      const target = acc;
      crumbs.push({ label: part, go: () => loadRemote(root, target) });
    }
  }

  const up = () => {
    if (!r.root) return;
    if (!r.path) return loadRemote(null, '');
    loadRemote(r.root, r.path.split('/').slice(0, -1).join('/'));
  };

  const list = fileList('remote', r, (e) => (e.isDir ? 'folder' : 'file'), (e) => {
    if (!r.root) {
      const root = r.roots.find((x) => x.name === e.name);
      if (root) loadRemote(root, '');
    } else if (e.isDir) {
      loadRemote(r.root, r.path ? `${r.path}/${e.name}` : e.name);
    } else {
      downloadSelected([e.name]);
    }
  }, !!r.root);

  if (!r.root && !r.entries.length && !r.loading && !r.error) {
    list.replaceChildren(h('div', { class: 'placeholder' }, h('div', { class: 'big' }, 'Nothing shared'),
      'This PC has not shared any folders yet.'));
  }

  renderKeepingScroll(pane, `${r.deviceId}|${r.root?.id ?? ''}|${r.path}`, () => pane.replaceChildren(
    h('div', { class: 'pane-header' },
      h('div', { class: 'pane-title' }, device?.name ?? 'Remote PC'),
      h('div', { class: 'pane-sub' }, device ? device.host : 'offline'),
      h('div', { class: 'spacer' }),
      h('button', { class: 'btn small', onclick: () => disconnectDevice(r.deviceId!) }, 'Disconnect'),
    ),
    h('div', { class: 'toolbar' },
      iconButton(ICONS.up, 'Up', up, !r.root),
      iconButton(ICONS.refresh, 'Refresh', () => loadRemote(r.root, r.path)),
      crumbBar(crumbs),
      r.root && r.readOnly ? h('span', { class: 'ro-tag', title: readOnlyMessage() }, 'Read only') : null,
    ),
    list,
  ));
}

function readOnlyMessage(): string {
  const r = state.remote;
  const pc = state.devices.find((d) => d.id === r.deviceId)?.name ?? 'The other PC';
  return `${pc} shares "${r.root?.name ?? 'this folder'}" as read-only. To send files here, open Settings on ${pc} and set this folder to Read & write.`;
}

function renderActions(): void {
  const r = state.remote;
  const canUpload = !!r.deviceId && !!r.root && !r.readOnly;
  const send = $('send-btn') as HTMLButtonElement;
  send.disabled = !canUpload || !state.local.selected.size || !state.local.path;
  send.title = r.root && r.readOnly ? readOnlyMessage() : 'Send selected files to the remote PC';
  (($('fetch-btn')) as HTMLButtonElement).disabled = !r.deviceId || !r.root || !r.selected.size;
}

// ---------- Rendering: transfers ----------

function renderTransfers(): void {
  const t = state.transfers;
  const el = $('transfers');
  if (!t.length) {
    el.replaceChildren();
    el.style.display = 'none';
    return;
  }
  el.style.display = '';
  el.classList.toggle('collapsed', state.transfersCollapsed);
  const running = t.filter((x) => x.status === 'active' || x.status === 'queued').length;
  const failed = t.filter((x) => x.status === 'error').length;
  const summary = [running ? `${running} in progress` : 'All done', failed ? `${failed} failed` : ''].filter(Boolean).join(' · ');

  el.replaceChildren(
    h('div', { class: 'transfers-head' },
      h('span', { class: 'title', onclick: () => { state.transfersCollapsed = !state.transfersCollapsed; renderTransfers(); } },
        `${state.transfersCollapsed ? '▸' : '▾'} Transfers`),
      h('span', { class: 'summary' }, summary),
      h('button', { class: 'btn small', onclick: () => api.clearTransfers() }, 'Clear finished'),
    ),
    h('div', { class: 'transfer-list' },
      ...t.slice().reverse().map((x) => {
        const pct = x.total ? Math.min(100, (x.done / x.total) * 100) : x.status === 'done' ? 100 : 0;
        let stat: string;
        if (x.status === 'active') stat = `${formatSize(x.done)} / ${formatSize(x.total)}${x.speed ? ` · ${formatSize(x.speed)}/s` : ''}`;
        else if (x.status === 'queued') stat = 'Waiting…';
        else if (x.status === 'done') stat = `Done · ${formatSize(x.total)}`;
        else if (x.status === 'cancelled') stat = 'Cancelled';
        else stat = x.error ?? 'Failed';
        return h('div', { class: `transfer ${x.status}` },
          h('span', { class: 'dir', title: x.direction === 'download' ? 'Copy to this PC' : 'Send to remote PC' },
            svg(x.direction === 'download' ? ICONS.down : ICONS.upArrow)),
          h('div', { style: 'min-width:0' },
            h('div', { class: 'tname', title: x.name }, x.name),
            h('div', { class: 'tsub' }, x.direction === 'download' ? `from ${x.deviceName}` : `to ${x.deviceName}`)),
          h('div', { class: 'bar' }, h('div', { style: `width:${pct}%` })),
          h('span', { class: 'tstat', title: stat }, stat),
          x.status === 'active' || x.status === 'queued'
            ? iconButton(ICONS.close, 'Cancel', () => api.cancelTransfer(x.id))
            : h('span'),
        );
      }),
    ),
  );
}

// ---------- Actions ----------

async function openDevice(d: Device): Promise<void> {
  if (d.connected) return showRemote(d.id);
  if (d.hasSavedLogin) {
    const res = await api.connectSaved(d.id);
    if (res.ok) return showRemote(d.id);
    if (res.identityChanged) return identityDialog(d);
  }
  passwordDialog(d);
}

function showRemote(deviceId: string): void {
  Object.assign(state.remote, { ...newPane(), deviceId, roots: [], root: null, path: '', readOnly: false });
  renderDevices();
  loadRemote(null, '');
}

async function disconnectDevice(deviceId: string): Promise<void> {
  await api.disconnect(deviceId);
  if (state.remote.deviceId === deviceId) state.remote.deviceId = null;
  renderRemote();
  renderActions();
}

function selectedItems(pane: PaneState): RemoteItem[] {
  return pane.entries.filter((e) => pane.selected.has(e.name)).map((e) => ({ name: e.name, isDir: e.isDir }));
}

async function downloadSelected(names?: string[]): Promise<void> {
  const r = state.remote;
  if (!r.deviceId || !r.root) return;
  const items = names
    ? r.entries.filter((e) => names.includes(e.name)).map((e) => ({ name: e.name, isDir: e.isDir }))
    : selectedItems(r);
  if (!items.length) return;
  const dest = state.local.path; // Empty means the Downloads folder.
  try {
    await api.download(r.deviceId, r.root.id, r.path, items, dest);
    toast(`Copying ${items.length} item${items.length > 1 ? 's' : ''} to ${dest || 'Downloads'}`);
  } catch (err) {
    toast(errorMessage(err), 'error');
  }
}

async function uploadPaths(paths: string[]): Promise<void> {
  const r = state.remote;
  if (!r.deviceId || !r.root) return toast('Open a shared folder on the remote PC first', 'error');
  if (r.readOnly) return toast(readOnlyMessage(), 'error');
  if (!paths.length) return;
  try {
    await api.upload(r.deviceId, r.root.id, r.path, paths);
    toast(`Sending ${paths.length} item${paths.length > 1 ? 's' : ''} to ${r.root.name}`);
  } catch (err) {
    toast(errorMessage(err), 'error');
  }
}

function uploadSelected(): void {
  const l = state.local;
  if (!l.path) return;
  uploadPaths([...l.selected].map((n) => localJoin(l.path, n)));
}

// Refresh panes when transfers into them finish.
let lastDone = new Set<string>();
function refreshAfterTransfers(): void {
  const done = new Set(state.transfers.filter((t) => t.status === 'done').map((t) => t.id));
  const newly = state.transfers.filter((t) => done.has(t.id) && !lastDone.has(t.id));
  lastDone = done;
  if (newly.some((t) => t.direction === 'download') && state.local.path) quietReload('local');
  if (newly.some((t) => t.direction === 'upload') && state.remote.root) quietReload('remote');
}

const reloadTimers: Record<string, number> = {};
function quietReload(side: 'local' | 'remote'): void {
  clearTimeout(reloadTimers[side]);
  reloadTimers[side] = window.setTimeout(async () => {
    try {
      if (side === 'local') {
        const { entries } = await api.localList(state.local.path);
        state.local.entries = entries;
        renderLocal();
      } else if (state.remote.deviceId && state.remote.root) {
        const res = await api.remoteList(state.remote.deviceId, state.remote.root.id, state.remote.path);
        state.remote.entries = res.entries;
        renderRemote();
      }
    } catch {
      // Ignore; the user can refresh manually.
    }
  }, 400);
}

function setupDropTarget(el: HTMLElement, side: 'local' | 'remote'): void {
  const accepts = (ev: DragEvent) =>
    side === 'local' ? dragSource === 'remote' : dragSource === 'local' || (!dragSource && ev.dataTransfer?.types.includes('Files'));
  el.addEventListener('dragover', (ev) => {
    if (!accepts(ev)) return;
    ev.preventDefault();
    if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'copy';
    el.classList.add('drop-target');
  });
  el.addEventListener('dragleave', (ev) => {
    if (!el.contains(ev.relatedTarget as Node)) el.classList.remove('drop-target');
  });
  el.addEventListener('drop', (ev) => {
    el.classList.remove('drop-target');
    if (!accepts(ev)) return;
    ev.preventDefault();
    if (side === 'local') downloadSelected();
    else if (dragSource === 'local') uploadSelected();
    else uploadPaths([...(ev.dataTransfer?.files ?? [])].map((f) => api.pathForFile(f)).filter(Boolean));
    dragSource = null;
  });
}

// ---------- Dialogs ----------

function modal(build: (close: () => void) => Child[], opts: { dismissable?: boolean } = {}): () => void {
  const dismissable = opts.dismissable ?? true;
  const close = () => {
    backdrop.remove();
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (ev: KeyboardEvent) => {
    if (ev.key === 'Escape' && dismissable) close();
  };
  const box = h('div', { class: 'modal', role: 'dialog' }, ...build(close));
  const backdrop = h('div', { class: 'modal-backdrop', onmousedown: (ev: MouseEvent) => {
    if (ev.target === backdrop && dismissable) close();
  } }, box);
  document.addEventListener('keydown', onKey);
  $('modal-root').append(backdrop);
  box.querySelector<HTMLInputElement>('input')?.focus();
  return close;
}

function passwordDialog(d: Device): void {
  const pw = h('input', { type: 'password', autocomplete: 'off' });
  const remember = h('input', { type: 'checkbox' });
  const err = h('div', { class: 'error-text' });
  const go = h('button', { class: 'btn primary', type: 'submit' }, 'Connect');

  modal((close) => [
    h('h2', {}, `Connect to ${d.name}`),
    h('p', { class: 'lead' }, `Enter the password set on ${d.name} (${d.host}).`),
    h('form', {
        onsubmit: async (ev: Event) => {
          ev.preventDefault();
          if (!pw.value) return;
          go.disabled = true;
          go.textContent = 'Connecting…';
          err.textContent = '';
          const res = await api.connect(d.id, pw.value, remember.checked);
          go.disabled = false;
          go.textContent = 'Connect';
          if (res.ok) {
            close();
            showRemote(d.id);
          } else if (res.identityChanged) {
            close();
            identityDialog(d);
          } else {
            err.textContent = res.error ?? 'Could not connect';
            pw.select();
          }
        },
        style: 'display:flex;flex-direction:column;gap:12px',
      },
      h('div', { class: 'field' }, h('label', {}, 'Password'), pw),
      h('label', { class: 'check' }, remember, 'Remember this PC'),
      err,
      h('div', { class: 'modal-actions' }, h('button', { class: 'btn', type: 'button', onclick: close }, 'Cancel'), go),
    ),
  ]);
}

function identityDialog(d: Device): void {
  modal((close) => [
    h('h2', {}, 'Security warning'),
    h('p', { class: 'lead' },
      `${d.name} is presenting a different security identity than the last time you connected. ` +
      'This is expected if LAN Share was reinstalled or its settings were reset on that PC. ' +
      'Otherwise, another device may be impersonating it.'),
    h('div', { class: 'modal-actions' },
      h('button', { class: 'btn', onclick: close }, 'Cancel'),
      h('button', { class: 'btn danger', onclick: async () => {
        await api.forgetIdentity(d.id);
        close();
        passwordDialog(d);
      } }, 'Trust it again'),
    ),
  ]);
}

function manualDialog(): void {
  const host = h('input', { type: 'text', placeholder: 'e.g. 192.168.1.20' });
  const port = h('input', { type: 'number', value: '47821', min: '1', max: '65535' });
  const err = h('div', { class: 'error-text' });
  modal((close) => [
    h('h2', {}, 'Connect by IP address'),
    h('p', { class: 'lead' }, 'Use this if the other PC does not appear automatically (some routers block discovery).'),
    h('form', {
        style: 'display:flex;flex-direction:column;gap:12px',
        onsubmit: async (ev: Event) => {
          ev.preventDefault();
          err.textContent = '';
          const res = await api.addManualDevice(host.value, Number(port.value) || 47821);
          if (res.ok) close();
          else err.textContent = res.error ?? 'Could not reach that address';
        },
      },
      h('div', { class: 'row' },
        h('div', { class: 'field', style: 'flex:3' }, h('label', {}, 'IP address'), host),
        h('div', { class: 'field', style: 'flex:1' }, h('label', {}, 'Port'), port)),
      err,
      h('div', { class: 'modal-actions' },
        h('button', { class: 'btn', type: 'button', onclick: close }, 'Cancel'),
        h('button', { class: 'btn primary', type: 'submit' }, 'Add')),
    ),
  ]);
}

async function phoneDialog(): Promise<void> {
  const info = state.info;
  let problem = '';
  if (!info?.hasPassword) problem = 'Set a password in Settings first. Phones need it to connect.';
  else if (!info.serverRunning) problem = 'Turn on "Allow other PCs to connect to this PC" in Settings first.';
  const links = problem ? [] : await api.phoneLinks();
  if (!problem && !links.length) problem = 'This PC is not connected to a network.';

  const qr = h('img', { class: 'qr', alt: 'QR code' });
  const urlText = h('div', { class: 'qr-url' });
  const show = (i: number) => {
    qr.src = links[i].qrDataUrl;
    urlText.textContent = links[i].url;
  };
  if (links.length) show(0);

  modal((close) => [
    h('h2', {}, 'Connect a phone'),
    problem
      ? h('p', { class: 'error-text' }, problem)
      : h('div', { class: 'qr-wrap' },
          qr,
          urlText,
          links.length > 1
            ? h('select', { class: 'qr-select', onchange: (ev: Event) => show(Number((ev.target as HTMLSelectElement).value)) },
                ...links.map((l, i) => h('option', { value: String(i) }, `${l.interfaceName} (${l.url.split('/')[2].split(':')[0]})`)))
            : null,
        ),
    (info?.publicNetworks.length ?? 0) > 0
      ? h('p', { class: 'error-text' }, 'Your network is set to Public, so the phone will not be able to connect. See the warning in the sidebar.')
      : null,
    problem ? null : h('ol', { class: 'steps' },
      h('li', {}, 'Connect the phone to the same Wi-Fi as this PC.'),
      h('li', {}, 'Scan the QR code with the phone camera, or type the address into its browser.'),
      h('li', {}, 'The browser warns that the connection is not private, because LAN Share uses its own certificate. ' +
        'Tap Advanced → Proceed (Android) or Show Details → visit this website (iPhone). This is needed only once.'),
      h('li', {}, "Enter this PC's LAN Share password."),
    ),
    problem ? null : h('p', { class: 'hint' },
      'The phone can download from all shared folders and upload into folders set to Read & write. The connection is encrypted.'),
    h('div', { class: 'modal-actions' }, h('button', { class: 'btn primary', onclick: close }, 'Done')),
  ]);
}

function settingsDialog(firstRun = false): void {
  const s = state.settings!;
  const name = h('input', { type: 'text', value: s.deviceName, maxLength: 64 });
  const pw = h('input', { type: 'password', autocomplete: 'new-password' });
  const pw2 = h('input', { type: 'password', autocomplete: 'new-password' });
  const allow = h('input', { type: 'checkbox', checked: s.allowConnections });
  const err = h('div', { class: 'error-text' });
  let folders: SharedFolder[] = s.sharedFolders.map((f) => ({ ...f }));
  const folderList = h('div', { class: 'folder-list' });
  const sessionList = h('div', { class: 'folder-list' });

  const renderFolders = () => {
    folderList.replaceChildren(
      ...(folders.length
        ? folders.map((f, i) => {
            const mode = h('select', {
                onchange: (ev: Event) => (f.readOnly = (ev.target as HTMLSelectElement).value === 'ro'),
              },
              h('option', { value: 'ro', selected: f.readOnly }, 'Read only'),
              h('option', { value: 'rw', selected: !f.readOnly }, 'Read & write'));
            return h('div', { class: 'folder-item' },
              h('span', { class: 'folder' }, svg(ICONS.folder)),
              h('span', { class: 'path', title: f.path }, f.path),
              mode,
              iconButton(ICONS.close, 'Stop sharing', () => {
                folders.splice(i, 1);
                renderFolders();
              }));
          })
        : [h('div', { class: 'hint' }, 'No folders shared yet. Other PCs will see an empty list.')]),
    );
  };

  const renderSessions = () => {
    sessionList.replaceChildren(
      ...(state.sessions.length
        ? state.sessions.map((x) => h('div', { class: 'folder-item' },
            h('span', { class: 'path' }, `${x.clientName} · ${x.ip}`),
            h('span', { class: 'hint' }, `since ${new Date(x.since).toLocaleTimeString()}`),
            h('button', { class: 'btn small danger', onclick: async () => {
              await api.revokeSession(x.id);
              state.sessions = await api.listSessions();
              renderSessions();
            } }, 'Disconnect')))
        : [h('div', { class: 'hint' }, 'No PCs are connected to this PC right now.')]),
    );
  };
  renderFolders();
  renderSessions();

  const save = h('button', { class: 'btn primary', type: 'submit' }, firstRun ? 'Save and start' : 'Save');

  modal((close) => [
    h('h2', {}, firstRun ? 'Set up this PC' : 'Settings'),
    firstRun ? h('p', { class: 'lead' }, 'Give this PC a name and a password. Other PCs must enter this password before they can see your shared folders.') : null,
    h('form', {
        style: 'display:flex;flex-direction:column;gap:12px',
        onsubmit: async (ev: Event) => {
          ev.preventDefault();
          err.textContent = '';
          if (!name.value.trim()) return void (err.textContent = 'Please enter a PC name');
          const needPassword = !s.hasPassword;
          if (needPassword && !pw.value) return void (err.textContent = 'Please choose a password');
          if (pw.value || pw2.value) {
            if (pw.value !== pw2.value) return void (err.textContent = 'Passwords do not match');
            const r = await api.setPassword(pw.value);
            if (!r.ok) return void (err.textContent = r.error ?? 'Could not set password');
          }
          save.disabled = true;
          try {
            state.settings = await api.saveSettings({ deviceName: name.value, allowConnections: allow.checked, sharedFolders: folders });
            await refreshInfo();
            close();
            toast(pw.value && !needPassword ? 'Password changed. Connected PCs must log in again.' : 'Settings saved');
          } catch (e) {
            err.textContent = errorMessage(e);
          } finally {
            save.disabled = false;
          }
        },
      },
      h('div', { class: 'field' }, h('label', {}, 'PC name (shown to other PCs)'), name),
      h('div', { class: 'row' },
        h('div', { class: 'field' }, h('label', {}, s.hasPassword ? 'New password (optional)' : 'Password'), pw),
        h('div', { class: 'field' }, h('label', {}, 'Confirm password'), pw2)),
      h('div', { class: 'hint' }, s.hasPassword
        ? 'Leave blank to keep the current password. Changing it signs out every connected PC.'
        : 'At least 6 characters. You will share this with people you want to give access.'),
      h('div', { class: 'divider' }),
      h('div', { class: 'field' }, h('label', {}, 'Shared folders')),
      folderList,
      h('div', {}, h('button', { class: 'btn', type: 'button', onclick: async () => {
        const p = await api.pickFolder();
        if (p && !folders.some((f) => f.path === p)) {
          folders.push({ id: '', name: p.split(/[\\/]/).filter(Boolean).pop() ?? p, path: p, readOnly: true });
          renderFolders();
        }
      } }, '+ Add folder')),
      h('label', { class: 'check' }, allow, 'Allow other PCs to connect to this PC'),
      firstRun ? null : h('div', { class: 'divider' }),
      firstRun ? null : h('div', { class: 'field' }, h('label', {}, 'PCs connected to this PC')),
      firstRun ? null : sessionList,
      err,
      h('div', { class: 'modal-actions' },
        firstRun ? h('button', { class: 'btn', type: 'button', onclick: close }, 'Later') : h('button', { class: 'btn', type: 'button', onclick: close }, 'Cancel'),
        save),
    ),
  ]);
}

// ---------- Startup ----------

async function refreshInfo(): Promise<void> {
  state.info = await api.getInfo();
  renderThisPc();
  renderNetworkWarning();
  renderLocal();
}

async function init(): Promise<void> {
  $('settings-btn').append(svg(ICONS.gear));
  $('settings-btn').addEventListener('click', async () => {
    state.settings = await api.getSettings();
    state.sessions = await api.listSessions();
    settingsDialog();
  });
  $('manual-btn').addEventListener('click', manualDialog);
  $('phone-btn').addEventListener('click', phoneDialog);
  $('send-btn').addEventListener('click', uploadSelected);
  $('fetch-btn').addEventListener('click', () => downloadSelected());
  setupDropTarget($('local-pane'), 'local');
  setupDropTarget($('remote-pane'), 'remote');

  api.onInfo((info) => {
    state.info = info;
    renderThisPc();
    renderNetworkWarning();
  });
  api.onDevices((devices) => {
    state.devices = devices;
    renderDevices();
    if (state.remote.deviceId) renderRemote();
  });
  api.onTransfers((transfers) => {
    state.transfers = transfers;
    renderTransfers();
    refreshAfterTransfers();
  });
  api.onSessions((sessions) => {
    state.sessions = sessions;
    refreshInfo();
  });
  api.onDisconnected((id) => {
    if (state.remote.deviceId === id) {
      state.remote.deviceId = null;
      renderRemote();
      renderActions();
      toast('Disconnected from the remote PC', 'error');
    }
  });

  [state.settings, state.devices] = await Promise.all([api.getSettings(), api.listDevices()]);
  await refreshInfo();
  renderDevices();
  renderRemote();
  renderTransfers();
  renderActions();
  loadLocal(await api.localHome());

  if (!state.settings.hasPassword) settingsDialog(true);
  // The server starts asynchronously; refresh the status shortly after launch.
  setTimeout(refreshInfo, 1500);
}

init();
