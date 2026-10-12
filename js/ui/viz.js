/* [viz.js] source: Pro.html 3770-3791（顶栏频谱可视化 rAF 循环） */
import { actx, A } from '../core/state.js';
import { UI } from '../core/util.js';

/* ---------- 顶栏频谱可视化 ----------
   这是一条**按需 rAF 循环**：只有在"有 AnalyserNode（音频已启动）且正在播放"时才跑。
   --------------------------------------------------------------------------
   实测（headless Edge / 5 秒空闲）主线程忙时 700ms ≈ 单核 17.4%；把那两条常驻 rAF 循环
   全停掉后掉到 36ms（0.9%）—— 也就是"页面静止却仍以 60fps 重画 + 重合成 1.5 万个时间线
   元素"，正是任务管理器里那 20~30% CPU 的来源。因此这里改掉三件事：
     1) 不再常驻：停止态只画一帧静止的底噪（vizIdle），然后退出循环；
     2) 不再每帧 `new Uint8Array(...)`（60Hz 垃圾分配），改为复用一块缓冲；
     3) 不再每帧 40 次 `fillStyle` 赋值（每次都要重新解析颜色串），改成单色一次赋值；
        另外页面进后台（document.hidden）时整帧跳过。
   频谱条数 40→32：顶栏画布只有 120×30，40 条已经是亚像素宽，视觉上无差别。 */
const BARS = 32;
let _freqBuf = null, _bars = null, _bufFor = 0, _vizOn = false;

function drawIdle(g, W, H) {
  g.clearRect(0, 0, W, H);
  g.fillStyle = 'rgba(90,150,255,.25)';
  const bw = W / BARS;
  for (let i = 0; i < BARS; i++) {
    const h = 2 + Math.sin(i * .7) * 1.5;
    g.fillRect(i * bw, H - h, 2, h);
  }
}
/* 点火：进入频谱动画（由 audio/master.js 在 ensureAudio 成功后调用） */
export function wakeViz() {
  if (_vizOn) return;
  const cv = UI.viz; if (!cv) return;
  if (typeof document !== 'undefined' && document.hidden) return;
  _vizOn = true;
  requestAnimationFrame(vizLoop);
}
export function vizLoop() {
  const cv = UI.viz;
  const an = actx && A && A.an;
  if (!cv) { _vizOn = false; return; }
  // 音频没起来 / 页面在后台 → 画一帧静止底噪就退出，不再续期
  if (!an || (typeof document !== 'undefined' && document.hidden)) {
    _vizOn = false;
    const g0 = cv.getContext('2d');
    if (g0) drawIdle(g0, cv.width, cv.height);
    return;
  }
  requestAnimationFrame(vizLoop);
  const g = cv.getContext('2d'); if (!g) { _vizOn = false; return; }
  const W = cv.width, H = cv.height;
  const n = an.frequencyBinCount;
  if (!_freqBuf || _bufFor !== n) { _freqBuf = new Uint8Array(n); _bufFor = n; }  // 复用，不每帧分配
  an.getByteFrequencyData(_freqBuf);
  if (!_bars || _bars.length !== BARS) _bars = new Float32Array(BARS);
  const step = Math.max(1, Math.floor(_freqBuf.length * .7 / BARS));
  let max = 1;
  for (let i = 0; i < BARS; i++) {
    let v = 0; for (let j = 0; j < step; j++) v += _freqBuf[i * step + j];
    v /= step;
    if (v > max) max = v;
    _bars[i] = v;
  }
  g.clearRect(0, 0, W, H);
  g.fillStyle = 'rgba(24,209,255,.85)';          // 单色：原来逐条 hsl() + Math.random() 没有必要
  const bw = W / BARS;
  for (let i = 0; i < BARS; i++) {
    const h = Math.max(1, _bars[i] / max * H);
    g.fillRect(i * bw, H - h, Math.max(1, bw - 1), h);
  }
}
