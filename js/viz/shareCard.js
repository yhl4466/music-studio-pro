/* [viz/shareCard.js] FEAT-V6 / T1：分享卡片生成器（1200×630，社交平台标准尺寸）。
   定位：纯绘制模块——入参全部由调用方给（canvas / features / opts），**不 import 任何单例、不碰 DOM**，
   与 cover.js / fingerprint.js 并列，三者共用同一份调色板语言（derivePalette，style='bricks'）。

   版面（逻辑像素 1200×630，scale=2 时按 2400×1260 出图）：
     · 顶部 60px：标题栏。左＝工程名（24px 粗体），右＝BPM · 调式 · 时长（14px）
     · 中部 400px：主视觉。背景＝波形（rmsCurve 或 opts.waveformData 归一化后的包络，镜像填充 + 主题色渐变），
                   前景＝稀疏频谱竖线（缩略谱每 8 列采 1 列）
     · 底部 170px：信息区。左 600px＝关键数据（时长/调式/BPM/音符/段落/起音），
                   右 600px＝URL 文本（自动换行）+ **真·可扫描二维码**
   关于二维码：由 ./qrcode.js 现场编码（纯 JS 实现，纠错等级 M，版本 1–10 自动选），
    编码对象就是卡片上印的那个分享链接 —— 扫码即还原工程。
    链接超过 213 字节（v10-M 容量上限）时**退化为一小块"链接过长"提示，而不是画假码**：
    印一个扫不出来的图案比留白更误导。二维码不参与 seed 随机（它是链接的确定函数）。
    依赖：../core/util.js（clamp / mulberry32）、./cover.js（derivePalette）、./qrcode.js（encodeQR）。 */

import { clamp, mulberry32 } from '../core/util.js';
import { derivePalette } from './cover.js';
import { encodeQR } from './qrcode.js';

/* ---------- 常量 ---------- */
export const CARD_W=1200;
export const CARD_H=630;
const TOP_H=60;                 // 标题栏
const MID_H=400;                // 主视觉
const BOT_H=CARD_H-TOP_H-MID_H; // 信息区（170）
const PAD=32;                   // 左右留白
const COL_W=600;                // 信息区左右各 600px（规格）
const SPECTRO_STEP=8;           // 频谱竖线抽样步长（每 8 列采 1 列）
/* 二维码方框边长上限（逻辑像素）。信息区高 BOT_H=170，上下各留 3px。
   注意：**实际方框由模块数反推**（drawQR 里取整数 cell），所以这里只是上限。
   v4（33 模块）在 164px 上限下取到 cell=4 → 方框 164×164；v10（57 模块）取 cell=2 → 162×162。 */
const QR_SIZE=BOT_H-6;
const QR_QUIET=4;               // 静默区模块数（规范要求 ≥4）
const FONT='"Segoe UI","Microsoft YaHei",system-ui,sans-serif';
const MONO='ui-monospace,SFMono-Regular,Menlo,Consolas,monospace';

