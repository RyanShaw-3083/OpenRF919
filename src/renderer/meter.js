'use strict';
/**
 * meter.js —— 底部横向 VU + 峰值表（看【原始】声卡输入电平，用来调声卡输入增益）
 * ===========================================================================
 * 电平都是 dBFS（0 = 满量程）。
 *   - RMS 条：功率按 300ms 时间常数做指数平滑（接近 VU 表的 300ms 积分时间）
 *   - 快速峰值：瞬时起音，150ms 时间常数回落（条上浅色部分）
 *   - 峰值保持：竖线，保持 1.5 秒，然后以 20 dB/秒 下落
 *   - 削波：任一样本 |x| ≥ 0.999（≈ -0.01 dBFS）就点亮，锁存 2 秒；点一下立即复位
 * 色区：< -18 绿，-18 ~ -6 黄，> -6 红。
 * 推荐电平：说话 / 音乐时 RMS 在 -24 ~ -12，峰值不超过 -6，削波灯从来不亮。
 */
(function () {
  const DB_MIN = -60, DB_MAX = 0;
  const TICKS = [-60, -48, -40, -36, -30, -24, -18, -12, -9, -6, -3, 0];
  const LABELED = new Set([-60, -48, -36, -24, -18, -12, -6, -3, 0]);
  const CLIP_LIN = 0.999;
  const toDb = (lin) => (lin > 0 ? 20 * Math.log10(lin) : -Infinity);

  class LevelMeter {
    constructor(canvas, clipEl, readEl) {
      this.c = canvas; this.x = canvas.getContext('2d');
      this.clipEl = clipEl; this.readEl = readEl;
      this.ch = []; // 每声道 {ms, fast, hold, holdT}
      this.clipUntil = 0; this.clipCount = 0;
      clipEl.addEventListener('click', () => { this.clipUntil = 0; this.clipCount = 0; this._clipUi(performance.now()); });
      new ResizeObserver(() => this._resize()).observe(canvas);
      this._resize();
    }

    _resize() {
      const dpr = window.devicePixelRatio || 1;
      const w = Math.max(1, Math.round(this.c.clientWidth * dpr)), h = Math.max(1, Math.round(this.c.clientHeight * dpr));
      if (this.c.width !== w || this.c.height !== h) { this.c.width = w; this.c.height = h; }
    }

    /** m = engine.readMeters() 的 inp 数组；dt 秒；now = performance.now() */
    update(inp, dt, now) {
      if (!inp) { this.ch = []; this.draw(now); return; }
      const aRms = 1 - Math.exp(-dt / 0.3), aFast = 1 - Math.exp(-dt / 0.15);
      while (this.ch.length < inp.length) this.ch.push({ ms: 0, fast: 0, hold: -Infinity, holdT: 0 });
      this.ch.length = inp.length;
      inp.forEach((s, i) => {
        const c = this.ch[i];
        c.ms += (s.ms - c.ms) * aRms;
        c.fast = s.peak >= c.fast ? s.peak : c.fast + (s.peak - c.fast) * aFast;
        const pDb = toDb(s.peak);
        if (pDb >= c.hold) { c.hold = pDb; c.holdT = now; } else if (now - c.holdT > 1500) c.hold = Math.max(pDb, c.hold - 20 * dt);
        if (s.peak >= CLIP_LIN) { this.clipUntil = now + 2000; this.clipCount++; }
      });
      this.draw(now);
    }

    levels() {
      return this.ch.map((c) => ({ rms: 10 * Math.log10(c.ms + 1e-12), peak: toDb(c.fast), hold: c.hold }));
    }

    _clipUi(now) {
      const on = now < this.clipUntil;
      this.clipEl.classList.toggle('on', on);
      this.clipEl.title = `削波指示：样本 ≥ -0.01 dBFS 时点亮，锁存 2 秒，点击复位。本次累计 ${this.clipCount} 帧削波`;
    }

    draw(now) {
      const c = this.x, W = this.c.width, H = this.c.height, dpr = window.devicePixelRatio || 1;
      c.fillStyle = '#0d0d0d'; c.fillRect(0, 0, W, H);
      const padL = 18 * dpr, padR = 6 * dpr, scaleH = 12 * dpr;
      const bw = W - padL - padR;
      const xOf = (db) => padL + bw * (Math.max(DB_MIN, Math.min(DB_MAX, db)) - DB_MIN) / (DB_MAX - DB_MIN);
      const n = Math.max(1, this.ch.length);
      const gap = 2 * dpr, barH = Math.max(3 * dpr, (H - scaleH - gap * (n + 1)) / n);
      // 色区底色（暗）
      const zones = [[DB_MIN, -18, '#4ec94e'], [-18, -6, '#e6b422'], [-6, DB_MAX, '#e05050']];
      for (let i = 0; i < n; i++) {
        const y = gap + i * (barH + gap);
        for (const [a, b, col] of zones) { c.globalAlpha = 0.13; c.fillStyle = col; c.fillRect(xOf(a), y, xOf(b) - xOf(a), barH); }
        c.globalAlpha = 1;
        const ch = this.ch[i];
        if (ch) {
          const rms = 10 * Math.log10(ch.ms + 1e-12), fast = toDb(ch.fast);
          // 快速峰值（浅）
          for (const [a, b, col] of zones) {
            const e = Math.min(b, fast); if (e <= a) continue;
            c.globalAlpha = 0.35; c.fillStyle = col; c.fillRect(xOf(a), y, xOf(e) - xOf(a), barH);
          }
          // RMS（实）
          c.globalAlpha = 1;
          for (const [a, b, col] of zones) {
            const e = Math.min(b, rms); if (e <= a) continue;
            c.fillStyle = col; c.fillRect(xOf(a), y, xOf(e) - xOf(a), barH);
          }
          // 峰值保持线
          if (ch.hold > DB_MIN) {
            const hx = Math.round(xOf(ch.hold));
            c.fillStyle = ch.hold > -6 ? '#ff8080' : '#ffffff'; c.fillRect(hx - dpr, y, 2 * dpr, barH);
          }
        }
        if (n > 1) { c.fillStyle = '#888'; c.font = `${9 * dpr}px monospace`; c.fillText(i ? 'R' : 'L', 4 * dpr, y + barH - 1); }
      }
      // 刻度
      c.font = `${9 * dpr}px monospace`; c.textBaseline = 'bottom';
      for (const t of TICKS) {
        const x = Math.round(xOf(t)) + 0.5;
        c.fillStyle = '#555'; c.fillRect(x, H - scaleH, 1, 3 * dpr);
        if (LABELED.has(t)) {
          c.fillStyle = t > -6 ? '#e07070' : t > -18 ? '#c8a040' : '#7a8a9a';
          const s = `${t}`; const tw = c.measureText(s).width;
          c.fillText(s, Math.min(W - tw - 1, Math.max(0, x - tw / 2)), H);
        }
      }
      this._clipUi(now);
      if (this.readEl) {
        if (!this.ch.length) this.readEl.textContent = 'RMS --  峰 --';
        else {
          const lv = this.levels();
          const f = (v) => (Number.isFinite(v) && v > -99 ? v.toFixed(1).padStart(5) : '  -∞ ');
          const rms = Math.max(...lv.map((l) => l.rms)), pk = Math.max(...lv.map((l) => l.hold));
          this.readEl.textContent = `RMS ${f(rms)}  峰 ${f(pk)}`;
        }
      }
    }
  }

  window.LevelMeter = LevelMeter;
})();
