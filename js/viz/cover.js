/* [viz/cover.js] FEAT-V4 / T3：专辑封面生成器（三种风格，纯绘制）。
   定位：入参全部由调用方给（canvas / features / style / seed / opts），**不 import 任何单例**
   （不碰 transport / data / registry / main），因此可在 Console 里反复调用做像素级自检。

   依赖约束：只 import core/util.js 的 clamp。基于该约束，本文件自带三样小工具：
   ① mulberry32（与 core/util.js 同算法）——确定性种子随机；
   ② HSL 颜色字符串构造（画布原生支持 hsl()/hsla()，无需引入颜色库）；
   ③ 曲线统计（均值/峰值/分位）与圆角矩形路径（用 arcTo 而非 roundRect，兼容性更稳）。

   三条设计原则：
   1) 确定性：同一份 (features, seed, style, opts) 必须画出**完全相同的像素**。
      所有随机只来自 mulberry32(seed)，代码里绝不出现 Math.random / Date / 全局状态。
   2) 数据驱动：所有视觉参数都从 FeatureObject 推出来，不做"看起来像"的假装饰——
      段落→环、每拍→砖、亮度→流线位置、RMS→线宽、起音→竖线、缩略频谱→频段比例。
   3) 性能：背景一律用 gradient，形状一律走 Path2D 批量绘制（同色形状合并成一次 fill/stroke），
      不使用 ImageData 逐像素操作，每种风格 < 150ms。

   features 需要的字段（全部做了缺省兜底，缺字段也能出图）：
   duration / rmsCurve / brightnessCurve / onsets / segments / bandEnergy / spectrogram +
   spectroCols / spectroRows / binHz / bars / meterN / crest / key{name,mode} / sampleRate。 */

import { clamp } from '../core/util.js';

export const COVER_SIZE=800;              // 封面逻辑尺寸（正方形）
export const COVER_STYLES=['ring','bricks','ribbon'];
const TAU=Math.PI*2;

/* =========================================================================
   1. 本地小工具（受"只 import clamp"约束，此处自带）
   ========================================================================= */
/** mulberry32：与 core/util.js 同算法的确定性 PRNG（同一 seed 永远同一序列） */
function mulberry32(a){
  return function(){
    a|=0; a=a+0x6D2B79F5|0;
    let t=Math.imul(a^a>>>15,1|a);
    t=t+Math.imul(t^t>>>7,61|t)^t;
    return ((t^t>>>14)>>>0)/4294967296;
  };
}
const safe=(v,f)=>{ const n=Number(v); return Number.isFinite(n)?n:f };
const frac=(v)=>clamp(safe(v,0),0,1);
/** 曲线统计：只读、不分配（缺字段/全 NaN 时返回缺省值） */
function curveMean(a,def){
  if(!a||!a.length)return def==null?0:def;
  let s=0,n=0;
  for(let i=0;i<a.length;i++){ const v=a[i]; if(Number.isFinite(v)){ s+=v; n++ } }
  return n?s/n:(def==null?0:def);
}
function curveMax(a,def){
  if(!a||!a.length)return def==null?0:def;
  let m=0;
  for(let i=0;i<a.length;i++){ const v=a[i]; if(Number.isFinite(v)&&v>m)m=v }
  return m;
}
/** 值域归一化到 0-1（以自身峰值为参考；全零/空曲线返回 0） */
function normAt(a,i,mx){ const v=safe(a&&a[i],0); return mx>1e-9?frac(v/mx):0 }
/** 均匀取样：把任意长度曲线压到 n 个采样点（用于 60 条流线，避免几万次 lineTo） */
function sampleAt(a,n,idx){
  if(!a||!a.length)return 0;
  const p=n<=1?0:(a.length-1)*(idx/(n-1));
  const i0=Math.floor(p), i1=Math.min(a.length-1,i0+1), t=p-i0;
  return safe(a[i0],0)*(1-t)+safe(a[i1],0)*t;
}
function hsl(h,s,l,a){
  const hh=((h%360)+360)%360, ss=clamp(s,0,100), ll=clamp(l,0,100);
  return a==null?('hsl('+hh.toFixed(1)+','+ss.toFixed(1)+'%,'+ll.toFixed(1)+'%)')
                :('hsla('+hh.toFixed(1)+','+ss.toFixed(1)+'%,'+ll.toFixed(1)+'%,'+clamp(a,0,1).toFixed(3)+')');
}
/** 圆角矩形路径（用 arcTo：Path2D.roundRect 在老浏览器缺失） */
function roundRectPath(p,x,y,w,h,r){
  const rr=Math.max(0,Math.min(r,Math.min(w,h)/2));
  p.moveTo(x+rr,y);
  p.lineTo(x+w-rr,y); p.arcTo(x+w,y,x+w,y+rr,rr);
  p.lineTo(x+w,y+h-rr); p.arcTo(x+w,y+h,x+w-rr,y+h,rr);
  p.lineTo(x+rr,y+h); p.arcTo(x,y+h,x,y+h-rr,rr);
  p.lineTo(x,y+rr); p.arcTo(x,y,x+rr,y,rr);
  p.closePath();
}

