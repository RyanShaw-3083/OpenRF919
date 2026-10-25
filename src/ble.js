'use strict';
/**
 * ble.js —— 蓝牙传输层（只管"连上、收字节、发字节"，不懂协议内容）
 * ==================================================================
 *
 * 对外是一个 EventEmitter：
 *   事件 'state'  (state, detail)   连接状态变化：idle / scanning / connecting / connected / reconnecting / disconnected / error
 *   事件 'data'   (Buffer)           收到一包通知（ff14），可能是半帧、一帧或多帧，由上层切帧
 *   事件 'tx'     (Buffer)           成功写出一帧（给上层记日志）
 *   事件 'log'    (string)           内部日志（写日志文件，不打到终端）
 *   方法 scan(ms) → [{id, name, rssi}]
 *   方法 connect(id?)  不给 id 就按名字（HRD-C919-BLE 等）自动找
 *   方法 disconnect()
 *   方法 send(Buffer)
 *
 * 三种后端，用环境变量 C919_BLE_BACKEND 选：
 *   bluez（默认，Linux）—— 通过 D-Bus 调系统的 BlueZ（npm 包 node-ble）。
 *        和你在 Python 里用的 bleak 是同一条路，已经在真机上验证过能连。
 *        最大的好处：和 BlueZ 共存，同一个蓝牙适配器上还能同时跑 A2DP 音频（PipeWire），
 *        也不需要 setcap / root。
 *   noble —— @abandonware/noble，直接开 HCI 原始套接字，绕过 bluetoothd。
 *        需要 setcap cap_net_raw 或 root；而且它和 bluetoothd 抢同一个适配器，
 *        经常要先停掉 bluetoothd，这样 A2DP 蓝牙音频就没了。所以只作为备选。
 *   mock —— 不碰蓝牙，用 mock.js 模拟一台收音机（C919_MOCK=1 时自动用它）。
 *
 * 真机上观察到的几个坑（都已经处理）：
 *   - 第一次连接偶尔报 "failed to discover services"，重试一次就好 → connect() 内部重试 3 次；
 *   - 必须先开通知，再发握手 AB 01 FF AB，否则会漏掉握手后马上推过来的那一批状态；
 *   - 不需要心跳（keepalive），只要连接不断即可。连接意外断开时自动重连（可关）。
 */