/* ---------- 小工具 ---------- */
const safe=(v,d)=>(typeof v==='number'&&isFinite(v))?v:d;
/** 给调色板里的 'hsl(...)' 字符串加透明度（derivePalette 只给不透明色，这里就地派生 hsla） */
function alpha(c,a){
  const s=String(c||'');
  if(s.indexOf('hsl(')===0)return 'hsla('+s.slice(4,-1)+','+clamp(a,0,1).toFixed(3)+')';
  if(s.indexOf('hsla(')===0)return s.replace(/,[^,)]*\)$/,'');
  return s;
}
/** 时长 → m:ss（≥60 分钟退回 123.4 秒，避免出现 1:02:03 这种过长文本） */
function fmtDur(sec){
  const s=Math.max(0,safe(sec,0));
  if(s>=3600)return s.toFixed(0)+' 秒';
  const m=Math.floor(s/60), r=Math.floor(s%60);
  return m+':'+(r<10?'0':'')+r;
}
/** 文本按宽度折行；超出 maxLines 时最后一行用 … 收尾。返回行数组（不修改入参） */
function wrapText(ctx,text,maxW,maxLines){
  const s=String(text==null?'':text);
  const out=[];
  if(!s)return out;
  /* 优先在这些位置断行（URL 友好）：/ ? & = - _ # ；**不含 '.'**，否则会把 "visualizer.html" 拆开 */
  const breakers='/?&=-_#';
  let rest=s;
  while(rest.length&&out.length<maxLines){
    if(ctx.measureText(rest).width<=maxW){ out.push(rest); rest=''; break }
    let cut=-1;
    for(let i=1;i<=rest.length;i++){
      if(ctx.measureText(rest.slice(0,i)).width>maxW)break;
      cut=i;
    }
    if(cut<=0)cut=1;                                   // 极窄：至少放一个字符，避免死循环
    let at=-1;
    for(let i=cut;i>0;i--){ if(breakers.indexOf(rest.charAt(i-1))>=0){ at=i; break } }
    if(at<=0)at=cut;
    out.push(rest.slice(0,at));
    rest=rest.slice(at);
  }
  if(rest.length&&out.length){
    let last=out[out.length-1];
    while(last.length>1&&ctx.measureText(last+'…').width>maxW)last=last.slice(0,-1);
    out[out.length-1]=last+'…';
  }
  return out;
}
/** 按可用宽度自动缩字号地画一行文本（返回实际用到的字号） */
function fitText(ctx,text,x,y,maxW,basePx,weight){
  const s=String(text==null?'':text);
  let fs=basePx;
  ctx.font=(weight||700)+' '+fs+'px '+FONT;
  const w=ctx.measureText(s).width;
  if(w>maxW&&w>0){
    fs=Math.max(basePx*0.55,fs*maxW/w);
    ctx.font=(weight||700)+' '+fs.toFixed(1)+'px '+FONT;
  }
  ctx.fillText(s,x,y);
  return fs;
}
/** 单行省略：超宽就从尾部截断加 …（用于标题栏右侧那行元信息） */
function ellipsize(ctx,text,maxW){
  let s=String(text==null?'':text);
  if(ctx.measureText(s).width<=maxW)return s;
  while(s.length>1&&ctx.measureText(s+'…').width>maxW)s=s.slice(0,-1);
  return s+'…';
}

/* =========================================================================
   1. 数据 → 绘制用数组
   ========================================================================= */
/** 波形包络：优先用 opts.waveformData（时域样本或曲线），否则用 features.rmsCurve。
    统一步骤：重采样到 n 段 → 每段取绝对值峰值（样本）或均值（曲线）→ 归一化到 0..1。
    返回 null 表示没有可用数据（此时主视觉只画底纹，不抛异常）。 */
function envelope(src,n){
  if(!src||!src.length||n<=0)return null;
  const out=new Float32Array(n);
  const L=src.length;
  if(L>=n*3){                                   // 视为高密度样本：分段取峰值（保留瞬态，形态更像波形）
    for(let i=0;i<n;i++){
      const a=Math.floor(i*L/n), b=Math.max(a+1,Math.floor((i+1)*L/n));
      let m=0;
      for(let k=a;k<b&&k<L;k++){ const v=Math.abs(safe(src[k],0)); if(v>m)m=v }
      out[i]=m;
    }
  }else{                                        // 视为曲线（rmsCurve）：线性插值采样
    for(let i=0;i<n;i++){
      const p=n<=1?0:(L-1)*(i/(n-1));
      const i0=Math.floor(p), i1=Math.min(L-1,i0+1), t=p-i0;
      out[i]=Math.abs(safe(src[i0],0)*(1-t)+safe(src[i1],0)*t);
    }
  }
  let mx=0;
  for(let i=0;i<n;i++)if(out[i]>mx)mx=out[i];
  if(!(mx>1e-9))return null;
  const k=1/mx;
  for(let i=0;i<n;i++)out[i]=clamp(out[i]*k,0,1);
  return out;
}
/** 频谱缩略：每 SPECTRO_STEP 列采 1 列，返回 {col,mean,peak} 三个 Float32Array（长度 = 抽样列数）。
    列能量用整列的均值（形态稳定性好）+ 峰值（给竖线加一个亮点）。 */
function spectroBars(f){
  const cols=safe(f.spectroCols,0)|0, rows=safe(f.spectroRows,0)|0, sp=f.spectrogram;
  if(!sp||cols<=0||rows<=0||sp.length<cols*rows)return null;
  const n=Math.max(1,Math.floor(cols/SPECTRO_STEP));
  const idx=new Int32Array(n), mean=new Float32Array(n), peak=new Float32Array(n);
  let mxMean=0, mxPeak=0;
  for(let i=0;i<n;i++){
    const c=Math.min(cols-1,i*SPECTRO_STEP);
    idx[i]=c;
    let s=0,p=0;
    for(let k=0;k<rows;k++){ const v=safe(sp[c*rows+k],0); s+=v; if(v>p)p=v }
    mean[i]=s/rows; peak[i]=p;
    if(mean[i]>mxMean)mxMean=mean[i];
    if(peak[i]>mxPeak)mxPeak=peak[i];
  }
  if(mxMean>1e-9){ const k=1/mxMean; for(let i=0;i<n;i++)mean[i]*=k }
  if(mxPeak>1e-9){ const k=1/mxPeak; for(let i=0;i<n;i++)peak[i]*=k }
  return {n,idx,mean,peak};
}

