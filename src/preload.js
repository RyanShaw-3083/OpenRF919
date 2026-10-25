'use strict';
/**
 * preload.js —— 主进程和网页之间的"桥"
 * 网页里只能通过 window.c919.xxx 调用下面这些函数，拿不到完整的 Node / Electron 能力（安全）。
 */
const { contextBridge, ipcRenderer } = require('electron');

const on = (ch) => (cb) => {
  const h = (_e, payload) => cb(payload);
  ipcRenderer.on(ch, h);
  return () => ipcRenderer.removeListener(ch, h); // 返回取消订阅函数
};

contextBridge.exposeInMainWorld('c919', {
  info: () => ipcRenderer.invoke('app:info'),
  scan: (ms) => ipcRenderer.invoke('ble:scan', ms),
  connect: (id) => ipcRenderer.invoke('ble:connect', id),
  disconnect: () => ipcRenderer.invoke('ble:disconnect'),
  setAutoReconnect: (on_) => ipcRenderer.invoke('ble:autoReconnect', on_),
  key: (name) => ipcRenderer.invoke('ble:key', name),
  setFreq: (band, k) => ipcRenderer.invoke('ble:setFreq', band, k),
  setBand: (band) => ipcRenderer.invoke('ble:setBand', band),
  sleep: (min) => ipcRenderer.invoke('ble:sleep', min),
  squelch: (lv) => ipcRenderer.invoke('ble:squelch', lv),
  timeSync: () => ipcRenderer.invoke('ble:timeSync'),
  alarm: (h, m, on_, kind) => ipcRenderer.invoke('ble:alarm', h, m, on_, kind),
  raw: (hex, fixSum) => ipcRenderer.invoke('ble:raw', hex, fixSum),
  onStatus: on('radio:status'),
  onConn: on('radio:conn'),
  onLog: on('radio:log'),
});
