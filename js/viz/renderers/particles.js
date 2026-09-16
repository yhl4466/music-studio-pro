/* [viz/renderers/particles.js] 星空粒子（FEAT-V3 / 渲染器 2；V3.1 星空化；V3.2 每粒子色相 + 逐粒点亮；
   V3.3 点亮改由**拍点**驱动）。
   形态：整块画布就是一片星空——星点在**全屏随机位置**生成，各自以极慢速度漂移，寿命 2–5 秒内
   淡入淡出；每颗粒子有**自己的色相**（以 hue 为基准、按 hueSpread 散布），低频能量驱动整体亮度，
   鼓点按 lightMode **只点亮少数粒子**（不再整片一起闪）。
   数据源：audio.beat（env 亮度呼吸、strength 强度加强）+ audio.projectBpm/beat.bpm（拍点）+ audio.dt。
   历史修正（实测问题，保留备查）：
   - 「永久痕迹」：旧版靠"每帧盖一层半透明底色"维持画面（在旧帧上叠加），任何一帧绘制被打断就把
     最后一帧永久烙在画布上。→ 现在**每帧第一件事就是 ctx.clearRect**，画面 100% 由本帧重绘。
   - 「播放一段时间后不再有粒子」：旧版只在 onset 时补粒子且被计数闸门卡住。→ 现在**恒定目标数量**，
     每帧按 `目标−存活` 差额补足，池满时抢占寿命进度最大的粒子，生成永不枯竭。
   - 「稳定段不再点亮」：旧版用 onset 触发点亮，而 onset 靠自适应慢线（env > 慢线×1.6）判定，
     慢线跟到稳态后阈值偏高，只有冷启动/改参数那一下能超过阈值。→ 现在触发源改为**拍点**：
     按 BPM 每拍点一次，onset 检测只作为"同拍加强"（窗口 ONSET_WIN 内算重合 → 强度 1.0）。
     渲染器契约里没有 actx.currentTime（也不允许 import transport），所以拍点时钟用主循环给的 dt
     累加（features.js 内部同样这么做）；暂停/静音时包络落到门下 → 冻结拍点并退出跟拍，
     声音回来重新对齐相位（绝不补一串漏掉的拍）。
   V3.2 两项设计改动：
   1) 每粒子独立色相：精灵表按**全色相 24 档**预生成（发光 / 实心两套，共 48 张小 canvas，init 时一次），
      与 hue/hueSpread 参数**解耦**——参数只决定"每颗粒子查哪一档"，所以拖动色相滑块不重建任何精灵，
      而且对已存在的星点立即生效。每颗粒子只存一个 0–1 的随机系数 hf，实际色相 =
      hue + (hf−0.5)×2×hueSpread（hueSpread=0 → 全同色；180 → 全色相彩虹）。
   2) 逐粒点亮：每颗粒子一个 highlight（Float32Array）。每拍按 lightMode 挑粒子置为本次强度值：
      single=随机 5–10 颗、burst=随机一片区域里 20–30 颗、wave=从画面中心向外扩散的环带
      （环带扫过时整圈一起亮，形成涟漪）；每帧按 exp(−dt/τ) 衰减（帧率无关，≈"每帧 ×0.935"），
      绘制时 alpha = 基础 alpha + highlight×0.5，其余粒子完全不受影响。
   实现要点：粒子池 TypedArray 一次分配、生成/回收/积分只写既有字段 → 每帧零分配；
   外观只用预渲染精灵 drawImage（不用 arc+shadowBlur）；闪烁是三角波（无三角函数）；
   波浪环带用平方距离比较，免开方。
   契约与参数：params 是**纯声明对象**（键名即参数名），当前值在 values（缺省回落 def）。
   依赖：仅 ../../core/util.js 的 clamp 与 ../registry.js 的 register。 */
import { clamp } from '../../core/util.js';
import { register } from '../registry.js';

