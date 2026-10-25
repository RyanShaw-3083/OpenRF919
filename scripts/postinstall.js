// npm install 之后自动执行：把 noble 依赖的原生模块（bluetooth-hci-socket）
// 按 Electron 的 Node ABI 重新编译。系统 node 和 Electron 内置的 node 版本不同，
// 不重编的话 Electron 里 require 会报 "was compiled against a different Node.js version"。
// 失败不致命：模拟模式（C919_MOCK=1）和音频频谱不依赖 noble。
const { spawnSync } = require('node:child_process');
const path = require('node:path');
let hasNoble = true;
try { require.resolve('@abandonware/noble'); } catch { hasNoble = false; }
if (!hasNoble) {
  console.log('[postinstall] 没装上 @abandonware/noble（可选依赖），跳过重编。只能用模拟模式。');
  process.exit(0);
}
const bin = path.join(__dirname, '..', 'node_modules', '.bin', 'electron-rebuild');
const r = spawnSync(bin, ['-f', '-w', '@abandonware/bluetooth-hci-socket'], { stdio: 'inherit' });
if (r.status !== 0) {
  console.warn('[postinstall] electron-rebuild 失败（见上面的输出）。真机 BLE 可能用不了，可稍后手动 npm run rebuild。');
}