/* =========================================================================
   2. 调色板推导
   ========================================================================= */
/* 调式 → 基础色相：大调暖（橙黄≤50）、小调冷（≥160）、多利亚中性（青绿） */
const MODE_HUE={major:32, mixolydian:18, lydian:50, majorPent:40,
                minor:214, harmonicMinor:236, melodicMinor:196, phrygian:282,
                dorian:162};
const HUE_FALLBACK=32;
/* 暖/冷分组 + 色弧（保证"大调仍偏暖、小调仍偏冷"）。
   三条风格的色相是把同一个基准色相整体平移 ±SHIFT 得到的，若逐条硬夹到色弧上会把风格间距压小
   （实测 ±60 时最小成对差会掉到 43°）。所以这里做"整体平移入弧"：先看三条色相构成的 120° 簇，
   整体平移到能装进色弧为止 —— 色弧宽度都大于 120°，因此总能装下，三条之间的差值（±60）原样保留。
   暖弧宽度 140°（T5 从 125° 放宽）：留出余量给 seed 抖动，否则"换一张"只换颗粒不换色相。 */
const WARM_MODES={major:1,mixolydian:1,lydian:1,majorPent:1};
const ARC_WARM_LO=320, ARC_WARM_HI=100;    // 暖色弧：红(320)–黄(100)，跨 0°，宽 140°（T5 从 125° 放宽，留 20° 余量给 seed 抖动）
const ARC_COOL_LO=140, ARC_COOL_HI=300;     // 冷色弧：青(140)–紫(300)
const arcWidth=(isWarm)=>isWarm?((ARC_WARM_HI-ARC_WARM_LO+360)%360):(ARC_COOL_HI-ARC_COOL_LO);
/* 风格色相偏移（T3.5/T3.6 修：三风格原本只差 seed 抖动，视觉上"换风格"不明显）。
   +60/0/−60：两两差距 60/60/120°，都不小于 60°。 */
const STYLE_HUE_SHIFT={ring:60, bricks:0, ribbon:-60};

/** 把 base0（含 seed 抖动）按风格偏移展开成三条色相，并整体平移进所属色弧 */
function styleHues(base0,isWarm){
  const LO=isWarm?ARC_WARM_LO:ARC_COOL_LO, W=arcWidth(isWarm);
  const shifts=[STYLE_HUE_SHIFT.ring,STYLE_HUE_SHIFT.bricks,STYLE_HUE_SHIFT.ribbon];
  const hi=Math.max(shifts[0],shifts[1],shifts[2]), lo=Math.min(shifts[0],shifts[1],shifts[2]);
  let u=((base0-LO)%360+360)%360;
  let delta=0;
  if(u+lo<0)delta=-(u+lo);                       // 最低那条掉到弧外下方 → 整体上移
  else if(u+hi>W)delta=W-(u+hi);                 // 最高那条超出弧上界 → 整体下移
  const at=(shift)=>{ const v=((u+delta+shift)%360+360)%360; return (LO+v)%360 };
  return {ring:at(STYLE_HUE_SHIFT.ring), bricks:at(STYLE_HUE_SHIFT.bricks), ribbon:at(STYLE_HUE_SHIFT.ribbon)};
}

