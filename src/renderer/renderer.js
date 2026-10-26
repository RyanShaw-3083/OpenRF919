'use strict';
/**
 * renderer.js —— 界面逻辑（运行在 Electron 的网页里）
 * ===================================================
 * 这里不能直接用蓝牙，只能通过 preload 暴露的 window.c919 调主进程：
 *   c919.key('POWER')            发按键
 *   c919.setFreq(band, K)        直接设频率
 *   c919.onStatus(cb)            收音机状态有变化时回调（主进程已经解析好）
 * 音频频谱（audio.js）完全在网页里跑，和蓝牙互不依赖。
 */
const $ = (id) => document.getElementById(id);
const api = window.c919;

let INFO = null; // 主进程给的常量表（KEYS、BANDS、BUTTONS……）
let ST = null; // 最新的收音机状态
let connected = false;

// 每个波段的显示格式标定：band → {unit, decimals, source:'radio'|'guess', verified}
// 只要在这个波段收到过一次频率帧，就用真机的格式（source = 'radio'）。
const calib = {};

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------
let toastTimer = null;
function toast(msg, ok = false) {
  const t = $('toast');
  t.textContent = msg; t.style.display = 'block';
  t.style.borderColor = ok ? 'var(--ok)' : 'var(--bad)';
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.style.display = 'none'; }, 3500);
}
/** 调主进程，失败就弹提示 */
async function call(fn, ...args) {
  const r = await fn(...args);
  if (!r.ok) toast(`操作失败：${r.error}`);
  return r;
}
function flash(el) { el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash'); }

// ---------------------------------------------------------------------------
// 1. 初始化
// ---------------------------------------------------------------------------
async function init() {
  INFO = (await api.info()).result;
  $('connHint').textContent = `后端：${INFO.backend}${INFO.mock ? '（模拟收音机）' : ''}`;
  $('logPath').textContent = `日志文件：${INFO.logPath}（可 tail -f）`;

  // 波段下拉框（收到 0x15 帧后会按"本机支持的波段"重新过滤）
  fillBands(Object.keys(INFO.bands).map(Number).filter((b) => b <= 8));

  // 睡眠定时：0（关）/10/20…/90
  for (let m = 0; m <= 90; m += 10) $('sleepSel').add(new Option(m ? `${m} 分钟` : '关闭', m));

  // "全部按键"网格：KEYS 表里每个键一个按钮
  const grid = $('allKeys');
  for (const [name, code] of Object.entries(INFO.keys)) {
    const b = document.createElement('button');
    b.textContent = name; b.dataset.key = name;
    b.title = `0x${code.toString(16).padStart(2, '0')}  ${INFO.keyDesc[name] || ''}`;
    grid.appendChild(b);
  }

  // 所有 data-key 按钮：点一下发对应按键
  document.querySelectorAll('[data-key]').forEach((b) => b.addEventListener('click', async () => {
    flash(b);
    await call(api.key, b.dataset.key);
  }));
  // data-btn：App 的 5 个"可变按钮"，短按/长按发不同键码（见 protocol.BUTTONS）
  document.querySelectorAll('[data-btn]').forEach((b) => b.addEventListener('click', async () => {
    flash(b);
    const def = INFO.buttons[b.dataset.btn];
    await call(api.key, b.dataset.long === '1' ? def.longKey : def.key);
  }));

  bindConnection();
  bindFrequency();
  bindMisc();
  setConnected(false, 'idle');

  api.onStatus(({ status, changed }) => onStatus(status, changed));
  api.onConn(({ state, detail }) => onConn(state, detail));
  api.onLog((line) => appendLog(line));

  initLayout();
  initAudio();
  drawHistory();
}

function fillBands(list) {
  const sel = $('bandSel');
  const cur = sel.value;
  sel.innerHTML = '';
  for (const b of list) sel.add(new Option(`${INFO.bands[b]}${b === 0 ? '' : ''}`, b));
  if (cur !== '' && list.includes(Number(cur))) sel.value = cur;
}

// ---------------------------------------------------------------------------
// 2. 连接
// ---------------------------------------------------------------------------
function bindConnection() {
  $('btnScan').onclick = async () => {
    $('btnScan').disabled = true;
    const r = await call(api.scan, 8000);
    $('btnScan').disabled = false;
    if (!r.ok) return;
    const sel = $('devSel');
    sel.innerHTML = '<option value="">（自动按名字查找）</option>';
    for (const d of r.result) sel.add(new Option(`${d.name}  ${d.id}  ${d.rssi ?? ''}dBm`, d.id));
    if (r.result.length) sel.selectedIndex = 1; else toast('没扫到收音机：确认已开机、在附近，手机 App 没占着连接');
  };
  $('btnConnect').onclick = () => call(api.connect, $('devSel').value || null);
  $('btnDisconnect').onclick = () => call(api.disconnect);
  $('chkAuto').onchange = (e) => api.setAutoReconnect(e.target.checked);
}

const CONN_CN = { idle: '未连接', scanning: '扫描中…', connecting: '连接中…', connected: '已连接',
  reconnecting: '重连中…', disconnected: '已断开', error: '出错' };
/** 连接状态 → 圆点颜色：ok 绿 / warn 琥珀闪烁 / bad 红 */
function connClass(on, state) {
  return on ? 'ok' : (state === 'connecting' || state === 'reconnecting' || state === 'scanning') ? 'warn' : 'bad';
}
function onConn(state, detail) {
  setConnected(state === 'connected', state);
  // 左侧提示：后端名 + 状态圆点（文字放 tooltip），再加后端给的细节
  const h = $('connHint'); const txt = CONN_CN[state] || state;
  h.textContent = `后端：${INFO.backend}　`;
  const dot = document.createElement('i');
  dot.className = `dot sm ${connClass(state === 'connected', state)}`; dot.title = txt; dot.setAttribute('role', 'img'); dot.setAttribute('aria-label', txt);
  h.appendChild(dot);
  h.appendChild(document.createTextNode(` ${detail || ''}`));
  h.title = `${txt} ${detail || ''}`.trim();
  if (state === 'error') toast(detail || '连接出错');
}
function setConnected(on, state) {
  connected = on;
  const el = $('stConn'); const txt = CONN_CN[state] || state;
  el.className = `dot ${connClass(on, state)}`;
  el.setAttribute('aria-label', txt); el.title = txt; $('stConnBox').title = `连接：${txt}`;
  // 没连接时，所有发指令的按钮都禁用（音频部分不受影响）
  document.querySelectorAll('#side [data-key], #side [data-btn], #btnSetBand, #btnSq, #btnSleep, #btnTime, #btnAlarmOn, #btnAlarmOff, #btnRaw, #btnTune')
    .forEach((b) => { b.disabled = !on; });
  $('btnConnect').disabled = on;
  $('btnDisconnect').disabled = !on && state !== 'reconnecting';
}

// ---------------------------------------------------------------------------
// 3. 频率显示 / 滚轮调谐 / 直接输入
// ---------------------------------------------------------------------------
// 显示规则：频率帧里的 K 就是屏幕上的数字去掉小数点（106.80 ↔ K=10680）。
// 所以"滚轮调第 p 位"= K 加减 10^p，和波段无关；单位换算只在"直接输入"时才需要。
let pendingK = null; // 用户在滚轮/输入后、收音机还没回报之前的目标 K
let pendingTimer = null; let pendingGuard = null;

function bandFormat(band) {
  if (calib[band]) return calib[band];
  const g = INFO.bandGuess[band] || { unit: 'MHz', decimals: 3 };
  return { unit: g.unit, decimals: g.decimals, source: 'guess', verified: !!g.verified };
}

function renderFreq() {
  const box = $('freqDigits');
  if (!ST || ST.k === null || ST.band === null) { box.textContent = '---.--'; return; }
  if (ST.freqText === 'ALERT') { box.textContent = 'ALERT'; return; }
  const fmt = bandFormat(ST.band);
  const dec = fmt.decimals;
  const K = pendingK ?? ST.k;
  const s = String(K).padStart(dec + 4, '0'); // 整数部分至少 4 位，前导 0 暗色显示（SDR# 风格）
  const intLen = s.length - dec;
  box.innerHTML = '';
  let leading = true;
  for (let i = 0; i < s.length; i++) {
    const p = s.length - 1 - i; // 这一位在 K 里的"权"：10^p
    if (i === intLen && dec > 0) {
      const dot = document.createElement('span'); dot.className = 'dot'; dot.textContent = '.'; box.appendChild(dot);
    }
    const d = document.createElement('span');
    d.className = 'd'; d.textContent = s[i]; d.dataset.p = p;
    if (leading && s[i] === '0' && i < intLen - 1) d.classList.add('lead'); else leading = false;
    box.appendChild(d);
  }
  box.classList.toggle('pending', pendingK !== null);
  $('bandTag').textContent = ST.bandName || '--';
  $('freqUnit').textContent = ST.unit || fmt.unit;
  $('entryUnit').textContent = fmt.unit;
  const tag = $('calibTag');
  tag.style.display = '';
  if (ST.band === 0) { tag.textContent = ''; tag.className = 'tag'; tag.title = ''; tag.style.display = 'none'; } else if (fmt.source === 'radio') {
    tag.textContent = '真机帧标定'; tag.className = 'tag ok'; tag.title = '格式取自该波段收到的频率帧（显示规则从 App 代码推出）';
  } else { tag.textContent = '推断'; tag.className = 'tag warn'; tag.title = '还没收到过这个波段的频率帧，小数位数是按说明书步进猜的'; }
  $('entryHint').textContent = ST.band === 0 ? 'FM：K = round(MHz×100)'
    : `${ST.bandName}：K = round(值×10^${dec})【推断】`;
}

/** 改 K：先在界面上显示（黄色 = 等待收音机确认），120ms 内没有新滚动再真正发出去 */
function tuneTo(K) {
  if (!ST || ST.band === null) return;
  pendingK = Math.max(0, K);
  renderFreq();
  clearTimeout(pendingTimer);
  pendingTimer = setTimeout(async () => {
    pendingTimer = null;
    await call(api.setFreq, ST.band, pendingK);
    clearTimeout(pendingGuard);
    // 2 秒还没收到回报，就放弃等待，恢复显示收音机的真实频率
    pendingGuard = setTimeout(() => { pendingK = null; renderFreq(); }, 2000);
  }, 120);
}

function bindFrequency() {
  const box = $('freqDigits');
  box.addEventListener('wheel', (e) => {
    const d = e.target.closest('.d');
    if (!d || !connected) return;
    e.preventDefault();
    const step = 10 ** Number(d.dataset.p);
    tuneTo((pendingK ?? ST.k) + (e.deltaY < 0 ? step : -step));
  }, { passive: false });
  // 点数字上半部分 = 加，下半部分 = 减（SDR# 的习惯）
  box.addEventListener('mousedown', (e) => {
    const d = e.target.closest('.d');
    if (!d || !connected) return;
    const r = d.getBoundingClientRect();
    const step = 10 ** Number(d.dataset.p);
    tuneTo((pendingK ?? ST.k) + (e.clientY < r.top + r.height / 2 ? step : -step));
  });

  const doTune = async () => {
    const v = parseFloat($('freqInput').value);
    if (!Number.isFinite(v)) return toast('请输入数字，例如 99.5');
    const band = ST && ST.band !== null ? ST.band : Number($('bandSel').value);
    const fmt = bandFormat(band);
    const K = Math.round(v * 10 ** fmt.decimals); // FM：K = round(MHz*100)
    if (fmt.source !== 'radio' && band !== 0) toast(`${INFO.bands[band]} 的换算是推断的（K=${K}），收到频率帧后会自动校准`, true);
    pendingK = K; renderFreq();
    await call(api.setFreq, band, K);
    clearTimeout(pendingGuard);
    pendingGuard = setTimeout(() => { pendingK = null; renderFreq(); }, 2000);
  };
  $('btnTune').onclick = doTune;
  $('freqInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') doTune(); });
  $('btnSetBand').onclick = () => call(api.setBand, Number($('bandSel').value));
}