/* ---------- 常量 ---------- */
const POOL_MAX=2000;               // 池容量（一次分配；目标数量不会超过它）
const AREA_PER_STAR=7200;          // 每颗星"占用"的像素面积（density=1 时即此值，密度是它的倍率）
const TARGET_MIN=12;               // 目标数量下限（极小窗口也要有星）
const LIFE_MIN=2.0, LIFE_MAX=5.0;  // 寿命区间（秒）
const DRIFT_PX_S=12;               // 漂浮速度：speed=1 时约 12 px/s（= 0.2 px/帧 @60fps）
const FADE_IN=.18;                 // 淡入占寿命比例
const FADE_OUT=.30;                // 淡出占寿命比例
const PEAK_ALPHA=.92;              // 单颗星的峰值不透明度
const TWK_MIN=.35, TWK_MAX=.85;    // 闪烁速率区间（Hz）
const TWK_DEPTH=.35;               // 闪烁深度（0=不闪）
const ENV_TAU=.12;                 // 低频包络平滑时间常数（秒）
const NB=24;                       // 色相档数（精灵表固定 24 档 = 每 15°）
const SPR=48;                      // 精灵边长（设备像素）
/* 逐粒点亮 */
const HL_TAU=.25;                  // highlight 衰减时间常数（秒，≈"每帧 ×0.935"）
const HL_ADD=.5;                   // 点亮叠加的不透明度（规格：alpha = 基础 + highlight×0.5）
const HL_SIZE=.45;                 // 点亮时半径放大比例
const SINGLE_MIN=5, SINGLE_MAX=10; // single：随机点亮颗数区间
const BURST_MIN=20, BURST_MAX=30;  // burst：区域点亮颗数区间
const BURST_R_MIN=140, BURST_R_MAX=260;   // burst：随机区域半径区间（px）
const WAVE_SPEED=900;              // wave：环带扩散速度（px/s）
const WAVE_BAND=55;                // wave：环带宽度（px）
/* 拍点驱动（V3.3）：不再依赖 onset 检测的稳定性——onset 的自适应慢线跟到稳态后阈值会偏高，
   稳态段就再也超不过阈值，只有"冷启动/改参数"那一下才闪。改为按 BPM 点拍，
   onset 只作为同拍时的强度加强。 */
const BEAT_BASE=.6;                // 每拍的基础强度（规格：0.6）
const BEAT_STRONG=.7;              // beat.strength 超过它就按满强度 1.0 处理
const ONSET_WIN=.12;               // 与 onset 判为"同拍"的时间窗（秒，容忍一两帧抖动）
const ENV_GATE=.02;                // 低频包络低于此值视为"没有声音"（暂停/静音）
const RESYNC_SEC=.5;               // 无声超过这个时长 → 退出跟拍，下次有声重新对齐相位
const MAX_LAG_BEATS=2;             // 拍点落后超过 2 拍 → 重置相位（绝不补拍一大串）

