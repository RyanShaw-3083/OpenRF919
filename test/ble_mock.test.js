'use strict';
// 连接管理器（ble.js）+ 模拟收音机（mock.js）的集成测试：不需要真机和蓝牙。
// 验证：连接 → 握手 → 收到整批状态 → 设频率 → 收音机回报新频率 → 按键 → 断开。
const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../src/protocol');
const { C919Ble } = require('../src/ble');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('模拟后端：握手、状态、设频率、按键', async () => {
  const ble = new C919Ble({ backend: 'mock' });
  const sp = new P.FrameSplitter();
  const parser = new P.FrameParser();
  const tx = [];
  const states = [];
  ble.on('tx', (b) => tx.push(P.hex(b)));
  ble.on('state', (s) => states.push(s));
  ble.on('data', (c) => { for (const f of sp.push(c)) parser.feed(f); });

  await ble.connect(null);
  assert.equal(ble.state, 'connected');
  assert.deepEqual(tx[0], 'ab 01 ff ab'); // 握手是第一帧
  await sleep(200);
  assert.equal(parser.st.workMode, 'RADIO');
  assert.equal(parser.st.freqText, '106.80');
  assert.equal(parser.st.bandwidth, '110K');
  assert.equal(sp.badChecksum, 0);

  await ble.send(P.setFreqFrame(0, P.valueToK(99.5, 2)));
  await sleep(150);
  assert.equal(parser.st.k, 9950);
  assert.equal(parser.st.freqText, '99.50');

  await ble.send(P.keyFrame('VOL_UP'));
  await sleep(150);
  assert.equal(parser.st.volume, 13);

  await ble.disconnect();
  assert.equal(ble.state, 'disconnected');
  assert.ok(states.includes('connecting'));
  await ble.destroy();
});