const { EventEmitter } = require('node:events');
const P = require('./protocol');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 给一个 Promise 加超时，免得 D-Bus / HCI 调用卡死 */
function withTimeout(promise, ms, what) {
  let t;
  return Promise.race([
    promise.finally(() => clearTimeout(t)),
    new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${what} 超时（${ms}ms）`)), ms); }),
  ]);
}

const nameMatches = (name) => !!name && P.NAME_HINTS.some((h) => name.includes(h));

// ===========================================================================
// 后端 1：BlueZ D-Bus（node-ble）
// ===========================================================================
class BluezBackend {
  constructor(log) {
    this.log = log;
    this.bt = null; // node-ble 的 bluetooth 对象
    this.destroyBus = null;
    this.adapter = null;
    this.device = null;
    this.wChar = null; // ff13
    this.nChar = null; // ff14
    this.onData = null; // 由 C919Ble 设置
    this.onDisconnect = null;
  }

  async _init() {
    if (this.adapter) return;
    const { createBluetooth } = require('node-ble'); // 懒加载：mock 模式不需要 D-Bus
    const { bluetooth, destroy } = createBluetooth();
    // D-Bus 连接出错（比如系统没有 dbus / bluetoothd 没运行）时 dbus-next 会发 'error' 事件，
    // 不监听的话整个程序会崩。这里接住它，变成一个普通的失败。
    let busErr = null;
    bluetooth.dbus.on('error', (e) => { busErr = e; this.log(`D-Bus 错误：${e.message}`); });
    try {
      this.adapter = await withTimeout(bluetooth.defaultAdapter(), 5000, '获取蓝牙适配器');
    } catch (e) {
      destroy();
      throw new Error(`连不上 BlueZ（${busErr ? busErr.message : e.message}）：确认 bluetoothd 在运行（systemctl status bluetooth）`);
    }
    this.bt = bluetooth; this.destroyBus = destroy;
    if (!(await this.adapter.isPowered())) throw new Error('蓝牙适配器没有打开（bluetoothctl power on）');
  }

  /** 扫描 ms 毫秒，返回名字像收音机的设备；找到第一个匹配的就提前返回（stopOnFirst） */
  async scan(ms = 10000, stopOnFirst = false) {
    await this._init();
    const a = this.adapter;
    if (!(await a.isDiscovering())) await a.startDiscovery();
    const found = new Map();
    const deadline = Date.now() + ms;
    try {
      while (Date.now() < deadline) {
        for (const mac of await a.devices()) {
          if (found.has(mac)) continue;
          try {
            const d = await a.getDevice(mac);
            const name = await d.getName().catch(() => d.getAlias().catch(() => ''));
            if (!nameMatches(name)) continue;
            const rssi = await d.getRSSI().catch(() => null);
            found.set(mac, { id: mac, name, rssi });
            this.log(`扫描到 ${name} @ ${mac} rssi=${rssi}`);
          } catch { /* 设备刚好消失，忽略 */ }
        }
        if (stopOnFirst && found.size) break;
        await sleep(500);
      }
    } finally {
      // 连接之前要停止扫描（BlueZ 在扫描中连接 LE 设备容易失败）
      if (await a.isDiscovering().catch(() => false)) await a.stopDiscovery().catch(() => {});
    }
    return [...found.values()];
  }

  async connect(id) {
    await this._init();
    let dev;
    try { dev = await this.adapter.getDevice(id); } catch {
      // BlueZ 缓存里已经没有这个设备了（扫描结束后会被清掉）→ 重新扫一下
      this.log(`BlueZ 缓存里没有 ${id}，重新扫描`);
      await this.scan(10000, true);
      dev = await this.adapter.getDevice(id);
    }
    this.device = dev;
    dev.removeAllListeners('disconnect');
    dev.on('disconnect', () => { this.log('BlueZ 报告：设备断开'); this._cleanup(); if (this.onDisconnect) this.onDisconnect(); });
    if (!(await dev.isConnected())) await withTimeout(dev.connect(), 20000, '连接');
    const gatt = await withTimeout(dev.gatt(), 20000, '发现服务');
    // 先按已知服务 ff12 找；找不到就遍历所有服务找 ff13/ff14（App 本身就是这么做的）
    let svcs = [];
    try { svcs = [await gatt.getPrimaryService(P.SERVICE_UUID)]; } catch {
      svcs = await Promise.all((await gatt.services()).map((u) => gatt.getPrimaryService(u)));
    }
    for (const s of svcs) {
      const chars = await s.characteristics();
      if (chars.includes(P.CHAR_WRITE)) this.wChar = await s.getCharacteristic(P.CHAR_WRITE);
      if (chars.includes(P.CHAR_NOTIFY)) this.nChar = await s.getCharacteristic(P.CHAR_NOTIFY);
    }
    if (!this.wChar || !this.nChar) throw new Error('没找到 ff13/ff14 特征：确认连的是 HRD-C919-BLE');
    this.nChar.removeAllListeners('valuechanged');
    this.nChar.on('valuechanged', (buf) => this.onData && this.onData(buf));
    await this.nChar.startNotifications();
  }

  async send(buf) {
    if (!this.wChar) throw new Error('未连接');
    // 特征属性是 ['write']，即"带响应写"（type: request）【已验证】
    await withTimeout(this.wChar.writeValue(Buffer.from(buf), { type: 'request' }), 5000, '写入');
  }

  _cleanup() { this.wChar = null; this.nChar = null; }

  async disconnect() {
    const dev = this.device;
    try { if (this.nChar) await this.nChar.stopNotifications().catch(() => {}); } finally {
      this._cleanup();
      if (dev) { dev.removeAllListeners('disconnect'); await dev.disconnect().catch(() => {}); }
    }
  }

  async destroy() {
    await this.disconnect().catch(() => {});
    if (this.destroyBus) this.destroyBus();
  }
}

// ===========================================================================
// 后端 2：noble（HCI 原始套接字，备选）
// ===========================================================================
class NobleBackend {
  constructor(log) {
    this.log = log;
    this.noble = null;
    this.peripherals = new Map();
    this.per = null; this.wChar = null; this.nChar = null;
    this.onData = null; this.onDisconnect = null;
  }

  async _init() {
    if (this.noble) return;
    this.noble = require('@abandonware/noble'); // 懒加载：没装或没权限也不影响其它模式
    if (this.noble.state !== 'poweredOn') {
      await withTimeout(new Promise((res, rej) => {
        this.noble.on('stateChange', (s) => {
          if (s === 'poweredOn') res();
          if (s === 'unauthorized' || s === 'unsupported') rej(new Error(`noble 状态 ${s}：检查 setcap cap_net_raw 或 bluetooth 组权限`));
        });
      }), 10000, '等待蓝牙适配器就绪');
    }
  }

  async scan(ms = 10000, stopOnFirst = false) {
    await this._init();
    const found = new Map();
    const onDiscover = (per) => {
      const name = per.advertisement && per.advertisement.localName;
      if (!nameMatches(name) || found.has(per.id)) return;
      this.peripherals.set(per.id, per);
      found.set(per.id, { id: per.id, name, rssi: per.rssi });
      this.log(`扫描到 ${name} @ ${per.address || per.id} rssi=${per.rssi}`);
    };
    this.noble.on('discover', onDiscover);
    await this.noble.startScanningAsync([], true);
    const deadline = Date.now() + ms;
    while (Date.now() < deadline && !(stopOnFirst && found.size)) await sleep(200);
    await this.noble.stopScanningAsync().catch(() => {});
    this.noble.removeListener('discover', onDiscover);
    return [...found.values()];
  }

  async connect(id) {
    await this._init();
    let per = this.peripherals.get(id);
    if (!per) { await this.scan(10000, true); per = this.peripherals.get(id); }
    if (!per) throw new Error(`找不到设备 ${id}`);
    this.per = per;
    per.removeAllListeners('disconnect');
    per.once('disconnect', () => { this.log('noble 报告：设备断开'); this.wChar = this.nChar = null; if (this.onDisconnect) this.onDisconnect(); });
    await withTimeout(per.connectAsync(), 20000, '连接');
    const { characteristics } = await withTimeout(
      per.discoverSomeServicesAndCharacteristicsAsync([], ['ff13', 'ff14']), 20000, '发现服务');
    this.wChar = characteristics.find((c) => c.uuid === 'ff13');
    this.nChar = characteristics.find((c) => c.uuid === 'ff14');
    if (!this.wChar || !this.nChar) throw new Error('没找到 ff13/ff14 特征');
    this.nChar.removeAllListeners('data');
    this.nChar.on('data', (buf) => this.onData && this.onData(buf));
    await this.nChar.subscribeAsync();
  }

  async send(buf) {
    if (!this.wChar) throw new Error('未连接');
    await withTimeout(this.wChar.writeAsync(Buffer.from(buf), false), 5000, '写入'); // false = 带响应
  }

  async disconnect() {
    const per = this.per;
    this.wChar = this.nChar = null;
    if (per) { per.removeAllListeners('disconnect'); await per.disconnectAsync().catch(() => {}); }
  }

  async destroy() { await this.disconnect(); }
}

// ===========================================================================
// 后端 3：模拟（见 mock.js）
// ===========================================================================
class MockBackend {
  constructor(log) {
    const { MockRadio } = require('./mock');
    this.log = log;
    this.radio = new MockRadio();
    this.onData = null; this.onDisconnect = null;
    this.radio.on('notify', (buf) => this.onData && this.onData(buf));
  }
  async scan() { await sleep(300); return [{ id: 'F6:F5:2C:FF:42:41', name: 'HRD-C919-BLE（模拟）', rssi: -60 }]; }
  async connect() { await sleep(300); this.radio.connect(); }
  async send(buf) { this.radio.write(Buffer.from(buf)); }
  async disconnect() { this.radio.disconnect(); }
  async destroy() { this.radio.disconnect(); }
}

// ===========================================================================
// 对外的连接管理器：重试、自动重连、握手
// ===========================================================================
class C919Ble extends EventEmitter {
  constructor({ backend } = {}) {
    super();
    this.backendName = backend || (process.env.C919_MOCK === '1' ? 'mock' : (process.env.C919_BLE_BACKEND || 'bluez'));
    const log = (m) => this.emit('log', m);
    const B = { bluez: BluezBackend, noble: NobleBackend, mock: MockBackend }[this.backendName];
    if (!B) throw new Error(`未知后端 ${this.backendName}`);
    this.be = new B(log);
    this.be.onData = (buf) => this.emit('data', Buffer.from(buf));
    this.be.onDisconnect = () => this._onUnexpectedDisconnect();
    this.state = 'idle';
    this.target = null; // 当前（或要重连的）设备 id
    this.autoReconnect = true;
    this.userDisconnected = false;
    this._reconnecting = false;
  }

  _set(state, detail = '') {
    this.state = state;
    this.emit('state', state, detail);
  }

  async scan(ms = 8000) {
    this._set('scanning');
    try {
      const list = await this.be.scan(ms, false);
      this._set(this.state === 'scanning' ? 'idle' : this.state, `找到 ${list.length} 台`);
      return list;
    } catch (e) {
      this._set('error', String(e.message || e));
      throw e;
    }
  }

  /** 连接 + 开通知 + 握手。失败自动重试 3 次（真机首次连接偶尔失败） */
  async connect(id) {
    this.userDisconnected = false;
    if (!id) {
      this._set('scanning', '按名字查找 HRD-C919-BLE');
      const list = await this.be.scan(10000, true);
      if (!list.length) { this._set('error', '没找到收音机：确认已开机、在附近，并且手机 App 没有占着连接'); throw new Error('not found'); }
      id = list[0].id;
    }
    this.target = id;
    this._connecting = true; // 连接过程中的断开事件交给这里的重试处理，不触发自动重连
    let lastErr;
    try {
    for (let i = 1; i <= 3; i++) {
      this._set('connecting', `${id}（第 ${i} 次）`);
      try {
        await this.be.connect(id);
        // 顺序很重要：通知已经在 be.connect 里打开了，这里再发握手
        await this.send(P.HANDSHAKE);
        this._set('connected', id);
        return;
      } catch (e) {
        lastErr = e;
        this.emit('log', `连接失败（第 ${i} 次）：${e.message || e}`);
        await this.be.disconnect().catch(() => {});
        if (this.userDisconnected) break;
        await sleep(1500);
      }
    }
    } finally { this._connecting = false; }
    this._set('error', `连接失败：${lastErr && lastErr.message}`);
    throw lastErr;
  }

  async disconnect() {
    this.userDisconnected = true;
    await this.be.disconnect().catch(() => {});
    this._set('disconnected', '用户断开');
  }

  async send(buf) {
    await this.be.send(buf);
    this.emit('tx', Buffer.from(buf));
  }

  /** 非用户主动的断开：按 2s、4s、8s…（最多 30s）退避重连，直到连上或用户点了断开 */
  async _onUnexpectedDisconnect() {
    if (this._connecting) return;
    if (this.userDisconnected || !this.autoReconnect || this._reconnecting) {
      if (!this.userDisconnected) this._set('disconnected', '连接断开');
      return;
    }
    this._reconnecting = true;
    let delay = 2000;
    try {
      while (!this.userDisconnected && this.autoReconnect) {
        this._set('reconnecting', `${delay / 1000}s 后重连`);
        await sleep(delay);
        if (this.userDisconnected) break;
        try { await this.connect(this.target); return; } catch { delay = Math.min(delay * 2, 30000); }
      }
    } finally { this._reconnecting = false; }
  }

  async destroy() {
    this.userDisconnected = true;
    await this.be.destroy().catch(() => {});
  }
}

module.exports = { C919Ble };
