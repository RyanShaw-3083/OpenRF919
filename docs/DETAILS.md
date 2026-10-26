# C919 控制台：汉荣达 HRD-C919 / Raddy RF919 的 BLE 控制程序（Electron 版）

界面布局参照 SDR#（SDRSharp），通过 BLE 控制收音机，同时把收音机 AUX 输出的**声音**做成实时频谱和瀑布图。

- 左侧是控制栏：连接、电源、波段、接收设置、音量、频道、数字键盘、定时，还有全部按键。
- 顶部是大号频率显示：鼠标滚轮放在哪一位上，就调哪一位；也可以直接输入频率。
- 中间是**当前频率的音频频谱和音频瀑布图**，数据来自 line-in 或蓝牙音频的 FFT。**没有全频扫描图**。
- 右侧是音频输入设备，以及频谱和瀑布图的显示设置。
- 底部是状态栏：连接状态、RSSI、SNR、解调、带宽、电量、温度、固件版本，外加 RSSI/SNR 历史小图。

![预览](docs/preview.png)

> 截图用的是模拟模式（`C919_MOCK=1`），音频是振荡器造的测试信号，不是真机画面。

---

## 1. 安装

需要 Node.js 18 或更高版本（推荐 20 以上），还要有编译工具，备用的 noble 后端要编译原生模块。

```bash
# Fedora
sudo dnf install nodejs gcc-c++ make python3 systemd-devel bluez-libs-devel
# Debian / Ubuntu
sudo apt install nodejs npm build-essential python3 libudev-dev libbluetooth-dev

cd c919-electron
npm install
npm test          # 跑协议单元测试和模拟集成测试，不用连真机
```

- `npm install` 会自动下载 Electron。安装完之后，`postinstall` 会用 `electron-rebuild` 把 noble 的原生模块按 Electron 的 ABI 重新编译一遍。
- 如果 npm 11 提示 `install scripts not yet covered by allowScripts`，而且 `node_modules/electron/dist` 是空的，就手动跑 `node node_modules/electron/install.js`，或者执行 `npm install-scripts approve electron` 再装一次。
- noble 是可选依赖，编译失败也不影响默认的 BlueZ 后端、模拟模式和音频频谱。

## 2. 运行

```bash
npm start                          # 真机，默认走 BlueZ D-Bus 后端
npm run mock                       # 模拟收音机（C919_MOCK=1），不用蓝牙也能看完整界面
C919_BLE_BACKEND=noble npm start   # 备用 noble 后端，见第 3 节
C919_LOG=/tmp/c919.log npm start   # 改日志路径
C919_FAKE_AUDIO=1 npm start        # 启动后自动用振荡器测试信号画频谱
```

用法：
1. 点「连接」。下拉框留空时，程序会按名字自动找 `HRD-C919-BLE`。也可以先点「扫描」，再选设备。
2. 连上以后，程序会先开通知、再发握手 `AB 01 FF AB`，收音机随后自己推一批状态过来。
3. 连接不用心跳。只要程序不断开，App 图标就一直亮着。连接意外断开时会自动重连，退避间隔是 2s、4s、8s，最长 30s。
4. 调频率有三种方式：
   - 在大号数字的某一位上滚动鼠标滚轮；
   - 点某一位的上半部分加、下半部分减；
   - 在右边输入框里输入数值，再点「调谐」或按回车。
   改完后数字会先变黄，表示在等收音机回报；收音机回了 `AB 09 01` 频率帧，就恢复成绿色。
5. 音频：在右侧选输入设备，然后点「开始」。

**日志**：收发的每一帧（RX/TX）、连接事件和错误，都带毫秒时间戳追加写进 `./c919_rx.log`，也就是启动时所在的目录；目录不可写时改写到 Electron 的 userData 目录。日志不往终端打，另开一个终端执行 `tail -f c919_rx.log` 就能看。界面左侧「原始帧 / 日志」面板也能看到最近 200 行，并显示日志文件路径。

## 3. Linux 蓝牙权限：BLE 部分

