'use strict';
/**
 * protocol.js —— 汉荣达 HRD-C919（Raddy RF919）BLE 协议：纯函数层
 * ==================================================================
 *
 * 这个文件【不碰蓝牙、不碰界面】，只负责两件事：
 *   1. 把"我要做什么"（按键、设频率……）拼成字节帧（下行，写到 ff13 特征）；
 *   2. 把收音机推过来的字节（上行，ff14 通知）切成帧、解析成状态。
 *
 * 因为是纯函数（输入字节 → 输出对象），可以脱离真机用 node:test 单元测试，
 * 测试用的就是你在真机日志里抓到的帧（见 test/protocol.test.js）。
 *
 * 协议来源：官方 App Radio-C v1.1.9 反编译（详见 ../PROTOCOL.md），
 * 以及 Python 版 c919_ble.py（已在真机上跑通）。这里是逐行移植。
 *
 * 标记约定：
 *   【已验证】= 真机上实测通过
 *   【推断】  = 从 App 代码 / 说明书推出来的，没在真机上确认
 */

const iconv = require('iconv-lite'); // GBK 解码。收音机的文字都是 GBK 编码（不是 UTF-8）

// ---------------------------------------------------------------------------
// 1. GATT 常量
// ---------------------------------------------------------------------------
// 【已验证】服务 ff12 下面有两个特征：ff13 用来写指令（属性 write，即"带响应写"），
// ff14 用来收通知。设备广播名是 HRD-C919-BLE。
const SERVICE_UUID = '0000ff12-0000-1000-8000-00805f9b34fb';
const CHAR_WRITE = '0000ff13-0000-1000-8000-00805f9b34fb';
const CHAR_NOTIFY = '0000ff14-0000-1000-8000-00805f9b34fb';
// 扫描时按名字匹配。真机名是 HRD-C919-BLE；说明书里写的是 RF919-BLE（Raddy 贴牌版）。
const NAME_HINTS = ['HRD-C919-BLE', 'RF919-BLE', 'C919', 'RF919'];

const HEADER = 0xab; // 每一帧都以 0xAB 开头

// ---------------------------------------------------------------------------
// 2. 帧格式：AB LEN CMD payload... SUM
// ---------------------------------------------------------------------------
//   LEN = 1 + payload 长度（从 CMD 开始数，到 SUM 之前）
//   SUM = 前面所有字节（含 AB）相加，只取低 8 位（& 0xFF）
// 例：AB 02 0C 14 → 0xAB+0x02+0x0C+0x14 = 0xCD → 完整帧 AB 02 0C 14 CD（电源键）

/** 计算校验和：所有字节相加取低 8 位 */
function checksum(bytes) {
  let s = 0;
  for (const b of bytes) s += b;
  return s & 0xff;
}

/**
 * 拼一帧。
 * @param {number} cmd 命令字节
 * @param {number[]|Buffer} payload 负载
 * @returns {Buffer}
 */
function buildFrame(cmd, payload = []) {
  const body = [HEADER, 1 + payload.length, cmd, ...payload];
  return Buffer.from([...body, checksum(body)]);
}

/**
 * 切帧器：BLE 通知不保证"一次通知 = 一帧"，可能一包里有多帧，也可能一帧拆成两包。
 * 所以我们把收到的字节都塞进缓冲区，再按 LEN 一帧一帧地切出来。
 * 不完整的尾巴留着，等下一包来了再拼。
 */
class FrameSplitter {
  constructor() {
    this.buf = Buffer.alloc(0);
    this.badChecksum = 0; // 统计校验不符的帧数（App 本身不校验，我们只记个数）
  }

