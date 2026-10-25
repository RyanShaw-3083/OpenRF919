'use strict';
// protocol.js 单元测试：用 node 自带的 node:test，不需要装测试框架。
// 运行：npm test
// 测试向量全部来自真机日志（src/sample_frames.js）。
const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../src/protocol');
const S = require('../src/sample_frames');

test('校验和与拼帧：握手、按键、设频率', () => {
  assert.equal(P.hex(P.HANDSHAKE), 'ab 01 ff ab');
  assert.equal(P.hex(P.buildFrame(0xff)), 'ab 01 ff ab'); // 握手也符合通用规则
  assert.equal(P.hex(P.keyFrame('BAND')), 'ab 02 0c 00 b9'); // PROTOCOL.md 里的例子
  assert.equal(P.hex(P.keyFrame('POWER')), 'ab 02 0c 14 cd'); // 真机验证过的电源键
  // 真机验证：raw 0 10000 → FM 100.00MHz（期望值与 Python 版 c919_ble.build_frame 输出一致）
  assert.equal(P.hex(P.setFreqFrame(0, 10000)), 'ab 06 10 00 10 27 00 00 f8');
  // PROTOCOL.md 例子：99.5MHz → K=9950 → AB 06 10 00 DE 26 00 00 SUM
  const f = P.setFreqFrame(0, P.valueToK(99.5, 2));
  assert.equal(P.hex(f.subarray(0, 8)), 'ab 06 10 00 de 26 00 00');
  assert.equal(f[8], P.checksum(f.subarray(0, 8)));
  assert.throws(() => P.keyFrame('NOPE'));
});

test('所有真机帧的校验和都正确', () => {
  const all = [...S.CONNECT_BURST, ...S.SIGNAL_PAIRS.flat(), S.MODE_OFF];
  for (const h of all) {
    const b = P.fromHex(h);
    assert.equal(b.length, b[1] + 3, `长度不对：${h}`);
    assert.equal(P.checksum(b.subarray(0, -1)), b[b.length - 1], `校验不对：${h}`);
  }
});

test('切帧器：多帧粘包、一帧拆两包、前导垃圾', () => {
  const sp = new P.FrameSplitter();
  const a = P.fromHex('ab 02 07 02 b6');
  const b = P.fromHex('ab 09 01 00 b8 29 00 00 00 24 00 ba');
  // 两帧粘在一起，前面再加两个垃圾字节，后面再拆开
  const all = Buffer.concat([Buffer.from([0x00, 0x11]), a, b]);
  let out = sp.push(all.subarray(0, 9));
  assert.equal(out.length, 1);
  assert.deepEqual(out[0], a);
  out = sp.push(all.subarray(9));
  assert.equal(out.length, 1);
  assert.deepEqual(out[0], b);
  assert.equal(sp.badChecksum, 0);
});

test('频率帧：FM 106.80MHz（K=10680, af=4, ag=2）', () => {
  const p = new P.FrameParser();
  const ev = p.feed(P.fromHex('ab 09 01 00 b8 29 00 00 00 24 00 ba'));
  assert.equal(ev.type, 'freq');
  assert.equal(p.st.band, 0);
  assert.equal(p.st.bandName, 'FM');
  assert.equal(p.st.k, 10680);
  assert.equal(p.st.unit, 'MHz');
  assert.equal(p.st.af, 4);
  assert.equal(p.st.ag, 2);
  assert.equal(p.st.freqText, '106.80');
  assert.equal(P.decimalsOf(p.st.freqText), 2);
  // 反过来：FM K = round(MHz*100)
  assert.equal(P.valueToK(106.8, 2), 10680);
  assert.equal(P.valueToK(87.5, 2), 8750);
});

test('formatFreq 推断规则', () => {
  assert.equal(P.formatFreq(10680, 4, 2), '106.80');
  assert.equal(P.formatFreq(9810, 4, 3), '98.10');
  assert.equal(P.formatFreq(1008, 0, 0), '1008');
});

test('工作模式、电池、波段位图、上限', () => {
  const p = new P.FrameParser();
  p.feed(P.fromHex(S.MODE_OFF));
  assert.equal(p.st.workMode, 'OFF');
  p.feed(P.fromHex('ab 02 07 02 b6'));
  assert.equal(p.st.workMode, 'RADIO');
  p.feed(P.fromHex('ab 03 08 03 00 b9'));
  assert.equal(p.st.battery, 3);
  assert.equal(p.st.charging, false);
  p.feed(P.fromHex('ab 03 15 ff 01 c3'));
  assert.deepEqual(p.st.supportedBands.map((b) => P.BANDS[b]),
    ['FM', 'AM', 'SW', 'AIR', 'CB', 'UHF', 'WB', 'VHF', 'LW']);
  p.feed(P.fromHex('ab 03 18 5a 09 29'));
  assert.equal(p.st.sleepMax, 90);
  assert.equal(p.st.sqMax, 9);
});