// ---------------------------------------------------------------------------
// 4. 其它控制
// ---------------------------------------------------------------------------
function bindMisc() {
  $('sqRange').oninput = () => { $('sqVal').textContent = $('sqRange').value; };
  $('btnSq').onclick = () => call(api.squelch, Number($('sqRange').value));
  $('btnSleep').onclick = () => call(api.sleep, Number($('sleepSel').value));
  $('btnTime').onclick = async () => { if ((await call(api.timeSync)).ok) toast('已发送时间同步', true); };
  const alarm = (on) => {
    const [h, m] = $('alarmTime').value.split(':').map(Number);
    return call(api.alarm, h, m, on, Number($('alarmKind').value));
  };
  $('btnAlarmOn').onclick = () => alarm(true);
  $('btnAlarmOff').onclick = () => alarm(false);
  $('btnRaw').onclick = async () => {
    const r = await call(api.raw, $('rawHex').value, $('chkFix').checked);
    if (r.ok) toast(`已发送 ${r.result}`, true);
  };
  // 频谱 / 瀑布之间的分隔条可以拖动
  const sp = $('splitter');
  sp.addEventListener('mousedown', (e) => {
    const wrap = $('specWrap'); const startY = e.clientY; const startH = wrap.offsetHeight;
    const mv = (ev) => { wrap.style.flex = `0 0 ${Math.max(100, startH + ev.clientY - startY)}px`; };
    const up = () => { removeEventListener('mousemove', mv); removeEventListener('mouseup', up); };
    addEventListener('mousemove', mv); addEventListener('mouseup', up);
  });
}