/* =========================================================================
   2. 绘制：底 / 标题栏 / 主视觉 / 信息区 / 装饰图案
   ========================================================================= */
function paintBase(ctx,pal,rng){
  const g=ctx.createLinearGradient(0,0,CARD_W,CARD_H);
  g.addColorStop(0,pal.bg);
  g.addColorStop(0.5,pal.bg);
  g.addColorStop(1,alpha(pal.primary,0.22));
  ctx.fillStyle=g; ctx.fillRect(0,0,CARD_W,CARD_H);
  /* 主视觉区域的柔光（让波形那一带亮起来） */
  const r=ctx.createRadialGradient(CARD_W*0.5,TOP_H+MID_H*0.55,0,CARD_W*0.5,TOP_H+MID_H*0.55,CARD_W*0.55);
  r.addColorStop(0,alpha(pal.primary,0.20));
  r.addColorStop(1,alpha(pal.bg,0));
  ctx.fillStyle=r; ctx.fillRect(0,0,CARD_W,CARD_H);
  /* 确定性颗粒：给大色块一点呼吸感（与 cover.js 同款做法，只是数量更多一点） */
  const path=new Path2D();
  for(let i=0;i<420;i++){
    const x=rng()*CARD_W, y=rng()*CARD_H, rr=0.4+rng()*1.6;
    path.moveTo(x+rr,y);
    path.arc(x,y,rr,0,Math.PI*2);
  }
  ctx.fillStyle=alpha(pal.accent,0.05);
  ctx.fill(path);
}
function paintTopBar(ctx,f,pal,opts,info){
  ctx.fillStyle=alpha(pal.bg,0.55);
  ctx.fillRect(0,0,CARD_W,TOP_H);
  ctx.fillStyle=alpha(pal.primary,0.16);
  ctx.fillRect(0,TOP_H-3,CARD_W,3);
  /* 左：工程名（24px 粗体）；右侧元信息要留位，最多占 620px */
  const name=String(info.title||'未命名工程');
  ctx.textAlign='left'; ctx.textBaseline='middle';
  ctx.fillStyle=pal.primary;
  fitText(ctx,name,PAD,TOP_H*0.5,600,24,700);      // 右侧元信息最少要 520px（32+600 ≤ 1200−32−520）
  /* 右：BPM · 调式 · 时长（14px）。缺失项自动省略，不留空占位符 */
  const meta=[];
  if(info.bpm)meta.push('BPM '+Math.round(info.bpm));
  if(info.keyName)meta.push(info.keyName);
  if(info.duration>0)meta.push(fmtDur(info.duration));
  if(info.notes!=null)meta.push(info.notes+' 音符');
  ctx.textAlign='right';
  ctx.fillStyle=alpha(pal.accent,0.92);
  ctx.font='600 14px '+FONT;
  ctx.fillText(ellipsize(ctx,meta.join('  ·  '),520),CARD_W-PAD,TOP_H*0.5);
}
/** 主视觉背景：波形包络（镜像填充 + 主题色渐变 + 上缘描线） */
function paintWave(ctx,pal,env){
  const y0=TOP_H, y1=TOP_H+MID_H, mid=(y0+y1)*0.5, half=MID_H*0.5-18;
  ctx.save();
  ctx.beginPath();
  ctx.rect(0,y0,CARD_W,MID_H);
  ctx.clip();
  const base=ctx.createLinearGradient(0,y0,0,y1);
  base.addColorStop(0,alpha(pal.bg,0.0));
  base.addColorStop(0.5,alpha(pal.primary,0.10));
  base.addColorStop(1,alpha(pal.bg,0.0));
  ctx.fillStyle=base; ctx.fillRect(0,y0,CARD_W,MID_H);
  if(env&&env.length>=2){
    const n=env.length, step=CARD_W/(n-1);
    /* 上缘包络 + 下缘镜像 → 一条闭合路径（一次 fill） */
    ctx.beginPath();
    ctx.moveTo(0,mid-env[0]*half);
    for(let i=1;i<n;i++)ctx.lineTo(i*step,mid-env[i]*half);
    for(let i=n-1;i>=0;i--)ctx.lineTo(i*step,mid+env[i]*half);
    ctx.closePath();
    const g=ctx.createLinearGradient(0,y0,0,y1);
    g.addColorStop(0,alpha(pal.highBand,0.50));
    g.addColorStop(0.32,alpha(pal.primary,0.62));
    g.addColorStop(0.5,alpha(pal.accent,0.30));
    g.addColorStop(0.68,alpha(pal.primary,0.62));
    g.addColorStop(1,alpha(pal.lowBand,0.50));
    ctx.fillStyle=g; ctx.fill();
    /* 上缘描线：让形态边界清晰（下缘不描，保持"水线"感） */
    ctx.beginPath();
    ctx.moveTo(0,mid-env[0]*half);
    for(let i=1;i<n;i++)ctx.lineTo(i*step,mid-env[i]*half);
    ctx.strokeStyle=alpha(pal.primary,0.95);
    ctx.lineWidth=2; ctx.lineJoin='round'; ctx.stroke();
  }
  /* 中轴线 */
  ctx.strokeStyle=alpha(pal.accent,0.18);
  ctx.lineWidth=1;
  ctx.beginPath(); ctx.moveTo(0,Math.round(mid)+0.5); ctx.lineTo(CARD_W,Math.round(mid)+0.5); ctx.stroke();
  ctx.restore();
}
/** 主视觉前景：稀疏频谱竖线（每 8 列采 1 列），从底边向上生长 */
function paintSpectro(ctx,pal,bars){
  if(!bars)return;
  const y1=TOP_H+MID_H, maxH=MID_H*0.82;
  ctx.save();
  ctx.beginPath(); ctx.rect(0,TOP_H,CARD_W,MID_H); ctx.clip();
  ctx.lineWidth=1.5;
  ctx.strokeStyle=alpha(pal.accent,0.20);
  ctx.beginPath();
  for(let i=0;i<bars.n;i++){
    const x=Math.round((i+0.5)/bars.n*CARD_W)+0.5;
    const h=bars.mean[i]*maxH;
    if(h<1)continue;
    ctx.moveTo(x,y1); ctx.lineTo(x,y1-h);
  }
  ctx.stroke();
  /* 峰值亮点：每根竖线顶端点一下（比竖线亮，形成"星光"） */
  ctx.fillStyle=alpha(pal.highBand,0.55);
  ctx.beginPath();
  for(let i=0;i<bars.n;i++){
    const x=Math.round((i+0.5)/bars.n*CARD_W)+0.5;
    const h=bars.mean[i]*maxH, ph=bars.peak[i]*maxH;
    if(h<1)continue;
    ctx.moveTo(x+1.8,y1-ph);
    ctx.arc(x,y1-ph,1.8,0,Math.PI*2);
  }
  ctx.fill();
  ctx.restore();
}
/** 底部信息区：左半关键数据（2 列 × 3 行），右半 URL + 真二维码 */
function paintBottom(ctx,pal,info){
  const y0=TOP_H+MID_H;
  ctx.fillStyle='rgba(0,0,0,0.28)';
  ctx.fillRect(0,y0,CARD_W,BOT_H);
  ctx.fillStyle=alpha(pal.primary,0.16);
  ctx.fillRect(0,y0,CARD_W,1);
  /* 左右分隔线（信息区左 600 / 右 600，规格） */
  ctx.fillStyle=alpha(pal.accent,0.14);
  ctx.fillRect(PAD+COL_W-8,y0+18,1,BOT_H-36);
  /* —— 左：关键数据 —— */
  const rows=[
    ['时长',info.duration>0?fmtDur(info.duration)+'（'+info.duration.toFixed(1)+' 秒）':'—'],
    ['调式',info.keyName||'未推断'],
    ['速度',info.bpm?('BPM '+Math.round(info.bpm)):'—'],
    ['音符',info.notes!=null?String(info.notes):'—'],
    ['段落',info.segments!=null?String(info.segments):'—'],
    ['起音',info.onsets!=null?String(info.onsets):'—']
  ];
  const colW=280, rowH=44, tx=PAD, ty=y0+30;
  ctx.textAlign='left'; ctx.textBaseline='alphabetic';
  for(let i=0;i<rows.length;i++){
    const cx2=tx+Math.floor(i/3)*colW, cy2=ty+((i%3)*rowH);
    ctx.font='600 12px '+FONT;
    ctx.fillStyle=alpha(pal.accent,0.72);
    ctx.fillText(rows[i][0],cx2,cy2);
    ctx.font='700 20px '+FONT;
    ctx.fillStyle=pal.primary;
    ctx.fillText(ellipsize(ctx,rows[i][1],colW-24),cx2,cy2+26);
  }
  /* —— 右：URL 文本 + 真二维码 —— */
  const qr=QR_SIZE;
  const qx=CARD_W-PAD-qr, qy=y0+(BOT_H-qr)/2;
  const urlX=PAD+COL_W+8, urlW=qx-16-urlX;
  ctx.textAlign='left'; ctx.textBaseline='alphabetic';
  const lines=[];
  ctx.font='700 13px '+FONT;
  ctx.fillStyle=alpha(pal.accent,0.80);
  ctx.fillText('扫码打开',urlX,y0+32);
  ctx.font='13px '+MONO;
  ctx.fillStyle=pal.primary;
  const wrap=wrapText(ctx,info.url,urlW,3);
  for(let i=0;i<wrap.length;i++)ctx.fillText(wrap[i],urlX,y0+56+i*19);
  if(info.hashKB>0){
    ctx.font='12px '+FONT;
    ctx.fillStyle=alpha(pal.accent,0.62);
    ctx.fillText('含分享数据 '+info.hashKB.toFixed(1)+' KB（扫码即还原工程）',urlX,y0+56+wrap.length*19+6);
  }
  info.qr=drawQR(ctx,qx,qy,qr,info.url,pal);
}
/** 真·二维码：把 info.url 编码成可扫描的二维码并画进给定方框。
 *  ⚠ 关键实现约束（踩过坑，别改）：**每模块必须取整数像素**。
 *    实测同一份正确编码，3px/模块 与 4px/模块 都能被 jsQR 解出，
 *    但 3.366px/模块 必然失败 —— 非整数格宽会让模块边界忽宽忽窄（有的 3px、有的 4px，
 *    且反复横跳），解码器采样时对不齐格心。所以这里先按可用边长求出**整数** cell，
 *    再由 cell 反推方框尺寸（方框因此略小于传入的 maxSize，居中放置即可）。
 *  - 链接超出容量（>213 字节）或编码失败 → 画"链接过长"提示，**绝不画假码**；
 *  - 白底 + 四周 ≥4 模块静默区（规范要求，缺了明显降低识别率）+ 纯黑模块。 */
