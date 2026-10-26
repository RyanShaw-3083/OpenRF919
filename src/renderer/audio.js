'use strict';
/**
 * audio.js —— 当前频率的【音频】频谱 + 瀑布图
 * ============================================
 * 收音机 AUX / 耳机输出 → 电脑 line-in（或蓝牙 A2DP 音频）→ 这里做 FFT 显示。
 * 注意：这显示的是【解调后的声音】的频谱（0 ~ 采样率/2，比如 0~24kHz），
 * 不是射频频谱；C919 不输出 IQ，所以做不了 SDR# 那种射频全景，用户也明确不需要全频扫描图。
 *
 * Web Audio 的处理链（v0.2 起加了"弱信号处理"）：
 *
 *   声卡输入 src ─┬─> preSplit ─> 每声道 AnalyserNode（底部 VU / 峰值表：看【原始】输入电平，调声卡增益用）
 *                ├─> preAnalyser（频谱 / 瀑布：可选"处理前"）
 *                ├─> dryDelay ─> dryGain ─────────────────────────────────────┐
 *                └─> 高通 100Hz → 工频陷波 50/100(或 60/120)Hz → 带宽限制（低切/高切）→  │
 *                    降噪 Worklet → 增益 0..+30dB → 限幅器 → wetGain ────────────┴─> mix
 *   带宽限制放在降噪之前：带外先被 24dB/oct 衰减掉，降噪 / 增益 / 限幅只对带内信号起作用。
 *   mix ─┬─> postAnalyser（频谱 / 瀑布：可选"处理后"）+ 输出电平表
 *        └─> monitorGain（监听音量，默认 0 = 关）─> 扬声器
 *
 * 干/湿混合（MIX）：dry = 原始声音（延迟对齐降噪的 1024 点 STFT 延迟），wet = 处理后的声音。
 * 处理链里每一级都可以单独开关，关掉的级不接进图里（真正旁路，不耗 CPU）。
 * 音频部分和蓝牙完全独立：没连收音机也能看频谱，反之亦然。
 */