### 默认后端：BlueZ D-Bus（`node-ble`），推荐

这和 Python 版用的 bleak 是同一条路，已经在你的机器上验证能连。它通过 D-Bus 调用系统的 `bluetoothd`，**不需要 root，也不需要 setcap**，而且和 A2DP 蓝牙音频、PipeWire 共用同一个适配器，互不冲突。

- 确认 bluetoothd 在运行，适配器已打开：`systemctl status bluetooth`，`bluetoothctl power on`。
- Fedora 默认允许所有本地用户访问 `org.bluez`。Debian/Ubuntu 上如果报 `AccessDenied`，把自己加进 bluetooth 组：`sudo usermod -aG bluetooth $USER`，然后重新登录。

### 备用后端：noble（`C919_BLE_BACKEND=noble`）

noble 不走 bluetoothd，而是直接打开 HCI 原始套接字，所以：
- **需要权限**，下面两种方法任选一种：
  ```bash
  # 方法 1：给 Electron 可执行文件加 cap_net_raw（每次重装 electron 后都要重新做）
  sudo setcap cap_net_raw+eip $(readlink -f node_modules/electron/dist/electron)
  # 方法 2：用 root 运行（不推荐）
  ```
  注意：Electron 的 chrome-sandbox 和 setcap 有时会冲突。冲突时可以加 `--no-sandbox` 启动：`npx electron . --no-sandbox`。
- **它和 bluetoothd 抢同一个适配器**，常常要先停掉 bluetoothd（`sudo systemctl stop bluetooth`）才能稳定工作。可是 bluetoothd 一停，下面第 6 节说的 A2DP 蓝牙音频也就没了。所以 noble 只适合"不用蓝牙音频，或者另插一个 USB 蓝牙适配器"的情况。用 `NOBLE_HCI_DEVICE_ID=1` 可以指定用 hci1。

## 4. 架构

```
src/
  protocol.js     纯函数：拼帧、校验、切帧（FrameSplitter）、解析（FrameParser）、键码表、频率换算
                  不依赖 Electron 和蓝牙，可以单独做单元测试
  sample_frames.js 真机日志里抓到的帧，同时用作测试向量和模拟模式的回放数据
  ble.js          传输层：BlueZ / noble / mock 三个后端；连接重试 3 次、自动重连、先开通知再握手
  mock.js         模拟收音机：回放真机的帧，每秒推一次 RSSI/SNR，会响应设频率、音量和电源指令
  main.js         Electron 主进程：BLE 字节 → 切帧 → 解析 → 写日志 → 把状态快照发给界面（节流 30ms）
  preload.js      contextBridge：只把 window.c919.* 这几个安全的 API 暴露给网页
  renderer/
    index.html    SDR# 风格布局
    renderer.js   界面逻辑：频率滚轮、按钮、状态栏、历史图
    audio.js      Web Audio：getUserMedia → 处理链 / AnalyserNode（FFT）→ 频谱和瀑布（瀑布用环形缓冲），约 30fps
    meter.js      底部横向 VU / 峰值表 + 削波灯
    dsp/denoise_core.js     STFT 频谱减法降噪（纯函数类，Worklet 和 node 测试共用）
    dsp/denoise_worklet.js  降噪 AudioWorklet 包装（每声道一个实例）
    dsp/hilbert_worklet.js  伪 IQ：255 阶 FIR 希尔伯特 + 可选频移
    colormaps.js  瀑布色图（SDR#、Turbo、Viridis、灰度）
    styles.css    暗色主题
test/
  protocol.test.js  用真机帧测协议层（node:test）
  ble_mock.test.js  连接管理器加模拟收音机的集成测试
  denoise.test.js   降噪：完全重建、合成信号（正弦 + 白噪声）SNR 提升、持续单音保护、学习模式、CPU
  hilbert.test.js   伪 IQ：I/Q 幅度一致、90° 相位、镜像抑制
```

数据流：

