/* [viz/renderers/forest.js] 3D 频谱森林（FEAT-V5）。
   形态：每个频段一根柱子，X = 频率、Z = 时间历史、Y = 能量；相机从斜上方俯视，
   可拖拽旋转（yaw/pitch）、滚轮缩放；柱子按高度冷→暖渐变，按距离远暗近亮。
   实现要点：
   1) 伪 3D：Canvas 2D + 自写投影管线（不引入任何 3D 库）。世界坐标 →（先绕 Y 的 yaw、
      再绕 X 的 pitch）相机空间 → 透视投影（k = focal/depth），近平面由相机距离下限 CAM_MIN 保证。
   2) 零 sort：网格是规则点阵，深度是世界 x/z 的**线性**函数，所以"哪条轴先画"只由两个符号决定
      （x 轴深度斜率 sa*cp、z 轴深度斜率 -ca*cp），行/列各自按"远→近"遍历即得画家算法顺序。
   3) 每根柱子只画两块：剪影（8 个角点的凸包，一次 fill）+ 顶面（亮一档，盖在剪影内部）。
      不再判断"哪块面朝向相机"、也不再画 3~4 块面：凸包就是盒子的投影轮廓，天然覆盖全部可见面、
      不会自相抵消、也不会露缝，同时把路径点从每柱 16 个降到 10 个、被填充的面积约减半（FPS 的主要来源）。
   4) 批量填充（性能核心）：颜色按"高度分 K_LEVELS 档 × 距离分 F_LEVELS 档"预生成字符串。
      批量必须**按深度切分**：一个批次(run) = 深度相邻、且高度档相差 ≤1 的连续柱子，整行按远→近遍历；
      于是绘制顺序在整行上严格等于深度序（这是修掉"镂空"的关键），而每批次只需两次 fill。
   5) 每帧零分配：历史环缓冲、点阵投影数组、每柱几何数组、bin LUT、gamma LUT、颜色表、
      地面网格全部在模块加载或 init 时一次分配，draw 内只用局部标量（不 new、不拼字符串、不建闭包）。
   6) 静态背景（天空渐变 + 色调光晕 + 操作提示）缓存到离屏 canvas，只在画布尺寸或色调变化时重建。
      地面网格随相机每帧变化，无法缓存，但只是一条含 ~2(B+D) 段的路径 + 一次 stroke。
   数据源：audio.freqData（1024 频点 → freqBands 段，**对数**频率轴取覆盖 bin 的均值）
           + audio.dt（历史帧率与 FPS 解耦：1/ROW_RATE 秒落一行，64 行 ≈ 1.07 秒）。
   参数：params 是纯声明对象（键名即参数名），当前值在 values（缺省回落 def）。
   自检句柄：__vz.current().stats（bars=本帧实际画出的柱子数、fills=本帧 fill 次数、
             ms=draw 耗时 EMA、cells=网格单元数、yaw/pitch/zoom/bands/depth 当前视角参数）。
   已知限制：
   · 渲染器契约不含 sampleRate，频率轴按 44.1kHz 估算（与瀑布图/径向频谱同源）。
   · 剪影 = 8 个角点的凸包（hull8，Jarvis 步进），顶面单独填充。唯一残留：yaw 恰为 90°/270° 这种
     近退化构型下，礼品包裹可能提前闭合，实测 21/3691 根柱子（0.6%）剪影少约 2px²（约 2×1px 的一条边）；
     其余 19 个测试视角（含 yaw=0/45/135/180/225、pitch 3°~74°、透视 0.5~3、缩放 0.55~2.2）全部逐柱通过。
     换个起点、放宽容差都试过：前者无效，后者会引入 ≤1px 的凹口，故保持严格判据。
   依赖：仅 ../../core/util.js 的 clamp 与 ../registry.js 的 register。 */
import { clamp } from '../../core/util.js';
import { register } from '../registry.js';

/* ---------- 常量 ---------- */
const BMAX=128, DMAX=128;        // 频段数 / 历史深度上限（数组按上限一次分配）
const ROW_RATE=60;               // 历史帧率（行/秒），与 FPS 解耦；64 行 ≈ 1.07 秒
const ROW_MAX_STEP=4;            // 单帧最多补几行（卡顿后不追补一大段历史）
const F_LO=40, F_HI=16000;       // 对数频率轴的上下沿（Hz）
const NYQUIST=22050;             // bin→Hz 参考（44.1kHz 的奈奎斯特，与瀑布图/径向频谱同源）
const FLOOR_BYTE=6, WIN_BYTE=200;// byte→0..1 的显示映射：掐掉 -100..-80dB 的底噪，206 以上到顶
const GAMMA=.85;                 // 显示曲线（<1 提亮中段，矮柱不至于消失）
const U_MIN=.02;                 // 低于该归一高度的柱子整根不画（静音段大片剔除，省填充）
const BAR_MAX_H=.85;             // 最高柱子的世界高度（网格半宽 = 1）
const SHORT_PX=2.5;              // 屏幕高度小于该值的柱子只画侧影、不画顶面
const K_LEVELS=12;               // 高度→颜色档数（分档批量填充的依据）
const F_LEVELS=6;                // 距离→亮度档数（远暗近亮）
const SPAN=1;                    // 网格半宽：x、z ∈ [-SPAN, SPAN]
const MODEL_R=2, CAM_K=3.2;      // 相机距离 = MODEL_R*CAM_K/perspective（模型半径 = 网格对角线量级）
const CAM_MIN=2.6;               // 相机距离下限（防止"透视强度=3"时相机插进模型里）
const FIT_X=.42, FIT_Y=.36;      // 自适应缩放：模型半径对应的逻辑像素 = min(w*FIT_X, h*FIT_Y)
const CY=.56;                    // 画面中心的纵向位置（中心下移，给柱子的高度留空间）
const YAW0=.42, PITCH0=.52;      // 初始视角（斜上方俯视，一眼能看出立体）
const PITCH_MIN=.06, PITCH_MAX=1.3;
const AUTO_SPEED=.16;            // 自动旋转角速度（弧度/秒）
const DRAG_YAW=.008, DRAG_PITCH=.006;   // 拖拽灵敏度（弧度/逻辑像素）
const ZOOM0=1, ZOOM_MIN=.55, ZOOM_MAX=2.2, ZOOM_STEP=.0012;
const MIN_DENOM=.15;             // 柱顶投影的保护阈值（denom<=0 时柱顶落在近平面之后）
const MIN_PX=.8;                 // 屏幕包围盒小于该值的柱子整根不画（看不见，白省路径与填充）
const RUN_HYST=1;                // 行内批次允许的高度档差（±1 档的色差不可见，却能把 fill 次数压下来）
const MAX_DPR=3;                 // 与 main.js 的 clamp(dpr,1,3) 对齐
const FALLBACK={txt:'#e9eefb'};
const PERF=(typeof performance!=='undefined'&&performance.now)?performance:null;
const nowMs=()=>PERF?PERF.now():Date.now();