  /**
   * 喂入一段字节，返回切出来的完整帧数组。
   * @param {Buffer|Uint8Array|number[]} chunk
   * @returns {Buffer[]}
   */
  push(chunk) {
    this.buf = Buffer.concat([this.buf, Buffer.from(chunk)]);
    const out = [];
    while (this.buf.length) {
      // 帧头之前的垃圾字节丢掉
      if (this.buf[0] !== HEADER) {
        const idx = this.buf.indexOf(HEADER);
        this.buf = idx < 0 ? Buffer.alloc(0) : this.buf.subarray(idx);
        continue;
      }
      if (this.buf.length < 2) break;
      const total = this.buf[1] + 3; // AB + LEN + (LEN 个字节) + SUM
      if (this.buf.length < total) break; // 还没收全，等下一包
      const frame = Buffer.from(this.buf.subarray(0, total));
      this.buf = this.buf.subarray(total);
      if (checksum(frame.subarray(0, -1)) !== frame[frame.length - 1]) this.badChecksum++;
      out.push(frame);
    }
    return out;
  }

  reset() { this.buf = Buffer.alloc(0); }
}

// ---------------------------------------------------------------------------
// 3. 按键码表：AB 02 0C <key> SUM（全部来自 App 的 SendData.java）
// ---------------------------------------------------------------------------
// 注意：长按是【单独的一个码】，不是"按下 / 松开"两条指令。
const KEYS = {
  BAND: 0x00,
  '1': 0x01, '2': 0x02, '3': 0x03, '4': 0x04, '5': 0x05,
  '6': 0x06, '7': 0x07, '8': 0x08, '9': 0x09, '0': 0x0a,
  BACK: 0x0b, // 退格
  POINT: 0x0c, // 小数点
  FREQ: 0x0d, // FREQ / EN：直接输入频率
  UP: 0x0e, UP_LONG: 0x0f,
  DOWN: 0x10, DOWN_LONG: 0x11,
  VOL_UP: 0x12, VOL_DOWN: 0x13,
  POWER: 0x14, // 【已验证】短按开机
  SUBBAND: 0x17, // App 第 1 个可变按钮（C919 上显示 BW-DM）
  PLAY: 0x1a, // App 第 3 个可变按钮（C919 上显示 V-UHF）
  STEP: 0x1b, // App 第 2 个可变按钮（C919 上显示 ANT-ATT）
  BT: 0x1c, // 蓝牙 / TF / PC 模式切换
  DEMOD: 0x1d, // 点状态格 1（解调方式）
  BANDWIDTH: 0x1e, // 点状态格 2（带宽）
  FUNC: 0x1f, // App 第 5 个可变按钮（C919 上显示 LOCK）
  SQ: 0x20, // ⚠️ App 没绑按钮
  STEREO: 0x21, // ⚠️ App 没绑按钮
  DE: 0x22, // ⚠️ 含义不明（去加重？）
  PRESET: 0x23, // 频率模式 / 频道模式切换
  MEMO: 0x24,
  REC: 0x25,
  MUSIC: 0x26, // bt_subband 按钮（说明书：SW 下选米波段，推断）
  CIRCLE: 0x27, // bt_step 按钮
  MUSIC_CIRCLE: 0x28, // ⚠️ App 没绑按钮
  BAND_LONG: 0x29,
  SOS: 0x2a, SOS_LONG: 0x2b, // App 第 4 个可变按钮（C919 上显示 MUTE）
  MEMO_LONG: 0x2c, // 存台
  REC_TEXT: 0x2d,
  CELL3: 0x2e, // 点状态格 3（SNR）
  CELL4: 0x2f, // 点状态格 4（RSSI）
  CELL5: 0x30, // 点状态格 5（SQL）→ 收音机会弹出静噪等级选择
  ALARM_SNOOZE: 0x31, ALARM_SNOOZE_LONG: 0x32,
  PLAY_LONG: 0x33,
  FUNC_LONG: 0x34,
  '1_LONG': 0x35, '2_LONG': 0x36, '3_LONG': 0x37, '4_LONG': 0x38, '5_LONG': 0x39,
  '6_LONG': 0x3a, '7_LONG': 0x3b, '8_LONG': 0x3c, '9_LONG': 0x3d, '0_LONG': 0x3e,
  BT_LONG: 0x3f,
  PRESET_LONG: 0x40,
  SUBBAND_LONG: 0x41,
  STEP_LONG: 0x42,
  VOL_DOWN_LONG: 0x43, VOL_UP_LONG: 0x44,
  POWER_LONG: 0x45, // 长按关机（说明书：长按 2 秒关机）【推断】
  FREQ_LONG: 0x46,
  POINT_LONG: 0x47,
  BACK_LONG: 0x48,
  REC_LONG: 0x49,
};