// ---------------------------------------------------------------------------
// 4b. 可拖动分隔条：左栏宽 / 右栏宽 / 右栏上下比例，存在 localStorage 'layout'
//     画布都挂了 ResizeObserver，尺寸一变会自动重排。双击分隔条恢复默认。
// ---------------------------------------------------------------------------
const LAYOUT_DEF = { lw: 270, rw: 280, rth: 0.5 };
const LAYOUT_MIN = { side: 180, right: 220, center: 360, pane: 120 };
let layout = { ...LAYOUT_DEF };
function applyLayout() {
  const W = window.innerWidth;
  // 先保证中间区至少 center 宽：左右栏按比例让出
  let { lw, rw } = layout;
  lw = Math.max(LAYOUT_MIN.side, Math.min(520, lw)); rw = Math.max(LAYOUT_MIN.right, Math.min(600, rw));
  const over = lw + rw + 10 + LAYOUT_MIN.center - W;
  if (over > 0) {
    const room = Math.max(0, (lw - LAYOUT_MIN.side) + (rw - LAYOUT_MIN.right));
    const k = room ? Math.min(1, over / room) : 0;
    lw -= (lw - LAYOUT_MIN.side) * k; rw -= (rw - LAYOUT_MIN.right) * k;
  }
  const app = $('app');
  app.style.setProperty('--lw', `${Math.round(lw)}px`); app.style.setProperty('--rw', `${Math.round(rw)}px`);
  const rh = $('right').clientHeight || 600;
  const top = Math.max(LAYOUT_MIN.pane, Math.min(rh - LAYOUT_MIN.pane - 5, layout.rth * rh));
  app.style.setProperty('--rth', `${Math.round(top)}px`);
}
function saveLayout() { localStorage.setItem('layout', JSON.stringify(layout)); }
function dragHelper(el, axis, onMove) {
  el.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const start = { x: e.clientX, y: e.clientY };
    document.body.classList.add('dragging', axis === 'x' ? 'col' : 'row'); el.classList.add('drag');
    const mv = (ev) => { onMove(ev.clientX - start.x, ev.clientY - start.y, ev); applyLayout(); };
    const up = () => {
      removeEventListener('mousemove', mv); removeEventListener('mouseup', up);
      document.body.classList.remove('dragging', 'col', 'row'); el.classList.remove('drag'); saveLayout();
    };
    onMove.begin && onMove.begin();
    addEventListener('mousemove', mv); addEventListener('mouseup', up);
  });
}
function initLayout() {
  try { layout = { ...LAYOUT_DEF, ...(JSON.parse(localStorage.getItem('layout') || '{}') || {}) }; } catch { layout = { ...LAYOUT_DEF }; }
  let base = null;
  const lMove = (dx) => { layout.lw = base.lw + dx; }; lMove.begin = () => { base = { lw: $('side').offsetWidth }; };
  const rMove = (dx) => { layout.rw = base.rw - dx; }; rMove.begin = () => { base = { rw: $('right').offsetWidth }; };
  const vMove = (_dx, dy) => { const h = $('right').clientHeight; layout.rth = Math.max(0.05, Math.min(0.95, (base.top + dy) / h)); };
  vMove.begin = () => { base = { top: $('rightTop').offsetHeight }; };
  dragHelper($('splitL'), 'x', lMove); dragHelper($('splitM'), 'x', rMove); dragHelper($('splitR'), 'y', vMove);
  $('splitL').ondblclick = () => { layout.lw = LAYOUT_DEF.lw; applyLayout(); saveLayout(); };
  $('splitM').ondblclick = () => { layout.rw = LAYOUT_DEF.rw; applyLayout(); saveLayout(); };
  $('splitR').ondblclick = () => { layout.rth = LAYOUT_DEF.rth; applyLayout(); saveLayout(); };
  addEventListener('resize', applyLayout);
  applyLayout();
}