/* ---------- 模块状态（全部预分配；draw 内不分配） ---------- */
const _c={
  x:new Float32Array(POOL_MAX), y:new Float32Array(POOL_MAX),
  vx:new Float32Array(POOL_MAX), vy:new Float32Array(POOL_MAX),
  age:new Float32Array(POOL_MAX), life:new Float32Array(POOL_MAX),
  r:new Float32Array(POOL_MAX),          // 半径个体差异（× size 参数）
  amp:new Float32Array(POOL_MAX),        // 每颗星的亮度系数（0.55–1.0，做出疏密明暗）
  ph:new Float32Array(POOL_MAX),         // 闪烁相位（0–2 的三角波）
  rt:new Float32Array(POOL_MAX),         // 闪烁速率（Hz）
  hf:new Float32Array(POOL_MAX),         // 色相随机系数 0–1（实际色相 = hue +（hf−0.5)×2×spread）
  hl:new Float32Array(POOL_MAX),         // 逐粒点亮值 0–1（onset 置 1，逐帧指数衰减）
  live:new Uint8Array(POOL_MAX),         // 存活位
  count:0, cursor:0,                     // 活跃数 / 回收游标
  target:0,                              // 本帧目标数量
  rng:0x9e3779b9,                        // xorshift32 状态（非零；确定性、无分配）
  sprGlow:null, sprSolid:null,           // 全色相精灵表（各 NB 张；init 建一次，之后永不重建）
  env:0,                                 // 低频包络平滑值
  w:0, h:0,                              // 本帧画布尺寸（burst 取随机区域用）
  /* 拍点时钟：渲染器契约里没有 actx.currentTime（也不能 import transport），
     所以用主循环给的 dt 累加出等价时钟（features.js 内部同样这么做）。 */
  clock:0,                               // dt 累加时钟（秒）
  interval:.5,                           // 当前拍距（秒）= 60/bpm
  nextBeat:0,                            // 下一个拍点的时钟值
  beatOn:0,                              // 是否已进入跟拍（有声音且有合法 BPM）
  silent:99,                             // 距上一帧"有声音"的秒数（暂停/恢复重同步用）
  lastOnset:-99,                         // 上一次 onset 的时钟值（同拍加强用）
  waveOn:0, waveR:0, w2lo:0, w2hi:0, wcx:0, wcy:0, waveSt:1   // 波浪扫描状态（环带用平方距离比较，免开方）
};

/* xorshift32：确定性伪随机，无分配 */
function rnd(){
  let x=_c.rng;
  x^=x<<13; x|=0; x^=x>>>17; x^=x<<5; x|=0;
  _c.rng=x;
  return (x>>>0)/4294967296;
}
/* 全色相精灵表：24 档 × 2 种外观（发光 / 实心），init 时一次建好，之后永不重建。
   表与 hue / hueSpread **无关**（参数只决定每颗粒子查哪一档），所以拖动色相滑块零重建。
   两张精灵的"可见半径"都等于 SPR/2，绘制几何统一，发光开关只是换一张。 */
function buildSprites(){
  if(_c.sprGlow&&_c.sprSolid)return;
  const glow=_c.sprGlow||(_c.sprGlow=new Array(NB));
  const solid=_c.sprSolid||(_c.sprSolid=new Array(NB));
  const r=SPR/2;
  for(let k=0;k<NB;k++){
    const hs=(k*360/NB).toFixed(0);
    const cvG=document.createElement('canvas'), cvS=document.createElement('canvas');
    cvG.width=SPR; cvG.height=SPR; cvS.width=SPR; cvS.height=SPR;
    const gx=cvG.getContext('2d'), sx=cvS.getContext('2d');
    const g1=gx.createRadialGradient(r,r,0,r,r,r);          // 发光：柔和的大光晕
    g1.addColorStop(0,'hsla('+hs+',100%,97%,1)');
    g1.addColorStop(.10,'hsla('+hs+',100%,86%,.95)');
    g1.addColorStop(.32,'hsla('+hs+',96%,66%,.42)');
    g1.addColorStop(.66,'hsla('+hs+',96%,58%,.12)');
    g1.addColorStop(1,'hsla('+hs+',96%,55%,0)');
    gx.fillStyle=g1;
    gx.beginPath(); gx.arc(r,r,r,0,Math.PI*2); gx.fill();
    const g2=sx.createRadialGradient(r,r,0,r,r,r);          // 实心：亮核 + 快速衰减，边缘干净
    g2.addColorStop(0,'hsla('+hs+',100%,98%,1)');
    g2.addColorStop(.46,'hsla('+hs+',98%,76%,.95)');
    g2.addColorStop(.72,'hsla('+hs+',96%,62%,.28)');
    g2.addColorStop(1,'hsla('+hs+',96%,55%,0)');
    sx.fillStyle=g2;
    sx.beginPath(); sx.arc(r,r,r,0,Math.PI*2); sx.fill();
    glow[k]=cvG; solid[k]=cvS;
  }
}
/* 取一个槽位：优先空槽（游标扫描，通常一两步命中）；池满则抢占用得最"老"的（寿命进度最大）。
   目标数量 ≤ POOL_MAX 且每帧按差额补足，正常永远走不到抢占分支——它是自愈保险。 */
