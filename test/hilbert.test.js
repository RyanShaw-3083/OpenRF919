'use strict';
/** 伪 IQ 希尔伯特 Worklet：在 node 里模拟 AudioWorklet 环境跑一遍，测 I/Q 幅度一致性和 90° 相位 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

function load() {
  let Cls = null;
  const g = { sampleRate: 48000, AudioWorkletProcessor: class { constructor() { this.port = {}; } }, registerProcessor: (_n, c) => { Cls = c; } };
  const src = fs.readFileSync(path.join(__dirname, '../src/renderer/dsp/hilbert_worklet.js'), 'utf8');
  new Function('sampleRate', 'AudioWorkletProcessor', 'registerProcessor', src)(g.sampleRate, g.AudioWorkletProcessor, g.registerProcessor);
  return Cls;
}

test('希尔伯特：I/Q 等幅、Q = sin（正频率），镜像抑制', () => {
  const P = load();
  for (const f of [300, 1000, 5000, 15000]) {
    const p = new P(); let eI = 0, eQ = 0, cr = 0, t = 0;
    let pr = 0, pi = 0, nr = 0, ni = 0; // I+jQ 与 e^{+jωt} / e^{-jωt} 的相关 → 正 / 负频率分量
    for (let b = 0; b < 375; b++) {
      const x = new Float32Array(128).map((_, i) => Math.cos(2 * Math.PI * f * (t + i) / 48000));
      const I = new Float32Array(128), Q = new Float32Array(128);
      p.process([[x]], [[I, Q]]);
      if (b > 10) for (let i = 0; i < 128; i++) { eI += I[i] ** 2; eQ += Q[i] ** 2; cr += Q[i] * Math.sin(2 * Math.PI * f * (t + i - 127) / 48000);
        const w = 2 * Math.PI * f * (t + i) / 48000, c = Math.cos(w), s = Math.sin(w);
        // (I + jQ)·e^{-jw} → 正频率；(I + jQ)·e^{+jw} → 负频率（镜像）
        pr += I[i] * c + Q[i] * s; pi += Q[i] * c - I[i] * s; nr += I[i] * c - Q[i] * s; ni += Q[i] * c + I[i] * s; }
      t += 128;
    }
    const ratio = 10 * Math.log10(eQ / eI);
    const irr = 10 * Math.log10((pr * pr + pi * pi) / (nr * nr + ni * ni + 1e-30)); // 实测镜像抑制
    console.log(`  ${f} Hz：Q/I ${ratio.toFixed(2)} dB，镜像抑制 ≈ ${irr.toFixed(0)} dB`);
    assert.ok(cr > 0, 'Q 应与 sin 同相（正频率）');
    assert.ok(Math.abs(ratio) < 1);
    assert.ok(irr > 20, '镜像抑制 > 20 dB');
  }
});