// ---------------------------------------------------------------------------
// 5. 收到状态 → 刷新界面
// ---------------------------------------------------------------------------
const hist = []; // [{t, rssi, snr}]
function onStatus(st, changed) {
  ST = st;
  if (changed.includes('freq') && st.band !== null && st.freqText && st.freqText !== 'ALERT') {
    // 用真机帧标定这个波段的显示格式
    const dec = st.freqText.includes('.') ? st.freqText.length - st.freqText.indexOf('.') - 1 : 0;
    calib[st.band] = { unit: st.unit, decimals: dec, source: 'radio', verified: st.band === 0 };
    // 收音机回报的频率等于我们刚发的目标 → 结束"等待确认"状态
    if (pendingK !== null && pendingK === st.k) { pendingK = null; clearTimeout(pendingGuard); }
    $('bandSel').value = String(st.band);
  }
  if (changed.includes('bands') && st.supportedBands.length) fillBands(st.supportedBands);
  renderFreq();

  const set = (id, v) => { $(id).textContent = v ?? '-'; };
  set('topRssi', st.rssi ?? '--'); set('topSnr', st.snr ?? '--');
  set('stRssi', st.rssi); set('stSnr', st.snr);
  set('stDemod', st.demod); set('stBw', st.bandwidth);
  set('stBatt', st.battery === null ? '-' : `${st.battery}/3${st.charging ? ' ⚡' : ''}`);
  set('stTemp', st.info.TEMPRATURE || st.info.TEMPERATURE);
  const ver = /Firmware version:\s*([\d.]+)/.exec(st.version || '');
  set('stVer', ver ? ver[1] : '-');
  set('workMode', st.workMode ? `${INFO.workModeCn[st.workMode] || st.workMode}` : '-');
  set('infoStep', st.info.STEP); set('infoDeemp', st.info['DE-EMP']);
  set('infoAtt', st.info.ATT); set('infoAnt', st.info.ANT);
  set('infoStereo', st.info.STEREO ? 'STEREO' : st.info.MONO ? 'MONO' : '-'); set('infoEq', st.info.EQ);
  if (st.volume !== null) { set('volVal', st.volume); $('volFill').style.width = `${Math.min(100, st.volume / 32 * 100)}%`; }
  set('presetNo', st.preset ?? (st.presetState === 3 ? '- -' : '-'));
  set('sqText', [st.texts.text9, st.texts.text10].filter(Boolean).join(' '));
  if (st.sqMax) $('sqRange').max = st.sqMax;
  if (st.sleepLeft) set('sleepLeft', `剩 ${st.sleepLeft} 分`); else set('sleepLeft', '');
  if (st.alarm) set('alarmInfo', `${st.alarm.hour}:${String(st.alarm.minute).padStart(2, '0')} ${['关', '开', '响铃', '贪睡'][st.alarm.state] || st.alarm.state}`);

  // App 可变按钮的文字（C919：BW-DM / ANT-ATT / V-UHF / MUTE / LOCK）放进 tooltip，按钮 3 直接显示
  document.querySelectorAll('[data-btn]').forEach((b) => {
    const lbl = st.buttonLabels[b.dataset.btn];
    if (lbl) {
      b.title = b.title.replace(/\s*【收音机按钮：.*】$/, '') + `　【收音机按钮：${lbl}】`;
      if (b.dataset.btn === '3' && !b.dataset.long) b.textContent = lbl;
    }
    if (st.buttonsEnabled && b.dataset.btn in st.buttonsEnabled) b.disabled = !connected || !st.buttonsEnabled[b.dataset.btn];
  });
  document.querySelectorAll('[data-btn="4"]').forEach((b) => b.classList.toggle('blink', st.sosBlink === 1));
  document.querySelectorAll('[data-btn="5"]').forEach((b) => b.classList.toggle('blink', st.funcBlink === 1));
  if (changed.includes('sqdialog') && st.sqDialog) toast('收音机请求选择静噪等级：调滑块后点"设置"', true);

  if (changed.includes('signal') && st.rssi !== null) {
    hist.push({ t: Date.now(), rssi: st.rssi, snr: st.snr ?? 0 });
    while (hist.length > 180) hist.shift();
    drawHistory();
  }
}