function take(){
  let i=_c.cursor;
  for(let n=0;n<POOL_MAX;n++){
    if(!_c.live[i]){ _c.cursor=(i+1)%POOL_MAX; return i }
    i=(i+1)%POOL_MAX;
  }
  let worst=0,wk=-1;
  for(let n=0;n<POOL_MAX;n++){
    const k=_c.life[n]>0?_c.age[n]/_c.life[n]:2;
    if(k>wk){ wk=k; worst=n }
  }
  return worst;
}
/* 生成一颗星：全屏随机位置 + 缓慢随机漂移 + 2–5 秒寿命 + 自己的色相系数。
   速度只存"单位方向 × 个体系数"、半径只存个体系数，真正的 px 值在 draw 里乘参数 ——
   这样拖动"漂浮速度/大小/色相"滑块对**已有**星点立即生效，而不是等它们重生。 */
function spawnOne(w,h){
  const i=take();
  const was=_c.live[i];
  const a=rnd()*Math.PI*2;
  const m=.35+.9*rnd();
  _c.x[i]=rnd()*w;
  _c.y[i]=rnd()*h;
  _c.vx[i]=Math.cos(a)*m;
  _c.vy[i]=Math.sin(a)*m;
  _c.life[i]=LIFE_MIN+(LIFE_MAX-LIFE_MIN)*rnd();
  /* 初始相位打散：首帧就是满屏亮度不一的星，而不是一起从零淡入 */
  _c.age[i]=rnd()*_c.life[i]*FADE_IN;
  _c.r[i]=.55+.75*rnd();
  _c.amp[i]=.55+.45*rnd();
  _c.ph[i]=rnd()*2;
  _c.rt[i]=TWK_MIN+(TWK_MAX-TWK_MIN)*rnd();
  _c.hf[i]=rnd();                       // 色相随机系数（0–1；hueSpread 决定它铺多宽）
  _c.hl[i]=0;                           // 新星不继承上一颗的亮点
  _c.live[i]=1;
  if(!was)_c.count++;                   // 抢占时是"替换"，活跃数不变
}
function kill(i){ _c.live[i]=0; _c.count-- }

/* ---------- 逐粒点亮 ---------- */
/* 随机点亮 n 颗（跳过已经亮着的，让光点分散），亮点值取本次事件强度；返回实际点亮颗数 */
function lightRandom(n,st){
  let got=0,tries=0;
  const maxTries=n*8+32;
  while(got<n&&tries<maxTries){
    tries++;
    const i=(rnd()*POOL_MAX)|0;
    if(!_c.live[i]||_c.hl[i]>.6*st)continue;
    _c.hl[i]=st; got++;
  }
  return got;
}
/* 在随机位置的一片区域里点亮：区域内不足 n 颗时用随机点亮补齐（保证每次强度一致） */
function lightBurst(n,st){
  const cx=rnd()*_c.w, cy=rnd()*_c.h;
  const R=BURST_R_MIN+(BURST_R_MAX-BURST_R_MIN)*rnd();
  const R2=R*R;
  let got=0;
  for(let i=0;i<POOL_MAX&&got<n;i++){
    if(!_c.live[i])continue;
    const dx=_c.x[i]-cx, dy=_c.y[i]-cy;
    if(dx*dx+dy*dy>R2)continue;
    _c.hl[i]=st; got++;
  }
  if(got<n)got+=lightRandom(n-got,st);
  return got;
}
/* 拍点/onset → 按 lightMode 点亮。st 是本次事件的强度（0.6 基础 / 1.0 加强），
   三种模式统一口径：st 同时决定"点亮多少颗"（映射回规格给定的颗数区间）和 highlight 的初值。 */
