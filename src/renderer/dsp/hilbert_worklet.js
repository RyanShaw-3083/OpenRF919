'use strict';
/**
 * hilbert_worklet.js —— 伪 IQ：把实数音频变成解析信号 I + jQ
 * ============================================================
 * 注意：这【不是】射频 IQ。C919 只给解调后的音频；这里只是对音频做希尔伯特变换，
 * 得到 0..fs/2 的单边（解析）信号，主要用来"看起来像 SDR"、看相位关系（李萨如图）。
 *
 *   I = 输入延迟 (N-1)/2 个样本     Q = 输入经过 N 阶 FIR 希尔伯特滤波器（Blackman 窗）
 *   可选频移：(I + jQ)·e^{-j2π·f0·t}，f0 = fs/4 时整个音频带被搬到 -fs/4..+fs/4，画面居中。
 * 输入：单声道（多声道会被下混）。输出：2 声道，0 = I，1 = Q。
 * 主线程 port 消息：{offsetHz}
 * 255 阶，偶数位系数为 0，只算 128 个乘加/样本，CPU 很低。
 */
/* global sampleRate, registerProcessor, AudioWorkletProcessor */
const TAPS = 255, MID = (TAPS - 1) / 2;
class HilbertProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    // 只存奇数偏移的系数：h[MID ± k] = ±2/(πk)·w，k 奇数
    const ks = [], hs = [];
    for (let k = 1; k <= MID; k += 2) {
      const n = MID + k; const w = 0.42 - 0.5 * Math.cos(2 * Math.PI * n / (TAPS - 1)) + 0.08 * Math.cos(4 * Math.PI * n / (TAPS - 1));
      ks.push(k); hs.push(2 / (Math.PI * k) * w);
    }
    this.ks = Int32Array.from(ks); this.hs = Float32Array.from(hs);
    this.L = 1024; this.buf = new Float32Array(this.L * 2); this.pos = 0; // 双写环形缓冲，免取模
    this.phase = 0; this.dphi = 0;
    this.port.onmessage = (e) => { const f = Number(e.data && e.data.offsetHz) || 0; this.dphi = 2 * Math.PI * f / sampleRate; };
  }
  process(inputs, outputs) {
    const inp = inputs[0] && inputs[0][0];
    const oI = outputs[0][0], oQ = outputs[0][1] || outputs[0][0];
    const L = this.L, b = this.buf, ks = this.ks, hs = this.hs, nk = ks.length;
    for (let i = 0; i < oI.length; i++) {
      const x = inp ? inp[i] : 0;
      b[this.pos] = x; b[this.pos + L] = x;
      // 中心样本位于 pos - MID（以 pos + L 为基准避免负下标）
      const c = this.pos + L - MID;
      let q = 0;
      for (let j = 0; j < nk; j++) { const k = ks[j]; q += hs[j] * (b[c - k] - b[c + k]); }
      // 因果 FIR：h[n] 作用于 x[t-n]；n=MID-k 对应 c+k（更新），符号为 -1/(…)→ 这里写成 (旧 - 新)
      const I = b[c];
      if (this.dphi) {
        const co = Math.cos(this.phase), si = Math.sin(this.phase);
        oI[i] = I * co + q * si; oQ[i] = q * co - I * si;
        this.phase += this.dphi; if (this.phase > Math.PI) this.phase -= 2 * Math.PI;
      } else { oI[i] = I; oQ[i] = q; }
      this.pos = (this.pos + 1) % L;
    }
    return true;
  }
}
registerProcessor('c919-hilbert', HilbertProcessor);