(function () {
  const OSC_ID = 'osc:test'; // 设备列表里的"测试信号"假设备
  const DN_LATENCY = 1024;
  const BW4_QDB = [20 * Math.log10(0.5412), 20 * Math.log10(1.3066)]; // 4 阶 Butterworth 两节的 Q（dB） // 降噪 STFT 固定延迟（采样数），见 dsp/denoise_core.js

  /** 处理链默认参数（也是 localStorage 里存的结构） */
  const DSP_DEFAULTS = {
    enabled: false, // 总开关：关 = 监听原声
    hp: true, // 高通 100Hz
    hum: 'off', // 'off' | '50' | '60'
    dn: true, dnStrength: 0.5, dnMode: 'auto', // 降噪：'auto' 最小值统计 | 'learned' 学到的噪声谱
    band: 'full', // 带宽限制预设：'full' 全带宽 | 'voice' 语音 300–3400 | 'am' AM 窄带 200–2500 | 'custom'
    bandLo: 300, bandHi: 3400, // 当前低切 / 高切（Hz），预设会改写这两个值
    gainDb: 6, // 补偿增益 0..30
    limiter: true,
    mix: 100, // 湿信号比例 %
    specPost: false, // 频谱显示处理后的信号
  };

  class AudioEngine {
    constructor() {
      this.ctx = null; this.stream = null; this.src = null;
      this.preAnalyser = null; this.postAnalyser = null; this.analyser = null;
      this.monitorGain = null; this.oscNodes = [];
      this.running = false; this.deviceLabel = '';
      this.fftSize = 4096; this.smoothing = 0.5;
      this.freqData = null; this.timeData = null;
      this.dsp = { ...DSP_DEFAULTS };
      this.monitorOn = false; this.monitorVol = 0.8;
      this.channels = 1; this.meterIn = []; this.meterOut = null; this.meterBuf = null;
      this.dnNode = null; this.dnReady = false; this.dnError = ''; this.noiseProfile = null;
      this.onLearned = null;
      // 伪 IQ（希尔伯特变换）
      this.iq = { on: false, offsetHz: 0 }; this.iqNode = null; this.iqI = null; this.iqQ = null;
      this.iqFft = null; this.iqN = 0; this.iqMag = null; this.iqDb = null; this.iqBufI = null; this.iqBufQ = null; this.iqWin = null;
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
      const ctx = this.ctx = new AudioContext({ latencyHint: 'interactive' });
      const mkAnalyser = (n, sm) => {
        const a = ctx.createAnalyser(); a.fftSize = n; a.smoothingTimeConstant = sm;
        a.minDecibels = -160; a.maxDecibels = 0; return a;
      };
      this.preAnalyser = mkAnalyser(this.fftSize, this.smoothing);
      this.postAnalyser = mkAnalyser(this.fftSize, this.smoothing);

      if (deviceId === OSC_ID) {
        this.src = this._makeTestSignal();
        this.channels = 1;
      } else {
        // 关键：关掉回声消除 / 降噪 / 自动增益。这些处理是给语音通话用的，
        // 会把收音机的声音"修"坏，频谱也会失真；电平表也会不准。
        this.stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            deviceId: deviceId ? { exact: deviceId } : undefined,
            echoCancellation: false, noiseSuppression: false, autoGainControl: false,
            channelCount: { ideal: 2 }, sampleRate: { ideal: 48000 }, latency: { ideal: 0.01 },
          },
        });
        const tr = this.stream.getAudioTracks()[0];
        const set = tr && tr.getSettings ? tr.getSettings() : {};
        this.src = ctx.createMediaStreamSource(this.stream);
        this.channels = Math.max(1, Math.min(2, set.channelCount || this.src.channelCount || 1));
      }

      // ---- 原始电平表：每个声道一个 AnalyserNode（只读时域数据）
      // fftSize 2048 @48k = 42ms > 一帧绘制间隔 33ms，所以每个样本至少被看到一次，峰值 / 削波不会漏。
      const split = ctx.createChannelSplitter(this.channels);
      this.src.connect(split);
      this.meterIn = [];
      for (let c = 0; c < this.channels; c++) {
        const a = mkAnalyser(2048, 0); split.connect(a, c); this.meterIn.push(a);
      }
      this.meterBuf = new Float32Array(2048);
      this.src.connect(this.preAnalyser);

      // ---- 处理链的固定节点
      const C = this.channels;
      const mk = (type, f, q) => { const b = ctx.createBiquadFilter(); b.type = type; b.frequency.value = f; if (q !== undefined) b.Q.value = q; return b; };
      this.n = {
        // 注意：Web Audio 的 lowpass / highpass 的 Q 单位是 dB（谐振量），不是线性 Q。
        // 4 阶 Butterworth 两节的线性 Q = 0.5412 / 1.3066 → 20·log10 = −5.33 dB / +2.32 dB
        hp: [mk('highpass', 100, BW4_QDB[0]), mk('highpass', 100, BW4_QDB[1])], // 24dB/oct，交流嗡嗡声、低频隆隆声
        hum1: mk('notch', 50, 12), hum2: mk('notch', 100, 12), hum3: mk('notch', 150, 12),
        // 带宽限制：低切 / 高切各两级 = 4 阶 Butterworth（24dB/oct，截止频率处 −3dB）
        bLo: [mk('highpass', 300, BW4_QDB[0]), mk('highpass', 300, BW4_QDB[1])],
        bHi: [mk('lowpass', 3400, BW4_QDB[0]), mk('lowpass', 3400, BW4_QDB[1])],
        gain: ctx.createGain(),
        comp: ctx.createDynamicsCompressor(),
        clip: ctx.createWaveShaper(),
        wet: ctx.createGain(), dry: ctx.createGain(), dryDelay: ctx.createDelay(1),
        mix: ctx.createGain(),
      };
      // 限幅器：DynamicsCompressor 当"硬"压缩用（-3dBFS 起压、20:1、3ms 起音），
      // 后面再接一个 tanh 软削波兜底，保证任何增益下输出都不会超过 0 dBFS
      const cp = this.n.comp;
      cp.threshold.value = -3; cp.knee.value = 3; cp.ratio.value = 20; cp.attack.value = 0.003; cp.release.value = 0.12;
      const curve = new Float32Array(1025);
      // 曲线最大值 0.966（-0.3 dBFS）；不开过采样——过采样的插值滤波会过冲，实测会冒到 1.04
      for (let i = 0; i < curve.length; i++) { const x = (i / 512) - 1; curve[i] = 0.966 * Math.tanh(1.2 * x) / Math.tanh(1.2); }
      this.n.clip.curve = curve; this.n.clip.oversample = 'none';
      this.n.dryDelay.delayTime.value = DN_LATENCY / ctx.sampleRate;

      // ---- 降噪 AudioWorklet（加载失败就旁路，界面会提示）
      this.dnNode = null; this.dnReady = false; this.dnError = '';
      try {
        await ctx.audioWorklet.addModule('dsp/denoise_core.js');
        await ctx.audioWorklet.addModule('dsp/denoise_worklet.js');
        this.dnNode = new AudioWorkletNode(ctx, 'c919-denoise', {
          numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [C],
          channelCount: C, channelCountMode: 'explicit', channelInterpretation: 'speakers',
        });
        this.dnNode.port.onmessage = (e) => {
          const m = e.data;
          if (m.type === 'ready') this.dnReady = true;
          if (m.type === 'learned') { this.noiseProfile = Array.from(m.data); if (this.onLearned) this.onLearned(this.noiseProfile); }
        };
        if (this.noiseProfile) this.dnNode.port.postMessage({ type: 'profile', data: this.noiseProfile });
      } catch (e) {
        this.dnError = String(e && e.message ? e.message : e);
        console.warn('降噪 Worklet 加载失败，降噪旁路', e);
      }

      this.n.mix.connect(this.postAnalyser);
      // 输出电平（处理后，单声道总和即可）
      this.meterOut = mkAnalyser(2048, 0);
      this.n.mix.connect(this.meterOut);
      this.monitorGain = ctx.createGain();
      this.monitorGain.gain.value = 0; // 默认不从电脑扬声器播放（避免啸叫 / 回声）
      this.n.mix.connect(this.monitorGain);
      this.monitorGain.connect(ctx.destination);

      this._rewire();
      this._applyMonitor();
      if (this.iq.on) await this._setupIq();
      this.analyser = this.dsp.specPost ? this.postAnalyser : this.preAnalyser;
      this.freqData = new Float32Array(this.analyser.frequencyBinCount);
      this.timeData = new Float32Array(this.analyser.fftSize);
      this.running = true;
      this.deviceLabel = label;
    }

    /** 按 this.dsp 重新连接处理链（只断开处理链内部的线，输入/分析器不动） */
    _rewire() {
      if (!this.ctx) return;
      const n = this.n, d = this.dsp, t = this.ctx.currentTime;
      const all = [...n.hp, n.hum1, n.hum2, n.hum3, ...n.bLo, ...n.bHi, n.gain, n.comp, n.clip, n.wet, n.dry, n.dryDelay, this.dnNode].filter(Boolean);
      for (const x of all) { try { x.disconnect(); } catch { /* 没连过 */ } }
      // src 还连着电平表 / 频谱分析器 / 伪 IQ，所以只断开它到处理链各节点（任何一个都可能是链头）的线
      for (const x of all) { try { this.src.disconnect(x); } catch { /* 没连过 */ } }

      // 湿信号路径
      const chain = [];
      if (d.enabled) {
        if (d.hp) chain.push(...n.hp);
        if (d.hum !== 'off') {
          const f = Number(d.hum);
          n.hum1.frequency.value = f; n.hum2.frequency.value = 2 * f; n.hum3.frequency.value = 3 * f;
          chain.push(n.hum1, n.hum2, n.hum3);
        }
        if (d.band !== 'full') { this._applyBand(); chain.push(...n.bLo, ...n.bHi); }
        if (this.dnNode) chain.push(this.dnNode); // 降噪关时也留在链里（增益=1），保证延迟恒定、MIX 对齐
        chain.push(n.gain);
        if (d.limiter) chain.push(n.comp, n.clip);
      }
      chain.push(n.wet);
      let prev = this.src;
      for (const x of chain) { prev.connect(x); prev = x; }
      n.wet.connect(n.mix);
      // 干信号路径：延迟到和湿信号对齐
      this.src.connect(n.dryDelay); n.dryDelay.connect(n.dry); n.dry.connect(n.mix);
      // 干信号延迟 = 降噪 STFT 的 1024 点 + 限幅器（Chromium DynamicsCompressor 固定 6ms 预读）
      let dly = 0;
      if (d.enabled) { if (this.dnNode) dly += DN_LATENCY / this.ctx.sampleRate; if (d.limiter) dly += 0.006; }
      n.dryDelay.delayTime.setValueAtTime(dly, t);
      this.wetLatencyMs = dly * 1000;

      n.gain.gain.setTargetAtTime(Math.pow(10, d.gainDb / 20), t, 0.02);
      const w = d.enabled ? d.mix / 100 : 1;
      // 处理总开关关闭时：只走 wet（= 原声直通，无延迟），dry 静音
      n.wet.gain.setTargetAtTime(w, t, 0.02);
      n.dry.gain.setTargetAtTime(d.enabled ? 1 - w : 0, t, 0.02);
      if (this.dnNode) this.dnNode.port.postMessage({ type: 'config', enabled: !!d.dn, strength: d.dnStrength, mode: d.dnMode });
    }

    /** 改一个或多个处理参数。只有改了开关类参数才重连，滑块只改参数值 */
    setDsp(patch) {
      const structural = ['enabled', 'hp', 'hum', 'limiter'];
      // 带宽：全带宽 ↔ 其它 要重连（旁路），其它之间只改截止频率
      if ('band' in patch && (patch.band === 'full') !== (this.dsp.band === 'full')) patch = { ...patch, enabled: this.dsp.enabled, _re: 1 };
      const need = !!patch._re || Object.keys(patch).some((k) => structural.includes(k) && patch[k] !== this.dsp[k]);
      delete patch._re;
      Object.assign(this.dsp, patch);
      if (!this.ctx) return;
      if ('specPost' in patch) this._selectSpectrum();
      if (need) { this._rewire(); return; }
      const t = this.ctx.currentTime, d = this.dsp, n = this.n;
      if ('bandLo' in patch || 'bandHi' in patch || 'band' in patch) this._applyBand();
      if ('gainDb' in patch) n.gain.gain.setTargetAtTime(Math.pow(10, d.gainDb / 20), t, 0.02);
      if ('mix' in patch && d.enabled) { n.wet.gain.setTargetAtTime(d.mix / 100, t, 0.02); n.dry.gain.setTargetAtTime(1 - d.mix / 100, t, 0.02); }
      if (this.dnNode && ('dn' in patch || 'dnStrength' in patch || 'dnMode' in patch)) {
        this.dnNode.port.postMessage({ type: 'config', enabled: !!d.dn, strength: d.dnStrength, mode: d.dnMode });
      }
    }

    /** 把 dsp.bandLo / bandHi 写进 4 个滤波器（平滑过渡，拖滑块不会咔哒） */
    _applyBand() {
      if (!this.ctx) return;
      const nyq = this.ctx.sampleRate / 2, t = this.ctx.currentTime;
      const lo = Math.max(20, Math.min(nyq * 0.9, this.dsp.bandLo));
      const hi = Math.max(lo + 50, Math.min(nyq * 0.95, this.dsp.bandHi));
      for (const f of this.n.bLo) f.frequency.setTargetAtTime(lo, t, 0.02);
      for (const f of this.n.bHi) f.frequency.setTargetAtTime(hi, t, 0.02);
    }

    learnNoise(seconds = 1) {
      if (!this.dnNode) return false;
      this.dnNode.port.postMessage({ type: 'learn', seconds });
      return true;
    }
    setNoiseProfile(arr) { this.noiseProfile = arr; if (this.dnNode) this.dnNode.port.postMessage({ type: 'profile', data: arr }); }

    /** 伪 IQ 开关 / 频移（Hz）。开着时频谱 / 瀑布显示复数 FFT（-fs/2..+fs/2） */
    async setIq(patch) {
      Object.assign(this.iq, patch);
      if (!this.ctx) return;
      if (this.iq.on && !this.iqNode) await this._setupIq();
      else if (!this.iq.on && this.iqNode) this._teardownIq();
      if (this.iqNode) { this.iqNode.port.postMessage({ offsetHz: this.iq.offsetHz }); this._iqSource(); }
    }
    async _setupIq() {
      const ctx = this.ctx;
      try {
        await ctx.audioWorklet.addModule('dsp/hilbert_worklet.js');
      } catch (e) { this.iqError = String(e && e.message ? e.message : e); return; }
      if (ctx !== this.ctx) return; // 期间被 stop 了
      this.iqNode = new AudioWorkletNode(ctx, 'c919-hilbert', {
        numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2],
        channelCount: 1, channelCountMode: 'explicit', channelInterpretation: 'speakers',
      });
      const sp = ctx.createChannelSplitter(2);
      this.iqNode.connect(sp);
      const mk = () => { const a = ctx.createAnalyser(); a.fftSize = 32768; a.smoothingTimeConstant = 0; return a; };
      this.iqI = mk(); this.iqQ = mk(); sp.connect(this.iqI, 0); sp.connect(this.iqQ, 1);
      this.iqNode.port.postMessage({ offsetHz: this.iq.offsetHz });
      this.iqMag = null;
      this._iqSource();
    }
    _iqSource() {
      if (!this.iqNode) return;
      for (const s of [this.src, this.n && this.n.mix]) { try { s.disconnect(this.iqNode); } catch { /* */ } }
      (this.dsp.specPost ? this.n.mix : this.src).connect(this.iqNode);
    }
    _teardownIq() {
      try { this.iqNode.disconnect(); } catch { /* */ }
      for (const s of [this.src, this.n && this.n.mix]) { try { s.disconnect(this.iqNode); } catch { /* */ } }
      this.iqNode = null; this.iqI = null; this.iqQ = null;
    }

    /** 复数 FFT：最近 fftSize 个 I/Q 样本，Blackman 窗，|X|/N 的 dB（和 AnalyserNode 同一标度），按"平滑"做幅度平均 */
    _readIq() {
      const N = this.fftSize;
      if (this.iqN !== N) {
        this.iqN = N; this.iqFft = window.C919DSP.makeFFT(N);
        this.iqRe = new Float64Array(N); this.iqIm = new Float64Array(N);
        this.iqBufI = new Float32Array(32768); this.iqBufQ = new Float32Array(32768);
        this.iqWin = new Float32Array(N);
        for (let i = 0; i < N; i++) this.iqWin[i] = 0.42 - 0.5 * Math.cos(2 * Math.PI * i / N) + 0.08 * Math.cos(4 * Math.PI * i / N);
        this.iqMag = new Float32Array(N); this.iqDb = new Float32Array(N);
      }
      this.iqI.getFloatTimeDomainData(this.iqBufI); this.iqQ.getFloatTimeDomainData(this.iqBufQ);
      const off = 32768 - N, re = this.iqRe, im = this.iqIm, w = this.iqWin;
      let ss = 0;
      for (let i = 0; i < N; i++) { const a = this.iqBufI[off + i], b = this.iqBufQ[off + i]; ss += a * a; re[i] = a * w[i]; im[i] = b * w[i]; }
      this.iqFft(re, im, false);
      const sm = this.smoothing, mag = this.iqMag, db = this.iqDb, h = N / 2;
      for (let k = 0; k < N; k++) {
        // 输出下标 j = 0..N-1 对应 -fs/2..+fs/2（fftshift）
        const src = (k + h) % N;
        const m = Math.sqrt(re[src] * re[src] + im[src] * im[src]) / N;
        mag[k] = sm * mag[k] + (1 - sm) * m;
        db[k] = 20 * Math.log10(mag[k] + 1e-12);
      }
      return { freq: db, rms: 10 * Math.log10(ss / N + 1e-12), sampleRate: this.ctx.sampleRate, iq: true };
    }

    /** 李萨如图用：最近 n 个 I/Q 样本（引用内部缓冲，别改） */
    iqScope(n = 1024) {
      if (!this.iqNode || !this.iqBufI) return null;
      return { I: this.iqBufI.subarray(32768 - n), Q: this.iqBufQ.subarray(32768 - n) };
    }

    _selectSpectrum() {
      this.analyser = this.dsp.specPost ? this.postAnalyser : this.preAnalyser;
      this._iqSource();
      if (this.analyser) {
        this.analyser.fftSize = this.fftSize; this.analyser.smoothingTimeConstant = this.smoothing;
        this.freqData = new Float32Array(this.analyser.frequencyBinCount);
        this.timeData = new Float32Array(this.analyser.fftSize);
      }
    }

    /**
     * 测试信号：没有声卡（比如无头截图）时用振荡器造一段"像电台"的声音：
     *   1kHz 正弦 + 一个 300Hz~6kHz 来回扫的音 + 带通噪声（模拟人声频段）+ 白噪声底 + 50Hz 交流声。
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
      // 白噪声 → 带通 300~3400Hz；另一路宽带白噪声当"底噪"
      const buf = c.createBuffer(1, c.sampleRate * 2, c.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      const noise = c.createBufferSource(); noise.buffer = buf; noise.loop = true;
      const bp = c.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1200; bp.Q.value = 0.6;
      const ng = c.createGain(); ng.gain.value = 0.25; noise.connect(bp).connect(ng).connect(mix);
      const wg = c.createGain(); wg.gain.value = 0.03; noise.connect(wg).connect(mix);
      // 19kHz 立体声导频（FM 立体声广播特有，常在 line-in 频谱里看到）
      const pilot = c.createOscillator(); pilot.frequency.value = 19000;
      const pg = c.createGain(); pg.gain.value = 0.01; pilot.connect(pg).connect(mix);
      const hum = c.createOscillator(); hum.frequency.value = 50;
      const hg = c.createGain(); hg.gain.value = 0.03; hum.connect(hg).connect(mix);
      [tone, sweep, lfo, noise, pilot, hum].forEach((x) => x.start());
      this.oscNodes = [tone, sweep, lfo, noise, pilot, hum];
      return mix;
    }

    async stop() {
      this.running = false;
      this.oscNodes.forEach((n) => { try { n.stop(); } catch { /* 已停 */ } });
      this.oscNodes = [];
      if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
      if (this.ctx) await this.ctx.close().catch(() => {});
      this.ctx = null; this.dnNode = null; this.meterIn = []; this.meterOut = null;
      this.iqNode = null; this.iqI = null; this.iqQ = null;
    }

    setFftSize(n) {
      this.fftSize = n;
      for (const a of [this.preAnalyser, this.postAnalyser]) if (a) a.fftSize = n;
      if (this.analyser) {
        this.freqData = new Float32Array(this.analyser.frequencyBinCount);
        this.timeData = new Float32Array(n);
      }
    }
    setSmoothing(v) { this.smoothing = v; for (const a of [this.preAnalyser, this.postAnalyser]) if (a) a.smoothingTimeConstant = v; }
    setMonitor(on) { this.monitorOn = !!on; this._applyMonitor(); }
    setMonitorVolume(v) { this.monitorVol = v; this._applyMonitor(); }
    _applyMonitor() {
      if (!this.monitorGain) return;
      this.monitorGain.gain.setTargetAtTime(this.monitorOn ? this.monitorVol : 0, this.ctx.currentTime, 0.02);
    }

    /** 读一帧：返回 {freq: dB 数组, rms: dBFS, sampleRate} */
    read() {
      if (!this.running) return null;
      if (this.iq.on && this.iqNode) return this._readIq();
      this.analyser.getFloatFrequencyData(this.freqData);
      this.analyser.getFloatTimeDomainData(this.timeData);
      let s = 0;
      for (const v of this.timeData) s += v * v;
      const rms = 10 * Math.log10(s / this.timeData.length + 1e-12);
      return { freq: this.freqData, rms, sampleRate: this.ctx.sampleRate };
    }

    /**
     * 电平表原始数据：每声道取最近 win 个样本的 均方 和 |峰值|，外加输出总电平。
     * win = 距上一帧的样本数（上限 2048），这样相邻两帧不会重复统计太多。
     */
    readMeters(win) {
      if (!this.running || !this.meterIn.length) return null;
      const n = Math.max(64, Math.min(2048, win | 0));
      const buf = this.meterBuf;
      const stat = (a) => {
        a.getFloatTimeDomainData(buf);
        let ss = 0, pk = 0;
        for (let i = 2048 - n; i < 2048; i++) { const v = buf[i]; ss += v * v; const av = v < 0 ? -v : v; if (av > pk) pk = av; }
        // 峰值 / 削波看整个 2048 窗口（稍有重叠无妨，宁可多报不漏报）
        for (let i = 0; i < 2048 - n; i++) { const av = Math.abs(buf[i]); if (av > pk) pk = av; }
        return { ms: ss / n, peak: pk };
      };
      return { inp: this.meterIn.map(stat), out: this.meterOut ? stat(this.meterOut) : null };
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
      this.band = null; // {lo, hi, shift}：处理链带宽限制，在频谱上画阴影（shift = 伪 IQ 频移）
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
      // 拖分隔条 / 改窗口大小时保留瀑布历史：先拍一张旧画面，改尺寸后按比例贴回去，再从画布重建环形缓冲
      let snap = null;
      const ww = Math.max(1, Math.round(this.wc.clientWidth * dpr)), wh = Math.max(1, Math.round(this.wc.clientHeight * dpr));
      if (this.ring && (this.wc.width !== ww || this.wc.height !== wh)) {
        snap = document.createElement('canvas'); snap.width = this.wc.width; snap.height = this.wc.height;
        snap.getContext('2d').drawImage(this.wc, 0, 0);
      }
      for (const c of [this.sc, this.wc]) {
        const w = Math.max(1, Math.round(c.clientWidth * dpr));
        const h = Math.max(1, Math.round(c.clientHeight * dpr));
        if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
      }
      this.wx.fillStyle = '#000'; this.wx.fillRect(0, 0, this.wc.width, this.wc.height);
      this.cols = null; this.peak = null; this.ring = null;
      if (snap) {
        // 宽度按比例拉伸，高度保持像素行数（=时间轴不变），多出来的部分是黑的
        this.wx.drawImage(snap, 0, 0, snap.width, snap.height, 0, 0, this.wc.width, snap.height);
        this.ring = this.wx.getImageData(0, 0, this.wc.width, this.wc.height); this.head = 0;
      }
    }

    set(k, v) { this.opts[k] = v; this.cols = null; if (k === 'fmax' || k === 'log') this.peak = null; }

    /** 计算 x 像素 ↔ 频率的映射（参数变化或尺寸变化时重算一次） */
    _layout(nBins, sr, iq = false) {
      const nyq = sr / 2;
      const fmax = this.opts.fmax > 0 ? Math.min(this.opts.fmax, nyq) : nyq;
      // 伪 IQ：复数谱，nBins = N 个点覆盖 -fs/2..+fs/2；显示 ±最大频率，强制线性轴
      const log = this.opts.log && !iq;
      this.logAxis = log;
      const fmin = iq ? -fmax : log ? 20 : 0;
      const W = this.sc.width;
      const xToF = (x) => (log ? fmin * Math.pow(fmax / fmin, x / W) : fmin + (fmax - fmin) * x / W);
      const binHz = iq ? sr / nBins : nyq / nBins;
      const f0 = iq ? -nyq : 0; // 下标 0 对应的频率
      const cols = new Int32Array(W * 2);
      for (let x = 0; x < W; x++) {
        let a = Math.floor((xToF(x) - f0) / binHz);
        let b = Math.floor((xToF(x + 1) - f0) / binHz);
        a = Math.max(0, Math.min(nBins - 1, a)); b = Math.max(a, Math.min(nBins - 1, b));
        cols[x * 2] = a; cols[x * 2 + 1] = b;
      }
      this.cols = cols; this.fmax = fmax; this.fmin = fmin; this.xToF = xToF; this.nBins = nBins; this.sr = sr;
      this.fToX = (f) => (log ? W * Math.log(Math.max(f, fmin) / fmin) / Math.log(fmax / fmin) : W * (f - fmin) / (fmax - fmin));
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
      const iq = !!frame.iq;
      if (!this.cols || this.nBins !== frame.freq.length || this.sr !== frame.sampleRate || this.iqMode !== iq) {
        if (this.iqMode !== iq) { this.peak = null; this.ring = null; this.iqMode = iq; } // 换模式清空瀑布
        this._layout(frame.freq.length, frame.sampleRate, iq);
      }
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
      const ticks = this.logAxis ? [50, 100, 200, 500, 1000, 2000, 5000, 10000, 15000, 20000]
        : niceTicks(this.fmin, this.fmax, 10);
      for (const f of ticks) {
        if (f < this.fmin || f > this.fmax) continue;
        const x = Math.round(this.fToX(f)) + 0.5;
        c.beginPath(); c.moveTo(x, 0); c.lineTo(x, H); c.stroke();
        c.fillText(Math.abs(f) >= 1000 ? `${f / 1000}k` : `${f}`, x + 3 * dpr, H - 4 * dpr);
      }
      // 峰值保持（缓慢下落）
      if (this.opts.peak) {
        if (!this.peak || this.peak.length !== W) this.peak = Float32Array.from(db);
        for (let x = 0; x < W; x++) this.peak[x] = Math.max(db[x], this.peak[x] - 0.4);
      }
      // 处理链的带宽限制：带内淡青色阴影 + 两条边界虚线（带外压暗）
      if (this.band) {
        const sh = frame.iq ? this.band.shift || 0 : 0;
        const x0 = Math.max(0, this.fToX(this.band.lo - sh)), x1 = Math.min(W, this.fToX(this.band.hi - sh));
        if (x1 > x0) {
          c.fillStyle = 'rgba(0,0,0,0.35)'; c.fillRect(0, 0, x0, H); c.fillRect(x1, 0, W - x1, H);
          c.fillStyle = 'rgba(78,201,78,0.10)'; c.fillRect(x0, 0, x1 - x0, H);
          c.save(); c.setLineDash([4 * dpr, 4 * dpr]); c.strokeStyle = 'rgba(78,201,78,0.8)';
          for (const x of [x0, x1]) { c.beginPath(); c.moveTo(Math.round(x) + 0.5, 0); c.lineTo(Math.round(x) + 0.5, H); c.stroke(); }
          c.restore();
          c.fillStyle = 'rgba(120,230,120,0.9)';
          c.fillText(`处理带宽 ${fmtHz(this.band.lo)} – ${fmtHz(this.band.hi)}`, x0 + 4 * dpr, H - 18 * dpr); // 放底部，避开右上角读数
        }
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
      let txt = `${frame.iq ? '伪 IQ　' : ''}峰值 ${fmtHz(this.xToF(px + 0.5))}  ${db[px].toFixed(1)} dB　|　电平 ${frame.rms.toFixed(1)} dBFS`;
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
  function fmtHz(f) { return Math.abs(f) >= 1000 ? `${(f / 1000).toFixed(2)} kHz` : `${f.toFixed(0)} Hz`; }

  /** 李萨如 / 星座小示波器：I 横轴、Q 纵轴，余辉效果 */
  function drawIqScope(canvas, data) {
    const c = canvas.getContext('2d'), W = canvas.width, H = canvas.height;
    c.fillStyle = 'rgba(5,8,12,0.35)'; c.fillRect(0, 0, W, H); // 半透明覆盖 = 余辉
    c.strokeStyle = '#26303a'; c.lineWidth = 1;
    c.beginPath(); c.moveTo(W / 2 + 0.5, 0); c.lineTo(W / 2 + 0.5, H); c.moveTo(0, H / 2 + 0.5); c.lineTo(W, H / 2 + 0.5); c.stroke();
    if (!data) return;
    const { I, Q } = data; let m = 1e-6;
    for (let i = 0; i < I.length; i++) { const a = Math.abs(I[i]), b = Math.abs(Q[i]); if (a > m) m = a; if (b > m) m = b; }
    const sc = 0.45 * Math.min(W, H) / m; // 自动缩放
    c.fillStyle = 'rgba(63,193,255,0.55)';
    for (let i = 0; i < I.length; i += 2) c.fillRect(W / 2 + I[i] * sc, H / 2 - Q[i] * sc, 1.5, 1.5);
    c.fillStyle = '#7a8a9a'; c.font = '10px monospace'; c.fillText('I →', W - 26, H / 2 - 3); c.fillText('Q ↑', W / 2 + 3, 10);
    c.fillText(`满刻度 ${(20 * Math.log10(m)).toFixed(0)} dBFS`, 3, H - 4);
  }

  window.AudioEngine = AudioEngine;
  window.drawIqScope = drawIqScope;
  window.DSP_DEFAULTS = DSP_DEFAULTS;
  window.SpectrumView = SpectrumView;
  window.AUDIO_OSC_ID = OSC_ID;
})();
