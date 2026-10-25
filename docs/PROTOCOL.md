# 汉荣达 HRD-C919（Raddy RF919）BLE 控制协议

> 来源：官方 Android 控制 App **Radio-C / Radio-CT**，包名 `com.myhomesmartlife.bluetooth`，versionName **1.1.9**（versionCode 2）。
> 用 jadx 1.5.6 反编译。所有字节都**直接抄自反编译代码**，下面每条都注明了出处（类名:行号，行号对应 `jadx_out/sources/com/myhomesmartlife/bluetooth/`）。
> 标 ⚠️ 的是**推断**或**代码里看不出来**的部分，需要接真机验证。
> 这个 App 是迪斯普（Dispo）通用的收音机控制 App，同时支持 HRD-787 / A320 / 320 / 757 / C919 等机型。协议是共用的，所以有些功能 C919 可能没有。

## 0. APK 来源

| 项 | 值 |
|---|---|
| 官方下载地址 | `http://www.szdipusi.cn/file/Radio-c.apk`（RF919 说明书 V2.5 第 12 章二维码解出来就是这个地址） |
| 实际获取 | 官方服务器从这台机器连不上（超时），改从 Wayback Machine 的 2023-12-26 快照下载：`https://web.archive.org/web/20231226174809id_/http://www.szdipusi.cn/file/Radio-c.apk` |
| 校验 | SHA1(base32) `6GV6IHYQOME3UF5RI73AKQ6MAMY3IOLW`，跟 Wayback 记录的摘要一致；SHA256 `52c17f639327ecbf57c4f454b5555427c22a499a9ed3e8c2713661b6841a5f84` |
| ⚠️ | 这是 2023-12 的版本。官方服务器上现在可能有更新的版本，协议也许多了新指令 |

BLE 相关逻辑基本全在 `MainActivity.java`（4766 行）和 `SendData.java`（固定指令表）里。代码没混淆字符串，也没加密。

---

## 1. GATT 连接

| 项 | 值 | 出处 |
|---|---|---|
| 广播名 | `RF919-BLE`（说明书写的；App 扫描时不按名字过滤） | 说明书 §12 |
| 写特征（App → 收音机） | `0000ff13-0000-1000-8000-00805f9b34fb` | MainActivity:1328 |
| 通知特征（收音机 → App） | `0000ff14-0000-1000-8000-00805f9b34fb` | MainActivity:1333 |
| 服务 UUID | App 没写死，只是遍历所有服务找这两个特征。⚠️ 推测是 `0000ff10-…` 或 `0000ff12-…`，实际要以 bleak 扫出来的为准 | MainActivity:1324-1339 |
| MTU | App **没有**调用 `requestMtu`，所以默认 23（payload 20 字节） | 全文搜索结果 |
| 配对/绑定 | **不需要**。没有 `createBond`，也没有密码或鉴权 | 全文搜索结果 |
| 写入方式 | `writeCharacteristic()`，没设 writeType，即特征默认的方式 | MainActivity:1222-1233 |
| 通知开启 | 只调用了 `setCharacteristicNotification(ff14, true)`，**没写 CCCD 描述符**（0x2902）。⚠️ 这说明固件很可能不管 CCCD 都会推通知。bleak 的 `start_notify` 会写 CCCD，一般没问题 | MainActivity:4733-4738 |

### 连接流程（MainActivity:1280-1342）
1. `connectGatt(autoConnect=true)`，连上后 `discoverServices()`
2. 服务发现完成后：
   - **先发握手** `AB 01 FF AB`（`SendData.sendWoshou`，"woshou" 就是握手的拼音）
   - 然后打开 ff14 的通知
3. ⚠️ 握手后收音机应该会主动推一批状态帧（频率、波段、音量、电量、界面文字等）。代码里看不到 App 主动去"查询"状态的指令，**所有状态都是收音机推过来的**。

断开：收音机发 `AB 02 24 ..` 时 App 会主动断开（MainActivity:3988）。

---

## 2. 帧格式与校验

```
AB  LEN  CMD  [payload ...]  SUM
```