/** 底部小图：最近 180 个 RSSI（绿）/ SNR（黄）读数（约 3 分钟） */
function drawHistory() {
  const c = $('history'); const x = c.getContext('2d');
  const W = c.width, H = c.height;
  x.fillStyle = '#111'; x.fillRect(0, 0, W, H);
  if (hist.length < 2) { x.fillStyle = '#555'; x.font = '11px sans-serif'; x.fillText('RSSI / SNR 历史', 6, H / 2 + 4); return; }
  const max = Math.max(40, ...hist.map((h) => h.rssi));
  const line = (key, col) => {
    x.beginPath();
    hist.forEach((h, i) => {
      const px = W - (hist.length - 1 - i) * (W / 179);
      const py = H - 2 - (h[key] / max) * (H - 4);
      i ? x.lineTo(px, py) : x.moveTo(px, py);
    });
    x.strokeStyle = col; x.lineWidth = 1.4; x.stroke();
  };
  line('rssi', '#4ec94e'); line('snr', '#e6b422');
  x.fillStyle = '#888'; x.font = '10px monospace'; x.fillText(`${max}`, 2, 10);
}

const logLines = [];
function appendLog(line) {
  logLines.push(line);
  if (logLines.length > 200) logLines.shift();
  const v = $('logView');
  if (v.closest('details').open) { v.textContent = logLines.join('\n'); v.scrollTop = v.scrollHeight; }
}

// ---------------------------------------------------------------------------
// 6. 音频频谱
// ---------------------------------------------------------------------------
const engine = new window.AudioEngine();
let view = null;

/**
 * PipeWire 的设备名往往很长（"Monitor of Built-in Audio Analog Stereo"、
 * "USB PnP Sound Device Analog Mono" …），下拉框里截短显示，完整名字放 title。
 */
function shortLabel(s, max = 34) {
  s = String(s).replace(/\s*\([0-9a-f]{4}:[0-9a-f]{4}\)\s*$/i, ''); // 去掉 "(0d8c:0014)" 这种 USB ID
  return s.length <= max ? s : `${s.slice(0, max - 12)}…${s.slice(-11)}`;
}
function syncAudioTitle() {
  const sel = $('audioSel'); const o = sel.options[sel.selectedIndex];
  sel.title = o ? (o.dataset.full || o.text) : '';
}