// 每个键的中文说明（界面上的"全部按键"网格用来做 tooltip）
const KEY_DESC = {
  BAND: 'BAND 短按：FM/SW/MW/LW 轮换', BAND_LONG: 'BAND 长按',
  BACK: '退格', POINT: '小数点', FREQ: 'EN：输入频率 / 确认',
  UP: '上调一步', UP_LONG: '向上自动搜台', DOWN: '下调一步', DOWN_LONG: '向下自动搜台',
  VOL_UP: '音量 +', VOL_DOWN: '音量 −', VOL_UP_LONG: '音量 + 长按', VOL_DOWN_LONG: '音量 − 长按',
  POWER: '电源短按（开机）', POWER_LONG: '电源长按（关机）',
  SUBBAND: '按钮1 短按（C919: BW-DM → 带宽）', SUBBAND_LONG: '按钮1 长按（C919: BW-DM → 解调方式）',
  STEP: '按钮2 短按（C919: ANT-ATT → 天线/衰减）', STEP_LONG: '按钮2 长按',
  PLAY: '按钮3 短按（C919: V-UHF → AIR/CB/WB/VHF/UHF）', PLAY_LONG: '按钮3 长按',
  SOS: '按钮4 短按（C919: MUTE）', SOS_LONG: '按钮4 长按（C919: MUTE）',
  FUNC: '按钮5 短按（C919: LOCK）', FUNC_LONG: '按钮5 长按（C919: LOCK）',
  BT: '模式切换：蓝牙 / TF / PC', BT_LONG: '断开蓝牙音频',
  DEMOD: '状态格1：解调方式', BANDWIDTH: '状态格2：带宽', CELL3: '状态格3：SNR 区',
  CELL4: '状态格4：RSSI 区', CELL5: '状态格5：SQL（弹出静噪等级）',
  SQ: 'SQ（App 未绑定）', STEREO: '立体声（App 未绑定）', DE: '含义不明（App 未绑定）',
  PRESET: 'PRESET：频率/频道模式切换', PRESET_LONG: 'PRESET 长按',
  MEMO: 'MEMO 短按', MEMO_LONG: 'MEMO 长按：存台',
  REC: 'REC 短按：录音开始/停止', REC_LONG: 'REC 长按', REC_TEXT: 'REC 文字区',
  MUSIC: 'bt_subband（推断：SW 米波段）', CIRCLE: 'bt_step（推断：步进）', MUSIC_CIRCLE: '音乐循环（App 未绑定）',
  ALARM_SNOOZE: '闹钟贪睡', ALARM_SNOOZE_LONG: '闹钟关闭（长按）',
  FREQ_LONG: 'FREQ 长按', POINT_LONG: '小数点长按', BACK_LONG: '退格长按（删除频道）',
};

// 波段码。注意 0x10-0x15 是十六进制字节，0x0A-0x0F 没有对应波段。
const BANDS = {
  0x00: 'FM', 0x01: 'AM', 0x02: 'SW', 0x03: 'AIR', 0x04: 'CB', 0x05: 'UHF',
  0x06: 'WB', 0x07: 'VHF', 0x08: 'LW', 0x09: 'HAM',
  0x10: 'RAIL', 0x11: 'MRN', 0x12: 'RACE', 0x13: 'POL', 0x14: 'FIRE', 0x15: 'OTHER',
};
// 0x15 帧"支持的波段"位图，第 i 位对应这个顺序的第 i 个波段
const BAND_ORDER = Object.keys(BANDS).map(Number).sort((a, b) => a - b);