- `AB`：帧头，固定 0xAB
- `LEN`：从 CMD 开始算、到 SUM 之前的字节数（= 1 + payload 长度）
- `CMD`：命令或类型
- `SUM`：**前面所有字节（含 AB）相加，取低 8 位**

验证：`SendData.java` 里 76 条固定指令我用脚本逐条核对过，长度和校验**全部吻合**。动态拼的指令也是这样算的（例如 MainActivity:4204 `(byte)(b0+b1+b2+b3)`）。
- 例：`AB 02 0C 00` → 0xAB+0x02+0x0C+0x00 = 0xB9 → `AB 02 0C 00 B9`
- 握手：`AB 01 FF` → 0x1AB → 低 8 位 0xAB → `AB 01 FF AB`

⚠️ App 收数据时**不校验 SUM**，只按前 3 个字节（`AB LEN CMD`）的 hex 字符串匹配。所以**同一个 CMD 的 LEN 不同，就是不同的帧**，例如 `ab0901` 和 `ab090f` 不是同一种。
⚠️ App 默认一次通知就是一帧，不做拼包和拆包。PC 端最好按 LEN 自己切帧（`c919_ble.py` 里就是这么做的）。

---

## 3. 下行指令（App → 收音机，写 ff13）

### 3.1 按键：`AB 02 0C <key> SUM`

全部来自 `SendData.java`。界面绑定是用脚本从 MainActivity:450-1100 提取出来的，"短按/长按"指 App 界面上对应按钮的操作。

| key | SendData 名 | App 按钮 / 含义 |
|---|---|---|
| 00 | sendBand | BAND 短按（bt_band） |
| 01–09 | sendNumberOne…Nine | 数字 1–9 |
| 0A | sendNumberZero | 数字 0 |
| 0B | sendButtonBack | 退格/删除（bt_back） |
| 0C | sendButtonPoint | 小数点（bt_number_point） |
| 0D | sendButtonFreq | FREQ / 直接输入频率（bt_freq） |
| 0E | sendButtonTopShortClick | 上（bt_shang）短按 |
| 0F | sendButtonTopLongtClick | 上 长按 |
| 10 | sendButtonDownShortClick | 下（bt_down）短按 |
| 11 | sendButtonDownLongClick | 下 长按 |
| 12 | sendButtonVolAdd | 音量+（bt_jia） |
| 13 | sendButtonVolDel | 音量−（bt_jian） |
| 14 | sendButtonPower | 电源（bt_power）短按 |
| 17 | sendButtonSubBand | 子波段/MODE（bt_subband_text，需要 0x17 帧允许） |
| 1A | sendButtonPlay | 播放/SCAN（bt_play）短按 |
| 1B | sendButtonStep | STEP（bt_step_text）短按 |
| 1C | sendButtonBluetooth | 蓝牙/TF 切换（bt_bluetooth） |
| 1D | sendButtonDemodulation / firstClick / sendButtonDem | 点击状态区第 1 格（解调方式 lin_demodulation） |
| 1E | sendButtonBandWidth / twoClick | 点击状态区第 2 格（带宽 lin_bandwidth） |
| 1F | sendButtonMobileDisPlay | FUNC / 手机播放（iv_phone_play）短按 |
| 20 | sendButtonSQ | SQ（静噪），⚠️ App 里没绑按钮 |
| 21 | sendButtonStereo | 立体声，⚠️ 没绑按钮 |
| 22 | sendButtonDe | ⚠️ 含义不明，没绑按钮（De = 去加重？） |
| 23 | sendButtonPreset | PRESET 短按 |
| 24 | sendButtonMemo | MEMO 短按 |
| 25 | sendButtonRec | REC（bt_rec）短按 |
| 26 | sendButtonMusic | bt_subband 按钮 / 循环模式图标（iv_xunhuan） |
| 27 | sendButtonCircle | bt_step 按钮 |
| 28 | sendTypeMusicCircle | ⚠️ 音乐循环，没绑按钮 |
| 29 | sendButtonBandLong | BAND 长按 |
| 2A | sendSOSclick | SOS 短按 |
| 2B | sendSOSLongclick | SOS 长按 |
| 2C | sendMEMOLongclick | MEMO 长按 |
| 2D | sendRECclick | REC 文字区（tv_rec）点击 |
| 2E | sendStepNewclick / thirdClick | 状态区第 3 格（SNR 区 lin_snr） |
| 2F | fourClick | 状态区第 4 格（RSSI 区 lin_rssi） |
| 30 | fiveClick | 状态区第 5 格（lin_text_9） |
| 31 | alarmDadunClick | 闹钟贪睡/图标短按（闹钟响或贪睡时） |
| 32 | alarmDadunLongClick | 闹钟图标长按（同上） |
| 33 | sendButtonLongPlay | 播放/SCAN 长按 |
| 34 | funcLongClick | FUNC 长按 |
| 35–3D | sendNumerOne…NinelongClick | 数字 1–9 长按 |
| 3E | sendNumerTenlongClick | 数字 0 长按 |
| 3F | sendNumerMusiclongClick | 蓝牙键长按 |
| 40 | sendNumerPlaylongClick | PRESET 长按 |
| 41 | sendNumerModelongClick | 子波段/MODE 长按 |
| 42 | sendNumerEqlongClick | STEP 长按 |
| 43 | sendNumerJianlongClick | 音量− 长按 |
| 44 | sendNumerJialongClick | 音量+ 长按 |
| 45 | sendNumerPowerlongClick | 电源长按 |
| 46 | sendNumerEnterlongClick | FREQ 长按 |
| 47 | sendNumerDianlongClick | 小数点长按 |
| 48 | sendNumerDeltelongClick | 退格长按 |
| 49 | sendNumerMetelongClick | REC 长按 |