```
收音机 ─ff14 通知─> ble.js ─'data'─> FrameSplitter ─> FrameParser ─> c919_rx.log
                                                          └─> IPC 'radio:status' ─> renderer
renderer 按钮 ─> preload ─> ipcMain 'ble:key' ─> protocol.keyFrame ─> ble.send ─ff13─> 收音机
line-in / 蓝牙音频 ─> getUserMedia ─> AnalyserNode ─> 频谱和瀑布（只在网页里，和 BLE 无关）
```

音频和 BLE 完全独立：没连收音机也能看频谱，反过来没开音频也能控制收音机。

## 5. 哪些已验证，哪些是推断

**已在真机上验证**，来自你在 HRD-C919、固件 1.723 上的测试：
- 服务 `ff12`；写特征 `ff13`，属性是 `write`，即带响应写；通知特征 `ff14`；设备名 `HRD-C919-BLE`。
- 第一次连接偶尔报 `failed to discover services`，重试一次就能连上。
- 先开通知、再握手 `AB 01 FF AB`，之后收音机会主动推送状态。
- 帧格式 `AB LEN CMD payload SUM`，SUM 是前面所有字节相加的低 8 位。
- 电源键 `AB 02 0C 14 CD` 能开机。
- 设频率 `AB 06 10 <band> <K 小端 4 字节>` 有效。FM 下 K 的单位是 10kHz，K = round(MHz×100)。
- 频率帧 `AB 09 01`；工作模式 `AB 02 07`（00 关机，02 收音）。
- RSSI 和 SNR 走 `0x1C` 文字帧，fid 8 是 RSSI，fid 6 是 SNR，大约每秒一次。
- `0x1C` 里还有：解调（如 `ST`）、带宽（如 `110K`）、text11（VOL/STEP/DE-EMP/ATT/STEREO）、text12（MIX/ANT/EQ/TEMPRATURE）。文字是 GBK 编码，会分多段发送。
- 电池帧 `AB 03 08`，支持的波段 `AB 03 15`，上限帧 `AB 03 18`（sleep_max=90，sq_max=9）。
- 按钮文字 `0x21`：收音机下发 BW-DM、ANT-ATT、V-UHF、MUTE、LOCK。

**推断**，来自 App 反编译或说明书，没在真机上试过：
- 除电源开机以外的所有按键，实际会触发什么效果。
- FM 以外波段的频率换算。程序处理方式是：先按说明书的步进猜一个小数位数，界面标为「推断」；只要在该波段收到过一帧频率，就改用真机帧里的格式，界面标为「真机帧标定」。滚轮调谐的原理是"K 的十进制数字 = 屏幕上的数字"，跟单位无关，因此相对可靠。
- 静噪 `AB 02 11`、睡眠 `AB 02 0F`、时间同步 `AB 07 0D`、闹钟 `AB 05 0E`、只切波段 `AB 06 10 band 00000000`。
- 模拟模式里收音机对各条指令的反应。

## 6. 说明书功能覆盖表

说明书原件：`Raddy RF919 Extended Manual V2.5（未随仓库分发）`（Raddy RF919 Extended Manual V2.5，2024-08-01）。

App 的 5 个"可变按钮"和键码的对应关系，是从 MainActivity 里核对出来的：

| 按钮号 | App 控件 | C919 下发的文字 | 短按 | 长按 |
|---|---|---|---|---|
| 1 | bt_subband_text | **BW-DM** | SUBBAND 0x17 | SUBBAND_LONG 0x41 |
| 2 | bt_step_text | **ANT-ATT** | STEP 0x1B | STEP_LONG 0x42 |
| 3 | bt_play | **V-UHF** | PLAY 0x1A | PLAY_LONG 0x33 |
| 4 | iv_sos | **MUTE** | SOS 0x2A | SOS_LONG 0x2B |
| 5 | iv_phone_play | **LOCK** | FUNC 0x1F | FUNC_LONG 0x34 |

状态说明：✅ 已验证（真机）｜🟡 推断（App 代码或说明书，没在真机上试）｜❓ 键码不确定｜⛔ BLE 做不到（只能在机身上操作）