function lightOnset(mode,st){
  const t=clamp((st-BEAT_BASE)/(1-BEAT_BASE),0,1);      // 0.6→0、1.0→1
  if(mode==='burst')return lightBurst(BURST_MIN+Math.round((BURST_MAX-BURST_MIN)*t),st);
  if(mode==='wave'){                      // 波浪：从画面中心起一圈向外扫（每帧按环带位置点亮）
    if(_c.waveOn)return 0;                // 上一道涟漪还没扫完 → 忽略这次拍点（半途重启观感像"跳回中心"）
    _c.waveOn=1; _c.waveR=0; _c.wcx=_c.w*.5; _c.wcy=_c.h*.5; _c.waveSt=st;
    return 0;
  }
  return lightRandom(SINGLE_MIN+Math.round((SINGLE_MAX-SINGLE_MIN)*t),st);
}
/* 拍点推进：返回本帧是否触发了一次点亮事件。
   相位规则：
   - 没有声音（包络低于门）时不推进拍点；无声超过 RESYNC_SEC 就退出跟拍，等声音回来重新对齐
     —— 这样暂停/恢复不会补出一串漏掉的拍；
   - 落后超过 MAX_LAG_BEATS 拍时把相位重置到"现在"，只补当拍这一下，不补历史。 */
function beatTick(bpm,env,strength,onset,mode,dt){
  _c.interval=60/bpm;
  if(onset)_c.lastOnset=_c.clock;             // 记下 onset 时刻，供"同拍加强"判定
  const gate=env>ENV_GATE;
  _c.silent=gate?0:(_c.silent+dt);
  if(!gate){
    if(_c.silent>RESYNC_SEC)_c.beatOn=0;      // 无声太久：退出跟拍，下次有声重新对齐相位
    return 0;
  }
  if(!_c.beatOn){ _c.beatOn=1; _c.nextBeat=_c.clock }        // 冷启动/恢复：立即对齐一拍
  if(_c.clock>=_c.nextBeat+MAX_LAG_BEATS*_c.interval)_c.nextBeat=_c.clock;
  if(_c.clock<_c.nextBeat)return 0;
  const st=((_c.clock-_c.lastOnset)<=ONSET_WIN||strength>BEAT_STRONG)?1:BEAT_BASE;
  lightOnset(mode,st);
  _c.nextBeat+=_c.interval;
  return 1;
}