⚠️ 长按是**单独的一个码**，不是"按下/松开"两条指令。另外 0x15、0x16、0x18、0x19 在代码里没出现。

**用按键直接输入频率**（推测，跟实机面板的操作一致）：`FREQ(0D)` → 依次发数字和 `点(0C)` → 再发一次 `FREQ(0D)` 确认。输入过程中收音机会回 `AB 09 0F` 帧（见 4.3）。⚠️ 确认键到底是 0D 还是 46，需要实测。

### 3.2 直接设置波段和频率：`AB 06 10 <band> <f0 f1 f2 f3> SUM` ★

- 出处：MainActivity:4274-4278（`onSend`：调出 App 里保存的电台备注），MainActivity:4339-4343（`RateTypeDialog` 选波段）
- `<band>` 是波段码（见第 5 节）
- `<f0..f3>` 跟状态帧 `AB 09 01` 里的 4 个频率字节**完全一样**（小端 32 位原始值）。App 存电台时就是原样存下这 4 个字节，调台时再原样发回去（RemarkInfo 的 byte4–byte7）。
- **只切波段**：App 发的是 `AB 06 10 <band> 00 00 00 00 SUM`，频率全 0（MainActivity:4341）。⚠️ 推测频率为 0 表示"切到该波段的上次频率"。
- ⚠️ **原始值的单位代码里没有写**。App 从来不自己算原始值，只是回放收到过的值。所以要做扫频，得先从真机状态帧把每个波段的换算关系标定出来，见 4.2。

### 3.3 其它参数指令

| 指令 | 格式 | 出处 | 说明 |
|---|---|---|---|
| 睡眠定时 | `AB 02 0F <分钟> SUM` | MainActivity:4198-4208 | 分钟只能是 0、10、20……直到最大值（最大值来自 0x18 帧 byte3，默认 90）。0 = 关闭 |
| 静噪（SQ）等级 | `AB 02 11 <等级> SUM` | MainActivity:4345-4356 | 等级 0…N（N 来自 0x18 帧 byte4）。收到 `AB 03 1F 01 <pos>` 时 App 弹出选择框 |
| 时间同步 | `AB 07 0D <时> <分> <秒> <年-1970> <月> <日> SUM` | MainActivity:787-822 | 月份 1–12，各字段都是二进制数值（不是 BCD） |
| 闹钟 | `AB 05 0E <类型 00/01> <时> <分> <开关 00/01> SUM` | MainActivity:4157-4180、2093-2110 | ⚠️ 类型 00/01 来自 TimePicker 的第三个参数，可能是"收音/铃声"两种。最后一个字节代码里写的是 `"0"+H`，H 为 0 或 1 |
| 握手 | `AB 01 FF AB` | SendData:5 | 连接后必须先发 |
| (未用) | `AB 02 12 01 C0` / `AB 02 12 00 BF` | SendData:80-81 | 名字叫 accectSuccess/Faile，App 里**没有用到** |