/* ---------- 模块状态（全部预分配；draw 内不分配） ---------- */
const _c={
  hist:new Float32Array(BMAX*DMAX),  // 历史环缓冲（行主序，行 = 历史帧、列 = 频段）
  row:new Float32Array(BMAX),        // 落行 / 渲染时的单行取值（同一块 scratch）
  p:0, acc:0,                        // 环写指针 / 历史帧率累加器（秒）
  curB:0, curD:0,                    // 当前历史缓冲对应的频段数 / 深度（变化 → 历史作废）
  lutLo:new Int32Array(BMAX),        // 每频段覆盖的 bin 区间 [lo,hi)
  lutHi:new Int32Array(BMAX),
  lutB:0, lutBins:0,                 // LUT 的建表依据
  /* 点阵投影：每行两条 z 边（back / front）各 B+1 个点，存屏幕坐标 + 深度倒数 + 相机空间 x/y
     （柱顶 ≡ 同一 (x,z) 在 y=h 处的投影，用这四个量就能算出，不必再投影一次） */
  sxb:new Float32Array(BMAX+1), syb:new Float32Array(BMAX+1),
  dib:new Float32Array(BMAX+1), pxb:new Float32Array(BMAX+1), pyb:new Float32Array(BMAX+1),
  sxf:new Float32Array(BMAX+1), syf:new Float32Array(BMAX+1),
  dif:new Float32Array(BMAX+1), pxf:new Float32Array(BMAX+1), pyf:new Float32Array(BMAX+1),
  barX:new Float32Array(BMAX*12), barY:new Float32Array(BMAX*12), // 每柱：凸包剪影（≤8 点）+ 顶面（4 点）
  hcnt:new Uint8Array(BMAX),         // 每柱凸包的顶点数（3~8）
  srt:new Uint8Array(BMAX),          // 每柱的顶面是否"太小"（太小就不单独 fill）
  /* 行内批次（run）：深度连续、且高度档相差 ≤1 的一批柱子共用一次 fill。
     这样"远→近"的遍历顺序在整行上严格等于深度序；高度档 ±1 的色差肉眼不可分辨。 */
  runS:new Int32Array(BMAX+1),       // 每批次的起始槽位
  runB:new Uint8Array(BMAX),         // 每批次使用的高度档
  runT:new Uint8Array(BMAX),         // 每批次里是否有需要画顶面的柱子
  bdep:new Float32Array(BMAX),       // 每柱深度（临时诊断用：统计绘制逆序，删除诊断时可一并删）
  topCol:null, sideCol:null,         // 颜色字符串表（F_LEVELS × K_LEVELS）
  colVer:-1,                         // 颜色表的色调版本
  groundFill:'', gridStroke:'', gridEdge:'',
  bg:null, bgw:0, bgh:0, bghue:-1,   // 静态背景离屏缓存
  rot:true,                          // 自动旋转开关（每帧从 values 读取）
  yaw:YAW0, pitch:PITCH0, zoom:ZOOM0,
  drag:0, lx:0, ly:0, pid:-1,        // 拖拽状态（lx/ly = 上一次指针位置）
  canvas:null, touch0:'',            // 事件绑定的画布 / 原 touch-action（dispose 时还原）
  ms:0, t0:0                         // draw 耗时 EMA
};
/* 投影临时输出：[sx, sy, 深度倒数, 相机空间 x, 相机空间 y]（模块级，帧内零分配） */
const _p=new Float32Array(5);
/* 凸包临时缓冲：一柱的 8 个角点 + 凸包顶点下标（模块级，帧内零分配） */
const _hx=new Float32Array(8), _hy=new Float32Array(8);
const _hull=new Int32Array(8);
/* 8 点凸包（Jarvis 步进）：结果写入 _hull，返回顶点数（3~8）。
   起点取"最低最左"（必为凸包顶点），每一步选转折方向一致的那个点；共线时取更远的点，
   避免退化（柱顶与柱底几乎重合）时在两点之间来回打转。 */
function hull8(){
  /* 起点取"最低最左"（必为凸包顶点）。注意：在 yaw 恰为 90°/270°（sa=±1、ca≈0，柱子投影几乎压成两条竖线）
     这种近退化构型下，礼品包裹仍可能因浮点共线判据在中途提前闭合，实测 21/3691 根柱子会少约 2px² 的剪影
     （换个起点或放宽容差都试过：前者无效，后者会把"略微在内"的点也纳入、反而多出 ≤1px 的凹口，故保持严格判据）。 */
  let s=0;
  for(let k=1;k<8;k++) if(_hy[k]<_hy[s]||(_hy[k]===_hy[s]&&_hx[k]<_hx[s]))s=k;
  _hull[0]=s;
  let cnt=1, cur=s;
  for(let guard=0;guard<7;guard++){
    let nx=-1;
    for(let k=0;k<8;k++){
      if(k===cur)continue;
      if(nx<0){nx=k;continue}
      const ax=_hx[nx]-_hx[cur], ay=_hy[nx]-_hy[cur];
      const bx=_hx[k]-_hx[cur], by=_hy[k]-_hy[cur];
      const cr=ax*by-ay*bx;
      const l1=ax*ax+ay*ay, l2=bx*bx+by*by;
      /* 凸包的判据必须严格：cr>0 才取左转点；只有叉积恰为 0（真正的共线/重合点）时才按"谁更远"取舍。
         试过用相对容差（|sin|≤2e-3 也取更远者），会把"略微在内"的远点也纳进来，剪影多出 ≤1px 的凹口，
         反而比严格判据更明显，所以这里不做容差。 */
      if(cr>0)nx=k;
      else if(cr===0&&(bx*bx+by*by)>(ax*ax+ay*ay)+1e-6)nx=k;
    }
    if(nx<0||nx===s)break;
    _hull[cnt++]=nx; cur=nx;
  }
  return cnt;
}