const DEMOD = { 0: 'WFM', 1: 'NFM', 2: 'MONO', 3: 'STEREO', 4: 'AM', 5: 'SSB', 6: 'LSB', 7: 'USB' };
const WORK_MODE = { 0: 'OFF', 1: 'BT', 2: 'RADIO', 3: 'OFF', 4: 'TF', 6: 'PC', 7: 'AUX' };
const WORK_MODE_CN = { OFF: '关机/待机', BT: '蓝牙音乐', RADIO: '收音机', TF: 'TF 卡', PC: 'PC', AUX: 'AUX' };

// 0x1C 文字帧 field 编号 → 名字
const TEXT_FIELDS = {
  1: 'cell1_title', 2: 'demod', 3: 'cell2_title', 4: 'bandwidth',
  5: 'cell3_title', 6: 'snr', 7: 'cell4_title', 8: 'rssi',
  9: 'text9', 10: 'text10', 11: 'text11', 12: 'text12',
  13: 'vol_text', 14: 'track_num', 15: 'text15', 16: 'rec_text',
};
// 0x21 按钮文字帧：b3 = 按钮号 → App 按钮 → 短按/长按发的键
// （从 MainActivity:1450-1534 / 923-1020 核对过）
const BUTTONS = {
  1: { name: 'MODE', key: 'SUBBAND', longKey: 'SUBBAND_LONG' },
  2: { name: 'STEP', key: 'STEP', longKey: 'STEP_LONG' },
  3: { name: 'SCAN', key: 'PLAY', longKey: 'PLAY_LONG' },
  4: { name: 'SOS', key: 'SOS', longKey: 'SOS_LONG' },
  5: { name: 'FUNC', key: 'FUNC', longKey: 'FUNC_LONG' },
};

// ---------------------------------------------------------------------------
// 4. 下行指令（App → 收音机）
// ---------------------------------------------------------------------------
/** 握手：连上并打开通知后发一次【已验证】 */
const HANDSHAKE = Buffer.from([0xab, 0x01, 0xff, 0xab]);

/** 按键帧：AB 02 0C <key> SUM */
function keyFrame(name) {
  if (!(name in KEYS)) throw new Error(`未知按键：${name}`);
  return buildFrame(0x0c, [KEYS[name]]);
}

/** 32 位无符号整数 → 4 字节小端 */
function u32le(k) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(k >>> 0, 0);
  return [...b];
}

/**
 * 直接设波段 + 频率原始值 K：AB 06 10 <band> <K 小端 4 字节> SUM
 * 【已验证】FM：K 单位 10kHz，K=10000 → 100.00MHz。
 */
function setFreqFrame(band, k) {
  if (!Number.isInteger(k) || k < 0) throw new Error(`K 必须是非负整数：${k}`);
  return buildFrame(0x10, [band & 0xff, ...u32le(k)]);
}

/** 只切波段（频率全 0）：App 选波段对话框就是这么发的【推断：0 = 该波段上次频率】 */
function setBandFrame(band) {
  return buildFrame(0x10, [band & 0xff, 0, 0, 0, 0]);
}

/** 睡眠定时：AB 02 0F <分钟>，0/10/20…90，0 = 关闭【推断，来自 App】 */
function sleepFrame(minutes) {
  return buildFrame(0x0f, [minutes & 0xff]);
}

/** 静噪等级：AB 02 11 <等级>，0..sq_max（C919 报 9）【推断，来自 App】 */
function squelchFrame(level) {
  return buildFrame(0x11, [level & 0xff]);
}

/** 时间同步：AB 07 0D 时 分 秒 (年-1970) 月 日【推断，来自 App】 */
function timeSyncFrame(d = new Date()) {
  return buildFrame(0x0d, [d.getHours(), d.getMinutes(), d.getSeconds(),
    d.getFullYear() - 1970, d.getMonth() + 1, d.getDate()]);
}