---

## 4. 上行通知（收音机 → App，ff14）

下面 `b[n]` 是帧里的字节下标（`b[0]=AB, b[1]=LEN, b[2]=CMD`）。出处统一是 `MainActivity.a(byte[])`，在 1391-4150 行。

### 4.1 总表

| 前缀 | 含义 | 字段 | 行号 |
|---|---|---|---|
| `AB 09 01` | **主状态：波段和频率** | 见 4.2 | 1612 |
| `AB 09 0F` | 频率输入模式中的状态 | 见 4.3 | 1793 |
| `AB 03 03` | **RSSI 和 SNR** | b3 = RSSI，b4 = SNR（无符号十进制，直接显示） | 1741 |
| `AB 09 04` | 解调方式和带宽 | b3 = 解调方式（0 WFM、1 NFM、2 MONO、3 STEREO、4 AM、5 SSB、6 LSB、7 USB）；b9 + b10×256 = 带宽数值（直接显示到 tv_band_width，⚠️ 单位未知）；b4–b8 读了但 UI 没用 | 1944 |
| `AB 02 09` | 音量 | b3 = 音量（"VOL:"+十进制） | 2445 |
| `AB 03 08` | 电池 | b3 = 电量格 0–3；b4 = 01 表示正在充电 | 2409 |
| `AB 02 07` | 工作模式/页面 | b3：00 或 03 = 关机/待机（显示"please enjoy"），01 = 蓝牙音乐，02 = **收音机**，04 = TF 卡 MP3，06 = PC（USB 声卡），07 = AUX | 2286 |
| `AB 04 10` | 预置台（存台）状态 | b3：00 隐藏，01 显示台号，02 台号闪烁（存台中），03 显示"- -"；b4 = 台号 | 2523 |
| `AB 02 05` | 睡眠定时剩余 | b3 = 分钟，0 = 关闭 | 2035 |
| `AB 05 06` | 闹钟 | b3 = 类型（00/01，决定图标），b4 = 时，b5 = 分，b6 = 状态（00 关、01 开、02 正在响/闪烁、03 贪睡） | 2053 |
| `AB 03 15` | 本机支持的波段 | b3、b4 两个字节是位图。App 把它们拼成二进制串后反转，第 i 位对应第 5 节波段列表的第 i 项（1 = 显示） | 4011 |
| `AB 03 18` | 能力上限 | b3 = 睡眠定时最大分钟数，b4 = SQ 最大等级 | 4109 |
| `AB 03 1F` | 打开 SQ 选择框 | b3 = 01 打开、00 关闭；b4 = 锚定在状态区第几格（1–5） | 1759 |
| `AB 04 17` | 按钮可用性 | b3 = 子波段/MODE 键，b4 = STEP 键，b5 = 播放/SCAN 键（00 禁用、01 可用） | 1414 |
| `AB 03 1E` | 状态区 5 个格子显隐 | b3 = 格子 1–5（解调、带宽、SNR、RSSI、第 9 项），b4：00 隐藏、01 显示、02 闪烁 | 1542 |
| `AB 03 1D` | 文字字段闪烁 | b3 = 字段号 1–16（同 0x1C 的编号），b4 = 02 闪烁，其它值停止 | 3786 |
| `AB LL 1C` | **界面文字下发**（GBK） | 见 4.4 | 2765-3775 |
| `AB LL 21` | 按钮文字下发（GBK） | b3 = 按钮号 1–5（1 MODE 键、2 STEP 键、3 SCAN/播放键、4 SOS、5 FUNC），格式同 0x1C | 3501-3730 |
| `AB LL 12` | 提示文字（GBK） | b3 = 分段号，b4 = 本段长度，b5… = 文本；显示在中间的提示区 | 2656 |
| `AB LL 19` | 固件版本字符串（GBK） | 同上 | 2703 |
| `AB LL 23` | Toast 文字（GBK） | 同上 | 4061 |
| `AB 02 16` | 版本号字节 | b3 | 4048 |
| `AB 02 0A` | MP3 EQ | 0 NORMAL、1 POP、2 ROCK、3 JAZZ、4 CLASSIC、5 COUNTRY | 2454 |
| `AB 02 0E` | MP3 播放状态 | 01 = 播放中，其它 = 暂停 | 2504 |
| `AB 02 11` | MP3 循环模式 | 00 全部、01 单曲、02 文件夹、03 随机 | 2556 |
| `AB 07 0D` | MP3 播放进度 | b3 + b4×256 = 已播秒数；b6 + b7×256 = 当前曲目号 | 2598 |
| `AB 06 0C` | MP3 曲目总数 | b3 + b4×256 = 当前曲号（N），b5 + b6×256 = 总数（M） | 2637 |
| `AB 04 02` | 选曲输入 | b3 = 00 正常、其它 = 输入中；输入中时显示 b4 + b5×256 | 2579 |
| `AB 02 20` | 语言 | 00 = 简体中文，其它 = 英文 | 2486 |
| `AB 03 22` | SOS / FUNC 闪烁 | b3 = 01 SOS、02 FUNC；b4 = 01 闪烁 | 4131 |
| `AB 03 13 00 C0` | 整帧匹配：提示"Please turn on the device……" | | 3777 |
| `AB 02 24` | 收音机要求断开 | App 收到后断开 | 3988 |
| `AB 03 0B` | 设备在线信息 | 只写了日志 | 2501 |
| `AB 04 14` | ⚠️ 未知 | b3 存下来了，b4 + b5×256 解析了但没用 | 3999 |
| `AB 02 1B` | ⚠️ 未知 | 空处理 | 4119 |

