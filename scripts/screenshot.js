// 开发用：在无显示器的机器上（xvfb）用模拟收音机 + 振荡器测试信号启动界面，截一张图。
// 用法：npm run screenshot [-- 输出路径]   需要先装 xvfb（xvfb-run）。
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const out = path.resolve(process.argv[2] || path.join(__dirname, '..', '..', 'electron_preview.png'));
const electron = require('electron'); // 在 node 里 require('electron') 得到的是可执行文件路径
const r = spawnSync('xvfb-run', ['-a', '-s', '-screen 0 1400x880x24', electron, '--no-sandbox', '--disable-gpu', path.join(__dirname, '..')], {
  stdio: ['ignore', 'ignore', 'inherit'],
  env: { ...process.env, C919_MOCK: '1', C919_FAKE_AUDIO: '1', C919_SCREENSHOT: out,
    C919_SCREENSHOT_DELAY: process.env.C919_SCREENSHOT_DELAY || '15000', C919_LOG: process.env.C919_LOG || '/tmp/c919_screenshot_rx.log' },
});
console.log(r.status === 0 ? `截图已保存：${out}` : `截图失败，退出码 ${r.status}`);