/** 闹钟 1：AB 05 0E <类型 0/1> 时 分 <开 1/关 0>【推断：类型可能是 收音/铃声】 */
function alarmFrame(hour, minute, on, kind = 0) {
  return buildFrame(0x0e, [kind & 0xff, hour & 0xff, minute & 0xff, on ? 1 : 0]);
}

// ---------------------------------------------------------------------------
// 5. 频率显示与换算
// ---------------------------------------------------------------------------
/**
 * 还原 App 的频率显示（MainActivity:4363-4731）：
 *   K 的十进制串从第 ag 格开始往右填，第 af 格后面点亮小数点。
 *   所以整数位数 = af - ag + 1。
 * 【已验证】FM：K=10680, af=4, ag=2 → "106.80"
 */
function formatFreq(k, af, ag) {
  const s = String(k);
  if (af === 0 || ag === 0) return s;
  const intDigits = af - ag + 1;
  if (intDigits <= 0 || intDigits >= s.length) return s;
  return s.slice(0, intDigits) + '.' + s.slice(intDigits);
}

/** 显示串里的小数位数，例如 "106.80" → 2 */
function decimalsOf(text) {
  const i = String(text).indexOf('.');
  return i < 0 ? 0 : String(text).length - i - 1;
}

/**
 * 各波段"默认"显示格式（单位 + 小数位）。
 *   - FM 是【已验证】的：MHz、2 位小数（K 单位 10kHz）。
 *   - 其余全部是【推断】，根据说明书里的最小步进猜的。
 * 真正用的时候，程序会优先用"这个波段最近一次收到的频率帧"来标定
 * （见 renderer 里的 calib 表），所以只要在该波段收到过一帧，就以真机为准。
 */
const BAND_FORMAT_GUESS = {
  0x00: { unit: 'MHz', decimals: 2, verified: true }, // FM 106.80
  0x01: { unit: 'kHz', decimals: 0 }, // MW 1008
  0x02: { unit: 'MHz', decimals: 3 }, // SW 9.650（SSB 可能是 kHz + 2 位）
  0x03: { unit: 'MHz', decimals: 3 }, // AIR 118.100
  0x04: { unit: 'MHz', decimals: 3 }, // CB 27.185
  0x05: { unit: 'MHz', decimals: 4 }, // UHF 446.0125（步进 12.5k）
  0x06: { unit: 'MHz', decimals: 3 }, // WB 162.550
  0x07: { unit: 'MHz', decimals: 4 }, // VHF 145.0125
  0x08: { unit: 'kHz', decimals: 0 }, // LW 198
};

/**
 * 把用户输入的频率（单位与该波段显示单位一致）换成 K。
 *   K = round(value × 10^小数位数)
 * FM：K = round(MHz × 100)【已验证】
 * @param {number} value 例如 99.5
 * @param {number} decimals 例如 2
 */
function valueToK(value, decimals) {
  return Math.round(value * 10 ** decimals);
}

// ---------------------------------------------------------------------------
// 6. 状态与上行帧解析
// ---------------------------------------------------------------------------
/** 新建一个空的收音机状态对象 */
function newStatus() {
  return {
    band: null, bandName: null, k: null, unit: null, af: 0, ag: 0, freqText: '', freqBlink: 0,
    rssi: null, snr: null, rssiSeq: 0,
    demod: null, bandwidth: null, bandwidthRaw: null,
    volume: null, battery: null, charging: false,
    workMode: null, inputState: null, preset: null, presetState: null,
    supportedBands: [], sleepMax: 90, sqMax: 0, sleepLeft: null,
    alarm: null, language: null, buttonsEnabled: null, sosBlink: null, funcBlink: null,
    sqDialog: null,
    texts: {}, buttonLabels: {}, blink: {},
    // 从 text11 / text12 里拆出来的小字段：VOL / STEP / DE-EMP / ATT / STEREO / MIX / ANT / EQ / 温度
    info: {},
    version: '', tip: '', toast: '',
    disconnectRequested: false,
  };
}