test('RSSI / SNR 走 0x1C 文字帧（fid 8 / fid 6）', () => {
  const p = new P.FrameParser();
  p.feed(P.fromHex('ab 06 1c 06 03 02 31 30 39'));
  p.feed(P.fromHex('ab 06 1c 08 03 02 33 30 3d'));
  assert.equal(p.st.snr, 10);
  assert.equal(p.st.rssi, 30);
  assert.equal(p.st.rssiSeq, 1);
  p.feed(P.fromHex('ab 05 1c 06 03 01 39 0f'));
  p.feed(P.fromHex('ab 06 1c 08 03 02 32 39 45'));
  assert.equal(p.st.snr, 9);
  assert.equal(p.st.rssi, 29);
  assert.equal(p.st.rssiSeq, 2);
});

test('解调 / 带宽文字、多段 text11 / text12（GBK ℃）', () => {
  const p = new P.FrameParser();
  for (const h of S.CONNECT_BURST) p.feed(P.fromHex(h));
  assert.equal(p.st.demod, 'ST');
  assert.equal(p.st.bandwidth, '110K');
  assert.equal(p.st.texts.text11, 'VOL:1  STEP:100K  DE-EMP:50US  ATT:DX  STEREO');
  assert.equal(p.st.texts.text12, 'MIX:DISABLE  ANT:AUTO  EQ:NORMAL  TEMPRATURE:25℃');
  assert.equal(p.st.info.VOL, '1');
  assert.equal(p.st.volume, 1);
  assert.equal(p.st.info.STEP, '100K');
  assert.equal(p.st.info['DE-EMP'], '50US');
  assert.equal(p.st.info.ATT, 'DX');
  assert.equal(p.st.info.STEREO, true);
  assert.equal(p.st.info.MIX, 'DISABLE');
  assert.equal(p.st.info.ANT, 'AUTO');
  assert.equal(p.st.info.EQ, 'NORMAL');
  assert.equal(p.st.info.TEMPRATURE, '25℃'); // 固件原文就拼错成 TEMPRATURE
  assert.match(p.st.version, /Firmware version:1\.723/);
  assert.match(p.st.version, /Model:HRD-C919/);
  assert.equal(p.st.snr, 9);
  assert.equal(p.st.rssi, 26);
  assert.equal(p.st.freqText, '106.80');
});

test('按钮文字（0x21）与按钮可用性（0x17）', () => {
  const p = new P.FrameParser();
  for (const h of S.CONNECT_BURST) p.feed(P.fromHex(h));
  assert.deepEqual(p.st.buttonLabels, { 1: 'BW-DM', 2: 'ANT-ATT', 3: 'V-UHF', 4: 'MUTE', 5: 'LOCK' });
  assert.deepEqual(p.st.buttonsEnabled, { 1: true, 2: true, 3: true });
  assert.equal(P.BUTTONS[1].key, 'SUBBAND');
  assert.equal(P.BUTTONS[4].longKey, 'SOS_LONG');
});

test('整批连接帧没有一帧落到 UNPARSED', () => {
  const p = new P.FrameParser();
  const un = [];
  for (const h of [...S.CONNECT_BURST, ...S.SIGNAL_PAIRS.flat()]) {
    const ev = p.feed(P.fromHex(h));
    if (ev.type === 'unparsed') un.push(h);
  }
  assert.deepEqual(un, []);
});

test('其它下行指令格式', () => {
  assert.equal(P.hex(P.setBandFrame(2)), 'ab 06 10 02 00 00 00 00 c3');
  assert.equal(P.hex(P.sleepFrame(30)), 'ab 02 0f 1e da');
  assert.equal(P.hex(P.squelchFrame(3)), 'ab 02 11 03 c1');
  const t = P.timeSyncFrame(new Date(2026, 9, 25, 14, 5, 9));
  assert.equal(P.hex(t.subarray(0, 9)), 'ab 07 0d 0e 05 09 38 0a 19');
  assert.equal(P.hex(P.alarmFrame(7, 30, true)), 'ab 05 0e 00 07 1e 01 e4');
  // 每个按键码都能拼出来且长度 5
  for (const k of Object.keys(P.KEYS)) assert.equal(P.keyFrame(k).length, 5);
});