export const particles={
  id:'particles',
  label:'粒子系统',
  params:{
    density:   {label:'密度',type:'range',min:.2,max:2,step:.1,def:1,fixed:1},
    size:      {label:'粒子大小',type:'range',min:1,max:6,step:.5,def:2.5,fixed:1},
    speed:     {label:'漂浮速度',type:'range',min:0,max:1,step:.05,def:.3,fixed:2},
    hue:       {label:'基础色调',type:'range',min:0,max:360,step:10,def:200,fixed:0},
    hueSpread: {label:'色相散布',type:'range',min:0,max:180,step:5,def:60,fixed:0},
    lightMode: {label:'点亮模式',type:'select',options:[['single','单个随机'],['burst','多点爆发'],['wave','波浪扫描']],def:'single'},
    glow:      {label:'发光',type:'toggle',def:true},
    reactive:  {label:'随音乐变化',type:'toggle',def:true}
  },
  values:{ density:1, size:2.5, speed:.3, hue:200, hueSpread:60, lightMode:'single', glow:true, reactive:true },

  init(ctx,view){
    buildSprites();
    _c.live.fill(0);
    _c.count=0; _c.cursor=0; _c.target=0; _c.env=0;
    _c.waveOn=0; _c.waveR=0; _c.waveSt=1;
    _c.clock=0; _c.interval=.5; _c.nextBeat=0; _c.beatOn=0; _c.silent=99; _c.lastOnset=-99;
    if(ctx&&view)ctx.clearRect(0,0,view.w||0,view.h||0);   // 切进来先清一次（本模块也会每帧清）
  },
  /* resize：星点坐标是逻辑像素，画布变化后旧星点仍有效；精灵表与画布尺寸无关，无需重建 */
  resize(){},
  /* dispose：本模块每帧都 clearRect，但切走时再清一次，保证不留任何残影 */
  dispose(ctx,view){
    _c.live.fill(0); _c.count=0; _c.cursor=0; _c.target=0; _c.env=0;
    _c.waveOn=0; _c.waveR=0; _c.waveSt=1;
    _c.clock=0; _c.interval=.5; _c.nextBeat=0; _c.beatOn=0; _c.silent=99; _c.lastOnset=-99;
    if(ctx&&view)ctx.clearRect(0,0,view.w||0,view.h||0);
  },

  draw(ctx,view,audio){
    const w=view.w,h=view.h;
    const v=this.values;
    const dt=clamp(Number(audio&&audio.dt)||1/60,0,.1);      // 无音频时也按 60fps 走，星点继续漂
    const reactive=v.reactive!==false;
    const hue=clamp(Number(v.hue)||0,0,360);
    const spread=clamp((v.hueSpread==null?60:Number(v.hueSpread))||0,0,180);
    const sizeMul=clamp(Number(v.size)||2.5,1,6);
    const speed=clamp(Number(v.speed)||0,0,1);
    const mode=(v.lightMode==='burst')?'burst':(v.lightMode==='wave')?'wave':'single';

    /* 0) 每帧完整清屏：画面完全由本帧重绘 → 结构上不可能有永久痕迹 */
    ctx.clearRect(0,0,w,h);
    ctx.imageSmoothingEnabled=true;      // 瀑布图会把插值关掉且不复位，这里显式设回
    ctx.globalAlpha=1;

    /* 1) 目标数量：随画布面积 × 密度变化（density=1 时约 每 7200px² 一颗星） */
    const dens=clamp(Number(v.density)||1,.2,2);
    let target=Math.round(w*h/AREA_PER_STAR*dens);
    if(target<TARGET_MIN)target=TARGET_MIN;
    if(target>POOL_MAX)target=POOL_MAX;
    _c.target=target;
    _c.w=w; _c.h=h;                      // burst 随机区域取点用

    /* 2) 音乐反应量：低频包络（一阶低通）驱动整体亮度；点亮由**拍点**驱动（不再等 onset）。
       BPM 优先取工程 BPM（audio.projectBpm，本应用自产工程即真值），回落 features 的检测值。 */
    const beat=(audio&&audio.beat)?audio.beat:null;
    const env=(reactive&&beat)?clamp(Number(beat.env)||0,0,1):0;
    _c.env+=(env-_c.env)*(1-Math.exp(-dt/ENV_TAU));
    _c.clock+=dt;                                        // dt 累加时钟（等价于 actx 时间轴）
    let bpm=Number(audio&&audio.projectBpm)||0;
    if(!(bpm>=40&&bpm<=220))bpm=Number(beat&&beat.bpm)||0;
    if(reactive&&beat&&bpm>=40&&bpm<=220)
      beatTick(bpm,env,Number(beat.strength)||0,!!beat.onset,mode,dt);
    const bright=reactive?(.70+.45*_c.env):1;

    /* 3) 波浪扫描推进：算出本帧环带的内外沿（平方距离，粒子循环里免开方） */
    if(_c.waveOn){
      _c.waveR+=WAVE_SPEED*dt;
      const lo=_c.waveR-WAVE_BAND, hi=_c.waveR+WAVE_BAND;
      _c.w2lo=lo>0?lo*lo:0; _c.w2hi=hi*hi;
      if(lo*lo>w*w+h*h)_c.waveOn=0;      // 扫过对角线就结束（每帧一次，可忽略）
    }

    /* 4) 补足到目标数量：每帧按差额补（寿命到了的星点当帧就被替换，数量恒定不衰减） */
    const need=target-_c.count;
    if(need>0){
      const n=need>POOL_MAX?POOL_MAX:need;
      for(let k=0;k<n;k++)spawnOne(w,h);
    }

    /* 5) 积分 + 绘制：扫全池（2000 次判断成本可忽略，省掉维护活跃索引表） */
    const spr=(v.glow!==false)?_c.sprGlow:_c.sprSolid;
    const fadeIn=FADE_IN, fadeOut=FADE_OUT, peak=PEAK_ALPHA, depth=TWK_DEPTH;
    const dr=speed*DRIFT_PX_S*dt;                 // 本帧位移系数（每颗星再乘自己的单位方向）
    const hlDecay=Math.exp(-dt/HL_TAU);           // 亮点衰减（帧率无关，≈"每帧 ×0.935"）
    const spread2=spread*2;                       // 色相散布全程宽度（基准 ± spread）
    const hueK=NB/360;                            // 度 → 色相档
    const waveOn=_c.waveOn, w2lo=_c.w2lo, w2hi=_c.w2hi, wcx=_c.wcx, wcy=_c.wcy;
    for(let i=0;i<POOL_MAX;i++){
      if(!_c.live[i])continue;
      const life=_c.life[i];
      const a=_c.age[i]+dt;
      let hl=_c.hl[i]*hlDecay;                    // 亮点逐帧衰减
      _c.hl[i]=hl;
      const r=_c.r[i]*sizeMul*(1+HL_SIZE*hl);     // 被点亮的星更大一点（"亮"的观感）
      if(a>=life){ kill(i); continue }            // 寿命到 → 立即标记待复用
      /* 调小密度时优雅减员：只提前收掉已经走过 3/4 寿命的星，不做"整片突然消失" */
      if(_c.count>target&&a>life*.75){ kill(i); continue }
      _c.age[i]=a;
      const nx=_c.x[i]+_c.vx[i]*dr, ny=_c.y[i]+_c.vy[i]*dr;
      if(nx<-r||ny<-r||nx>w+r||ny>h+r){ kill(i); continue }   // 飘出画布 → 立即回收待复用
      _c.x[i]=nx; _c.y[i]=ny;

      /* 波浪环带落在这一颗上 → 点亮（环带持续存在，扫过时整圈一起亮，形成涟漪） */
      if(waveOn){
        const dx=nx-wcx, dy=ny-wcy, q=dx*dx+dy*dy;
        if(q>w2lo&&q<w2hi){ hl=_c.waveSt; _c.hl[i]=hl }
      }

      /* 基础 alpha = 淡入淡出 × 个体亮度 × 三角波闪烁 × 音乐亮度；再叠加逐粒点亮 */
      const fi=a/(life*fadeIn);
      const fo=(life-a)/(life*fadeOut);
      let al=(fi<1?fi:1)*(fo<1?fo:1)*_c.amp[i];
      let t=_c.ph[i]+dt*_c.rt[i];
      if(t>2)t-=2;
      _c.ph[i]=t;
      al*=1-depth*(t<1?t:2-t);
      al*=bright*peak;
      al+=hl*HL_ADD;
      if(al<=.004)continue;
      if(al>1)al=1;

      /* 每粒子色相：hue ± hueSpread 随机（0 → 全部同色；180 → 全色相彩虹） */
      let hh=hue+(_c.hf[i]-.5)*spread2;
      if(hh<0)hh+=360; else if(hh>=360)hh-=360;
      let bi=(hh*hueK)|0;
      if(bi<0)bi=0; else if(bi>=NB)bi=NB-1;

      ctx.globalAlpha=al;
      const s=r*6;                                // 亮核半径 ≈ r（精灵亮核约占半径 1/3），光晕再向外扩 3 倍
      ctx.drawImage(spr[bi],nx-s*.5,ny-s*.5,s,s);
    }
    ctx.globalAlpha=1;
  }
};

/* 自注册：main.js import 本文件即完成注册 */
register(particles);