/**
 * 解析 "VOL:1  STEP:100K  DE-EMP:50US  ATT:DX  STEREO" 这种字符串。
 * 以两个以上空格分段，"键:值" 形式的拆开，单独一个词（如 STEREO）当作 {STEREO: true}。
 */
function parseInfoText(txt) {
  const out = {};
  for (const part of String(txt).split(/\s{2,}|\n/)) {
    const p = part.trim();
    if (!p) continue;
    const i = p.indexOf(':');
    if (i > 0) out[p.slice(0, i).trim().toUpperCase()] = p.slice(i + 1).trim();
    else out[p.toUpperCase()] = true;
  }
  return out;
}

/**
 * 帧解析器：维护状态 + 分段文本缓存。
 * 用法：const p = new FrameParser(); const ev = p.feed(frameBuffer);
 * feed 返回 { type, desc }，type 用来让界面知道哪类状态变了。
 */
class FrameParser {
  constructor(status = newStatus()) {
    this.st = status;
    this.segBuf = new Map(); // 分段文字缓存：key → Buffer
  }

  /**
   * 处理分段文本。seg：01 首段（清空再存）、02 中段（追加）、03 单段完整、04 末段（追加后输出）。
   * 文字是 GBK，用 iconv-lite 解码。
   * @returns {string|null} 拼完整了就返回文本，否则 null
   */
  _segment(key, seg, chunk) {
    if (seg === 0x01) { this.segBuf.set(key, Buffer.from(chunk)); return null; }
    if (seg === 0x02) {
      this.segBuf.set(key, Buffer.concat([this.segBuf.get(key) || Buffer.alloc(0), Buffer.from(chunk)]));
      return null;
    }
    let data;
    if (seg === 0x03) data = Buffer.from(chunk);
    else if (seg === 0x04) {
      data = Buffer.concat([this.segBuf.get(key) || Buffer.alloc(0), Buffer.from(chunk)]);
      this.segBuf.delete(key);
    } else return null;
    return iconv.decode(data, 'gbk');
  }