function drawQR(ctx,x,y,maxSize,text,pal){
  const enc=encodeQR(text);
  if(!enc){
    /* 容量不足：画一个明确的"链接过长"提示，而不是假码 */
    ctx.save();
    ctx.fillStyle='#ffffff';
    ctx.fillRect(x,y,maxSize,maxSize);
    ctx.fillStyle=alpha(pal.primary,0.85);
    ctx.font='600 12px '+FONT;
    ctx.textAlign='center'; ctx.textBaseline='middle';
    ctx.fillText('链接过长',x+maxSize/2,y+maxSize/2-8);
    ctx.fillText('请扫上方文本',x+maxSize/2,y+maxSize/2+8);
    ctx.restore();
    return {ok:false,reason:'too-long'};
  }
  const n=enc.size;
  /* 整数 cell：含静默区后必须放得进 maxSize */
  const cell=Math.max(1,Math.floor(maxSize/(n+QR_QUIET*2)));
  const size=cell*(n+QR_QUIET*2);                  // 实际方框边长（≤ maxSize）
  const ox=x+Math.floor((maxSize-size)/2), oy=y+Math.floor((maxSize-size)/2);
  ctx.save();
  ctx.fillStyle='#ffffff';                         // 静默区与底必须高对比，不能用主题色
  ctx.fillRect(ox,oy,size,size);
  ctx.fillStyle='#000000';
  const px0=ox+QR_QUIET*cell, py0=oy+QR_QUIET*cell;
  for(let r=0;r<n;r++){
    for(let c=0;c<n;c++){
      if(enc.modules[r][c]!==1)continue;
      ctx.fillRect(px0+c*cell,py0+r*cell,cell,cell);   // 整数格 → 无亚像素缝、无宽窄抖动
    }
  }
  ctx.restore();
  return {ok:true,version:enc.version,mask:enc.mask,size:n,cell,box:size,quiet:QR_QUIET,x:ox,y:oy};
}

