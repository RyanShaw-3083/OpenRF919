'use strict';
/**
 * denoise_core.js —— 频谱减法 / 谱门限降噪（纯 JS，无依赖）
 * ===========================================================
 * 同一份代码在三个地方用：
 *   1. AudioWorklet 里（denoise_worklet.js 先 addModule 本文件，挂到 globalThis 上）
 *   2. node 单元测试（module.exports）
 *   3. 以后想离线处理录音也能直接用
 *
 * 算法（每个声道一个实例）：
 *   - STFT：帧长 N=1024（48kHz 下 21ms），帧移 hop=256（75% 重叠），sqrt-Hann 分析窗 + 合成窗，
 *     重叠相加完全重建（未降噪时输出 = 输入延迟 N 个采样）。
 *   - 噪声谱估计，两种来源：
 *       a) 自动：最小值统计（minimum statistics）。每个频点的功率先做时间平滑，
 *          在约 1.5 秒的滑动窗口里取最小值，再乘一个偏差补偿系数，当作噪声底。
 *          收音机音频里人声/音乐会有停顿，最小值就落在噪声上。
 *       b) 学习：点「学习噪声」时把接下来约 1 秒（静音 / 只有底噪的那段）的平均功率谱存下来。
 *   - 增益：决策导向（decision-directed）先验信噪比 + Wiener 增益（Ephraim-Malah 那一套的简化版），
 *     再加过减系数、增益下限（不把噪声减到 0，保留一点"底"，听感更自然），
 *     频率方向 3 点平滑 + 时间方向快攻慢放，这几样一起把"音乐噪声"（随机冒出的叽叽声）压下去。
 *   - 强度 strength 0..1：同时控制过减系数（1..4）和增益下限（-6..-30 dB）。
 */