  /** 解析一帧（Buffer），更新 this.st，返回 {type, desc} */
  feed(f) {
    const st = this.st;
    const ln = f[1];
    const cmd = f[2];
    const p = f.subarray(3, f.length - 1); // payload（去掉 AB LEN CMD 和 SUM）
    const is = (l, c) => ln === l && cmd === c;

    // ---- 主状态：波段 + 频率【已验证】 AB 09 01 band K(4,LE) unit af|ag blink SUM
    if (is(0x09, 0x01) && p.length >= 8) {
      st.band = p[0];
      st.bandName = BANDS[st.band] || `0x${st.band.toString(16)}`;
      st.k = p.readUInt32LE(1);
      st.unit = p[5] === 0 ? 'MHz' : 'kHz';
      st.af = p[6] & 0x0f; // 小数点在第几格后
      st.ag = (p[6] >> 4) & 0x0f; // 首位数字在第几格
      st.freqBlink = p[7];
      st.freqText = (st.band === 0x06 && st.k === 0xff) ? 'ALERT' : formatFreq(st.k, st.af, st.ag);
      return { type: 'freq', desc: `FREQ ${st.bandName} ${st.freqText} ${st.unit} (K=${st.k}, af=${st.af}, ag=${st.ag})` };
    }
    // ---- 频率输入模式（按 FREQ 键输入数字时）
    if (is(0x09, 0x0f) && p.length >= 8) {
      st.inputState = p[0];
      st.band = p[1];
      st.bandName = BANDS[st.band] || `0x${st.band.toString(16)}`;
      st.k = p.readUInt32LE(2);
      st.unit = p[6] === 0 ? 'MHz' : 'kHz';
      st.af = p[7] & 0x0f; st.ag = (p[7] >> 4) & 0x0f;
      st.freqText = formatFreq(st.k, st.af, st.ag);
      return { type: 'freq', desc: `INPUT state=${st.inputState} ${st.freqText} ${st.unit}` };
    }
    // ---- 数字版 RSSI/SNR（C919 实测不用这个，而是用 0x1C 文字帧；保留以防别的固件）
    if (is(0x03, 0x03)) {
      st.rssi = p[0]; st.snr = p[1]; st.rssiSeq++;
      return { type: 'signal', desc: `RSSI=${st.rssi} SNR=${st.snr}` };
    }
    if (is(0x09, 0x04) && p.length >= 8) {
      st.demod = DEMOD[p[0]] || `?${p[0]}`;
      st.bandwidthRaw = p[6] | (p[7] << 8);
      return { type: 'demod', desc: `DEMOD=${st.demod} BW_raw=${st.bandwidthRaw}` };
    }
    if (is(0x02, 0x09)) { st.volume = p[0]; return { type: 'volume', desc: `VOL=${st.volume}` }; }
    if (is(0x03, 0x08)) { // 电池【已见于真机】
      st.battery = p[0]; st.charging = p[1] === 1;
      return { type: 'battery', desc: `BATT=${st.battery}/3 charging=${st.charging}` };
    }
    if (is(0x02, 0x07)) { // 工作模式【已验证】00 关机 02 收音
      st.workMode = WORK_MODE[p[0]] || `?${p[0]}`;
      return { type: 'mode', desc: `MODE=${st.workMode}` };
    }
    if (is(0x04, 0x10)) {
      st.presetState = p[0];
      st.preset = (p[0] === 1 || p[0] === 2) ? p[1] : null;
      return { type: 'preset', desc: `PRESET state=${p[0]} no=${p[1]}` };
    }
    if (is(0x02, 0x05)) { st.sleepLeft = p[0]; return { type: 'sleep', desc: `SLEEP=${p[0]}min` }; }
    if (is(0x05, 0x06)) {
      st.alarm = { kind: p[0], hour: p[1], minute: p[2], state: p[3] };
      return { type: 'alarm', desc: `ALARM kind=${p[0]} ${p[1]}:${String(p[2]).padStart(2, '0')} state=${p[3]}` };
    }
    if (is(0x03, 0x15)) { // 支持波段位图
      const bits = p[0] | (p[1] << 8);
      st.supportedBands = BAND_ORDER.filter((_, i) => (bits >> i) & 1);
      return { type: 'bands', desc: `BANDS=${st.supportedBands.map((b) => BANDS[b]).join(',')}` };
    }
    if (is(0x03, 0x18)) {
      st.sleepMax = p[0]; st.sqMax = p[1];
      return { type: 'limits', desc: `LIMITS sleep_max=${p[0]} sq_max=${p[1]}` };
    }
    if (is(0x03, 0x1f)) { // 收音机要求打开 / 关闭静噪选择框
      st.sqDialog = p[0] === 1 ? { anchor: p[1] } : null;
      return { type: 'sqdialog', desc: `SQ_DIALOG open=${p[0]} cell=${p[1]}` };
    }
    if (is(0x04, 0x17)) { // 按钮 1-3 可用性
      st.buttonsEnabled = { 1: p[0] === 1, 2: p[1] === 1, 3: p[2] === 1 };
      return { type: 'buttons', desc: `BTN_ENABLE ${p[0]} ${p[1]} ${p[2]}` };
    }
    if (is(0x03, 0x22)) { // SOS / FUNC 闪烁
      if (p[0] === 1) st.sosBlink = p[1]; else if (p[0] === 2) st.funcBlink = p[1];
      return { type: 'buttons', desc: `BLINK ${p[0] === 1 ? 'SOS' : 'FUNC'}=${p[1]}` };
    }
    if (is(0x03, 0x1d)) { // 文字字段闪烁
      st.blink[TEXT_FIELDS[p[0]] || `field${p[0]}`] = p[1];
      return { type: 'blink', desc: `TEXT_BLINK field=${p[0]} v=${p[1]}` };
    }
    if (is(0x02, 0x20)) { st.language = p[0] === 0 ? 'zh' : 'en'; return { type: 'misc', desc: `LANG=${st.language}` }; }
    if (is(0x02, 0x13)) return { type: 'misc', desc: `0x13 v=${p[0]}（含义未知）` };

    // ---- 界面文字【已验证】AB LL 1C field seg n <GBK 文本> SUM
    if (cmd === 0x1c && p.length >= 3) {
      const fid = p[0], seg = p[1], n = p[2];
      const txt = this._segment(`1c:${fid}`, seg, p.subarray(3, 3 + n));
      if (txt === null) return { type: 'partial', desc: '' };
      const name = TEXT_FIELDS[fid] || `field${fid}`;
      st.texts[name] = txt;
      if (fid === 6 || fid === 8) { // SNR / RSSI【已验证】大约每秒一次
        const v = parseInt(txt.trim(), 10);
        if (!Number.isNaN(v)) {
          if (fid === 6) st.snr = v; else { st.rssi = v; st.rssiSeq++; }
        }
        return { type: 'signal', desc: `TEXT ${name} = '${txt}'` };
      }
      if (fid === 2) st.demod = txt;
      if (fid === 4) st.bandwidth = txt;
      if (fid === 11 || fid === 12) {
        Object.assign(st.info, parseInfoText(txt));
        if (st.info.VOL !== undefined) st.volume = parseInt(st.info.VOL, 10);
      }
      return { type: 'text', desc: `TEXT ${name} = '${txt}'` };
    }
    // ---- 按钮文字（C919 实测：BW-DM / ANT-ATT / V-UHF / MUTE / LOCK）
    if (cmd === 0x21 && p.length >= 3) {
      const bid = p[0], seg = p[1], n = p[2];
      const txt = this._segment(`21:${bid}`, seg, p.subarray(3, 3 + n));
      if (txt === null) return { type: 'partial', desc: '' };
      st.buttonLabels[bid] = txt;
      return { type: 'buttons', desc: `BUTTON ${BUTTONS[bid] ? BUTTONS[bid].name : bid} = '${txt}'` };
    }
    // ---- 提示 / 版本 / Toast 文字（少一个 field 字节）
    if ((cmd === 0x12 || cmd === 0x19 || cmd === 0x23) && p.length >= 2) {
      const seg = p[0], n = p[1];
      const txt = this._segment(`${cmd}`, seg, p.subarray(2, 2 + n));
      if (txt === null) return { type: 'partial', desc: '' };
      const nm = { 0x12: 'TIP', 0x19: 'VERSION', 0x23: 'TOAST' }[cmd];
      if (cmd === 0x19) st.version = txt;
      if (cmd === 0x12) st.tip = txt;
      if (cmd === 0x23) st.toast = txt;
      return { type: nm.toLowerCase(), desc: `${nm} '${txt}'` };
    }
    if (is(0x02, 0x24)) { st.disconnectRequested = true; return { type: 'disconnect', desc: '收音机要求断开' }; }

    return { type: 'unparsed', desc: `UNPARSED ${hex(f)}` };
  }
}

/** Buffer → "ab 02 0c ..." 方便打日志 */
function hex(buf) {
  return [...buf].map((b) => b.toString(16).padStart(2, '0')).join(' ');
}
/** "ab 02 0c ..." → Buffer（测试和模拟模式用） */
function fromHex(s) {
  return Buffer.from(s.replace(/[^0-9a-f]/gi, ''), 'hex');
}

module.exports = {
  SERVICE_UUID, CHAR_WRITE, CHAR_NOTIFY, NAME_HINTS, HEADER,
  checksum, buildFrame, FrameSplitter, FrameParser, newStatus, parseInfoText,
  KEYS, KEY_DESC, BANDS, BAND_ORDER, DEMOD, WORK_MODE, WORK_MODE_CN, TEXT_FIELDS, BUTTONS,
  HANDSHAKE, keyFrame, setFreqFrame, setBandFrame, sleepFrame, squelchFrame, timeSyncFrame, alarmFrame,
  formatFreq, decimalsOf, valueToK, BAND_FORMAT_GUESS, hex, fromHex,
};