async function refreshDevices() {
  const sel = $('audioSel');
  const list = await engine.listDevices();
  const saved = JSON.parse(localStorage.getItem('audioDev') || 'null');
  sel.innerHTML = '';
  for (const d of list) { const o = new Option(shortLabel(d.label), d.id); o.title = d.label; o.dataset.full = d.label; sel.add(o); }
  // 记住上次的选择：deviceId 可能变（重启 / 重新配对后），所以 id 对不上时再按名字找
  if (saved) {
    const hit = list.find((d) => d.id === saved.id) || list.find((d) => d.label === saved.label);
    if (hit) sel.value = hit.id;
  }
  syncAudioTitle();
  return list;
}

let meter = null;

// ---------------------------------------------------------------------------
// 7. 弱信号处理（降噪 + 增益 + 干/湿混合），参数存在 localStorage 'dsp'
// ---------------------------------------------------------------------------
const BAND_PRESETS = { voice: [300, 3400], am: [200, 2500] }; // 'full' / 'custom' 不在表里
function loadDsp() {
  let d = {};
  try { d = JSON.parse(localStorage.getItem('dsp') || '{}') || {}; } catch { d = {}; }
  // 旧版（v0.2 早期）的「人声频段」开关 → 语音预设
  if (d.voice === true && !d.band) { d.band = 'voice'; d.bandLo = 300; d.bandHi = 3400; }
  delete d.voice;
  const out = { ...window.DSP_DEFAULTS, ...d };
  if (!['full', 'voice', 'am', 'custom'].includes(out.band)) out.band = 'full';
  return out;
}
/** 频谱上的带宽阴影：处理启用且不是全带宽时才画 */
function updateBandShade() {
  if (!view) return;
  const d = engine.dsp;
  view.band = d.enabled && d.band !== 'full' ? { lo: d.bandLo, hi: d.bandHi, shift: typeof iqOffsetHz === 'function' ? iqOffsetHz() : 0 } : null;
}
function saveDsp() { localStorage.setItem('dsp', JSON.stringify(engine.dsp)); }
function saveMon() { localStorage.setItem('monitor', JSON.stringify({ vol: Number($('monVol').value) })); }

function dspToUi(d) {
  $('dspOn').checked = d.enabled; $('dspHp').checked = d.hp; $('dspHum').value = d.hum;
  $('dspDn').checked = d.dn; $('dspStr').value = Math.round(d.dnStrength * 100); $('dspMode').value = d.dnMode;
  $('dspBand').value = d.band; $('dspLo').value = d.bandLo; $('dspHi').value = d.bandHi;
  $('dspLoR').value = Math.min(2000, d.bandLo); $('dspHiR').value = Math.max(1000, d.bandHi);
  for (const id of ['dspLo', 'dspHi', 'dspLoR', 'dspHiR']) $(id).disabled = d.band === 'full';
  updateBandShade();
  $('dspGain').value = d.gainDb; $('dspLim').checked = d.limiter;
  $('dspMix').value = d.mix; $('dspSpec').value = d.specPost ? 'post' : 'pre';
  $('dspStrV').textContent = Math.round(d.dnStrength * 100);
  $('dspGainV').textContent = `+${Number(d.gainDb).toFixed(d.gainDb % 1 ? 1 : 0)}`;
  $('dspMixV').textContent = `${d.mix}%`;
  $('dspPanel').classList.toggle('on', d.enabled);
}
function dspStatus() {
  const d = engine.dsp;
  $('dspLat').textContent = d.enabled && engine.running ? `延迟 ≈${(engine.wetLatencyMs || 0).toFixed(0)}ms` : '';
  if (engine.running && engine.dnError) $('dspHint').textContent = `降噪模块加载失败，已旁路：${engine.dnError}`;
  else if (d.enabled && !$('chkMonitor').checked) $('dspHint').textContent = '提示：处理只作用于监听声音（和"处理后"频谱），记得勾选监听';
  else $('dspHint').textContent = '';
}