function paletteNums(features,seed,style){
  const f=features||{};
  const rng=mulberry32((safe(seed,0)>>>0));
  const jitter=(rng()-0.5)*40;                                   // 色相 ±20°（seed 微调）
  /* T6：暖弧只有 140°、三风格要占 120°，色相抖动有相当一部分会被"整体平移入弧"吸收掉
     （实测约一半的随机种子色相不变）。所以在色相之外再叠加饱和度 ±10% 与明度 ±8%，
     让"换一张"必然能看出色调变化 —— 这两项不参与色弧保护，不影响调式暖冷。 */
  const jSat=(rng()-0.5)*20;                                     // 饱和度 ±10%
  const jLit=(rng()-0.5)*16;                                     // 明度 ±8%
  const modeRaw=(f.key&&f.key.mode)||f.mode||'major';
  const modeBase=(MODE_HUE[modeRaw]!=null?MODE_HUE[modeRaw]:HUE_FALLBACK);
  const hues=styleHues(modeBase+jitter,!!WARM_MODES[modeRaw]);
  const base=(STYLE_HUE_SHIFT[style]!=null?hues[style]:hues.bricks);   // 未知风格 = 不偏移
  const nyq=Math.max(4000,safe(f.sampleRate,44100)/2);
  const brig=frac(curveMean(f.brightnessCurve,nyq*0.12)/(nyq*0.35));   // 亮度均值 → 0-1（≈7.7kHz 视为最亮）
  const contrast=frac((safe(f.crest,6)-3)/15);                         // 波峰因数 → 对比度
  const dyn=frac((safe(f.peak,0.5)-0.2)/0.8);                          // 峰值 → 明度上限微调
  return {base,brig,contrast,dyn,jitter,jSat,jLit,
    /* 饱和度/明度都叠加 seed 抖动；背景只吃一半明度抖动并夹在 3–30%，避免"换一张"把底子洗白 */
    bgH:base+12,      bgS:12+14*contrast+jSat*0.5,  bgL:clamp(5+20*brig+jLit*0.5,3,30),
    primaryH:base,    primaryS:58+26*contrast+jSat, primaryL:44+16*brig+jLit,
    secondH:base+38,  secondS:50+22*contrast+jSat,  secondL:32+14*brig+jLit,
    accentH:base+168, accentS:74+jSat,              accentL:56+14*dyn+jLit,
    lowH:base-26,     lowS:70+jSat,                 lowL:28+12*contrast+jLit,
    midH:base+16,     midS:64+jSat,                 midL:44+12*brig+jLit,
    highH:base+64,    highS:72+jSat,                highL:60+14*brig+jLit};
}
function formatPalette(p){
  return {
    bg:       hsl(p.bgH,p.bgS,p.bgL),
    primary:  hsl(p.primaryH,p.primaryS,p.primaryL),
    secondary:hsl(p.secondH,p.secondS,p.secondL),
    accent:   hsl(p.accentH,p.accentS,p.accentL),
    lowBand:  hsl(p.lowH,p.lowS,p.lowL),
    midBand:  hsl(p.midH,p.midS,p.midL),
    highBand: hsl(p.highH,p.highS,p.highL)
  };
}
/**
 * 从特征推导统一调色板（三种风格共用，保证同一工程出图的色彩语言一致）。
 * 规则：亮度均值 → 明度；调式 → 主色相；**风格 → 色相偏移（ring +60° / bricks 0° / ribbon −60°）**；
 *      波峰因数 → 对比度/饱和度；seed → 色相 ±20° + 饱和度 ±10% + 明度 ±8° 抖动；
 *      三条色相整体平移进调式所属色弧（饱和度/明度抖动不参与色弧保护）。
 * @param {object} features analyzer 的 FeatureObject（只读）
 * @param {number} seed 确定性种子
 * @param {'ring'|'bricks'|'ribbon'} [style] 风格（缺省/未知 = 不偏移，兼容旧调用）
 * @returns {{bg:string,primary:string,secondary:string,accent:string,lowBand:string,midBand:string,highBand:string}}
 */
export function derivePalette(features,seed,style){
  return formatPalette(paletteNums(features,seed,style));
}

/* =========================================================================
   3. 频段比例（用缩略频谱算"某段时间内的低/中/高频占比"）
   ========================================================================= */
