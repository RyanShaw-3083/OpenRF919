'use strict';
/**
 * 降噪 DSP 单元测试（纯 node，不需要 Electron）
 * 合成信号：1 kHz 正弦（0.5 秒有 / 0.5 秒无，模拟节目里的停顿）+ 白噪声，48 kHz，6 秒。
 * 指标：
 *   - 输出 SNR：参考 = 干净信号延迟 1024 点；误差 = 输出 − 参考（含"信号被削弱"的部分，偏保守）
 *   - 停顿段噪声衰减：停顿段里输出功率 / 输入功率
 *   - 正弦保真：有信号段里输出在 1 kHz 上的幅度 / 原始幅度
 * 跳过前 2 秒（最小值统计需要 ~1.5 秒收敛）。
 */
const test = require('node:test');
const assert = require('node:assert');
const { SpectralDenoiser } = require('../src/renderer/dsp/denoise_core.js');

const SR = 48000;
function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
function gauss(r) { return Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r()); }

function makeSignal(sec, amp, noiseRms, seed = 1) {
  const n = sec * SR, clean = new Float32Array(n), noisy = new Float32Array(n), r = rng(seed);
  for (let i = 0; i < n; i++) {
    const on = Math.floor(i / (SR / 2)) % 2 === 0;
    clean[i] = on ? amp * Math.sin(2 * Math.PI * 1000 * i / SR) : 0;
    noisy[i] = clean[i] + noiseRms * gauss(r);
  }
  return { clean, noisy };
}
function run(d, x) {
  const y = new Float32Array(x.length);
  for (let i = 0; i < x.length; i += 128) d.process(x.subarray(i, i + 128), y.subarray(i, i + 128));
  return y;
}
const db = (v) => 10 * Math.log10(v);

function metrics(clean, noisy, y, lat, from) {
  let sig = 0, errIn = 0, errOut = 0, gapIn = 0, gapOut = 0, c1 = 0, c2 = 0;
  for (let i = from; i < clean.length - lat; i++) {
    const ref = clean[i], o = y[i + lat];
    sig += ref * ref; errIn += (noisy[i] - ref) ** 2; errOut += (o - ref) ** 2;
    const on = Math.floor(i / (SR / 2)) % 2 === 0;
    // 停顿段：避开边界 50ms
    const pos = i % (SR / 2);
    if (!on && pos > 2400 && pos < SR / 2 - 2400) { gapIn += noisy[i] ** 2; gapOut += o * o; }
    if (on) { c1 += o * Math.sin(2 * Math.PI * 1000 * i / SR); c2 += ref * Math.sin(2 * Math.PI * 1000 * i / SR); }
  }
  return { snrIn: db(sig / errIn), snrOut: db(sig / errOut), gapAtten: db(gapOut / gapIn), toneGain: db((c1 / c2) ** 2) };
}

test('关闭降噪时完全重建（延迟 1024 点）', () => {
  const d = new SpectralDenoiser({ sampleRate: SR }); d.enabled = false;
  const { noisy } = makeSignal(1, 0.1, 0.1);
  const y = run(d, noisy);
  let e = 0, p = 0;
  for (let i = 2000; i < noisy.length - 2000; i++) { e += (y[i + 1024] - noisy[i]) ** 2; p += noisy[i] ** 2; }
  console.log(`  重建误差 ${db(e / p).toFixed(1)} dB`);
  assert.ok(db(e / p) < -100);
  assert.equal(d.latency, 1024);
});

// 最后一项是 -14 dB 的极弱信号：信号本身也会被压掉一些，所以放宽到 6 dB
for (const [amp, nrms, str, maxLoss] of [[0.1, 0.05, 0.5, 3], [0.05, 0.05, 0.5, 3], [0.05, 0.05, 1.0, 3], [0.02, 0.05, 0.7, 6]]) {
  test(`自动噪声跟踪：正弦幅度 ${amp}、噪声 RMS ${nrms}、强度 ${str}`, () => {
    const { clean, noisy } = makeSignal(6, amp, nrms, 7);
    const d = new SpectralDenoiser({ sampleRate: SR, strength: str, mode: 'auto' });
    const m = metrics(clean, noisy, run(d, noisy), 1024, 2 * SR);
    console.log(`  SNR 输入 ${m.snrIn.toFixed(1)} dB → 输出 ${m.snrOut.toFixed(1)} dB（+${(m.snrOut - m.snrIn).toFixed(1)}）；停顿段噪声 ${m.gapAtten.toFixed(1)} dB；1kHz 幅度 ${m.toneGain.toFixed(2)} dB`);
    assert.ok(m.snrOut > m.snrIn + 6, 'SNR 至少提升 6 dB');
    assert.ok(m.gapAtten < -10, '停顿段噪声至少压 10 dB');
    assert.ok(m.toneGain > -maxLoss, `正弦损失 < ${maxLoss} dB`);
  });
}

test('自动模式下持续单音（6 秒不间断）不被当成噪声减掉', () => {
  const r = rng(11); const N = 6 * SR; const x = new Float32Array(N);
  for (let i = 0; i < N; i++) x[i] = 0.05 * Math.sin(2 * Math.PI * 1000 * i / SR) + 0.05 * gauss(r);
  const res = {};
  for (const protect of [false, true]) {
    const d = new SpectralDenoiser({ sampleRate: SR, protectTones: protect });
    const y = run(d, x); let c = 0, cnt = 0;
    for (let i = 4 * SR; i < N - 1024; i++) { c += y[i + 1024] * Math.sin(2 * Math.PI * 1000 * i / SR); cnt++; }
    res[protect] = 20 * Math.log10(c / (cnt / 2) / 0.05);
  }
  console.log(`  持续 1kHz 幅度：无保护 ${res.false.toFixed(1)} dB，窄带保护 ${res.true.toFixed(1)} dB`);
  assert.ok(res.true > -3);
});

test('学习噪声谱模式（先喂 1 秒纯噪声学习）', () => {
  const r = rng(99);
  const noiseOnly = new Float32Array(SR).map(() => 0.05 * gauss(r));
  const d = new SpectralDenoiser({ sampleRate: SR, strength: 0.5 });
  let learned = false; d.onLearned = () => { learned = true; };
  d.learn(0.8); run(d, noiseOnly);
  assert.ok(learned);
  d.setMode('learned');
  const { clean, noisy } = makeSignal(4, 0.05, 0.05, 3);
  const m = metrics(clean, noisy, run(d, noisy), 1024, 0); // 学习模式不需要收敛时间，从头算
  console.log(`  [学习] SNR 输入 ${m.snrIn.toFixed(1)} dB → 输出 ${m.snrOut.toFixed(1)} dB（+${(m.snrOut - m.snrIn).toFixed(1)}）；停顿段噪声 ${m.gapAtten.toFixed(1)} dB；1kHz 幅度 ${m.toneGain.toFixed(2)} dB`);
  assert.ok(m.snrOut > m.snrIn + 6);
});

test('CPU：处理 10 秒单声道的耗时', () => {
  const { noisy } = makeSignal(10, 0.05, 0.05, 5);
  const d = new SpectralDenoiser({ sampleRate: SR });
  const t0 = process.hrtime.bigint(); run(d, noisy); const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  console.log(`  10 秒音频耗时 ${ms.toFixed(0)} ms（实时系数 ${(ms / 10000 * 100).toFixed(2)}%）`);
  assert.ok(ms < 5000);
});