function bindDsp() {
  engine.dsp = loadDsp();
  const prof = (() => { try { return JSON.parse(localStorage.getItem('noiseProfile') || 'null'); } catch { return null; } })();
  if (prof && Array.isArray(prof.data)) { engine.noiseProfile = prof.data; $('learnHint').textContent = `已学习（${prof.when}）`; }
  dspToUi(engine.dsp);
  const set = (patch) => { engine.setDsp(patch); saveDsp(); dspToUi(engine.dsp); dspStatus(); };
  $('dspOn').onchange = (e) => set({ enabled: e.target.checked });
  $('dspHp').onchange = (e) => set({ hp: e.target.checked });
  $('dspHum').onchange = (e) => set({ hum: e.target.value });
  $('dspDn').onchange = (e) => set({ dn: e.target.checked });
  $('dspStr').oninput = (e) => set({ dnStrength: Number(e.target.value) / 100 });
  $('dspMode').onchange = (e) => {
    if (e.target.value === 'learned' && !engine.noiseProfile) toast('还没学习过噪声：先点「学习噪声」，学完前仍按自动跟踪处理', true);
    set({ dnMode: e.target.value });
  };
  // 带宽限制：预设改写低切 / 高切；手动改数值自动变成"自定义"
  $('dspBand').onchange = (e) => {
    const p = BAND_PRESETS[e.target.value];
    set(p ? { band: e.target.value, bandLo: p[0], bandHi: p[1] } : { band: e.target.value });
  };
  const setCut = (lo, hi) => {
    lo = Math.round(Number(lo)); hi = Math.round(Number(hi));
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) return;
    lo = Math.max(20, Math.min(20000, lo)); hi = Math.max(100, Math.min(22000, hi));
    if (hi < lo + 100) hi = lo + 100; // 至少留 100Hz
    const preset = Object.entries(BAND_PRESETS).find(([, v]) => v[0] === lo && v[1] === hi);
    set({ band: preset ? preset[0] : 'custom', bandLo: lo, bandHi: hi });
  };
  $('dspLoR').oninput = (e) => setCut(e.target.value, engine.dsp.bandHi);
  $('dspHiR').oninput = (e) => setCut(engine.dsp.bandLo, e.target.value);
  $('dspLo').onchange = (e) => setCut(e.target.value, engine.dsp.bandHi);
  $('dspHi').onchange = (e) => setCut(engine.dsp.bandLo, e.target.value);
  $('dspGain').oninput = (e) => set({ gainDb: Number(e.target.value) });
  $('dspLim').onchange = (e) => set({ limiter: e.target.checked });
  $('dspMix').oninput = (e) => set({ mix: Number(e.target.value) });
  $('dspSpec').onchange = (e) => { set({ specPost: e.target.value === 'post' }); view.peak = null; };
  $('btnDspReset').onclick = () => { engine.dsp = { ...window.DSP_DEFAULTS, enabled: engine.dsp.enabled }; engine._rewire(); engine._selectSpectrum(); saveDsp(); dspToUi(engine.dsp); dspStatus(); };
  $('btnLearn').onclick = () => {
    if (!engine.running) return toast('先在上面点「开始」打开音频输入');
    if (!engine.learnNoise(1)) return toast('降噪模块没加载成功，不能学习');
    $('learnHint').textContent = '学习中…（保持只有底噪）';
  };
  engine.onLearned = (data) => {
    const when = new Date().toLocaleTimeString();
    localStorage.setItem('noiseProfile', JSON.stringify({ data, when, sr: engine.ctx ? engine.ctx.sampleRate : 0 }));
    $('learnHint').textContent = `已学习（${when}）`;
    set({ dnMode: 'learned' });
    toast('噪声样本已记录，已切到「学习的噪声谱」', true);
  };
  setInterval(dspStatus, 1000);
}

// ---------------------------------------------------------------------------
// 8. 伪 IQ（希尔伯特变换），设置存在 localStorage 'iq'
// ---------------------------------------------------------------------------
const IQ_DEFAULTS = { on: false, shift: '0', hz: 6000 };
let iqCfg = { ...IQ_DEFAULTS };
function iqOffsetHz() {
  const sr = engine.ctx ? engine.ctx.sampleRate : 48000;
  return iqCfg.shift === 'q' ? sr / 4 : iqCfg.shift === 'custom' ? Number(iqCfg.hz) || 0 : 0;
}
function applyIq() {
  $('iqOn').checked = iqCfg.on; $('iqShift').value = iqCfg.shift; $('iqHz').value = iqCfg.hz;
  $('iqCustomRow').style.display = iqCfg.shift === 'custom' ? '' : 'none';
  $('iqPanel').classList.toggle('on', iqCfg.on);
  $('chkLog').disabled = iqCfg.on; // 复数谱有负频率，对数轴没意义
  if (iqCfg.on) $('iqPanel').open = true;
  localStorage.setItem('iq', JSON.stringify(iqCfg));
  engine.setIq({ on: iqCfg.on, offsetHz: iqOffsetHz() });
  updateBandShade();
}
function bindIq() {
  try { iqCfg = { ...IQ_DEFAULTS, ...(JSON.parse(localStorage.getItem('iq') || '{}') || {}) }; } catch { iqCfg = { ...IQ_DEFAULTS }; }
  $('iqOn').onchange = (e) => { iqCfg.on = e.target.checked; applyIq(); };
  $('iqShift').onchange = (e) => { iqCfg.shift = e.target.value; applyIq(); };
  $('iqHz').onchange = (e) => { iqCfg.hz = Number(e.target.value) || 0; applyIq(); };
  applyIq();
}