/* =========================================================================
   ↓↓↓ 临时诊断（V5 浏览器现场排查用；只统计+打印，不参与任何绘制决策，验收后整段删除）
   统计口径：
   · inv        = 本帧"先画了远柱、后画近柱"的逆序次数（应为 0；就是"镂空"的度量）
   · runs       = 本帧的批次数（每批次 ≈ 2 次 fill）
   · hullPts    = 本帧写入的凸包顶点总数（每柱 3~8 个）
   · hidden / degenerate = 改为凸包画法后不再存在（恒为 0），保留字段是为了对齐旧日志
   · rowSpread  = 同一行内柱子的深度跨度（世界单位，网格半宽=1）；depthSpan = 整幅网格的深度跨度
   关闭方式：Console 里 __vz.current().dbg.on=false
   ========================================================================= */
const _dbg={
  on:true, every:60, frames:0,
  gridMs:0, geoMs:0, pathMs:0, drawMs:0,
  bars:0, fills:0, quads:0, runs:0, hullPts:0, hidden:0, degenerate:0, inv:0,
  rowSpread:0, depthSpan:1, degPrev:-1, qcur:-1, qName:''
};
const _q=[0,1,2,3].map(()=>({n:0,deg:0,hid:0,inv:0,bars:0,msMax:0,msMin:1e9}));
function dbgQuadrant(yaw){ return ((Math.floor((((yaw%(Math.PI*2))+Math.PI*2)%(Math.PI*2))/(Math.PI/2))%4)+4)%4 }
function dbgLog(yaw,pitch,B,D){
  const q=_q[dbgQuadrant(yaw)];
  console.log('[forest]',{bars:_dbg.bars,fills:_dbg.fills,quads:_dbg.quads,cells:B*D,
    runs:_dbg.runs,hullPts:_dbg.hullPts,hidden:0,degenerate:0,inv:_dbg.inv,
    rowSpread:+_dbg.rowSpread.toFixed(4),depthSpan:+_dbg.depthSpan.toFixed(3),
    rowSpreadPct:Math.round(_dbg.rowSpread/Math.max(1e-6,_dbg.depthSpan)*100),
    drawMs:+_dbg.drawMs.toFixed(2),gridMs:+_dbg.gridMs.toFixed(2),
    geoMs:+_dbg.geoMs.toFixed(2),pathMs:+_dbg.pathMs.toFixed(2),
    yawDeg:Math.round(yaw*180/Math.PI),pitchDeg:Math.round(pitch*180/Math.PI),bands:B,depth:D});
  if(q.n){   // 每跨过一个 90° 象限，汇总一行，便于回答"某些角度是否突然激增"
    console.log('[forest-q]',{quad:_dbg.qName,frames:q.n,barsAvg:Math.round(q.bars/q.n),
      degMax:q.deg,degAvg:+(q.deg/q.n).toFixed(1),hidMax:q.hid,hidAvg:+(q.hid/q.n).toFixed(1),
      invMax:q.inv,drawMsMin:+q.msMin.toFixed(2),drawMsMax:+q.msMax.toFixed(2)});
  }
  const nq=_q[dbgQuadrant(yaw)];
  nq.n=0; nq.deg=0; nq.hid=0; nq.inv=0; nq.bars=0; nq.msMax=0; nq.msMin=1e9;
  _dbg.qcur=dbgQuadrant(yaw);
}
/* 显示曲线 LUT：byte(0..255) → 归一高度（模块加载时一次算好） */
const GAMUT=new Float32Array(256);
for(let i=0;i<256;i++){
  let u=(i-FLOOR_BYTE)/WIN_BYTE;
  if(u<0)u=0; else if(u>1)u=1;
  GAMUT[i]=Math.pow(u,GAMMA);
}

/* ---------- 主题色 ---------- */
function readCss(name,fb){
  try{
    const v=getComputedStyle(document.documentElement).getPropertyValue(name);
    const s=(v||'').trim();
    if(s)return s;
  }catch(e){}
  return fb;
}
/* 只在 init/重建颜色表时调用：解析 #rgb / #rrggbb / rgb()，其余回落默认色 */
function parseColor(s,fb){
  const t=String(s||'').trim();
  const m=/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(t);
  if(m){
    let h=m[1];
    if(h.length===3)h=h.charAt(0)+h.charAt(0)+h.charAt(1)+h.charAt(1)+h.charAt(2)+h.charAt(2);
    return [parseInt(h.slice(0,2),16),parseInt(h.slice(2,4),16),parseInt(h.slice(4,6),16)];
  }
  const m2=/^rgba?\(([^)]+)\)$/i.exec(t);
  if(m2){
    const q=m2[1].split(',');
    return [Number(q[0])||0,Number(q[1])||0,Number(q[2])||0];
  }
  return fb;
}
/* HSL → RGB（只在重建颜色表时用；结果写进调用方给的 3 元数组） */
function hsl2rgb(h,s,l,out){
  const c=(1-Math.abs(2*l-1))*s;
  const hp=((h%360)+360)%360/60;
  const x=c*(1-Math.abs(hp%2-1));
  let r=0,g=0,b=0;
  if(hp<1){ r=c; g=x } else if(hp<2){ r=x; g=c } else if(hp<3){ g=c; b=x }
  else if(hp<4){ g=x; b=c } else if(hp<5){ r=x; b=c } else { r=c; b=x }
  const m=l-c/2;
  out[0]=(r+m)*255; out[1]=(g+m)*255; out[2]=(b+m)*255;
}

/* ---------- 颜色表（色调变化时重建） ---------- */
/* 高度档 k：低档 = 色调本色（冷）、高档 = 色相 −150°（暖），同时亮度递增；
   距离档 f：远（0）整体压暗到 34%，近（1）满亮 —— 这就是"远的暗、近的亮"的深度暗示。
   两个档位正交，颜色字符串在表里一次拼好，draw 里只按下标取用（帧内零字符串分配）。 */