### 4.2 主状态帧 `AB 09 01` ★（MainActivity:1612-1740，显示逻辑在 4363-4731）

```
b0  b1  b2  b3    b4 b5 b6 b7   b8    b9        b10     b11
AB  09  01  band  f0 f1 f2 f3   unit  ag|af     blink   SUM
```
- `band`：波段码（第 5 节）
- `f0..f3`：**小端 32 位无符号整数 K**（代码：`hexToDec(b7 b6 b5 b4)`）
  - 特例：band = 06（WB）而且 K = 0x000000FF 时，显示 "ALERT"（气象警报）
- `unit`：00 = MHz，01 = kHz
- `b9`：低 4 位 `af` = **小数点位置**，高 4 位 `ag` = **首位数字所在的格子**
  - App 的频率显示一共 6 个大号数字格 `d1..d6`，后面跟 1–2 位小号数字。每个格子后面都有一个小数点 `dot1..dot6`（布局文件 activity_new_main.xml）。
  - 把 K 的十进制字符串从第 `ag` 格开始往右填；第 `af` 格后面点亮小数点（af = 0 表示没有小数点）。
  - 所以 **整数部分位数 = af − ag + 1**，`频率 = K / 10^(len(str(K)) − (af−ag+1))`，单位看 `unit`。
  - ⚠️ 这条公式是我从显示代码推出来的，代码里没有现成的"换算成 Hz"函数，需要实机核对。
- `blink`（cj）：频率区 00 = 显示，01 = 隐藏，02 = 闪烁
- 另外：K = 0 时隐藏频率区

**给 set_freq 标定**：同一个波段里，K 的"单位步长" = 10^−小数位数 × unit。例如假设 FM 显示 98.10 MHz、K = 9810，那么步长就是 0.01 MHz，要发 99.5 MHz 就是 K = 9950 → `AB 06 10 00 DE 26 00 00 SUM`。⚠️ 这只是举例，每个波段的步长必须从真机帧里标定。

### 4.3 频率输入帧 `AB 09 0F`（MainActivity:1793-1943）

```
AB 09 0F  state  band  f0 f1 f2 f3  unit  ag|af  SUM
```
- `state`：00 = 正常（按 4.2 显示），01 = 正在输入（K = 0 时显示"Please enter"），02 = "Input error"
- 注意：这里的字段比 0x01 帧**整体后移一个字节**，而且没有 blink 字节

### 4.4 文字帧 `AB LL 1C`（分段传 GBK 文本）

