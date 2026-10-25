'use strict';
/**
 * mock.js —— 模拟收音机（C919_MOCK=1）
 * =====================================
 * 没有真机也能开发和截图：它像真收音机一样
 *   - 收到握手后推一整批状态帧（直接回放真机日志里的帧，见 sample_frames.js）；
 *   - 开机状态下每秒推一对 SNR / RSSI 文字帧（数值在真机范围附近随机抖动）；
 *   - 收到"设频率"指令后回一个频率帧，模拟按键（电源、音量、上下调台）。
 * 注意：模拟器的行为是按协议"猜"的，不代表真机一定这样反应。
 */
const { EventEmitter } = require('node:events');
const P = require('./protocol');
const S = require('./sample_frames');
const iconv = require('iconv-lite');

/** 把一段文字拼成 0x1C / 0x21 文字帧（超过 13 字节就分段，和真机一样一包最多 20 字节） */
function textFrames(cmd, fid, str) {
  const data = iconv.encode(str, 'gbk');
  const chunks = [];
  for (let i = 0; i < data.length; i += 13) chunks.push(data.subarray(i, i + 13));
  if (!chunks.length) chunks.push(Buffer.alloc(0));
  return chunks.map((c, i) => {
    let seg;
    if (chunks.length === 1) seg = 3; else if (i === 0) seg = 1; else if (i === chunks.length - 1) seg = 4; else seg = 2;
    return P.buildFrame(cmd, [fid, seg, c.length, ...c]);
  });
}

/** 频率帧 AB 09 01：按 FM 的显示规则算 af/ag（整数部分 2~3 位，2 位小数） */
function freqFrame(band, k) {
  const len = String(k).length;
  const af = 4; // 小数点固定在第 4 格后
  const ag = af - (len - 2) + 1; // 整数位数 = len - 2
  return P.buildFrame(0x01, [band, ...[0, 1, 2, 3].map((i) => (k >>> (8 * i)) & 0xff), band === 1 || band === 8 ? 1 : 0, (ag << 4) | af, 0]);
}

class MockRadio extends EventEmitter {
  constructor() {
    super();
    this.connected = false;
    this.on_ = true; // 开机状态
    this.band = 0; this.k = 10680; this.vol = 12;
    this.timer = null; this.t = 0;
  }

  connect() { this.connected = true; }

  disconnect() {
    this.connected = false;
    clearInterval(this.timer); this.timer = null;
  }

  /** 推一帧（拆成 20 字节以内的包，模拟 BLE MTU） */
  _notify(buf) {
    if (!this.connected) return;
    for (let i = 0; i < buf.length; i += 20) this.emit('notify', buf.subarray(i, i + 20));
  }

  _text11() {
    return textFrames(0x1c, 11, `VOL:${this.vol}  STEP:100K  DE-EMP:50US  ATT:DX  STEREO`);
  }

  /** App → 收音机 */
  write(buf) {
    const sp = new P.FrameSplitter();
    for (const f of sp.push(buf)) setTimeout(() => this._handle(f), 30);
  }

  _handle(f) {
    const cmd = f[2];
    if (f[1] === 0x01 && cmd === 0xff) { // 握手
      for (const h of S.CONNECT_BURST) this._notify(P.fromHex(h));
      this._notify(P.fromHex(this.on_ ? 'ab 02 07 02 b6' : S.MODE_OFF));
      this._notify(freqFrame(this.band, this.k));
      for (const fr of this._text11()) this._notify(fr);
      if (!this.timer) this.timer = setInterval(() => this._tick(), 1000);
      return;
    }
    if (cmd === 0x10) { // 设频率
      this.band = f[3];
      const k = f.readUInt32LE(4);
      if (k) this.k = k;
      this._notify(freqFrame(this.band, this.k));
      return;
    }
    if (cmd === 0x0c) { // 按键
      const key = Object.keys(P.KEYS).find((n) => P.KEYS[n] === f[3]);
      if (key === 'POWER') this.on_ = true;
      if (key === 'POWER_LONG') this.on_ = false;
      if (key === 'POWER' || key === 'POWER_LONG') this._notify(P.buildFrame(0x07, [this.on_ ? 2 : 0]));
      if (key === 'VOL_UP' || key === 'VOL_UP_LONG') this.vol = Math.min(32, this.vol + 1);
      if (key === 'VOL_DOWN' || key === 'VOL_DOWN_LONG') this.vol = Math.max(0, this.vol - 1);
      if (key && key.startsWith('VOL')) for (const fr of this._text11()) this._notify(fr);
      if (key === 'UP' || key === 'DOWN') {
        this.k += key === 'UP' ? 10 : -10;
        this._notify(freqFrame(this.band, this.k));
      }
    }
  }

  _tick() {
    if (!this.on_) return;
    this.t++;
    // 让信号随频率变化一点：在 "电台"（每 0.4MHz 一个）附近强一些
    const d = Math.abs(((this.k % 40) + 40) % 40 - 20) / 20; // 0..1
    const rssi = Math.round(14 + 18 * d + Math.random() * 4);
    const snr = Math.max(0, Math.round(rssi / 3 + Math.random() * 3 - 1));
    for (const fr of textFrames(0x1c, 6, String(snr))) this._notify(fr);
    for (const fr of textFrames(0x1c, 8, String(rssi))) this._notify(fr);
    if (this.t % 10 === 0) this._notify(P.buildFrame(0x08, [3, 0])); // 偶尔推电池
  }
}

module.exports = { MockRadio, textFrames, freqFrame };