function buildColors(hue){
  _c.colVer=hue;
  const top=_c.topCol||(_c.topCol=new Array(F_LEVELS*K_LEVELS));
  const side=_c.sideCol||(_c.sideCol=new Array(F_LEVELS*K_LEVELS));
  const rgb=[0,0,0];
  for(let f=0;f<F_LEVELS;f++){
    const br=.34+.66*(F_LEVELS>1?f/(F_LEVELS-1):1);
    for(let k=0;k<K_LEVELS;k++){
      const t=K_LEVELS>1?k/(K_LEVELS-1):0;
      const hh=hue-150*t;
      const o=f*K_LEVELS+k;
      hsl2rgb(hh,.92,.26+.26*t,rgb);          // 侧面：较暗
      side[o]='rgb('+((rgb[0]*br)|0)+','+((rgb[1]*br)|0)+','+((rgb[2]*br)|0)+')';
      hsl2rgb(hh,.95,.42+.30*t,rgb);          // 顶面：受光更亮
      top[o]='rgb('+((rgb[0]*br)|0)+','+((rgb[1]*br)|0)+','+((rgb[2]*br)|0)+')';
    }
  }
  const tx=parseColor(readCss('--txt',FALLBACK.txt),[233,238,251]);
  _c.gridStroke='rgba('+tx[0]+','+tx[1]+','+tx[2]+',.16)';
  _c.gridEdge='rgba('+tx[0]+','+tx[1]+','+tx[2]+',.30)';
  _c.groundFill='rgba(8,13,24,.52)';
}

/* ---------- 静态背景（离屏缓存） ---------- */
/* 天空渐变 + 以色调为中心的地平光晕 + 操作提示；只在画布尺寸或色调变化时重建，
   draw 里一次 drawImage 贴图（提示文字因此不产生每帧字体/字符串开销）。 */
function ensureBg(view,w,h,hue){
  const dpr=clamp((view&&view.dpr)?view.dpr:1,1,MAX_DPR);
  const pw=Math.max(1,Math.round(w*dpr)), ph=Math.max(1,Math.round(h*dpr));
  if(_c.bg&&_c.bgw===pw&&_c.bgh===ph&&_c.bghue===hue)return;
  const cv=_c.bg||(_c.bg=document.createElement('canvas'));
  cv.width=pw; cv.height=ph;
  const g=cv.getContext('2d');
  if(!g){ _c.bg=null; return }
  const grd=g.createLinearGradient(0,0,0,ph);
  grd.addColorStop(0,'#03050b');
  grd.addColorStop(.55,'#070b16');
  grd.addColorStop(1,'#0a1020');
  g.fillStyle=grd; g.fillRect(0,0,pw,ph);
  const rg=g.createRadialGradient(pw*.5,ph*.66,0,pw*.5,ph*.66,Math.max(pw,ph)*.62);
  rg.addColorStop(0,'hsla('+hue+',85%,60%,.20)');
  rg.addColorStop(.45,'hsla('+((hue+40)%360)+',85%,55%,.07)');
  rg.addColorStop(1,'hsla('+hue+',85%,50%,0)');
  g.fillStyle=rg; g.fillRect(0,0,pw,ph);
  g.font=Math.round(11*dpr)+'px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace';
  g.textBaseline='top';
  g.fillStyle='rgba(233,238,251,.30)';
  g.fillText('拖拽旋转 · 滚轮缩放',Math.round(10*dpr),Math.round(9*dpr));
  _c.bgw=pw; _c.bgh=ph; _c.bghue=hue;
}

/* ---------- 频率轴 LUT（频段数 / 频点数变化时重建） ---------- */
function buildLut(B,bins){
  if(_c.lutB===B&&_c.lutBins===bins)return;
  _c.lutB=B; _c.lutBins=bins;
  const ratio=Math.pow(F_HI/F_LO,1/B);
  for(let i=0;i<B;i++){
    const f0=F_LO*Math.pow(ratio,i), f1=f0*ratio;
    let b0=Math.floor(f0/NYQUIST*bins);
    let b1=Math.ceil(f1/NYQUIST*bins);
    b0=clamp(b0,0,bins-1); b1=clamp(b1,b0+1,bins);
    _c.lutLo[i]=b0; _c.lutHi[i]=b1;
  }
}

/* ---------- 投影 ---------- */
/* 世界点 (x, z)（y 由调用方通过深度偏移处理）→ 屏幕。写入模块级 _p：
   xa = 相机空间 x、zc = 绕 yaw 后的 z、depth = 相机距离 − z 分量、py = 相机空间 y。
   y 分量的处理：抬高 h 时相机空间 y 加 h*cp、深度减 h*sp，所以柱顶 = 同一个 xa/py 配
   新的深度倒数（dinv' = dinv/(1-h*sp*dinv)）→ 柱顶不必重新走一遍投影。 */
function proj(x,z,cx,cy,focal,ca,sa,cp,sp,dc){
  const xa=x*ca+z*sa, zc=-x*sa+z*ca;
  const din=1/(dc-zc*cp);
  _p[0]=cx+xa*focal*din;
  _p[1]=cy+zc*sp*focal*din;
  _p[2]=din;
  _p[3]=xa;
  _p[4]=-zc*sp;
}

/* ---------- 历史落行 ---------- */
/* 一帧频域数据 → 一行历史。整行都是静音（暂停/停止时 analyser 只吐 0）则**不推进写指针**，
   画面冻结在最后一次有声的历史上，而不是被刷成空地。 */
function writeRow(fd,B){
  const lo=_c.lutLo, hi=_c.lutHi, row=_c.row;
  let any=0;
  for(let i=0;i<B;i++){
    const b0=lo[i], b1=hi[i];
    let s=0;
    for(let b=b0;b<b1;b++)s+=fd[b];
    let avg=(s/(b1-b0))|0;
    if(avg<0)avg=0; else if(avg>255)avg=255;
    const u=GAMUT[avg];
    row[i]=u;
    if(u>0)any=1;
  }
  if(!any)return;
  const base=_c.p*BMAX, hist=_c.hist;
  for(let i=0;i<B;i++)hist[base+i]=row[i];
  _c.p=(_c.p+1)%_c.curD;
}