```
AB LL 1C  field  seg  n  <n 字节 GBK 文本>  SUM
```
- `seg`：01 = 首段（清空缓存再存）、02 = 中间段（追加）、03 = **单段完整**、04 = 末段（追加后显示）
- `field` → App 控件（行号 2765-3775）：

| field | 控件 | 推测含义 |
|---|---|---|
| 01 | tv_demodulation_title | 状态格 1 的标题 |
| 02 | tv_demodulation | 状态格 1 的值（解调方式） |
| 03 | tv_band_width_title | 格 2 标题 |
| 04 | tv_band_width | 格 2 值（带宽） |
| 05 | tv_snr_title | 格 3 标题 |
| 06 | tv_snr | 格 3 值（SNR） |
| 07 | tv_rssi_title | 格 4 标题 |
| 08 | tv_rssi | 格 4 值（RSSI） |
| 09–0C | tv_text9/10/11/12 | 第 5 格等的标题或值 |
| 0D | tv_sdvol | 音量文字 |
| 0E | tv_num | 曲目号 |
| 0F | tv_text_15 | ⚠️ 未知 |
| 10 | tv_rec | REC 状态文字 |

⚠️ 也就是说，C919 有可能不是只用 `AB 03 03` 发 RSSI/SNR 数字，而是用 0x1C 帧把**整段文字**推过来，例如 field 06 = "25dB"。两种方式代码都支持，C919 实际用哪一种得抓包确认。`c919_ble.py` 两种都会解析。

`0x12 / 0x19 / 0x23` 帧格式相同，只是少了 `field` 字节：`AB LL CMD seg n <text> SUM`。

---

## 5. 波段码（MainActivity:347-427，以及 1612-1666）

| 码 | 波段 | 码 | 波段 |
|---|---|---|---|
| 00 | FM | 08 | LW |
| 01 | AM（MW） | 09 | HAM |
| 02 | SW | **10** | RAIL |
| 03 | AIR | **11** | MRN |
| 04 | CB | **12** | RACE |
| 05 | UHF | **13** | POL |
| 06 | WB | **14** | FIRE |
| 07 | VHF | **15** | OTHER |

⚠️ 注意：0x10–0x15 是**十六进制字节**。App 是拿 hex 字符串 "10"…"15" 比较的，0x0A–0x0F **没有对应的波段**。
`AB 03 15` 的位图按上表顺序（FM、AM、SW、AIR、CB、UHF、WB、VHF、LW、HAM、RAIL…）给出本机支持哪些波段。C919 实际有 FM/MW/SW/LW/AIR/CB/VHF/UHF/WB 这些。

---

## 6. 对 PC 端（扫频和瀑布图）的意义

- **可以直接设频率**（`AB 06 10`），不用一下一下模拟按键 → 扫频速度主要看收音机锁台和回报的速度。
- **信号强度可以直接从状态帧读**：`AB 03 03`（RSSI/SNR 数值），或者 0x1C field 06/08 的文字。不必用 line-in 的音频电平去估。
- 建议的扫频流程：`set_freq(K)` → 等 `AB 09 01` 回报的频率等于 K → 再等 50–200 ms 让 AGC 稳定 → 读最新的 RSSI/SNR → 下一个点。
- ⚠️ RSSI/SNR 推送的频率、换台后多久才更新，都得实测。

## 7. 未知点和风险清单

1. 服务 UUID 没写死，只能按特征 UUID 找，这一点不影响使用。
2. 频率原始值 K 的单位，只能靠显示公式推断，每个波段都需要标定。
3. 带宽数值（0x04 帧 b9–b10）的单位不明。
4. 0x22、0x28、0x20、0x21 这几个按键码 App 没用，在 C919 上的效果不确定。
5. 帧的分包：App 默认一帧一包。长文字帧（0x1C）要是超过 20 字节，会用 seg 分段发，所以协议本身已经避开了 MTU 限制。
6. 这个 App 版本是 1.1.9（2023-12）。用户已经逆向出来的按键表可以拿来对照；如果有不一致，以抓包为准。
7. 时间同步（0x0D）和闹钟（0x0E）是 C919 菜单里有的功能，但 App 是通用的，C919 是否全部支持还需要验证。
