'use strict';
/**
 * audio.js —— 当前频率的【音频】频谱 + 瀑布图
 * ============================================
 * 收音机 AUX / 耳机输出 → 电脑 line-in（或蓝牙 A2DP 音频）→ 这里做 FFT 显示。
 * 注意：这显示的是【解调后的声音】的频谱（0 ~ 采样率/2，比如 0~24kHz），
 * 不是射频频谱；C919 不输出 IQ，所以做不了 SDR# 那种射频全景，用户也明确不需要全频扫描图。
 *
 * Web Audio 的处理链：
 *   MediaStreamSource（声卡输入） ─┬─> AnalyserNode（做 FFT，我们每帧读结果）
 *                                 └─> GainNode（监听开关）─> 扬声器（可选）
 * 音频部分和蓝牙完全独立：没连收音机也能看频谱，反之亦然。
 */
(function () {
  const OSC_ID = 'osc:test'; // 设备列表里的"测试信号"假设备

  class AudioEngine {
    constructor() {
      this.ctx = null; this.stream = null; this.src = null; this.analyser = null;
      this.monitorGain = null; this.oscNodes = [];
      this.running = false; this.deviceLabel = '';
      this.fftSize = 4096; this.smoothing = 0.5;
      this.freqData = null; this.timeData = null;
    }

    /**
     * 列出所有音频输入设备。
     * 浏览器的隐私规则：没授权之前 enumerateDevices 拿不到设备名字（label 为空），
     * 所以先用 getUserMedia 请求一次权限，拿到后立刻关掉，再枚举一次。
     * 在 PipeWire 下，这里会列出：声卡 line-in / 麦克风、蓝牙 A2DP 音源（bluez_input…）、
     * 以及各个输出设备的 "Monitor of …" 监视源。
     */
    async listDevices() {
      let devs = await navigator.mediaDevices.enumerateDevices();
      if (!devs.some((d) => d.kind === 'audioinput' && d.label)) {
        try {
          const s = await navigator.mediaDevices.getUserMedia({ audio: true });
          s.getTracks().forEach((t) => t.stop());
          devs = await navigator.mediaDevices.enumerateDevices();
        } catch (e) { console.warn('请求音频权限失败', e); }
      }
      const inputs = devs.filter((d) => d.kind === 'audioinput')
        .map((d, i) => ({ id: d.deviceId, label: d.label || `输入设备 ${i + 1}` }));
      inputs.push({ id: OSC_ID, label: '🧪 测试信号（振荡器，不用声卡）' });
      return inputs;
    }

    async start(deviceId, label = '') {
      await this.stop();
      // latencyHint: 'interactive' 让延迟尽量低；采样率交给系统（PipeWire 一般 48000）
      this.ctx = new AudioContext({ latencyHint: 'interactive' });
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = this.fftSize;
      this.analyser.smoothingTimeConstant = this.smoothing;
      this.analyser.minDecibels = -160; this.analyser.maxDecibels = 0;
      this.monitorGain = this.ctx.createGain();
      this.monitorGain.gain.value = 0; // 默认不从电脑扬声器播放（避免啸叫 / 回声）
      this.monitorGain.connect(this.ctx.destination);

      if (deviceId === OSC_ID) {
        this.src = this._makeTestSignal();
      } else {
        // 关键：关掉回声消除 / 降噪 / 自动增益。这些处理是给语音通话用的，
        // 会把收音机的声音"修"坏，频谱也会失真。
        this.stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            deviceId: deviceId ? { exact: deviceId } : undefined,
            echoCancellation: false, noiseSuppression: false, autoGainControl: false,
            channelCount: { ideal: 2 }, sampleRate: { ideal: 48000 }, latency: { ideal: 0.01 },
          },
        });
        this.src = this.ctx.createMediaStreamSource(this.stream);
      }
      this.src.connect(this.analyser);
      this.src.connect(this.monitorGain);
      this.freqData = new Float32Array(this.analyser.frequencyBinCount);
      this.timeData = new Float32Array(this.analyser.fftSize);
      this.running = true;
      this.deviceLabel = label;
    }

    /**
     * 测试信号：没有声卡（比如无头截图）时用振荡器造一段"像电台"的声音：
     *   1kHz 正弦 + 一个 300Hz~6kHz 来回扫的音 + 带通噪声（模拟人声频段）。
     */
    _makeTestSignal() {
      const c = this.ctx;
      const mix = c.createGain(); mix.gain.value = 1;
      const tone = c.createOscillator(); tone.frequency.value = 1000;
      const tg = c.createGain(); tg.gain.value = 0.15; tone.connect(tg).connect(mix);
      const sweep = c.createOscillator(); sweep.type = 'sawtooth'; sweep.frequency.value = 600;
      const lfo = c.createOscillator(); lfo.frequency.value = 0.15; // 很慢的调制
      const lg = c.createGain(); lg.gain.value = 2500; lfo.connect(lg).connect(sweep.frequency);
      const sg = c.createGain(); sg.gain.value = 0.05; sweep.connect(sg).connect(mix);
      // 白噪声 → 带通 300~3400Hz
      const buf = c.createBuffer(1, c.sampleRate * 2, c.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      const noise = c.createBufferSource(); noise.buffer = buf; noise.loop = true;
      const bp = c.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1200; bp.Q.value = 0.6;
      const ng = c.createGain(); ng.gain.value = 0.25; noise.connect(bp).connect(ng).connect(mix);
      // 19kHz 立体声导频（FM 立体声广播特有，常在 line-in 频谱里看到）
      const pilot = c.createOscillator(); pilot.frequency.value = 19000;
      const pg = c.createGain(); pg.gain.value = 0.01; pilot.connect(pg).connect(mix);
      [tone, sweep, lfo, noise, pilot].forEach((n) => n.start());
      this.oscNodes = [tone, sweep, lfo, noise, pilot];
      return mix;
    }

    async stop() {
      this.running = false;
      this.oscNodes.forEach((n) => { try { n.stop(); } catch { /* 已停 */ } });
      this.oscNodes = [];
      if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
      if (this.ctx) await this.ctx.close().catch(() => {});
      this.ctx = null;
    }

    setFftSize(n) {
      this.fftSize = n;
      if (this.analyser) {
        this.analyser.fftSize = n;
        this.freqData = new Float32Array(this.analyser.frequencyBinCount);
        this.timeData = new Float32Array(n);
      }
    }
    setSmoothing(v) { this.smoothing = v; if (this.analyser) this.analyser.smoothingTimeConstant = v; }
    setMonitor(on) { if (this.monitorGain) this.monitorGain.gain.value = on ? 1 : 0; }

    /** 读一帧：返回 {freq: dB 数组, rms: dBFS, sampleRate} */
    read() {
      if (!this.running) return null;
      this.analyser.getFloatFrequencyData(this.freqData);
      this.analyser.getFloatTimeDomainData(this.timeData);
      let s = 0;
      for (const v of this.timeData) s += v * v;
      const rms = 10 * Math.log10(s / this.timeData.length + 1e-12);
      return { freq: this.freqData, rms, sampleRate: this.ctx.sampleRate };
    }
  }

  /**
   * 画频谱（上）和瀑布（下）。
   * 频率轴：x 像素 → 频率（线性或对数）→ FFT 下标范围，取范围内最大值（避免细峰被漏掉）。
   */
  class SpectrumView {
    constructor(specCanvas, wfCanvas, overlay) {
      this.sc = specCanvas; this.wc = wfCanvas; this.ov = overlay;
      this.sx = specCanvas.getContext('2d');
      this.wx = wfCanvas.getContext('2d', { willReadFrequently: false });
      this.opts = { dbMin: -110, dbMax: -10, contrast: 1, cmap: 'sdrsharp', fmax: 12000, log: false, peak: true, wfEvery: 1 };
      this.peak = null; this.frameNo = 0; this.mouseX = null;
      this.cols = null; // 每一列对应的 [bin 起, bin 止]
      const ro = new ResizeObserver(() => this.resize());
      ro.observe(specCanvas); ro.observe(wfCanvas);
      specCanvas.addEventListener('mousemove', (e) => { this.mouseX = e.offsetX * devicePixelRatio; });
      specCanvas.addEventListener('mouseleave', () => { this.mouseX = null; });
      this.resize();
    }

    resize() {
      const dpr = window.devicePixelRatio || 1;
      for (const c of [this.sc, this.wc]) {
        const w = Math.max(1, Math.round(c.clientWidth * dpr));
        const h = Math.max(1, Math.round(c.clientHeight * dpr));
        if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
      }
      this.wx.fillStyle = '#000'; this.wx.fillRect(0, 0, this.wc.width, this.wc.height);
      this.cols = null; this.peak = null; this.ring = null;
    }

    set(k, v) { this.opts[k] = v; this.cols = null; if (k === 'fmax' || k === 'log') this.peak = null; }

    /** 计算 x 像素 ↔ 频率的映射（参数变化或尺寸变化时重算一次） */
    _layout(nBins, sr) {
      const nyq = sr / 2;
      const fmax = this.opts.fmax > 0 ? Math.min(this.opts.fmax, nyq) : nyq;
      const fmin = this.opts.log ? 20 : 0;
      const W = this.sc.width;
      const xToF = (x) => (this.opts.log ? fmin * Math.pow(fmax / fmin, x / W) : fmin + (fmax - fmin) * x / W);
      const binHz = nyq / nBins;
      const cols = new Int32Array(W * 2);
      for (let x = 0; x < W; x++) {
        let a = Math.floor(xToF(x) / binHz);
        let b = Math.floor(xToF(x + 1) / binHz);
        a = Math.max(0, Math.min(nBins - 1, a)); b = Math.max(a, Math.min(nBins - 1, b));
        cols[x * 2] = a; cols[x * 2 + 1] = b;
      }
      this.cols = cols; this.fmax = fmax; this.fmin = fmin; this.xToF = xToF; this.nBins = nBins; this.sr = sr;
      this.fToX = (f) => (this.opts.log ? W * Math.log(Math.max(f, fmin) / fmin) / Math.log(fmax / fmin) : W * (f - fmin) / (fmax - fmin));
    }

    /** 把每一列的 dB 值算出来（取该列覆盖的 FFT 点里的最大值） */
    _columns(freq) {
      const W = this.sc.width;
      if (!this.colDb || this.colDb.length !== W) this.colDb = new Float32Array(W);
      const cols = this.cols;
      for (let x = 0; x < W; x++) {
        let m = -Infinity;
        for (let i = cols[x * 2]; i <= cols[x * 2 + 1]; i++) if (freq[i] > m) m = freq[i];
        this.colDb[x] = m;
      }
      return this.colDb;
    }

    draw(frame) {
      if (!frame) return;
      if (!this.cols || this.nBins !== frame.freq.length || this.sr !== frame.sampleRate) this._layout(frame.freq.length, frame.sampleRate);
      const db = this._columns(frame.freq);
      this._drawSpectrum(db, frame);
      if (++this.frameNo % this.opts.wfEvery === 0) this._drawWaterfallRow(db);
    }

    _norm(v) { // dB → 0..1，再按对比度围绕中点拉伸
      const { dbMin, dbMax, contrast } = this.opts;
      let t = (v - dbMin) / (dbMax - dbMin);
      t = 0.5 + (t - 0.5) * contrast;
      return t < 0 ? 0 : t > 1 ? 1 : t;
    }

    _drawSpectrum(db, frame) {
      const c = this.sx, W = this.sc.width, H = this.sc.height, dpr = devicePixelRatio || 1;
      const { dbMin, dbMax } = this.opts;
      c.fillStyle = '#0a0a14'; c.fillRect(0, 0, W, H);
      // 网格：横线每 10dB，竖线按频率
      c.font = `${11 * dpr}px monospace`; c.lineWidth = 1;
      c.strokeStyle = '#26303a'; c.fillStyle = '#7a8a9a';
      for (let d = Math.ceil(dbMax / 10) * 10; d >= dbMin; d -= 10) {
        const y = Math.round(H * (dbMax - d) / (dbMax - dbMin)) + 0.5;
        c.beginPath(); c.moveTo(0, y); c.lineTo(W, y); c.stroke();
        c.fillText(`${d}`, 4 * dpr, y - 2 * dpr);
      }
      const ticks = this.opts.log ? [50, 100, 200, 500, 1000, 2000, 5000, 10000, 15000, 20000]
        : niceTicks(this.fmin, this.fmax, 10);
      for (const f of ticks) {
        if (f < this.fmin || f > this.fmax) continue;
        const x = Math.round(this.fToX(f)) + 0.5;
        c.beginPath(); c.moveTo(x, 0); c.lineTo(x, H); c.stroke();
        c.fillText(f >= 1000 ? `${f / 1000}k` : `${f}`, x + 3 * dpr, H - 4 * dpr);
      }
      // 峰值保持（缓慢下落）
      if (this.opts.peak) {
        if (!this.peak || this.peak.length !== W) this.peak = Float32Array.from(db);
        for (let x = 0; x < W; x++) this.peak[x] = Math.max(db[x], this.peak[x] - 0.4);
      }
      const yOf = (v) => H * (1 - this._lin(v));
      // 填充 + 曲线
      const g = c.createLinearGradient(0, 0, 0, H);
      g.addColorStop(0, 'rgba(63,193,255,0.55)'); g.addColorStop(1, 'rgba(63,193,255,0.03)');
      c.beginPath(); c.moveTo(0, H);
      for (let x = 0; x < W; x++) c.lineTo(x, yOf(db[x]));
      c.lineTo(W, H); c.closePath(); c.fillStyle = g; c.fill();
      c.beginPath();
      for (let x = 0; x < W; x++) (x ? c.lineTo(x, yOf(db[x])) : c.moveTo(x, yOf(db[x])));
      c.strokeStyle = '#e8f6ff'; c.lineWidth = 1.2 * dpr; c.stroke();
      if (this.opts.peak && this.peak) {
        c.beginPath();
        for (let x = 0; x < W; x++) (x ? c.lineTo(x, yOf(this.peak[x])) : c.moveTo(x, yOf(this.peak[x])));
        c.strokeStyle = 'rgba(255,200,60,0.6)'; c.lineWidth = 1; c.stroke();
      }
      // 峰值读数 + 鼠标读数
      let px = 0;
      for (let x = 1; x < W; x++) if (db[x] > db[px]) px = x;
      let txt = `峰值 ${fmtHz(this.xToF(px + 0.5))}  ${db[px].toFixed(1)} dB　|　电平 ${frame.rms.toFixed(1)} dBFS`;
      if (this.mouseX !== null && this.mouseX < W) {
        const mx = Math.floor(this.mouseX);
        txt += `\n光标 ${fmtHz(this.xToF(mx + 0.5))}  ${db[mx].toFixed(1)} dB`;
        c.strokeStyle = 'rgba(255,80,80,0.8)'; c.beginPath(); c.moveTo(mx + 0.5, 0); c.lineTo(mx + 0.5, H); c.stroke();
      }
      this.ov.textContent = txt;
    }

    _lin(v) { // 频谱曲线用纯线性映射（对比度只影响瀑布）
      const t = (v - this.opts.dbMin) / (this.opts.dbMax - this.opts.dbMin);
      return t < 0 ? 0 : t > 1 ? 1 : t;
    }

    /**
     * 瀑布：用一个"环形缓冲区"（ImageData）存最近 H 行。
     * 每来一行只写一行像素，然后分两段贴到画布上（最新的一行在最上面）。
     * 比"把整张图往下挪一像素"更稳，也不需要从显卡读回像素。
     */
    _drawWaterfallRow(db) {
      const c = this.wx, W = this.wc.width, H = this.wc.height;
      if (!this.ring || this.ring.width !== W || this.ring.height !== H) {
        this.ring = c.createImageData(W, H);
        for (let i = 3; i < this.ring.data.length; i += 4) this.ring.data[i] = 255; // 不透明黑色
        this.head = 0;
      }
      this.head = (this.head - 1 + H) % H; // 新行写在 head，head 往"上"走
      const lut = window.COLORMAPS[this.opts.cmap] || window.COLORMAPS.sdrsharp;
      const k = db.length / W; // 频谱和瀑布宽度一般相同，不同就按比例取
      const base = this.head * W * 4, d = this.ring.data;
      for (let x = 0; x < W; x++) {
        const i = Math.round(this._norm(db[Math.min(db.length - 1, Math.floor(x * k))]) * 255) * 3;
        d[base + x * 4] = lut[i]; d[base + x * 4 + 1] = lut[i + 1]; d[base + x * 4 + 2] = lut[i + 2];
      }
      // 第一段：[head, H) 这些行（从最新到较旧）贴到画布顶部
      c.putImageData(this.ring, 0, -this.head, 0, this.head, W, H - this.head);
      // 第二段：[0, head) 更旧的行接在下面
      if (this.head > 0) c.putImageData(this.ring, 0, H - this.head, 0, 0, W, this.head);
    }
  }

  function niceTicks(a, b, n) {
    const span = b - a, raw = span / n, mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => span / s <= n) || 10 * mag;
    const out = [];
    for (let f = Math.ceil(a / step) * step; f <= b; f += step) out.push(Math.round(f));
    return out;
  }
  function fmtHz(f) { return f >= 1000 ? `${(f / 1000).toFixed(2)} kHz` : `${f.toFixed(0)} Hz`; }

  window.AudioEngine = AudioEngine;
  window.SpectrumView = SpectrumView;
  window.AUDIO_OSC_ID = OSC_ID;
})();