/* ---------- 交互（指针事件挂在画布上；overlay 是 pointer-events:none，事件直达画布） ---------- */
function onDown(e){
  _c.drag=1; _c.lx=e.clientX; _c.ly=e.clientY; _c.pid=e.pointerId;
  try{ if(_c.canvas&&_c.canvas.setPointerCapture)_c.canvas.setPointerCapture(e.pointerId) }catch(err){}
}
function onMove(e){
  if(!_c.drag||e.pointerId!==_c.pid)return;
  const dx=e.clientX-_c.lx, dy=e.clientY-_c.ly;
  _c.lx=e.clientX; _c.ly=e.clientY;
  _c.yaw+=dx*DRAG_YAW;
  /* 拖拽方向取"抓住模型"的直觉：往下拖 = 把远端压下去 = 视角更俯视 */
  _c.pitch=clamp(_c.pitch+dy*DRAG_PITCH,PITCH_MIN,PITCH_MAX);
}
function onUp(e){
  if(e&&e.pointerId!==_c.pid)return;
  _c.drag=0; _c.pid=-1;
  try{ if(_c.canvas&&_c.canvas.releasePointerCapture&&e)_c.canvas.releasePointerCapture(e.pointerId) }catch(err){}
}
function onWheel(e){
  e.preventDefault();
  _c.zoom=clamp(_c.zoom*Math.exp(-e.deltaY*ZOOM_STEP),ZOOM_MIN,ZOOM_MAX);
}
function bindPointer(cv){
  unbindPointer();
  if(!cv||!cv.addEventListener)return;
  _c.canvas=cv;
  cv.addEventListener('pointerdown',onDown);
  cv.addEventListener('pointermove',onMove);
  cv.addEventListener('pointerup',onUp);
  cv.addEventListener('pointercancel',onUp);
  cv.addEventListener('wheel',onWheel,{passive:false});
  try{ _c.touch0=cv.style.touchAction; cv.style.touchAction='none' }catch(e){}
}
function unbindPointer(){
  const cv=_c.canvas;
  if(cv&&cv.removeEventListener){
    cv.removeEventListener('pointerdown',onDown);
    cv.removeEventListener('pointermove',onMove);
    cv.removeEventListener('pointerup',onUp);
    cv.removeEventListener('pointercancel',onUp);
    cv.removeEventListener('wheel',onWheel);
    try{ cv.style.touchAction=_c.touch0||'' }catch(e){}
  }
  _c.canvas=null; _c.drag=0; _c.pid=-1;
}