/* =========================================================================
   3. 主入口
   ========================================================================= */
/**
 * 生成一张分享卡片（就地绘制到传入的 canvas）。
 * @param {HTMLCanvasElement} canvas 目标画布（尺寸由本函数设为 1200×630 × scale）
 * @param {object|null} features analyzer.analyze() 的 FeatureObject（可为 null：只出底图与标题）
 * @param {{scale?:number,title?:string,projectName?:string,seed?:number,bpm?:number,
 *          shareUrl?:string,waveformData?:ArrayLike<number>,style?:string}} [opts]
 *        scale：1 或 2（2 = 2400×1260 导出用）；title/projectName 二者取一（title 优先）；
 *        seed：配色与装饰图案的确定性种子；bpm：工程 BPM（FeatureObject 里没有，调用方注入）；
 *        shareUrl：要印在卡片上的链接文本；waveformData：可选的高密度波形（时域样本）
 * @returns {{width:number,height:number,scale:number,palette:object,duration:number,bpm:number,
 *            keyName:string,notes:number|null,segments:number,onsets:number,url:string}}
 */
export function generateShareCard(canvas,features,opts={}){
  if(!canvas||typeof canvas.getContext!=='function')throw new Error('generateShareCard() 需要一个 HTMLCanvasElement');
  const ctx=canvas.getContext('2d');
  if(!ctx)throw new Error('generateShareCard() 无法获取 2d 上下文');
  const scale=clamp(Math.round(safe(opts.scale,1))||1,1,2);
  const px=Math.round(CARD_W*scale), py=Math.round(CARD_H*scale);
  /* 先按导出分辨率设定位图尺寸（赋值会重置上下文状态），再设逻辑坐标变换 */
  if(canvas.width!==px)canvas.width=px;
  if(canvas.height!==py)canvas.height=py;
  ctx.setTransform(scale,0,0,scale,0,0);
  ctx.clearRect(0,0,CARD_W,CARD_H);

  const f=(features&&typeof features==='object')?features:{};
  const seed=Math.max(0,Math.round(safe(opts.seed,1)));
  const style=(typeof opts.style==='string'&&opts.style)?opts.style:'bricks';   // 规格：复用 bricks 调色板
  const pal=derivePalette(f,seed,style);
  const rng=mulberry32((seed>>>0)||1);      // 仅用于底图纹理（二维码是链接的确定函数，不参与随机）

  /* 文案与数据：features 缺失时逐项降级，不留 undefined */
  const rawTitle=(typeof opts.title==='string'&&opts.title.trim())?opts.title
               :((typeof opts.projectName==='string'&&opts.projectName.trim())?opts.projectName
               :((typeof f.title==='string'&&f.title.trim())?f.title:'未命名工程'));
  const url=String(opts.shareUrl||'').trim();
  let hashKB=0;
  try{
    if(typeof location!=='undefined'&&location.hash&&location.hash.length>1)hashKB=(location.hash.length-1)/1024;
  }catch(e){}
  const info={
    title:rawTitle.trim(),
    duration:safe(f.duration,0),
    bpm:safe(opts.bpm,0),
    keyName:(f.key&&f.key.name)?String(f.key.name):'',
    notes:(f.noteCount!=null)?(f.noteCount|0):null,
    segments:(f.segments&&f.segments.length)||0,
    onsets:(f.onsets&&f.onsets.length)||0,
    url:url||'（未设置分享链接）',
    hashKB,
    patternSeed:seed
  };

  paintBase(ctx,pal,rng);
  const env=envelope(opts.waveformData&&opts.waveformData.length?opts.waveformData:f.rmsCurve,Math.min(600,CARD_W));
  paintWave(ctx,pal,env);
  paintSpectro(ctx,pal,spectroBars(f));
  paintTopBar(ctx,f,pal,opts,info);
  paintBottom(ctx,pal,info);

  return {width:CARD_W,height:CARD_H,scale,palette:pal,style,
          duration:info.duration,bpm:info.bpm,keyName:info.keyName,notes:info.notes,
          segments:info.segments,onsets:info.onsets,url:info.url,patternSeed:seed,
          /* qr：真二维码的编码结果（{ok,version,mask,size,cell,quiet} 或 {ok:false,reason}）
             透出来便于自检/单测确认"印的是可扫的真码"，而不是只看画面对不对。 */
          qr:info.qr||null};
}