| 说明书功能（章节） | 界面控件 | BLE 指令 | 状态 |
|---|---|---|---|
| 开机（8.1.1） | 电源 → 开机 | 按键 POWER 0x14 | ✅ |
| 关机（8.1.1，长按 2 秒） | 电源 → 关机 | POWER_LONG 0x45 | 🟡 |
| 工作模式显示 | 电源面板「工作模式」 | 上行 `AB 02 07` | ✅（OFF/RADIO） |
| 睡眠定时 10–90 分钟（8.1.2） | 录音/定时 → 睡眠 | `AB 02 0F <分钟>`；剩余时间看上行 `AB 02 05` | 🟡 |
| 音量 0–32（8.2） | 音量 −/＋ | VOL_DOWN 0x13 / VOL_UP 0x12（长按 0x43/0x44） | 🟡（显示值来自 text11 ✅） |
| 波段 FM/SW/MW/LW（8.3.1） | 波段 → BAND | BAND 0x00 | 🟡 |
| 波段 AIR/CB/WB/VHF/UHF（8.3.1） | 波段 → V-UHF（按钮 3） | PLAY 0x1A | 🟡（按钮文字 ✅） |
| 直接选波段 | 波段下拉框 → 切换 | `AB 06 10 band 00 00 00 00` | 🟡 |
| 支持哪些波段 | 下拉框自动过滤 | 上行 `AB 03 15` | ✅ |
| 直接输入频率（6.4，EN + 数字键） | 顶部输入框 / 滚轮 | `AB 06 10 band K` | ✅ FM；🟡 其它波段 |
| 用数字键盘输入频率 | 频道/键盘 → 0–9 . ⌫ EN | 0x01–0x0A、0x0C、0x0B、FREQ 0x0D | 🟡 |
| 步进调台（8.3.4.1） | 波段 → ◀ ▶ | DOWN 0x10 / UP 0x0E | 🟡 |
| 自动搜台，找到即停（8.3.4.2） | 波段 → ◀◀搜台 / 搜台▶▶ | DOWN_LONG 0x11 / UP_LONG 0x0F | 🟡 |
| SCAN 长按，自动搜索并存台 ATS（8.3.4.3） | 频道 → ATS 自动存台 | PLAY_LONG 0x33 | ❓（C919 上按钮 3 是 V-UHF，长按的效果没确认） |
| VHF/UHF/AIR/CB 的 Scan-Freq 模式（6.3） | 全部按键 | 不确定 | ❓ |
| 选择旋钮步进（8.3.4.4） | 接收 → 步进 STEP | CIRCLE 0x27（App 的 bt_step） | ❓；当前步进显示 ✅（text11） |
| 米波段（8.3.5）、FM/MW 起始频率（8.3.2/8.3.3） | 波段 → 米波段 | MUSIC 0x26（App 的 bt_subband） | ❓ |
| UHF 长按切换各国免费对讲频段（6.1） | 全部按键 BAND_LONG | 0x29 | ❓ |
| 手动存台（8.3.6） | 频道 → 存台(长)，再按 MEMO 确认 | MEMO_LONG 0x2C / MEMO 0x24 | 🟡 |
| 调出频道、频道/频率模式切换（8.3.7） | 频道 → 频道/频率，加数字键和 EN | PRESET 0x23 | 🟡；频道号显示走上行 `AB 04 10` |
| 删除频道（8.3.8，DEL 长按） | 全部按键 BACK_LONG | 0x48 | 🟡 |
| WB 气象频道和警报（8.3.9） | 选 WB 波段；频率区显示 ALERT | `AB 06 10 06 …`；K=0xFF 表示 ALERT | 🟡 |
| 接收设置菜单：ANT-LNA/HPF/LPF/GAIN/WT-SCAN（8.3.10） | 无 | 要靠旋钮操作菜单，没有对应的 BLE 指令 | ⛔ |
| 静噪 SQL 0–9（8.3.10） | 接收 → SQL 滑块 + 设置；SQL 格 | `AB 02 11 <等级>`；CELL5 0x30（收音机回 `AB 03 1F` 弹出选择框） | 🟡（sq_max=9 ✅；SQL/OFF 文字 ✅） |
| 静噪开关（6.1，长按 MUTE） | 接收 → 静音(长) | SOS_LONG 0x2B | 🟡 |
| 带宽（8.3.11） | 接收 → 带宽 BW；状态格·带宽 | SUBBAND 0x17（BW-DM 短按）/ BANDWIDTH 0x1E | 🟡；显示 ✅（110K） |
| 解调 AM/USB/LSB/WFM/ST（8.3.12/8.3.13） | 接收 → 解调 DM；状态格·解调 | SUBBAND_LONG 0x41（BW-DM 长按）/ DEMOD 0x1D | 🟡；显示 ✅（ST） |
| 天线模式、DX/LOCAL 衰减（6.1） | 接收 → 天线/衰减 | STEP 0x1B（ANT-ATT） | 🟡；ATT/ANT 显示 ✅ |
| 立体声 / 去加重 | 接收 → 立体声；全部按键 DE | STEREO 0x21 / DE 0x22（App 没用到） | ❓；DE-EMP/STEREO 显示 ✅ |
| 静音（6.1） | 接收 → 静音 | SOS 0x2A（MUTE） | 🟡 |
| 锁（第 13 章，机身右侧拨动开关） | 接收 → 锁定 / 锁定(长) | FUNC 0x1F / FUNC_LONG 0x34（LOCK） | 🟡；机身拨动开关本身 ⛔。说明书写全锁时仍可用 App 操作 |
| EQ 均衡器（第 10 章） | 只显示（接收面板 EQ） | 没找到对应键码；MP3 模式下有上行 `AB 02 0A` | ❓；显示 ✅（NORMAL） |
| 蓝牙/TF/PC 模式切换（第 11 章、12.3） | 电源 → 模式 BT/TF/PC | BT 0x1C | 🟡 |
| 断开蓝牙音频（11.2） | 电源 → 断开蓝牙音频 | BT_LONG 0x3F | 🟡 |
| TF 播放：播放暂停、上一曲、下一曲（9.2） | ◀ ▶ 和全部按键 | UP/DOWN（TF 模式下）、MUSIC 0x26 | 🟡 |
| 录音到 TF 卡（9.3） | 录音/定时 → 录音 / 录音(长) | REC 0x25 / REC_LONG 0x49 | 🟡 |
| 设置时间（第 14 章） | 同步时间 | `AB 07 0D 时 分 秒 年-1970 月 日` | 🟡 |
| 闹钟（第 15 章，App 只能设闹钟 1） | 闹钟1：时间、类型、开/关 | `AB 05 0E 类型 时 分 开关`；上行 `AB 05 06` | 🟡（上行帧 ✅ 收到过） |
| 闹钟贪睡/确认（15.2） | 全部按键 ALARM_SNOOZE(_LONG) | 0x31 / 0x32 | 🟡 |
| 系统设置：背光、颜色、TONE、APP ENABLE、调谐静音、恢复出厂（第 16 章） | 无 | 没有 BLE 指令 | ⛔ |
| DISPLAY、TIME/SET、ALARM 这几个机身键（6.2） | 无 | 没有键码 | ⛔ |
| 温度显示（第 20 章） | 状态栏 → 温度 | text12 `TEMPRATURE:25℃` | ✅ |
| 电量、充电（第 17 章） | 状态栏 → 电量 | 上行 `AB 03 08` | ✅ |
| SNR / RSSI（7.4） | 顶部大字、状态栏、历史图 | `0x1C` fid 6 / fid 8 | ✅ |
| 固件版本 | 状态栏 → 固件 | 上行 `0x19` 分段文字 | ✅（1.723） |
| AUX 输入、USB 读卡器和声卡、外接天线开关、手动天线旋钮、固件升级（第 18、19、21、23 章） | 无 | 都是硬件操作 | ⛔ |

