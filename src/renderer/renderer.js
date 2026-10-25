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
function onConn(state, detail) {
  setConnected(state === 'connected', state);
  $('connHint').textContent = `后端：${INFO.backend}　${CONN_CN[state] || state} ${detail || ''}`;
  if (state === 'error') toast(detail || '连接出错');
}
function setConnected(on, state) {
  connected = on;
  const el = $('stConn');
  el.textContent = CONN_CN[state] || state;
  el.className = on ? 'ok' : (state === 'connecting' || state === 'reconnecting' || state === 'scanning') ? 'warn' : 'bad';
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
  if (ST.band === 0) { tag.textContent = '已验证'; tag.className = 'tag ok'; tag.title = 'FM：K 单位 10kHz，真机验证'; } else if (fmt.source === 'radio') {
    tag.textContent = '真机帧标定'; tag.className = 'tag ok'; tag.title = '格式取自该波段收到的频率帧（显示规则从 App 代码推出）';
  } else { tag.textContent = '推断'; tag.className = 'tag warn'; tag.title = '还没收到过这个波段的频率帧，小数位数是按说明书步进猜的'; }
  $('entryHint').textContent = ST.band === 0 ? 'FM：K = round(MHz×100)【已验证】'
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

async function refreshDevices() {
  const sel = $('audioSel');
  const list = await engine.listDevices();
  const saved = JSON.parse(localStorage.getItem('audioDev') || 'null');
  sel.innerHTML = '';
  for (const d of list) sel.add(new Option(d.label, d.id));
  // 记住上次的选择：deviceId 可能变（重启 / 重新配对后），所以 id 对不上时再按名字找
  if (saved) {
    const hit = list.find((d) => d.id === saved.id) || list.find((d) => d.label === saved.label);
    if (hit) sel.value = hit.id;
  }
  return list;
}

async function startAudio() {
  const sel = $('audioSel');
  const label = sel.options[sel.selectedIndex] ? sel.options[sel.selectedIndex].text : '';
  try {
    await engine.start(sel.value, label);
    engine.setMonitor($('chkMonitor').checked);
    localStorage.setItem('audioDev', JSON.stringify({ id: sel.value, label }));
    $('btnAudio').textContent = '停止';
    $('audioHint').textContent = `正在采集：${label}`;
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
  $('chkMonitor').onchange = (e) => engine.setMonitor(e.target.checked);
  $('btnAudioRefresh').onclick = () => refreshDevices();
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
  let last = 0;
  const loop = (t) => {
    requestAnimationFrame(loop);
    if (t - last < 32) return;
    last = t;
    const fr = engine.read();
    if (fr) {
      view.draw(fr);
      $('audioLvl').textContent = `${fr.rms.toFixed(0)} dBFS`;
    }
  };
  requestAnimationFrame(loop);
}

init();