async function startAudio() {
  const sel = $('audioSel');
  const opt = sel.options[sel.selectedIndex];
  const label = opt ? (opt.dataset.full || opt.text) : '';
  try {
    await engine.start(sel.value, label);
    engine.setMonitor($('chkMonitor').checked);
    engine.setIq({ on: iqCfg.on, offsetHz: iqOffsetHz() });
    localStorage.setItem('audioDev', JSON.stringify({ id: sel.value, label }));
    $('btnAudio').textContent = '停止';
    $('audioHint').textContent = `正在采集：${shortLabel(label, 40)}`; $('audioHint').title = label;
    $('audioSr').textContent = `${engine.ctx.sampleRate} Hz`;
    // 打开设备后浏览器才给真实名字，顺手刷新一次列表
    const id = sel.value;
    refreshDevices().then(() => { sel.value = id; });
  } catch (e) {
    toast(`打开音频输入失败：${e.message || e}`);
    $('audioHint').textContent = '失败';
  }
}

async function initAudio() {
  view = new window.SpectrumView($('spectrum'), $('waterfall'), $('specOverlay'));
  const bindRange = (id, key, fmt = (v) => v) => {
    const el = $(id), out = $(`${id}V`);
    const f = () => { const v = Number(el.value); out.textContent = fmt(v); view.set(key, v); };
    el.oninput = f; f();
  };
  bindRange('dbMax', 'dbMax'); bindRange('dbMin', 'dbMin');
  bindRange('contrast', 'contrast', (v) => v.toFixed(1));
  $('smooth').oninput = () => { const v = Number($('smooth').value); $('smoothV').textContent = v.toFixed(2); engine.setSmoothing(v); };
  $('fftSel').onchange = () => engine.setFftSize(Number($('fftSel').value));
  engine.setFftSize(Number($('fftSel').value));
  $('fmaxSel').onchange = () => view.set('fmax', Number($('fmaxSel').value));
  view.set('fmax', Number($('fmaxSel').value));
  $('cmapSel').onchange = () => view.set('cmap', $('cmapSel').value);
  $('wfSpeed').onchange = () => view.set('wfEvery', Number($('wfSpeed').value));
  $('chkPeak').onchange = (e) => view.set('peak', e.target.checked);
  $('chkLog').onchange = (e) => view.set('log', e.target.checked);
  $('chkMonitor').onchange = (e) => { engine.setMonitor(e.target.checked); saveMon(); };
  const monVol = () => { const v = Number($('monVol').value); $('monVolV').textContent = v; engine.setMonitorVolume(v / 100); };
  $('monVol').oninput = () => { monVol(); saveMon(); };
  { // 监听音量记住；监听开关本身【不】记住，每次启动默认关，防止一开就啸叫
    const m = JSON.parse(localStorage.getItem('monitor') || 'null');
    if (m && Number.isFinite(m.vol)) $('monVol').value = m.vol;
    monVol();
  }
  bindDsp();
  bindIq();
  $('btnAudioRefresh').onclick = () => refreshDevices();
  $('audioSel').addEventListener('change', syncAudioTitle);
  $('btnAudio').onclick = async () => {
    if (engine.running) {
      await engine.stop(); $('btnAudio').textContent = '开始'; $('audioHint').textContent = '已停止';
    } else await startAudio();
  };
  // 插拔声卡、蓝牙音频连上/断开时，系统会发 devicechange，自动刷新列表
  navigator.mediaDevices.addEventListener('devicechange', () => refreshDevices());

  await refreshDevices().catch(() => {});
  if (INFO.fakeAudio) { $('audioSel').value = window.AUDIO_OSC_ID; await startAudio(); }

  // 绘制循环：约 30 帧/秒（requestAnimationFrame 一般是 60，隔帧画）
  meter = new window.LevelMeter($('vuCanvas'), $('vuClip'), $('vuRead'));
  let last = 0; let outMs = 0;
  const loop = (t) => {
    requestAnimationFrame(loop);
    if (t - last < 32) return;
    const dt = Math.min(0.5, (t - last) / 1000);
    last = t;
    const fr = engine.read();
    if (fr) {
      view.draw(fr);
      $('audioLvl').textContent = `${fr.rms.toFixed(0)} dBFS`;
    }
    const m = engine.running ? engine.readMeters(dt * engine.ctx.sampleRate) : null;
    meter.update(m ? m.inp : null, dt, t);
    if (iqCfg.on) window.drawIqScope($('iqScope'), engine.iqScope(512));
    if (m && m.out) {
      outMs += (m.out.ms - outMs) * (1 - Math.exp(-dt / 0.3));
      const db = 10 * Math.log10(outMs + 1e-12);
      $('vuOut').textContent = db > -99 ? `${db.toFixed(1)} dBFS` : '-∞';
      $('vuOut').style.color = m.out.peak >= 0.999 ? 'var(--bad)' : '';
    } else { outMs = 0; $('vuOut').textContent = '--'; }
  };
  requestAnimationFrame(loop);
}

init();