"全部按键"面板列出了 KEYS 表里的全部 70 多个键码，鼠标悬停能看说明。拿不准的功能可以在这里逐个试，同时对照 `c919_rx.log`。

## 7. 音频输入：line-in 和蓝牙 A2DP

程序采集的是**收音机解调后的声音**。频谱的横轴是音频频率（0 到采样率的一半），**不是射频**。C919 没有 IQ 输出，所以做不了 SDR# 那种射频全景。

### 7.1 设备选择
- 右侧「音频输入」下拉框里有：声卡的 line-in 和麦克风、蓝牙 A2DP 音源、PipeWire 的「Monitor of …」监视源，还有一个「测试信号（振荡器）」。
- 首次使用时，程序会先请求一次音频权限，这样才能拿到设备的真实名字。插拔声卡、蓝牙连上或断开时，列表会自动刷新；也可以手动点「刷新」。
- 程序会记住上次用的设备：先按 deviceId 匹配，对不上再按名字匹配。
- 采集时关掉了 `echoCancellation`、`noiseSuppression` 和 `autoGainControl`。这三项是给语音通话设计的，开着会把收音机的声音和频谱"修"坏。
- 「监听」默认关闭（每次启动都关），以免形成回授；监听的是处理链的输出，见 7.5。

### 7.2 有线 line-in（先用这个测）
把收音机的 AUX 或耳机输出接到电脑的 line-in，然后用 `pavucontrol`，或者执行 `wpctl status`，确认输入电平。电平太高会削顶，频谱上会冒出很多谐波。

