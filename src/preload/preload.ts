// Exposes a narrow, typed API to the renderer. The renderer has no direct Node.js access.
import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { Api } from '../shared/api';

const invoke = (channel: string) => (...args: unknown[]) => ipcRenderer.invoke(channel, ...args);
const on = (channel: string) => (cb: (...args: any[]) => void) => {
  ipcRenderer.on(channel, (_e, ...args) => cb(...args));
};

const api: Api = {
  getInfo: invoke('getInfo'),
  fixNetwork: invoke('fixNetwork'),
  phoneLinks: invoke('phoneLinks'),
  getSettings: invoke('getSettings'),
  saveSettings: invoke('saveSettings'),
  setPassword: invoke('setPassword'),
  pickFolder: invoke('pickFolder'),
  listSessions: invoke('listSessions'),
  revokeSession: invoke('revokeSession'),
  listDevices: invoke('listDevices'),
  addManualDevice: invoke('addManualDevice'),
  connect: invoke('connect'),
  connectSaved: invoke('connectSaved'),
  disconnect: invoke('disconnect'),
  forgetIdentity: invoke('forgetIdentity'),
  remoteRoots: invoke('remoteRoots'),
  remoteList: invoke('remoteList'),
  localList: invoke('localList'),
  localHome: invoke('localHome'),
  openLocal: invoke('openLocal'),
  pathForFile: (file: File) => webUtils.getPathForFile(file),
  download: invoke('download'),
  upload: invoke('upload'),
  cancelTransfer: invoke('cancelTransfer'),
  clearTransfers: invoke('clearTransfers'),
  onInfo: on('info'),
  onDevices: on('devices'),
  onTransfers: on('transfers'),
  onSessions: on('sessions'),
  onDisconnected: on('disconnected'),
} as Api;

contextBridge.exposeInMainWorld('api', api);