(function (root) {
  // ---------------------------------------------------------------- FFT（基 2，原地，复数）
  function makeFFT(n) {
    const levels = Math.log2(n) | 0;
    if (1 << levels !== n) throw new Error('FFT 长度必须是 2 的幂');
    const cos = new Float64Array(n / 2), sin = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) { cos[i] = Math.cos(2 * Math.PI * i / n); sin[i] = Math.sin(2 * Math.PI * i / n); }
    const rev = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      let r = 0;
      for (let b = 0; b < levels; b++) r |= ((i >>> b) & 1) << (levels - 1 - b);
      rev[i] = r;
    }
    /** inverse=false：X = Σ x·e^{-j2πkn/N}；inverse=true：不除以 N（调用方自己缩放） */
    return function fft(re, im, inverse) {
      for (let i = 0; i < n; i++) {
        const j = rev[i];
        if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
      }
      const sgn = inverse ? 1 : -1;
      for (let size = 2; size <= n; size <<= 1) {
        const half = size >>> 1, step = n / size;
        for (let i = 0; i < n; i += size) {
          for (let j = 0, k = 0; j < half; j++, k += step) {
            const wr = cos[k], wi = sgn * sin[k];
            const a = i + j, b = a + half;
            const tr = re[b] * wr - im[b] * wi, ti = re[b] * wi + im[b] * wr;
            re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
          }
        }
      }
    };
  }

  class SpectralDenoiser {
    /**
     * @param {object} o
     *   n: 帧长（默认 1024）  hop: 帧移（默认 n/4）  sampleRate
     *   strength: 0..1（默认 0.5）  mode: 'auto' | 'learned'
     */
    constructor(o = {}) {
      const n = this.n = o.n || 1024;
      const hop = this.hop = o.hop || n / 4;
      this.sampleRate = o.sampleRate || 48000;
      this.bins = n / 2 + 1;
      this.fft = makeFFT(n);
      // sqrt-Hann（周期型）；分析 × 合成 = Hann，75% 重叠时叠加和 = 2 → 输出乘 1/(n/hop/2)
      this.win = new Float32Array(n);
      for (let i = 0; i < n; i++) this.win[i] = Math.sqrt(0.5 - 0.5 * Math.cos(2 * Math.PI * i / n));
      this.olaScale = 1 / (n / hop / 2);
      this.re = new Float64Array(n); this.im = new Float64Array(n);
      // 流式缓冲：inBuf 存最近 n 个输入；outAcc 是重叠相加累加器
      this.inBuf = new Float32Array(n); this.inFill = n - hop; // 先垫 n-hop 个 0，这样第一帧在第 hop 个样本后出
      this.outAcc = new Float32Array(n);
      this.outQ = new Float32Array(n * 4); this.outR = 0; this.outW = 0; this.outCount = 0;
      // 预填 hop 个 0，使"每进 hop 个样本就出 hop 个"稳定，总延迟固定为 n 个样本
      this._pushOut(new Float32Array(hop));
      this.latency = n; // 采样数

      const B = this.bins;
      this.psd = new Float32Array(B); // 当前帧 |X|²
      this.smP = new Float32Array(B); // 平滑后的功率（最小值统计用）
      this.noise = new Float32Array(B).fill(1e-12); // 正在用的噪声估计
      this.learned = null; // 学到的噪声谱
      this.prevClean = new Float32Array(B); // 上一帧 |G·X|²（决策导向用）
      this.gain = new Float32Array(B).fill(1);
      this.gTmp = new Float32Array(B);
      // 最小值统计：把 ~1.5s 分成 SUBW 个子窗口，每个子窗口 U 帧
      const framesPerSec = this.sampleRate / hop;
      this.SUBW = 6;
      this.U = Math.max(4, Math.round(1.5 * framesPerSec / this.SUBW));
      this.subMin = Array.from({ length: this.SUBW }, () => new Float32Array(B).fill(Infinity));
      this.curMin = new Float32Array(B).fill(Infinity);
      this.subIdx = 0; this.subCount = 0; this.frames = 0;
      this.minBias = 1.8; // 最小值偏小（功率是 χ² 分布），乘个系数补回来
      this.learnLeft = 0; this.learnAcc = null; this.learnN = 0; this.onLearned = null;

      this.enabled = true;
      this.protectTones = o.protectTones ?? true; // 自动模式下保护持续窄带信号（单音 / 载波 / CW）
      this.mode = o.mode || 'auto';
      this.setStrength(o.strength ?? 0.5);
    }

    setStrength(s) {
      this.strength = Math.max(0, Math.min(1, s));
      this.overSub = 1 + 3 * this.strength; // 过减
      this.floor = Math.pow(10, -(6 + 24 * this.strength) / 20); // 增益下限 -6..-30 dB（幅度）
    }
    setMode(m) { this.mode = m === 'learned' ? 'learned' : 'auto'; }
    /** 开始学习噪声：接下来 seconds 秒的平均功率谱当作噪声 */
    learn(seconds = 1) {
      this.learnLeft = Math.max(1, Math.round(seconds * this.sampleRate / this.hop));
      this.learnAcc = new Float64Array(this.bins); this.learnN = 0;
    }
    setLearnedProfile(arr) { this.learned = arr ? Float32Array.from(arr) : null; }

    _pushOut(blk) {
      const q = this.outQ, L = q.length;
      for (let i = 0; i < blk.length; i++) { q[this.outW] = blk[i]; this.outW = (this.outW + 1) % L; }
      this.outCount += blk.length;
    }

    /** 流式处理：input/output 等长，长度任意（AudioWorklet 是 128） */
    process(input, output) {
      const n = this.n, hop = this.hop;
      for (let i = 0; i < input.length; i++) {
        this.inBuf[this.inFill++] = input[i];
        if (this.inFill === n) {
          this._frame();
          this.inBuf.copyWithin(0, hop); this.inFill = n - hop;
        }
      }
      const q = this.outQ, L = q.length;
      for (let i = 0; i < output.length; i++) {
        if (this.outCount > 0) { output[i] = q[this.outR]; this.outR = (this.outR + 1) % L; this.outCount--; } else output[i] = 0;
      }
    }

    _frame() {
      const n = this.n, hop = this.hop, B = this.bins, re = this.re, im = this.im, w = this.win;
      for (let i = 0; i < n; i++) { re[i] = this.inBuf[i] * w[i]; im[i] = 0; }
      this.fft(re, im, false);
      const psd = this.psd;
      for (let k = 0; k < B; k++) psd[k] = re[k] * re[k] + im[k] * im[k] + 1e-20;
      this.frames++;

      // ---- 噪声估计：最小值统计（一直在跑，切到"自动"立刻可用）
      const a = 0.85;
      for (let k = 0; k < B; k++) {
        const p = this.frames === 1 ? psd[k] : a * this.smP[k] + (1 - a) * psd[k];
        this.smP[k] = p;
        if (p < this.curMin[k]) this.curMin[k] = p;
      }
      if (++this.subCount >= this.U) {
        this.subMin[this.subIdx].set(this.curMin);
        this.subIdx = (this.subIdx + 1) % this.SUBW;
        this.curMin.fill(Infinity); this.subCount = 0;
      }
      // ---- 学习
      if (this.learnLeft > 0) {
        for (let k = 0; k < B; k++) this.learnAcc[k] += psd[k];
        this.learnN++;
        if (--this.learnLeft === 0) {
          this.learned = new Float32Array(B);
          for (let k = 0; k < B; k++) this.learned[k] = this.learnAcc[k] / this.learnN;
          this.learnAcc = null;
          if (this.onLearned) this.onLearned(this.learned);
        }
      }
      const noise = this.noise;
      if (this.mode === 'learned' && this.learned) {
        noise.set(this.learned);
      } else {
        for (let k = 0; k < B; k++) {
          let m = this.curMin[k];
          for (let s = 0; s < this.SUBW; s++) if (this.subMin[s][k] < m) m = this.subMin[s][k];
          if (!Number.isFinite(m)) m = this.smP[k];
          noise[k] = m * this.minBias;
        }
        // 窄带保护：最小值统计会把"持续超过 ~1.5 秒的单音 / 载波 / CW"也当成噪声减掉。
        // 噪声谱在频率方向一般是平滑的，所以把每个频点的估计限制在 ±12 个频点（约 ±560Hz）
        // 局部最低值的 4 倍（+6dB）以内：宽带噪声不受影响，窄带持续信号得以保留。
        if (this.protectTones) {
          const a = this.gTmp, R = 12; // 临时借用 gTmp
          a[0] = noise[0]; a[B - 1] = noise[B - 1];
          for (let k = 1; k < B - 1; k++) a[k] = (noise[k - 1] + noise[k] + noise[k + 1]) / 3;
          const lim = this.psd2 || (this.psd2 = new Float32Array(B));
          for (let k = 0; k < B; k++) {
            let m = Infinity; const lo = Math.max(0, k - R), hi = Math.min(B - 1, k + R);
            for (let j = lo; j <= hi; j++) if (a[j] < m) m = a[j];
            lim[k] = 4 * m;
          }
          for (let k = 0; k < B; k++) if (noise[k] > lim[k]) noise[k] = lim[k];
        }
      }

      // ---- 增益
      const g = this.gTmp;
      if (!this.enabled) g.fill(1);
      else {
        const dd = 0.96; // 决策导向平滑系数：越大越平滑、音乐噪声越少，但瞬态略拖
        for (let k = 0; k < B; k++) {
          const nk = noise[k] + 1e-20;
          const post = psd[k] / nk; // 后验 SNR
          const prio = dd * this.prevClean[k] / nk + (1 - dd) * Math.max(post - 1, 0);
          let gk = prio / (prio + this.overSub);
          if (gk < this.floor) gk = this.floor;
          g[k] = gk;
        }
        // 频率方向 3 点平滑
        let prev = g[0];
        for (let k = 1; k < B - 1; k++) { const cur = g[k]; g[k] = 0.25 * prev + 0.5 * cur + 0.25 * g[k + 1]; prev = cur; }
        // 时间方向：增益上升快（保瞬态）、下降慢（防叽叽声）
        for (let k = 0; k < B; k++) {
          const old = this.gain[k];
          g[k] = g[k] > old ? 0.6 * g[k] + 0.4 * old : 0.25 * g[k] + 0.75 * old;
        }
      }
      for (let k = 0; k < B; k++) {
        const gk = g[k];
        this.gain[k] = gk;
        this.prevClean[k] = gk * gk * psd[k];
        re[k] *= gk; im[k] *= gk;
        if (k > 0 && k < n / 2) { re[n - k] = re[k]; im[n - k] = -im[k]; } // 共轭对称 → 实信号
      }
      this.fft(re, im, true);
      const acc = this.outAcc, sc = this.olaScale / n;
      for (let i = 0; i < n; i++) acc[i] += re[i] * sc * w[i];
      this._pushOut(acc.subarray(0, hop));
      acc.copyWithin(0, hop); acc.fill(0, n - hop);
    }
  }

  const api = { SpectralDenoiser, makeFFT };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.C919DSP = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