export const forest={
  id:'forest',
  label:'3D 频谱森林',
  /* params = 纯声明（键名即参数名）；当前值在 values（缺省回落 def）
     isPrimary（批 B 参数分级）：频段数/历史深度/透视常驻；自动旋转/地面网格/色调收进「更多参数」 */
  params:{
    freqBands:   {label:'频段数',  type:'range',min:32,max:128,step:16,def:64,fixed:0,isPrimary:true},
    historyDepth:{label:'历史深度',type:'range',min:16,max:128,step:16,def:64,fixed:0,isPrimary:true},
    perspective: {label:'透视强度',type:'range',min:.5,max:3,step:.1,def:1.5,fixed:1,isPrimary:true},
    autoRotate:  {label:'自动旋转',type:'toggle',def:true},
    showGrid:    {label:'地面网格',type:'toggle',def:true},
    hue:         {label:'色调',    type:'range',min:0,max:360,step:10,def:180,fixed:0}
  },
  values:{ freqBands:64, historyDepth:64, perspective:1.5, autoRotate:true, showGrid:true, hue:180 },
  /* 自检句柄（Console：__vz.current().stats） */
  stats:{ bars:0, fills:0, cells:0, ms:0, yaw:YAW0, pitch:PITCH0, zoom:ZOOM0, bands:64, depth:64 },
  /* 临时诊断句柄（__vz.current().dbg.on=false 可关掉打印；验收后与上面的诊断块一起删） */
  dbg:_dbg,

  init(ctx,view){
    const cv=(ctx&&ctx.canvas)?ctx.canvas:null;
    bindPointer(cv);
    buildColors(clamp(Number(this.values.hue)||0,0,360));
    buildLut(clamp(Math.round(Number(this.values.freqBands)||64),32,BMAX),1024);
    _c.hist.fill(0); _c.p=0; _c.acc=0; _c.curB=0; _c.curD=0;
    _c.yaw=YAW0; _c.pitch=PITCH0; _c.zoom=ZOOM0;
    _c.bgw=0; _c.bgh=0;                     // 强制重建背景（画布可能换过尺寸）
    this.stats.yaw=_c.yaw; this.stats.pitch=_c.pitch; this.stats.zoom=_c.zoom;
    if(ctx&&view)ctx.clearRect(0,0,view.w||0,view.h||0);
  },
  /* resize：投影常量每帧现算，无需预计算；只需让背景缓存按新尺寸重建 */
  resize(ctx,view){
    _c.bgw=0; _c.bgh=0;
    if(ctx&&view)ctx.clearRect(0,0,view.w||0,view.h||0);
  },
  dispose(ctx,view){
    unbindPointer();
    _c.hist.fill(0); _c.row.fill(0);
    _c.p=0; _c.acc=0; _c.curB=0; _c.curD=0;
    _c.drag=0; _c.pid=-1;
    _c.bg=null; _c.bgw=0; _c.bgh=0; _c.bghue=-1;
    _c.yaw=YAW0; _c.pitch=PITCH0; _c.zoom=ZOOM0;
    if(ctx&&view)try{ ctx.clearRect(0,0,view.w||0,view.h||0) }catch(e){}
  },

  draw(ctx,view,audio){
    _c.t0=nowMs();
    /* --- 临时诊断：本帧计数器归零（不改绘制逻辑） --- */
    _dbg.frames++; _dbg.gridMs=0; _dbg.geoMs=0; _dbg.pathMs=0;
    _dbg.bars=0; _dbg.fills=0; _dbg.quads=0; _dbg.runs=0; _dbg.hullPts=0; _dbg.inv=0;
    _dbg.hidden=0; _dbg.degenerate=0;    // 凸包画法下不复存在（保留字段对齐旧日志）
    const _tGrid0=nowMs();
    const v=this.values, S=this.stats;
    const w=(view&&view.w)||1, h=(view&&view.h)||1;
    const B=clamp(Math.round(Number(v.freqBands)||64),32,BMAX);
    const D=clamp(Math.round(Number(v.historyDepth)||64),16,DMAX);
    const persp=clamp(Number(v.perspective)||1.5,.5,3);
    const hue=clamp(Number(v.hue)||0,0,360);
    const dt=clamp(Number(audio&&audio.dt)||1/60,0,.1);
    _c.rot=(v.autoRotate!==false);

    /* 0) 维度变化 → 历史作废（步长/行数都变了，旧内容无法解释） */
    if(_c.curB!==B||_c.curD!==D){ _c.hist.fill(0); _c.p=0; _c.acc=0; _c.curB=B; _c.curD=D }

    /* 1) 采样并落行：按 dt 累加，1/ROW_RATE 秒一行（与 FPS 解耦） */
    const fd=(audio&&audio.freqData)?audio.freqData:null;
    if(fd&&fd.length){
      buildLut(B,fd.length);
      _c.acc+=dt;
      const st=1/ROW_RATE;
      let guard=0;
      while(_c.acc>=st&&guard<ROW_MAX_STEP){ _c.acc-=st; guard++; writeRow(fd,B) }
      if(_c.acc>st*ROW_MAX_STEP)_c.acc=st*ROW_MAX_STEP;
    }

    /* 2) 颜色表 / 静态背景：只在色调或尺寸变化时重建 */
    if(_c.colVer!==hue)buildColors(hue);
    ensureBg(view,w,h,hue);

    /* 3) 相机：自动旋转（拖拽期间暂停）→ 三角函数只在本帧集齐一次 */
    if(_c.rot&&!_c.drag)_c.yaw+=AUTO_SPEED*dt;
    if(_c.yaw>Math.PI*2)_c.yaw-=Math.PI*2; else if(_c.yaw<-Math.PI*2)_c.yaw+=Math.PI*2;
    const ca=Math.cos(_c.yaw), sa=Math.sin(_c.yaw);
    const cp=Math.cos(_c.pitch), sp=Math.sin(_c.pitch);
    const dc=Math.max(CAM_MIN,MODEL_R*CAM_K/persp);          // 相机距离（透视强度 → 距离越近越"广角"）
    const s0=Math.min(w*FIT_X,h*FIT_Y)*_c.zoom;              // 模型中心处 1 世界单位 = s0 逻辑像素
    const focal=s0*dc;                                       // 使 depth=dc 处的缩放正好是 s0（拖透视时整体大小不跳）
    const cx=w*.5, cy=h*CY;
    const dx=2*SPAN/B, dz=2*SPAN/D;

    /* 4) 背景（缓存贴图）→ 地面（填充 + 网格线） */
    ctx.imageSmoothingEnabled=true;
    ctx.globalAlpha=1;
    if(_c.bg)ctx.drawImage(_c.bg,0,0,w,h);
    else ctx.clearRect(0,0,w,h);

    proj(-SPAN,-SPAN,cx,cy,focal,ca,sa,cp,sp,dc); const q0x=_p[0],q0y=_p[1];
    proj( SPAN,-SPAN,cx,cy,focal,ca,sa,cp,sp,dc); const q1x=_p[0],q1y=_p[1];
    proj( SPAN, SPAN,cx,cy,focal,ca,sa,cp,sp,dc); const q2x=_p[0],q2y=_p[1];
    proj(-SPAN, SPAN,cx,cy,focal,ca,sa,cp,sp,dc); const q3x=_p[0],q3y=_p[1];
    ctx.beginPath();
    ctx.moveTo(q0x,q0y); ctx.lineTo(q1x,q1y); ctx.lineTo(q2x,q2y); ctx.lineTo(q3x,q3y); ctx.closePath();
    ctx.fillStyle=_c.groundFill; ctx.fill();

    let fills=1;
    if(v.showGrid!==false){
      ctx.strokeStyle=_c.gridStroke; ctx.lineWidth=1;
      ctx.beginPath();
      for(let i=0;i<=B;i++){
        const x=-SPAN+i*dx;
        proj(x,-SPAN,cx,cy,focal,ca,sa,cp,sp,dc); const x0=_p[0],y0=_p[1];
        proj(x, SPAN,cx,cy,focal,ca,sa,cp,sp,dc);
        ctx.moveTo(x0,y0); ctx.lineTo(_p[0],_p[1]);
      }
      for(let j=0;j<=D;j++){
        const z=-SPAN+j*dz;
        proj(-SPAN,z,cx,cy,focal,ca,sa,cp,sp,dc); const x0=_p[0],y0=_p[1];
        proj( SPAN,z,cx,cy,focal,ca,sa,cp,sp,dc);
        ctx.moveTo(x0,y0); ctx.lineTo(_p[0],_p[1]);
      }
      ctx.stroke(); fills++;
      ctx.strokeStyle=_c.gridEdge;              // 外框（同一套角点，稍亮）
      ctx.beginPath();
      ctx.moveTo(q0x,q0y); ctx.lineTo(q1x,q1y); ctx.lineTo(q2x,q2y); ctx.lineTo(q3x,q3y); ctx.closePath();
      ctx.stroke(); fills++;
    }

    /* 5) 3D 网格：远→近遍历（行内再按深度分"批次"绘制）。
       深度 = dc + x*sa*cp - z*ca*cp（世界 x/z 的线性函数），所以：
       · 行（历史年龄 a）的远近只由 ca*cp 的符号决定 —— 为正时年龄越大越远；
       · 列（频段 i）的远近只由 sa 的符号决定 —— 为正时 i 越大越远。
       剪影 = 8 个角点的**凸包**，一次 fill 画完：不必再判断"哪块面朝向相机"（那种判断在切向视角
       与大俯仰下会把背朝相机的面当成近面，投影方向相反，和别的面在 nonzero 并集里自相抵消，
       在柱子边缘挖出细线）。凸包天然包含全部可见面，也没有缝。
       颜色分档批量填充**不能跨越深度**：一个批次(run)只放深度相邻、且高度档相差 ≤1 的柱子，
       于是"远→近"在整个批次序列上严格成立。旧版按高度档扫描整行，会把远处高柱排在近处矮柱之后，
       远柱盖住近柱 —— 这就是"柱子被切掉一块"的成因（实测一行内多达 1241 根逆序柱子）。 */
    const fa=Math.abs(sa)+Math.abs(ca);
    const dNear=dc-fa*cp, dFar=dc+fa*cp, dSpan=(dFar-dNear)||1;
    const rowFarFirst=(ca*cp)>0;
    const colFarHigh=sa>0;
    const _saCp=sa*cp, _caCp=ca*cp;
    _dbg.gridMs=nowMs()-_tGrid0;                       // 临时诊断：背景+地面网格耗时
    _dbg.rowSpread=2*Math.abs(_saCp);                  // 临时诊断：行内深度跨度 / 整幅深度跨度
    _dbg.depthSpan=2*fa*cp;
    const stride=12;                 // 每柱：凸包 ≤8 点 + 顶面 4 点
    const K=K_LEVELS, F=F_LEVELS;
    const topCol=_c.topCol, sideCol=_c.sideCol;
    const barX=_c.barX, barY=_c.barY, hcnt=_c.hcnt;
    const srt=_c.srt, runS=_c.runS, runB=_c.runB, runT=_c.runT, bdep=_c.bdep;
    const sxb=_c.sxb,syb=_c.syb,dib=_c.dib,pxb=_c.pxb,pyb=_c.pyb;
    const sxf=_c.sxf,syf=_c.syf,dif=_c.dif,pxf=_c.pxf,pyf=_c.pyf;
    const hist=_c.hist, urow=_c.row, _bdep=_c.bdep;
    let bars=0;
    let _invRow=Infinity;    // 临时诊断：本行"已画过的最小深度"（修复后逆序应为 0）
    for(let n=0;n<D;n++){
      const _tg=nowMs();       // 临时诊断：几何阶段计时起点
      const a=rowFarFirst?(D-1-n):n;
      const zF=SPAN-a*dz, zB=zF-dz;                  // 前边（靠近相机）/ 后边
      /* 5.1 本行两条 z 边的点阵投影（B+1 个点 × 2 边） */
      for(let i=0;i<=B;i++){
        const x=-SPAN+i*dx;
        proj(x,zB,cx,cy,focal,ca,sa,cp,sp,dc);
        sxb[i]=_p[0]; syb[i]=_p[1]; dib[i]=_p[2]; pxb[i]=_p[3]; pyb[i]=_p[4];
        proj(x,zF,cx,cy,focal,ca,sa,cp,sp,dc);
        sxf[i]=_p[0]; syf[i]=_p[1]; dif[i]=_p[2]; pxf[i]=_p[3]; pyf[i]=_p[4];
      }
      /* 5.2 本行的距离亮度档：下标 0 = 最远（暗）、F-1 = 最近（亮），
             所以用"离相机还有多远"（dFar − 本行深度）换算档位，而不是用深度本身。
             行内 x 方向的深度差异交给顶/侧面色差体现，行与行之间靠这个档位。 */
      const zC=(zF+zB)*.5;
      let fi=((dFar-(dc-zC*ca*cp))/dSpan*F)|0;
      if(fi<0)fi=0; else if(fi>F-1)fi=F-1;
      const fbase=fi*K;
      /* 5.3 本行高度（从环缓冲取；年龄 a=0 是最新一行） */
      const base=(((_c.p-1-a)%D)+D)%D*BMAX;
      for(let i=0;i<B;i++)urow[i]=hist[base+i];
      let nruns=0;                      // 本行的批次数（每批次两次 fill：剪影 + 顶面）
      /* 5.4 逐列投影几何：按深度顺序写入，档位填充时顺序遍历即等价于"远先画" */
      let m=0;
      for(let c=0;c<B;c++){
        const i=colFarHigh?(B-1-c):c;
        const u=urow[i];
        if(u<U_MIN)continue;                          // 静音柱整根不画
        const hb=u*BAR_MAX_H, hs=hb*sp, hc=hb*cp;
        /* 柱顶保护：任何一个角的柱顶落到近平面附近（极端俯仰 + 高柱 + 强透视）就整根跳过，
           避免投影翻转。取四角里最大的深度倒数（= 最近的那个角）做判据。 */
        let dmax=dib[i];
        if(dib[i+1]>dmax)dmax=dib[i+1];
        if(dif[i]>dmax)dmax=dif[i];
        if(dif[i+1]>dmax)dmax=dif[i+1];
        if(1-hs*dmax<MIN_DENOM)continue;
        /* 八个角：柱底 b*、柱顶 t*；A=(后,i) B=(后,i+1) C=(前,i+1) D=(前,i)。
           柱顶 = 同一个角抬高 hb：深度变浅（dinv' = dinv/(1−hb*sp*dinv)）、
           相机空间 y 加 hb*cp —— 所以不必重新走一遍完整投影。 */
        const kA=focal*dib[i]/(1-hs*dib[i]);
        const tax=cx+pxb[i]*kA, tay=cy-(pyb[i]+hc)*kA;
        const kB=focal*dib[i+1]/(1-hs*dib[i+1]);
        const tbx=cx+pxb[i+1]*kB, tby=cy-(pyb[i+1]+hc)*kB;
        const kD=focal*dif[i]/(1-hs*dif[i]);
        const tdx=cx+pxf[i]*kD, tdy=cy-(pyf[i]+hc)*kD;
        const kC=focal*dif[i+1]/(1-hs*dif[i+1]);
        const tcx=cx+pxf[i+1]*kC, tcy=cy-(pyf[i+1]+hc)*kC;
        const bax=sxb[i],bay=syb[i], bbx=sxb[i+1],bby=syb[i+1];
        const bcx=sxf[i+1],bcy=syf[i+1], bdx=sxf[i],bdy=syf[i];
        const xw0=-SPAN+i*dx;             // 本柱左边界（世界坐标；临时诊断算深度用）
        /* 视口剔除：八个角的包围盒（只要一个角在视口内就画） */
        let x0=tax,x1=tax,y0=tay,y1=tay;
        if(tbx<x0)x0=tbx; else if(tbx>x1)x1=tbx;
        if(tby<y0)y0=tby; else if(tby>y1)y1=tby;
        if(tcx<x0)x0=tcx; else if(tcx>x1)x1=tcx;
        if(tcy<y0)y0=tcy; else if(tcy>y1)y1=tcy;
        if(tdx<x0)x0=tdx; else if(tdx>x1)x1=tdx;
        if(tdy<y0)y0=tdy; else if(tdy>y1)y1=tdy;
        if(bax<x0)x0=bax; else if(bax>x1)x1=bax;
        if(bay<y0)y0=bay; else if(bay>y1)y1=bay;
        if(bbx<x0)x0=bbx; else if(bbx>x1)x1=bbx;
        if(bby<y0)y0=bby; else if(bby>y1)y1=bby;
        if(bcx<x0)x0=bcx; else if(bcx>x1)x1=bcx;
        if(bcy<y0)y0=bcy; else if(bcy>y1)y1=bcy;
        if(bdx<x0)x0=bdx; else if(bdx>x1)x1=bdx;
        if(bdy<y0)y0=bdy; else if(bdy>y1)y1=bdy;
        if(x1<0||x0>w||y1<0||y0>h)continue;
        if(x1-x0<MIN_PX&&y1-y0<MIN_PX)continue;   // 整根不足 1px：看不见，白省路径与填充
        /* 剪影 = 8 个角点的凸包（Jarvis 步进，见 hull8），一次 fill 画完。
           凸包就是盒子投影的轮廓：包含全部可见面，不需要任何可见性判断，也不会有缝。 */
        _hx[0]=tax;_hy[0]=tay;  _hx[1]=tbx;_hy[1]=tby;
        _hx[2]=tcx;_hy[2]=tcy;  _hx[3]=tdx;_hy[3]=tdy;
        _hx[4]=bax;_hy[4]=bay;  _hx[5]=bbx;_hy[5]=bby;
        _hx[6]=bcx;_hy[6]=bcy;  _hx[7]=bdx;_hy[7]=bdy;
        const hn=hull8();
        const o=m*stride;
        for(let q=0;q<hn;q++){ const k=_hull[q]; barX[o+q]=_hx[k]; barY[o+q]=_hy[k] }
        /* 顶面单独一块（[A,D,C,B]，外法线 +y），盖在剪影内部 → 边界不会露缝 */
        barX[o+8]=tax;  barY[o+8]=tay;
        barX[o+9]=tdx;  barY[o+9]=tdy;
        barX[o+10]=tcx; barY[o+10]=tcy;
        barX[o+11]=tbx; barY[o+11]=tby;
        hcnt[m]=hn;
        /* 归组：高度档与当前批次相差 ≤1 就并进当前批次（色差不可见），否则开新批次。
           批次内的柱子深度相邻；批次之间按远→近排列 → 整行绘制顺序严格等于深度序。 */
        let kb=1+((u*K)|0); if(kb>K)kb=K;
        if(nruns===0||kb-runB[nruns-1]>RUN_HYST||runB[nruns-1]-kb>RUN_HYST){
          runS[nruns]=m; runB[nruns]=kb; runT[nruns]=0; nruns++;
        }
        /* 顶面太小（屏幕上宽或高不足 SHORT_PX）就不单独 fill：与剪影几乎重合，看不出差别 */
        const tw=Math.abs(tcx-tbx), th=bcy-tcy;
        if(th<SHORT_PX||tw<SHORT_PX)srt[m]=1;
        else{ srt[m]=0; runT[nruns-1]=1 }
        _bdep[m]=dc+(xw0+dx*.5)*_saCp-zC*_caCp;   // 临时诊断：本柱深度
        _dbg.hullPts+=hn;                          // 临时诊断：凸包顶点数
        m++;
      }
      bars+=m;
      _dbg.geoMs+=nowMs()-_tg;
      const _tp=nowMs();       // 临时诊断：填充阶段计时起点
      _invRow=Infinity;        // 临时诊断：行内逆序统计按行重置
      /* 5.5 按批次填充：批次按远→近排列，批次内柱子也按远→近存放 →
             整行的绘制顺序严格等于深度序（这正是修掉"镂空"的关键）。
             每个批次两次 fill：先剪影（凸包），再顶面（盖在剪影内部）。 */
      _dbg.runs+=nruns;
      for(let r=0;r<nruns;r++){
        const a0=runS[r], a1=(r+1<nruns)?runS[r+1]:m;
        const ci=fbase+runB[r]-1;
        ctx.beginPath();
        for(let q=a0;q<a1;q++){
          /* 临时诊断：批次内必须严格远→近，逆序次数修复后应为 0 */
          if(_dbg.on){ const _d=_bdep[q]; if(_d>_invRow+0.02)_dbg.inv++; else if(_d<_invRow)_invRow=_d }
          const z=q*stride, hc2=hcnt[q];
          ctx.moveTo(barX[z],barY[z]);
          for(let t=1;t<hc2;t++)ctx.lineTo(barX[z+t],barY[z+t]);
          ctx.closePath();
        }
        ctx.fillStyle=sideCol[ci];
        ctx.fill(); fills++;
        if(!runT[r])continue;
        ctx.beginPath();
        for(let q=a0;q<a1;q++){
          if(srt[q])continue;
          const z=q*stride+8;
          ctx.moveTo(barX[z],barY[z]);
          ctx.lineTo(barX[z+1],barY[z+1]);
          ctx.lineTo(barX[z+2],barY[z+2]);
          ctx.lineTo(barX[z+3],barY[z+3]);
          ctx.closePath();
        }
        ctx.fillStyle=topCol[ci];
        ctx.fill(); fills++;
      }
      _dbg.pathMs+=nowMs()-_tp;
    }

    /* 6) 自检句柄 + 耗时 EMA */
    const ms=nowMs()-_c.t0;
    _c.ms=_c.ms?_c.ms*.9+ms*.1:ms;
    S.bars=bars; S.fills=fills; S.cells=B*D; S.ms=+_c.ms.toFixed(2);
    S.yaw=_c.yaw; S.pitch=_c.pitch; S.zoom=_c.zoom;    // 原值（不做四舍五入，便于自检脚本反推相机）
    S.bands=B; S.depth=D;

    /* 7) 临时诊断：每 60 帧打印一次；跨 90° 象限时打印该象限汇总；degenerate 突增时单独打一行 */
    if(_dbg.on){
      _dbg.bars=bars; _dbg.fills=fills; _dbg.quads=bars*2; _dbg.drawMs=ms;
      const qd=dbgQuadrant(_c.yaw), q=_q[qd];
      q.n++; q.bars+=bars; q.inv+=_dbg.inv;
      if(_dbg.degenerate>q.deg)q.deg=_dbg.degenerate;
      if(_dbg.hidden>q.hid)q.hid=_dbg.hidden;
      if(ms>q.msMax)q.msMax=ms;
      if(ms<q.msMin)q.msMin=ms;
      if((_dbg.degPrev>=0&&_dbg.degenerate>Math.max(24,_dbg.degPrev*3))||_dbg.degenerate>_dbg.degPrev+400)
        console.log('[forest-spike]',{degenerate:_dbg.degenerate,prev:_dbg.degPrev,hidden:_dbg.hidden,
          inv:_dbg.inv,yawDeg:Math.round(_c.yaw*180/Math.PI),pitchDeg:Math.round(_c.pitch*180/Math.PI)});
      _dbg.degPrev=_dbg.degenerate;
      if(_dbg.qcur!==qd){ _dbg.qName='yaw '+Math.round(dbgQuadrant(_c.yaw)*90)+'°~'+Math.round((dbgQuadrant(_c.yaw)+1)*90)+'°'; _dbg.qcur=qd }
      if(_dbg.frames%_dbg.every===0)dbgLog(_c.yaw,_c.pitch,B,D);
    }
  }
};

/* 自注册：main.js import 本文件即完成注册 */
register(forest);