/** 预计算每列的频段均值（一次遍历 spectrogram，避免逐格重复扫 512 行） */
function bandColumns(f){
  const cols=safe(f.spectroCols,0)|0, rows=safe(f.spectroRows,0)|0, sp=f.spectrogram;
  if(!sp||cols<=0||rows<=0||sp.length<cols*rows)return null;
  const binHz=safe(f.binHz,21.53);
  const rowHz=binHz*2;                                  // 缩略谱每行 = 2 个 bin
  const kLow=clamp(Math.round(250/rowHz),1,rows-1);
  const kMid=clamp(Math.round(2000/rowHz),kLow+1,rows);
  const low=new Float32Array(cols), mid=new Float32Array(cols), high=new Float32Array(cols);
  for(let c=0;c<cols;c++){
    const base=c*rows;
    let a=0,b=0,d=0;
    for(let k=0;k<rows;k++){
      const v=safe(sp[base+k],0);
      if(k<kLow)a+=v; else if(k<kMid)b+=v; else d+=v;
    }
    low[c]=a; mid[c]=b; high[c]=d;
  }
  return {cols,low,mid,high,kLow,kMid};
}
/** 取 [t0,t1] 时间窗内的频段占比（和=1）；无频谱数据时回落到全局 bandEnergy */
function fracsOf(bc,f,t0,t1){
  const g=f.bandEnergy||{low:0.34,mid:0.33,high:0.33};
  if(!bc)return {low:frac(g.low),mid:frac(g.mid),high:frac(g.high)};
  const dur=Math.max(0.001,safe(f.duration,1));
  const c0=clamp(Math.floor(t0/dur*bc.cols),0,bc.cols-1);
  const c1=clamp(Math.ceil(t1/dur*bc.cols),c0+1,bc.cols);
  let a=0,b=0,d=0;
  for(let c=c0;c<c1;c++){ a+=bc.low[c]; b+=bc.mid[c]; d+=bc.high[c] }
  const tot=a+b+d;
  if(!(tot>1e-6))return {low:frac(g.low),mid:frac(g.mid),high:frac(g.high)};
  return {low:a/tot,mid:b/tot,high:d/tot};
}
/** [t0,t1] 时间窗内的平均 RMS（0-1，相对全曲峰值） */
function rmsOf(f,t0,t1,peak){
  const rc=f.rmsCurve;
  if(!rc||!rc.length)return 0;
  const dur=Math.max(0.001,safe(f.duration,1));
  const i0=clamp(Math.floor(t0/dur*rc.length),0,rc.length-1);
  const i1=clamp(Math.ceil(t1/dur*rc.length),i0+1,rc.length);
  let s=0;
  for(let i=i0;i<i1;i++)s+=safe(rc[i],0);
  return peak>1e-9?frac((s/(i1-i0))/peak):0;
}

/* =========================================================================
   4. 公共绘制：背景 / 质感 / 标题
   约定：paint* 系列一律接收 **数值调色板 pn**（便于内部派生明度/透明度），
   风格函数接收 (p, pn) 两份：p 是给 fillStyle/strokeStyle 直接用的颜色字符串，
   pn 用于需要自己算明度/透明度/色相偏移的地方。
   ========================================================================= */
function paintBackground(ctx,S,pn){
  const g=ctx.createLinearGradient(0,0,S,S);
  g.addColorStop(0,hsl(pn.bgH,pn.bgS+4,pn.bgL+3));
  g.addColorStop(0.55,hsl(pn.bgH,pn.bgS,pn.bgL));
  g.addColorStop(1,hsl(pn.bgH+40,pn.bgS+6,Math.max(2,pn.bgL-3)));
  ctx.fillStyle=g;
  ctx.fillRect(0,0,S,S);
  /* 中心柔光：用径向渐变提亮主体区域（一次 fill，不逐像素） */
  const r=ctx.createRadialGradient(S*0.5,S*0.46,0,S*0.5,S*0.5,S*0.72);
  r.addColorStop(0,hsl(pn.primaryH,pn.primaryS*0.5,pn.primaryL*0.42,0.34));
  r.addColorStop(1,hsl(pn.bgH,pn.bgS,pn.bgL,0));
  ctx.fillStyle=r;
  ctx.fillRect(0,0,S,S);
}
/** 确定性颗粒（同 seed 同图案）：不是噪声贴图，只是 260 个半透明小点，给大色块一点呼吸感 */
function paintGrain(ctx,S,pn,rng){
  const path=new Path2D();
  for(let i=0;i<260;i++){
    const x=rng()*S, y=rng()*S, r=0.4+rng()*1.7;
    path.moveTo(x+r,y);
    path.arc(x,y,r,0,TAU);
  }
  ctx.fillStyle=hsl(pn.primaryH,30,88,0.045);
  ctx.fill(path);
}
/** 标题 + 一行元信息。place='center' 时画在中心留白处，否则画在左下角。
    标题取值优先级：opts.title（弹窗里可编辑）→ features.title（调用方写入的覆盖值）→ '未命名工程' */