### 7.3 用蓝牙发射器无线传音频：把 Linux 当作 A2DP Sink（PipeWire / WirePlumber）
做法是：收音机 AUX 输出接一个经典蓝牙（A2DP）发射器，发射器配对到 Linux 电脑，电脑当"蓝牙音箱"（Sink）来接收。

1. 确认用的是 PipeWire，并且装了蓝牙模块：
   ```bash
   pactl info | grep "Server Name"        # 应该显示 PulseAudio (on PipeWire …)
   # Fedora 默认就有；Debian/Ubuntu 需要装：
   sudo apt install pipewire-pulse wireplumber libspa-0.2-bluetooth
   ```
2. 配对、信任、连接。先把发射器调到配对模式：
   ```bash
   bluetoothctl
   [bluetooth]# power on
   [bluetooth]# agent on
   [bluetooth]# default-agent
   [bluetooth]# scan on                # 等发射器出现，记下它的 MAC，例如 AA:BB:CC:DD:EE:FF
   [bluetooth]# pair AA:BB:CC:DD:EE:FF
   [bluetooth]# trust AA:BB:CC:DD:EE:FF   # 信任之后，下次发射器开机会自动回连
   [bluetooth]# connect AA:BB:CC:DD:EE:FF
   [bluetooth]# scan off
   ```
   有的发射器只肯连"耳机"。PipeWire 默认同时注册 A2DP Sink 和 Source 两种角色，一般不用改。如果连上后没有声音，检查 `/etc/wireplumber/` 或 `~/.config/wireplumber/` 下的蓝牙配置，确认 `bluez5.roles` 里有 `a2dp_sink`。
3. 确认电脑上出现了这个音源：
   ```bash
   wpctl status          # Audio → Sources 里应该有 bluez_input.AA_BB_… 或类似的条目
   pactl list short sources | grep bluez
   ```
   在本程序里点「刷新」，选这个蓝牙音源，再点「开始」。
4. **和 BLE 共用一个适配器**：
   - 默认的 BlueZ 后端和 A2DP 都由 bluetoothd 管理，可以在同一个适配器上同时工作，这也是选 BlueZ 后端做默认的原因。
   - 一个适配器同时跑 A2DP 流和 BLE 连接，偶尔会出现 BLE 写入变慢、音频卡顿的情况，这在 2.4GHz 拥挤时更明显。可以让两个设备都离电脑近一点；也可以另插一个 USB 蓝牙适配器，用 `bluetoothctl select <适配器MAC>` 把 A2DP 放到另一个适配器上。
   - 用 noble 后端时，常常得停掉 bluetoothd，**A2DP 就用不了了**（见第 3 节）。
