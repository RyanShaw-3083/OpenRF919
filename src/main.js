'use strict';
/**
 * main.js —— Electron 主进程
 * ===========================
 * Electron 有两种进程：
 *   - 主进程（本文件）：有完整的 Node.js 能力，能用蓝牙、写文件。界面不在这里。
 *   - 渲染进程（renderer/ 下的网页）：负责界面、音频频谱。出于安全，它不能直接用 Node。
 * 两边通过 IPC（进程间通信）说话，preload.js 是中间那座"桥"。
 *
 * 数据流：
 *   收音机 --通知--> ble.js 'data' --> FrameSplitter 切帧 --> FrameParser 解析
 *          --> 写日志文件 + 把状态快照发给界面（'radio:status'）
 *   界面点按钮 --> preload --> ipcMain.handle('ble:key') --> protocol.keyFrame --> ble.send
 */

const { app, BrowserWindow, ipcMain, session } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const P = require('./protocol');
const { C919Ble } = require('./ble');

// ---------------------------------------------------------------------------
// 日志文件：所有 RX / TX 都带毫秒时间戳追加写入，终端保持干净。
//   默认写到当前目录 ./c919_rx.log（和 Python 版一致，方便 `tail -f c919_rx.log`），
//   当前目录不可写时退到 Electron 的 userData 目录。可用环境变量 C919_LOG 指定路径。
// ---------------------------------------------------------------------------
let logStream = null;
let logPath = '';
function openLog() {
  const candidates = [process.env.C919_LOG, path.join(process.cwd(), 'c919_rx.log'),
    path.join(app.getPath('userData'), 'c919_rx.log')].filter(Boolean);
  for (const p of candidates) {
    try {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.accessSync(path.dirname(p), fs.constants.W_OK);
      logStream = fs.createWriteStream(p, { flags: 'a' });
      logPath = p;
      return;
    } catch { /* 试下一个 */ }
  }
}
function ts() {
  const d = new Date();
  const z = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())} ${z(d.getHours())}:${z(d.getMinutes())}:${z(d.getSeconds())}.${z(d.getMilliseconds(), 3)}`;
}
function logLine(kind, text) {
  const line = `${ts()} ${kind} ${text}\n`;
  if (logStream) logStream.write(line);
  // 同时把最近的日志推给界面的"帧日志"小窗口（可选看）
  if (win && !win.isDestroyed()) win.webContents.send('radio:log', line.trimEnd());
}

// ---------------------------------------------------------------------------
// 收音机连接 + 协议解析
// ---------------------------------------------------------------------------
let win = null;
const ble = new C919Ble();
const splitter = new P.FrameSplitter();
let parser = new P.FrameParser();

ble.on('log', (m) => logLine('INFO', m));
ble.on('tx', (buf) => logLine('TX', P.hex(buf)));
ble.on('state', (state, detail) => {
  logLine('CONN', `${state} ${detail || ''}`);
  if (state === 'connecting') { splitter.reset(); parser = new P.FrameParser(); } // 新连接重新建状态
  send('radio:conn', { state, detail, backend: ble.backendName });
});
ble.on('data', (chunk) => {
  for (const f of splitter.push(chunk)) {
    let ev;
    try { ev = parser.feed(f); } catch (e) { ev = { type: 'error', desc: `解析出错 ${e.message}` }; }
    if (ev.type === 'partial') { logLine('RX', P.hex(f)); continue; } // 分段文字的中间段
    logLine('RX', `${P.hex(f).padEnd(40)} ${ev.desc}`);
    scheduleStatus(ev.type);
    if (ev.type === 'disconnect') ble.disconnect(); // 收音机要求断开（App 也是这么做的）
  }
});

// 状态快照节流：一批帧来的时候不必每帧都刷界面，攒 30ms 发一次
let statusTimer = null;
const changed = new Set();
function scheduleStatus(type) {
  changed.add(type);
  if (statusTimer) return;
  statusTimer = setTimeout(() => {
    statusTimer = null;
    send('radio:status', { status: parser.st, changed: [...changed] });
    changed.clear();
  }, 30);
}

function send(ch, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(ch, payload);
}

// ---------------------------------------------------------------------------
// IPC：界面能调用的操作。每个都返回 {ok, error?}，界面据此提示。
// ---------------------------------------------------------------------------
function wrap(fn) {
  return async (_e, ...args) => {
    try { return { ok: true, result: await fn(...args) }; } catch (e) {
      logLine('ERR', String(e && e.message ? e.message : e));
      return { ok: false, error: String(e && e.message ? e.message : e) };
    }
  };
}
ipcMain.handle('app:info', wrap(() => ({
  logPath, backend: ble.backendName, mock: ble.backendName === 'mock',
  fakeAudio: process.env.C919_FAKE_AUDIO === '1',
  keys: P.KEYS, keyDesc: P.KEY_DESC, bands: P.BANDS, buttons: P.BUTTONS,
  bandGuess: P.BAND_FORMAT_GUESS, workModeCn: P.WORK_MODE_CN,
})));
ipcMain.handle('ble:scan', wrap((ms) => ble.scan(ms || 8000)));
ipcMain.handle('ble:connect', wrap((id) => ble.connect(id || null)));
ipcMain.handle('ble:disconnect', wrap(() => ble.disconnect()));
ipcMain.handle('ble:autoReconnect', wrap((on) => { ble.autoReconnect = !!on; }));
ipcMain.handle('ble:key', wrap((name) => ble.send(P.keyFrame(name))));
ipcMain.handle('ble:setFreq', wrap((band, k) => ble.send(P.setFreqFrame(band, k))));
ipcMain.handle('ble:setBand', wrap((band) => ble.send(P.setBandFrame(band))));
ipcMain.handle('ble:sleep', wrap((min) => ble.send(P.sleepFrame(min))));
ipcMain.handle('ble:squelch', wrap((lv) => ble.send(P.squelchFrame(lv))));
ipcMain.handle('ble:timeSync', wrap(() => ble.send(P.timeSyncFrame(new Date()))));
ipcMain.handle('ble:alarm', wrap((h, m, on, kind) => ble.send(P.alarmFrame(h, m, on, kind))));
// 原始帧：给"实验区"用。fixSum=true 时自动补 LEN 和 SUM（只需输入 CMD + payload）
ipcMain.handle('ble:raw', wrap((hexStr, fixSum) => {
  const b = P.fromHex(hexStr);
  const f = fixSum ? P.buildFrame(b[0], [...b.subarray(1)]) : b;
  return ble.send(f).then(() => P.hex(f));
}));

// 兜底：任何没接住的异常都写日志，不让主进程崩掉
process.on('uncaughtException', (e) => logLine('ERR', `未捕获异常：${e && e.stack ? e.stack : e}`));
process.on('unhandledRejection', (e) => logLine('ERR', `未处理的 Promise 拒绝：${e && e.stack ? e.stack : e}`));

// ---------------------------------------------------------------------------
// 窗口
// ---------------------------------------------------------------------------
function createWindow() {
  win = new BrowserWindow({
    width: 1400, height: 880, minWidth: 1000, minHeight: 640,
    backgroundColor: '#1e1e1e', title: 'C919 控制台',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, // 网页和 Node 隔离，网页只能用 preload 暴露的 API
      nodeIntegration: false,
      backgroundThrottling: false, // 窗口在后台时频谱也照常刷新
    },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // 截图模式（只给开发 / 预览用）：C919_SCREENSHOT=/path/to/x.png
  if (process.env.C919_SCREENSHOT) {
    win.webContents.once('did-finish-load', async () => {
      if (process.env.C919_MOCK === '1') ble.connect(null).catch(() => {});
      await new Promise((r) => setTimeout(r, Number(process.env.C919_SCREENSHOT_DELAY || 7000)));
      // 冒烟测试（开发用）：模拟用户操作——在"十分位"上滚一格、点音量+、直接输入 99.5 调谐
      if (process.env.C919_SMOKE === '1') {
        await win.webContents.executeJavaScript(`(async () => {
          const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
          const d = document.querySelector('#freqDigits .d[data-p="1"]');
          d.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true, cancelable: true }));
          await sleep(800);
          document.querySelector('[data-key="VOL_UP"]').click();
          await sleep(500);
          document.getElementById('freqInput').value = '99.5';
          document.getElementById('btnTune').click();
          await sleep(1500);
        })()`);
      }
      const img = await win.webContents.capturePage();
      fs.writeFileSync(process.env.C919_SCREENSHOT, img.toPNG());
      app.quit();
    });
  }
}

app.whenReady().then(() => {
  openLog();
  logLine('INFO', `C919 控制台启动，后端=${ble.backendName}，日志=${logPath}`);
  // 麦克风 / line-in 权限：本地应用，直接允许 "media"（getUserMedia 需要）
  session.defaultSession.setPermissionRequestHandler((_wc, perm, cb) => cb(perm === 'media'));
  session.defaultSession.setPermissionCheckHandler((_wc, perm) => perm === 'media');
  createWindow();
});

app.on('window-all-closed', async () => {
  await ble.destroy().catch(() => {});
  if (logStream) logStream.end();
  app.quit();
});