function paintTitle(ctx,f,pn,S,opts,place){
  if(opts.showTitle===false)return;
  const raw=(typeof opts.title==='string'&&opts.title.trim())?opts.title
           :((typeof f.title==='string'&&f.title.trim())?f.title:'未命名工程');
  const name=raw.trim();
  const short=name.length>22?(name.slice(0,21)+'…'):name;
  const parts=[];
  parts.push(safe(f.duration,0).toFixed(1)+' 秒');
  parts.push(((f.segments&&f.segments.length)||0)+' 段');
  if(f.key&&f.key.name)parts.push(f.key.name);
  if(f.noteCount!=null)parts.push(f.noteCount+' 音符');
  const meta=parts.join(' · ');
  const center=(place==='center');
  const cx=center?S*0.5:S*0.075;
  const cy=center?S*0.5:S*0.935;
  ctx.textAlign=center?'center':'left';
  ctx.textBaseline='middle';
  let fs=center?34:27;
  ctx.font='700 '+fs+'px "Segoe UI","Microsoft YaHei",system-ui,sans-serif';
  const w=ctx.measureText(short).width||short.length*fs*0.6;
  const maxW=S*(center?0.42:0.86);
  if(w>maxW&&w>0){ fs=Math.max(center?18:14,fs*maxW/w); ctx.font='700 '+fs.toFixed(1)+'px "Segoe UI","Microsoft YaHei",system-ui,sans-serif' }
  ctx.fillStyle=hsl(0,0,0,0.35);
  ctx.fillText(short,cx,cy+(center?fs*0.85:1.5));
  ctx.fillStyle=hsl(pn.primaryH,18,96,0.94);
  ctx.fillText(short,cx,cy);
  if(meta){
    const mfs=center?14:13;
    ctx.font='500 '+mfs+'px "Segoe UI","Microsoft YaHei",system-ui,sans-serif';
    ctx.fillStyle=hsl(pn.primaryH,26,86,0.62);
    ctx.fillText(meta,cx,cy+(center?fs*0.72+mfs*1.5:mfs*1.7));
  }
  ctx.textAlign='left'; ctx.textBaseline='alphabetic';
}

/* =========================================================================
   5. 风格 A：同心声纹（ring）
   一段 = 一圈；圈半径随段序递增（时间由内向外），环的**厚度**由该段能量决定，
   圈上按频段占比叠 3 层细弧（低/中/高各一层），弧长 = 该段时长占比 × 360°，
   所有弧首尾相接形成一个从 12 点方向顺时针的"声纹螺旋"。
   ========================================================================= */