5. **延迟和压缩的影响**：
   - A2DP 有延迟，一般在 150–300ms，有时更长：先经过发射器编码，再经过蓝牙缓冲，最后是 PipeWire 的缓冲。频谱和瀑布会比收音机的实际声音晚一点。调台之后，音频变化也会晚于 RSSI 的变化。
   - A2DP 用有损编码，多数发射器只支持 SBC，好一些的支持 aptX 或 AAC。编码器会砍掉高频（SBC 常见的截止频率在 15–20kHz）、加入量化噪声，还会做心理声学处理，所以细小的谱线、19kHz 立体声导频、底噪的形状都可能失真或被砍掉。**要看细节或做测量，请用有线 line-in。**
   - 某些发射器有自动增益，或者在静音时自动断开，这会让电平和底噪忽高忽低。

### 7.4 底部 VU / 峰值表

- 显示的是声卡**原始输入**（处理前）的电平，单位 dBFS，刻度 −60 ~ 0。立体声输入显示 L/R 两条细条。
- 实心条 = RMS（功率按 300ms 时间常数平滑）；浅色部分 = 快速峰值；白线 = 峰值保持（1.5 秒后以 20 dB/s 下落）。
- 色区：< −18 绿，−18 ~ −6 黄，> −6 红。
- **CLIP 灯**：任一样本 |x| ≥ 0.999 就亮，锁存 2 秒，点一下复位。亮了就先调小收音机音量或声卡增益，软件救不回削顶。
- 右侧「输出」是处理链输出（送去监听的信号）的 RMS，变红表示输出到了满幅。
- 推荐：节目 RMS 在 −24 ~ −12 dBFS，峰值不超过 −6，CLIP 从不亮。

### 7.5 弱信号处理（降噪 + 增益 + 干/湿混合）

处理链（每一级可单独开关，关掉的级不接进图里）：

```
输入 ─┬─────────────── 延迟对齐 ────────────────────────────── 干 ─┐
      └─ 高通 100Hz → 工频陷波 → 带宽限制 → 降噪 → 增益 → 限幅 ── 湿 ─┴─ 混合 → 监听（扬声器 / 耳机）
```

- **高通 100Hz**：两级 Butterworth，24 dB/oct，去交流嗡嗡声和低频隆隆声。
- **工频陷波**：50Hz（国内）或 60Hz，基波 + 2、3 次谐波，Q = 12。
- **降噪**：STFT 频谱减法（1024 点、75% 重叠、sqrt-Hann 窗，延迟 1024 个样本 ≈ 21ms），在 AudioWorklet 里跑。
  - 「自动跟踪」：最小值统计，约 1.5 秒窗口里每个频点的最低功率当噪声底，需要节目里有停顿。带"窄带保护"，持续的单音 / 载波 / CW 不会被当成噪声减掉。
  - 「学习的噪声谱」：调到空频点、或节目停顿时点「学习噪声（1 秒）」，录下噪声谱后自动切到这个模式。噪声谱保存在 localStorage，下次启动还在。
  - 强度 0~100：同时控制过减系数（1~4）和增益下限（−6 ~ −30 dB）。强度越高越干净，但越容易出"水声"、人声发闷。
- **带宽限制**（替代早期的「人声频段」开关）：低切 + 高切，各为 4 阶 Butterworth（24 dB/oct，截止点 −3dB）。放在降噪之前，所以降噪 / 增益 / 限幅只作用于带内，带外被衰减。
  - 预设：全带宽（旁路）、语音 300–3400 Hz、AM 窄带 200–2500 Hz；拖滑块或直接输入数字会自动变成「自定义」（两者至少相差 100Hz）。
  - 频谱上用绿色阴影 + 虚线标出处理带宽，带外压暗（处理启用且不是全带宽时才画；伪 IQ 模式下跟着频移）。
  - 实测频响（语音预设）：150Hz −24.1、300Hz −3.0、1kHz 0.0、3.4kHz −3.0、5kHz −14.4、8kHz −33.1 dB。
