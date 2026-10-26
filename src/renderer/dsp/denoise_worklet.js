'use strict';
/**
 * denoise_worklet.js —— AudioWorklet 包装：每个声道一个 SpectralDenoiser
 * 必须先 addModule('dsp/denoise_core.js')，它把 C919DSP 挂在 AudioWorkletGlobalScope 上。
 *
 * 主线程 → port 消息：
 *   {type:'config', enabled, strength, mode}   {type:'learn', seconds}   {type:'profile', data:[...]|null}
 * port → 主线程：
 *   {type:'learned', data:Float32Array}   {type:'ready', latency}
 * 关闭降噪时仍走 STFT（增益全 1），这样延迟不变，干/湿混合不会因为开关而错位。
 */
/* global C919DSP, sampleRate, registerProcessor, AudioWorkletProcessor */
class DenoiseProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.cfg = { enabled: true, strength: 0.5, mode: 'auto' };
    this.inst = [];
    this.profile = null;
    this.port.onmessage = (e) => this._msg(e.data);
    this.port.postMessage({ type: 'ready', latency: 1024 });
  }

  _get(ch) {
    while (this.inst.length <= ch) {
      const d = new C919DSP.SpectralDenoiser({ sampleRate, n: 1024 });
      this._apply(d);
      if (this.profile) d.setLearnedProfile(this.profile);
      const idx = this.inst.length;
      d.onLearned = (prof) => {
        if (idx === 0) { this.profile = prof; this.inst.forEach((o) => o !== d && o.setLearnedProfile(prof)); this.port.postMessage({ type: 'learned', data: prof }); }
      };
      this.inst.push(d);
    }
    return this.inst[ch];
  }

  _apply(d) { d.enabled = this.cfg.enabled; d.setStrength(this.cfg.strength); d.setMode(this.cfg.mode); }

  _msg(m) {
    if (!m) return;
    if (m.type === 'config') { Object.assign(this.cfg, m); this.inst.forEach((d) => this._apply(d)); }
    if (m.type === 'learn') { const d = this._get(0); d.learn(m.seconds || 1); }
    if (m.type === 'profile') { this.profile = m.data ? Float32Array.from(m.data) : null; this.inst.forEach((d) => d.setLearnedProfile(this.profile)); }
  }

  process(inputs, outputs) {
    const inp = inputs[0], out = outputs[0];
    if (!inp || !inp.length) { for (const o of out) o.fill(0); return true; }
    for (let ch = 0; ch < out.length; ch++) {
      const src = inp[Math.min(ch, inp.length - 1)];
      this._get(ch).process(src, out[ch]);
    }
    return true;
  }
}
registerProcessor('c919-denoise', DenoiseProcessor);