function drawRing(ctx,f,p,pn,S,opts,rng){
  paintBackground(ctx,S,pn);
  const dur=Math.max(0.05,safe(f.duration,1));
  let segs=(f.segments&&f.segments.length)?f.segments.slice():[{start:0,end:dur,energy:1}];
  if(segs.length>14)segs=segs.slice(0,14);                    // 圈层过多会糊在一起，超过 14 段取前 14
  const total=segs.reduce((a,s)=>a+Math.max(0.01,safe(s.end,0)-safe(s.start,0)),0)||dur;
  const bc=bandColumns(f);
  const peak=curveMax(f.rmsCurve,1)||1;
  const cx=S*0.5, cy=S*0.5;
  const R_OUT=S*0.415, R_IN=S*0.115;
  const step=(R_OUT-R_IN)/segs.length;
  /* 底纹：一组极淡的完整同心细圈，提供"刻度盘"的视觉基准 */
  ctx.strokeStyle=hsl(pn.primaryH,pn.primaryS*0.4,pn.primaryL,0.10);
  ctx.lineWidth=1;
  const grid=new Path2D();
  for(let i=0;i<segs.length;i++){ const r=R_IN+step*(i+1); grid.moveTo(cx+r,cy); grid.arc(cx,cy,r,0,TAU) }
  ctx.stroke(grid);

  let ang=-Math.PI*0.5;
  for(let i=0;i<segs.length;i++){
    const s=segs[i];
    const t0=Math.max(0,safe(s.start,0));
    const t1=Math.max(t0+0.01,safe(s.end,t0+1));
    const span=TAU*((t1-t0)/total);
    const e=frac(s.energy==null?rmsOf(f,t0,t1,peak):s.energy);
    const fr=fracsOf(bc,f,t0,t1);
    const r=R_IN+step*(i+0.5);
    const thick=Math.max(3.2,step*(0.30+0.55*e));             // 能量 → 环厚度
    /* 三层细弧：厚度按低/中/高频占比切分，颜色取对应频段色 */
    const layers=[[fr.low,p.lowBand],[fr.mid,p.midBand],[fr.high,p.highBand]];
    let rr=r-thick*0.5;
    for(let k=0;k<3;k++){
      const th=Math.max(1.1,thick*frac(layers[k][0]));
      ctx.beginPath();
      ctx.arc(cx,cy,rr+th*0.5,ang,ang+span);
      ctx.strokeStyle=layers[k][1];
      ctx.lineWidth=th;
      ctx.stroke();
      rr+=th;
    }
    /* 能量外沿：一条亮弧，把"这一段有多响"再强调一次（弱段几乎不可见，强段醒目） */
    ctx.beginPath();
    ctx.arc(cx,cy,r-thick*0.5-2.2,ang,ang+span);
    ctx.strokeStyle=hsl(pn.accentH,pn.accentS,Math.min(96,pn.accentL+18*e),0.16+0.72*e);
    ctx.lineWidth=1+2.2*e;
    ctx.stroke();
    /* 段落起点刻度 */
    const a0=ang;
    ctx.beginPath();
    ctx.moveTo(cx+Math.cos(a0)*(r-thick*0.5-6),cy+Math.sin(a0)*(r-thick*0.5-6));
    ctx.lineTo(cx+Math.cos(a0)*(r+thick*0.5+6),cy+Math.sin(a0)*(r+thick*0.5+6));
    ctx.strokeStyle=hsl(pn.primaryH,20,90,0.30);
    ctx.lineWidth=1;
    ctx.stroke();
    ang+=span;
  }
  /* 中心留白 + 细环收边 */
  ctx.beginPath(); ctx.arc(cx,cy,R_IN-S*0.028,0,TAU);
  ctx.strokeStyle=hsl(pn.primaryH,pn.primaryS*0.5,pn.primaryL,0.22); ctx.lineWidth=1; ctx.stroke();
  paintGrain(ctx,S,pn,rng);
  paintTitle(ctx,f,pn,S,opts,'center');
}

/* =========================================================================
   6. 风格 B：能量砖阵（bricks）
   每小节一行、每拍一格；格子颜色由调色板 + 该拍的频段占比偏移色相，
   亮度由该拍 RMS 决定；整行（小节）能量低于门限则整行留空 —— 负空间就是结构。
   ========================================================================= */
function drawBricks(ctx,f,p,pn,S,opts,rng){
  paintBackground(ctx,S,pn);
  const bc=bandColumns(f);
  const peak=curveMax(f.rmsCurve,1)||1;
  const dur=Math.max(0.05,safe(f.duration,1));
  const bars=clamp(Math.round(safe(f.bars,Math.max(1,Math.round(safe(f.barDensity&&f.barDensity.length,0))||1))),1,64);
  const cols=clamp(Math.round(safe(f.meterN,4)),1,16);
  const cells=bars*cols;
  const cellDur=dur/cells;
  const top=S*0.115, bottom=S*0.135, left=S*0.075, right=S*0.075;
  const gw=S-left-right, gh=S-top-bottom;
  const cw=gw/cols, ch=gh/bars;
  const gap=Math.min(cw,ch)*0.16;
  const r=Math.min(cw,ch)*0.26;

  /* 每小节的整体能量（行级门限用）：行能量 < 峰值的 4% 视为静音行 → 留空 */
  const rowE=new Float32Array(bars);
  for(let b=0;b<bars;b++){
    const t0=b*cols*cellDur, t1=t0+cols*cellDur;
    rowE[b]=rmsOf(f,t0,t1,peak);
  }
  const silent=0.04;

  /* 颜色分桶：把格子的颜色量化到有限几档，同色格子合并成一个 Path2D，一次 fill 画完 */
  const BUCKETS=12;
  const paths=new Array(BUCKETS); const fills=new Array(BUCKETS);
  let drawn=0, silentRows=0;
  for(let b=0;b<bars;b++){
    if(rowE[b]<silent){ silentRows++; continue }
    for(let c=0;c<cols;c++){
      const t0=(b*cols+c)*cellDur, t1=t0+cellDur;
      const e=rmsOf(f,t0,t1,peak);
      if(e<0.012)continue;                                     // 单拍也静音 → 留空
      const fr=fracsOf(bc,f,t0,t1);
      const hue=pn.primaryH+(fr.high-fr.low)*74+(fr.mid-0.33)*30;   // 频段占比 → 色相偏移
      const light=18+56*Math.pow(e,0.72);                      // 能量 → 明度（开方压一下动态）
      const sat=44+40*frac(fr.high*1.5);
      const bucket=clamp(Math.round(((hue-pn.base+90)/180)*6),0,5)*2+(light>50?1:0);
      const bi=clamp(bucket,0,BUCKETS-1);
      if(!paths[bi]){ paths[bi]=new Path2D(); fills[bi]=hsl(hue,sat,light,0.96) }
      const x=left+c*cw+gap*0.5, y=top+b*ch+gap*0.5;
      const w=cw-gap, h=ch-gap;
      roundRectPath(paths[bi],x,y,w,h,r);
      drawn++;
    }
  }
  for(let i=0;i<BUCKETS;i++){ if(paths[i]){ ctx.fillStyle=fills[i]; ctx.fill(paths[i]) } }

  /* 行基准线：每小节一条极淡横线（让留空的静音行仍能读出节奏网格） */
  ctx.globalAlpha=0.10;
  ctx.strokeStyle=p.secondary;
  ctx.lineWidth=1;
  const lines=new Path2D();
  for(let b=1;b<bars;b++){ const y=top+b*ch; lines.moveTo(left,y); lines.lineTo(left+gw,y) }
  for(let c=1;c<cols;c++){ const x=left+c*cw; lines.moveTo(x,top); lines.lineTo(x,top+gh) }
  ctx.stroke(lines);
  ctx.globalAlpha=1;

  paintGrain(ctx,S,pn,rng);
  paintTitle(ctx,f,pn,S,opts,'bottom');
  return {drawn,silentRows};
}