- **增益**：0 ~ +30 dB。
- **限幅**：−3 dBFS 起压的压缩器（20:1、3ms 起音、6ms 预读）+ tanh 软削波，输出最高 −0.3 dBFS，增益开到 30dB 也不会爆音。
- **混合 干/湿**：0% = 原声，100% = 只听处理后的声音。干信号按"降噪 1024 点 + 限幅 6ms"延迟对齐，混合时不会梳状滤波。
- **频谱显示**：处理前 / 处理后。VU 表永远看处理前。
- 处理**只作用于监听**：右侧「监听」默认关（外放容易啸叫，用耳机最好），监听音量单独可调。监听开关不记忆，处理参数和监听音量记忆在 localStorage。

### 7.5.1 界面布局

- 左栏 | 中间 | 右栏之间、右栏上半（音频输入 / 伪 IQ / 显示设置）和下半（弱信号处理）之间都有分隔条，拖动调整，双击恢复默认，尺寸存在 localStorage `layout`。
- 最小尺寸：左栏 180px、右栏 220px、中间 360px、右栏上下各 120px。窗口变窄时左右栏按比例让出空间。
- 拖动时频谱 / 瀑布 / VU 表自动重排，瀑布历史按比例保留。
- 全局隐藏滚动条（滚轮照常滚动）；音频设备名过长时截短显示，完整名字在鼠标悬停提示里。

### 7.6 伪 IQ 模式

**伪 IQ（由音频希尔伯特变换推导，非射频）**。C919 只输出解调后的音频，这里看到的不是电台周围的射频频谱。

- 255 阶 Blackman 窗 FIR 希尔伯特滤波器：I = 输入延迟 127 个样本，Q = 希尔伯特输出，得到只有正频率的解析信号。
- 频谱 / 瀑布改为复数 FFT，横轴 −fs/2 … +fs/2（受「最大频率」限制为 ±最大频率），对数轴在此模式下不可用。
- 频移：不移（0Hz 在中间，负半边基本为空，能看到镜像抑制）/ 居中（−fs/4，整个音频带搬到中间）/ 自定义 Hz。
- 李萨如小示波器：I 横轴、Q 纵轴。单音是一个圆，噪声是一团雾，立体声不平衡、相位问题一眼可见。
- 300Hz 以下镜像抑制只有约 28dB（FIR 长度的限制），1kHz 以上 > 80dB。
- 复数 FFT 在主线程用 JS 算，FFT 点数开到 16384 时 CPU 占用会明显上升，看完记得关。

## 8. 已知限制

- 真机只验证过上面第 5 节列出的项目。这个 Electron 程序**没有接过真机**：BlueZ 后端的代码路径和 bleak 一样，但本身没在真机上跑过；noble 后端也没跑过。
- FM 以外波段的频率换算在收到第一帧频率之前都是推断值。
- 很多按键在 C919 上的实际效果还不确定，见第 6 节标 ❓ 的行。
- 频谱是**音频频谱**，取决于收音机的音量、AUX 电平和声卡增益；跟射频信号强度不是一回事，射频强度请看 RSSI。
- RSSI 和 SNR 大约一秒更新一次，所以历史图是慢速曲线。
- 模拟模式的响应是"猜"的，只用来开发和演示界面。
- 降噪是经典频谱减法，不是神经网络降噪：对平稳噪声（白噪声、嘶嘶声、底噪）有效；对突发干扰（雷电噼啪、电机脉冲）和其他电台串音基本无效。强度开太高会有"水声"（音乐噪声）。
- 软件增益放大的是信号和噪声两者，救不回硬件信噪比；先把天线、收音机、声卡电平调好。
- 处理链总延迟约 27ms（48kHz，降噪 21ms + 限幅 6ms），加上系统音频缓冲。
- 电平表用 AnalyserNode 的 2048 点窗口在每帧（约 33ms）读取，窗口有重叠，峰值和削波不会漏，但不是逐样本的硬件级表头。