/* =========================================================================
   7. 风格 C：波形缎带（ribbon）
   60 条纵向流线；横轴 = 时间；每条流线的纵向基准位置均分画布，
   在基准上按"该时刻的亮度"上下偏移（亮度 = 频谱质心 → 越高越往上），
   线宽 = 该时刻 RMS；起音处叠短竖线。整图单色调 + 调式色相渐变。
   ========================================================================= */
function drawRibbon(ctx,f,p,pn,S,opts,rng){
  paintBackground(ctx,S,pn);
  const dur=Math.max(0.05,safe(f.duration,1));
  const frames=safe(f.frames,(f.rmsCurve&&f.rmsCurve.length)||0);
  const rc=f.rmsCurve, bc0=f.brightnessCurve;
  const rMax=curveMax(rc,1)||1;
  const bMax=curveMax(bc0,1)||1;
  const LINES=60;
  const PTS=Math.min(360,Math.max(80,Math.round(frames||240)));
  const top=S*0.09, bottom=S*0.87, mid=(top+bottom)*0.5, band=(bottom-top);
  /* 宽度分档（共 6 档）：同一档的流线段合并进同一个 Path2D，最后按档一次 stroke 画完。
     lastK[] 记录该档上一次写入的采样序号：只有"上一采样点也属于本档"时才 lineTo，
    否则必须 moveTo —— 否则不同流线/不同采样段会被连成一条跨画布的假线。 */
  const WCLASS=6;
  const paths=[], widths=[], lastK=new Int32Array(WCLASS).fill(-2);
  for(let i=0;i<WCLASS;i++){ paths.push(new Path2D()); widths.push(0.9+i*1.15) }
  const spread=band*0.92;
  for(let li=0;li<LINES;li++){
    const baseY=top+band*((li+0.5)/LINES);
    /* 亮度只做"相对基准的偏移"，幅度随流线序号先小后大 → 形成扇形展开的缎带 */
    const amp=spread*(0.10+0.30*Math.abs(li/(LINES-1)-0.5)*2);
    for(let k=0;k<PTS;k++){
      const fracK=PTS<=1?0:k/(PTS-1);
      const srcIdx=Math.round((frames-1)*fracK);
      const x=S*0.065+(S*0.87)*fracK;
      const bright=frac(normAt(bc0,srcIdx,bMax));
      const rms=frac(normAt(rc,srcIdx,rMax));
      const y=baseY+(0.5-bright)*amp;
      const wi=clamp(Math.round(rms*(WCLASS-1)),0,WCLASS-1);
      if(lastK[wi]!==k-1)paths[wi].moveTo(x,y); else paths[wi].lineTo(x,y);
      lastK[wi]=k;
    }
    lastK.fill(-2);                                  // 换下一条流线：全部断开，避免流线之间连笔
  }
  const grad=ctx.createLinearGradient(0,0,S,0);                 // 调式色相横向渐变（单色调家族）
  grad.addColorStop(0,hsl(pn.primaryH-14,pn.primaryS*0.8,pn.primaryL+6,0.42));
  grad.addColorStop(0.5,hsl(pn.primaryH,pn.primaryS,pn.primaryL+14,0.72));
  grad.addColorStop(1,hsl(pn.highH,pn.highS,pn.highL,0.46));
  ctx.strokeStyle=grad;
  ctx.lineCap='round';
  for(let i=0;i<WCLASS;i++){ ctx.lineWidth=widths[i]; ctx.stroke(paths[i]) }

  /* 起音：短竖线（长度随该处能量），用 accent 色统一描一次 */
  const onsets=f.onsets||[];
  if(onsets.length){
    const ticks=new Path2D();
    let n=0;
    for(let i=0;i<onsets.length;i++){
      const t=safe(onsets[i],-1);
      if(t<0||t>dur)continue;
      const x=S*0.065+(S*0.87)*(t/dur);
      const e=frac(rmsOf(f,t,Math.min(dur,t+0.12),rMax));
      const h=S*(0.018+0.055*e);
      ticks.moveTo(x,mid-h*0.5); ticks.lineTo(x,mid+h*0.5);
      n++;
    }
    if(n){
      ctx.globalAlpha=0.66;
      ctx.strokeStyle=p.accent;
      ctx.lineWidth=1.4;
      ctx.stroke(ticks);
      ctx.globalAlpha=1;
    }
  }
  /* 中轴线：一条极淡基准线，提示"亮度 0.5"的位置 */
  ctx.strokeStyle=hsl(pn.primaryH,pn.primaryS*0.5,pn.primaryL,0.18);
  ctx.lineWidth=1;
  ctx.beginPath(); ctx.moveTo(S*0.065,mid); ctx.lineTo(S*0.935,mid); ctx.stroke();

  paintGrain(ctx,S,pn,rng);
  paintTitle(ctx,f,pn,S,opts,'bottom');
}

/* =========================================================================
   8. 主入口
   ========================================================================= */
/**
 * 生成一张封面（就地绘制到传入的 canvas）。
 * @param {HTMLCanvasElement} canvas 目标画布（尺寸由本函数按 COVER_SIZE×scale 设定）
 * @param {object} features analyzer.analyze() 的返回值（可为 null/空对象：只出底图与标题）
 * @param {'ring'|'bricks'|'ribbon'} style 风格
 * @param {number} seed 确定性种子（同一 features+seed+style 必出同一张图）
 * @param {{scale?:number, showTitle?:boolean, title?:string}} [opts] scale 1 或 2（2 = 1600×1600 导出用）
 * @returns {{style:string,size:number,scale:number,palette:object,segments:number,onsets:number}}
 */
export function generateCover(canvas,features,style,seed,opts={}){
  if(!canvas||typeof canvas.getContext!=='function')throw new Error('generateCover() 需要一个 HTMLCanvasElement');
  const ctx=canvas.getContext('2d');
  if(!ctx)throw new Error('generateCover() 无法获取 2d 上下文');
  const scale=clamp(Math.round(safe(opts.scale,1))||1,1,2);
  const S=COVER_SIZE, px=Math.round(S*scale);
  /* 先按导出分辨率设置位图尺寸（赋值会重置上下文状态），再设逻辑坐标变换 */
  if(canvas.width!==px)canvas.width=px;
  if(canvas.height!==px)canvas.height=px;
  ctx.setTransform(scale,0,0,scale,0,0);
  ctx.clearRect(0,0,S,S);

  const f=features||{};
  const pn=paletteNums(f,seed,style);
  const pal=formatPalette(pn);
  const rng=mulberry32(safe(seed,0)>>>0);
  const st=COVER_STYLES.indexOf(style)>=0?style:'ring';       // 非法风格回落 ring，不抛异常
  if(st==='bricks')drawBricks(ctx,f,pal,pn,S,opts,rng);
  else if(st==='ribbon')drawRibbon(ctx,f,pal,pn,S,opts,rng);
  else drawRing(ctx,f,pal,pn,S,opts,rng);
  return {style:st,size:S,scale,palette:pal,
          segments:(f.segments&&f.segments.length)||0,
          onsets:(f.onsets&&f.onsets.length)||0};
}
