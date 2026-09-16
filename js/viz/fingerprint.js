/* [viz/fingerprint.js] FEAT-V4 / T4：音乐指纹（1920×400，一张可下载的"整曲肖像长图"）。
   与 cover.js 的分工：cover 是方形抽象封面（三种风格），fingerprint 只有一个版式、信息密度更高，
   它把整曲的四个维度并排铺开：

     ┌──────────────────────────────────────────────────────────┬──────────┐
     │ ① 上带 120px：低/中/高三频段堆叠面积图（横轴=时间）        │          │
     ├──────────────────────────────────────────────────────────┤ ④ 签名柱 │
     │ ② 中带 160px：缩略频谱图（底）+ 能量曲线折线（前景）       │  100px   │
     ├──────────────────────────────────────────────────────────┤  音高直方 │
     │ ③ 下带 100px：起音竖线 + 小节刻度                          │  图 + 调式│
     └──────────────────────────────────────────────────────────┴──────────┘

   依赖约束（T4 规格）：只 import cover.js 的 derivePalette 与 core/util.js 的 clamp。
   因此本文件自带少量工具（HSL→RGB、确定性 PRNG、频段聚合），并**不** import analyzer / transport / data。

   性能取向：
   - 除缩略频谱图外，全部用 Path2D 批量绘制（同色同线宽合并成一次 fill/stroke）；
   - 缩略频谱图是唯一的逐像素操作，用一次性 ImageData（下采样到 ≤900×160 ≈ 14 万像素后 putImageData），
     这是画热力图最省的做法；其余像素级操作一概没有。
   - 全程零 randomness 依赖：seed 只影响调色板与纹理图案，同 (features,seed) 必出同一张图。

   features 需要的字段全部做了缺省兜底（缺字段/NaN 都能出图）：
   duration / rmsCurve / onsets / segments / bandEnergy / spectrogram(+spectroCols/spectroRows/binHz) /
   bars / meterN / barDensity / pitchHistogram / key{name,modeName,mode}。 */

import { clamp } from '../core/util.js';
import { derivePalette } from './cover.js';

export const FP_W=1920, FP_H=400;         // 指纹逻辑尺寸（导出分辨率 = ×scale）

/* 版式：三条横向带的高度按 T4 规格（120/160/100），右端留 100px 签名柱 */
const PAD_L=16, PAD_R=12, PAD_T=8, PAD_B=12;
const SIG_W=100;
const H_TOP=120, H_MID=160, H_BOT=100;

/* =========================================================================
   1. 本地小工具（依赖约束：只能 import clamp 与 derivePalette）
   ========================================================================= */
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
function curveMax(a,def){
  if(!a||!a.length)return def==null?0:def;
  let m=0;
  for(let i=0;i<a.length;i++){ const v=a[i]; if(Number.isFinite(v)&&v>m)m=v }
  return m;
}
function hsl(h,s,l,a){
  const hh=((h%360)+360)%360;
  return a==null?('hsl('+hh.toFixed(1)+','+clamp(s,0,100).toFixed(1)+'%,'+clamp(l,0,100).toFixed(1)+'%)')
                :('hsla('+hh.toFixed(1)+','+clamp(s,0,100).toFixed(1)+'%,'+clamp(l,0,100).toFixed(1)+'%,'+clamp(a,0,1).toFixed(3)+')');
}
/** HSL→RGB（0-255）：只有 ImageData 需要数值 RGB，画布本身用 hsl() 字符串即可 */
function hslRgb(h,s,l){
  const hh=(((h%360)+360)%360)/360, ss=clamp(s,0,100)/100, ll=clamp(l,0,100)/100;
  if(ss<1e-6){ const v=Math.round(ll*255); return [v,v,v] }
  const q=ll<0.5?ll*(1+ss):ll+ss-ll*ss, p=2*ll-q;
  const f=(t)=>{
    let x=t; if(x<0)x+=1; if(x>1)x-=1;
    if(x<1/6)return p+(q-p)*6*x;
    if(x<1/2)return q;
    if(x<2/3)return p+(q-p)*(2/3-x)*6;
    return p;
  };
  return [Math.round(f(hh+1/3)*255),Math.round(f(hh)*255),Math.round(f(hh-1/3)*255)];
}

/* =========================================================================
   2. 数据聚合
   ========================================================================= */
/** 每列的频段能量（低/中/高）。缩略频谱存在时用它按列求和，否则回落到全局 bandEnergy 的平线。 */
function bandSeries(f){
  const cols=safe(f.spectroCols,0)|0, rows=safe(f.spectroRows,0)|0, sp=f.spectrogram;
  if(!sp||cols<=0||rows<=0||sp.length<cols*rows){
    const g=f.bandEnergy||{low:0.34,mid:0.33,high:0.33};
    const n=64;
    const low=new Float32Array(n),mid=new Float32Array(n),high=new Float32Array(n);
    for(let i=0;i<n;i++){ low[i]=frac(g.low); mid[i]=frac(g.mid); high[i]=frac(g.high) }
    return {n,low,mid,high,src:'bandEnergy'};
  }
  const binHz=safe(f.binHz,21.53), rowHz=binHz*2;
  const kLow=clamp(Math.round(250/rowHz),1,rows-1);
  const kMid=clamp(Math.round(2000/rowHz),kLow+1,rows);
  const low=new Float32Array(cols),mid=new Float32Array(cols),high=new Float32Array(cols),mag=new Float32Array(cols);
  let mxTot=0;
  for(let c=0;c<cols;c++){
    const base=c*rows;
    let a=0,b=0,d=0;
    for(let k=0;k<rows;k++){
      const v=safe(sp[base+k],0);
      if(k<kLow)a+=v; else if(k<kMid)b+=v; else d+=v;
    }
    const tot=a+b+d;
    low[c]=tot>1e-9?a/tot:0;                 // 每列三层占比（和 = 1）
    mid[c]=tot>1e-9?b/tot:0;
    high[c]=tot>1e-9?d/tot:0;
    mag[c]=tot;                              // 每列总强度（稍后按全局峰值归一）
    if(tot>mxTot)mxTot=tot;
  }
  const inv=mxTot>1e-9?1/mxTot:0;
  for(let c=0;c<cols;c++)mag[c]=clamp(mag[c]*inv,0,1);
  return {n:cols,low,mid,high,mag,src:'spectrogram'};
}
/** 12 音直方图 → [音级, 计数] 数组（按音高从高到低排，绘图时自上而下） */
function pitchRows(f){
  const h=f.pitchHistogram;
  const rows=[];
  let mx=0;
  for(let p=0;p<12;p++){ const v=safe(h&&h[p],0); if(v>mx)mx=v }
  for(let i=0;i<12;i++){
    const pc=11-i;                      // 顶部放 B(11)，底部放 C(0)
    rows.push({pc,count:safe(h&&h[pc],0),norm:mx>1e-9?frac(safe(h&&h[pc],0)/mx):0});
  }
  return {rows,max:mx};
}
const NOTE_NAMES=['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
/** 大数字缩写：2518 → '2.5k'（签名柱只有 100px 宽，长数字会把统计行顶出面板右边） */
function fmtK(n){
  const v=Math.max(0,Math.round(safe(n,0)));
  if(v<1000)return String(v);
  const k=v/1000;
  return (k<10?k.toFixed(1):String(Math.round(k)))+'k';
}
/**
 * 把一段文字裁到指定宽度以内（超长加省略号）。签名柱只有 82px 可用宽度，
 * 工程名/调式/统计都可能超宽 —— 修复前统计行右边界到 1956（画布 1920）被裁掉半截，
 * 现在所有列内文本一律先过这里，保证右边界不越出面板。
 */
function fitText(ctx,text,maxW,font){
  ctx.font=font;
  let t=String(text==null?'':text);
  if(!(maxW>4))return '';
  if(ctx.measureText(t).width<=maxW)return t;
  while(t.length>1&&ctx.measureText(t+'…').width>maxW)t=t.slice(0,-1);
  return t+'…';
}
/** 按顺序拼接若干片段，只保留"拼上后仍不超宽"的前缀（用于统计行：能放几项放几项） */
function fitParts(ctx,parts,sep,maxW,font){
  ctx.font=font;
  const list=(parts||[]).filter(p=>p!=null&&String(p).length);
  if(!list.length)return '';
  let out=String(list[0]);
  for(let i=1;i<list.length;i++){
    const next=out+sep+list[i];
    if(ctx.measureText(next).width<=maxW)out=next; else break;
  }
  return ctx.measureText(out).width<=maxW?out:fitText(ctx,out,maxW,font);
}

/* =========================================================================
   3. 公共绘制
   ========================================================================= */
function paintBackground(ctx,pal,pn,rng){
  const g=ctx.createLinearGradient(0,0,FP_W,FP_H);
  g.addColorStop(0,hsl(pn.bgH,pn.bgS+4,pn.bgL+3));
  g.addColorStop(0.6,hsl(pn.bgH,pn.bgS,pn.bgL));
  g.addColorStop(1,hsl(pn.bgH+34,pn.bgS+6,Math.max(2,pn.bgL-2)));
  ctx.fillStyle=g;
  ctx.fillRect(0,0,FP_W,FP_H);
  /* 极淡的横向格线：把"四区"的版式感先立起来（一次 Path2D） */
  const path=new Path2D();
  for(const y of [PAD_T,PAD_T+H_TOP,PAD_T+H_TOP+H_MID,PAD_T+H_TOP+H_MID+H_BOT]){
    path.moveTo(0,y+0.5); path.lineTo(FP_W,y+0.5);
  }
  ctx.strokeStyle=hsl(pn.primaryH,pn.primaryS*0.4,pn.primaryL,0.12);
  ctx.lineWidth=1;
  ctx.stroke(path);
  /* 确定性颗粒（同 seed 同图案）：给大面积色块一点呼吸感 */
  const dots=new Path2D();
  for(let i=0;i<220;i++){
    const x=rng()*FP_W, y=rng()*FP_H, r=0.4+rng()*1.4;
    dots.moveTo(x+r,y); dots.arc(x,y,r,0,Math.PI*2);
  }
  ctx.fillStyle=hsl(pn.primaryH,30,88,0.05);
  ctx.fill(dots);
}
function paintTitleBlock(ctx,f,pn,rng,x,y,w){
  const name=(typeof f.title==='string'&&f.title.trim())?f.title.trim():'音乐指纹';
  ctx.textAlign='left'; ctx.textBaseline='top';
  const tFont='700 13px "Segoe UI","Microsoft YaHei",system-ui,sans-serif';
  const title=fitText(ctx,name,w,tFont);                 // 工程名过长时裁到列宽（原来直接画会顶出画布）
  ctx.fillStyle=hsl(pn.primaryH,20,96,0.95);
  ctx.fillText(title,x,y);
  /* 元信息也按"能放几项放几项"处理：原来固定拼三项，长工程（420s · 32 段 · 900 击）会超出右边界 */
  const meta=fitParts(ctx,[safe(f.duration,0).toFixed(0)+'s',
                           ((f.segments&&f.segments.length)||0)+' 段'],' · ',w,
                      '500 10px "Segoe UI","Microsoft YaHei",system-ui,sans-serif');
  ctx.fillStyle=hsl(pn.primaryH,24,86,0.62);
  if(meta)ctx.fillText(meta,x,y+17);
  ctx.textBaseline='alphabetic';
}
/** 段落分隔：上带/中带共用的竖向虚线（时间轴的分段感） */
function paintSegmentLines(ctx,f,pal,pn,x0,y0,h,w){
  const segs=(f.segments&&f.segments.length)?f.segments:null;
  if(!segs||!w)return;
  const dur=Math.max(0.01,safe(f.duration,1));
  const path=new Path2D();
  let n=0;
  for(const s of segs){
    const t=clamp(safe(s.start,0)/dur,0,1);
    if(t<=0.001||t>=0.999)continue;
    const x=x0+t*w;
    path.moveTo(x,y0); path.lineTo(x,y0+h);
    n++;
  }
  if(!n)return;
  ctx.save();
  ctx.setLineDash([3,5]);
  ctx.strokeStyle=hsl(pn.primaryH,pn.primaryS*0.5,pn.primaryL,0.30);
  ctx.lineWidth=1;
  ctx.stroke(path);
  ctx.restore();
}

/* =========================================================================
   4. ① 上带：三频段堆叠面积图
   ========================================================================= */
function drawTopBand(ctx,f,pal,pn,bs,x0,y0,w,h){
  /* 面板底：比背景略亮的内凹块，让三条带在视觉上"分块" */
  ctx.fillStyle=hsl(pn.bgH,pn.bgS,pn.bgL+4,0.55);
  ctx.fillRect(x0,y0,w,h);
  const n=bs.n;
  if(n>0&&w>0){
    const xs=(i)=>x0+w*(i/(n-1||1));
    const pad=h*0.10, base=y0+h-pad, usable=h-2*pad;
    /* 每列三层厚度：占比（低+中+高=1）× 该列总强度 × 可用高度。
       有缩略频谱时总强度由频谱列和归一化得到（真实的强弱起伏）；没有时退化为等强度。 */
    const useMag=!!bs.mag;
    const tLow=new Float32Array(n), tMid=new Float32Array(n), tHigh=new Float32Array(n);
    const offMid=new Float32Array(n), offHigh=new Float32Array(n);
    for(let i=0;i<n;i++){
      const m=useMag?clamp(bs.mag[i],0.10,1):1;
      tLow[i]=bs.low[i]*m*usable;
      tMid[i]=bs.mid[i]*m*usable;
      tHigh[i]=bs.high[i]*m*usable;
      offMid[i]=tLow[i];                       // 中频的下沿 = 低频的上沿
      offHigh[i]=tLow[i]+tMid[i];              // 高频的下沿 = 低+中
    }
    const fillLayer=(thick,off,color,alpha)=>{
      const p=new Path2D();
      for(let i=0;i<n;i++){
        const yTop=base-(off?off[i]:0)-thick[i];
        if(i===0)p.moveTo(xs(i),yTop); else p.lineTo(xs(i),yTop);
      }
      for(let i=n-1;i>=0;i--)p.lineTo(xs(i),base-(off?off[i]:0));
      p.closePath();
      ctx.globalAlpha=alpha;
      ctx.fillStyle=color;
      ctx.fill(p);
      ctx.globalAlpha=1;
    };
    fillLayer(tLow,null,pal.lowBand,0.82);                 // 低频：贴底
    fillLayer(tMid,offMid,pal.midBand,0.72);               // 中频：叠在低频上
    fillLayer(tHigh,offHigh,pal.highBand,0.62);            // 高频：最上层
    /* 分界轮廓线：低频上沿 + 低+中上沿 + 总上沿，各描一次（合并成 3 条子路径） */
    const outline=new Path2D();
    for(let i=0;i<n;i++){
      const x=xs(i);
      if(i===0){ outline.moveTo(x,base-offMid[i]); outline.moveTo(x,base-offHigh[i]); outline.moveTo(x,base-offHigh[i]-tHigh[i]); }
      else { outline.lineTo(x,base-offMid[i]); outline.moveTo(x,base-offHigh[i]); outline.moveTo(x,base-offHigh[i]-tHigh[i]); }
    }
    ctx.strokeStyle=hsl(pn.primaryH,20,96,0.22);
    ctx.lineWidth=1;
    ctx.stroke(outline);
    paintSegmentLines(ctx,f,pal,pn,x0,y0,h,w);
  }
  /* 带内标题（左上角） */
  ctx.textAlign='left'; ctx.textBaseline='top';
  ctx.font='600 10px "Segoe UI","Microsoft YaHei",system-ui,sans-serif';
  ctx.fillStyle=hsl(pn.primaryH,26,88,0.55);
  ctx.fillText('频段构成 · 低 / 中 / 高'+(bs.src==='spectrogram'?'':'（无频谱数据，按全局占比平铺）'),x0+8,y0+6);
  ctx.textBaseline='alphabetic';
}

/* =========================================================================
   5. ② 中带：缩略频谱图 + 能量曲线
   ========================================================================= */
function buildSpectroImage(f,w,h,pn){
  const sp=f.spectrogram;
  const cols=safe(f.spectroCols,0)|0, rows=safe(f.spectroRows,0)|0;
  if(!sp||cols<=0||rows<=0||sp.length<cols*rows||w<=0||h<=0)return null;
  const W=Math.max(1,Math.min(Math.round(w),cols));
  const H=Math.max(1,Math.min(Math.round(h),rows));
  let cv=null;
  try{
    cv=(typeof OffscreenCanvas==='function')?new OffscreenCanvas(W,H):document.createElement('canvas');
    cv.width=W; cv.height=H;
  }catch(e){ return null }
  const g=cv.getContext?cv.getContext('2d'):null;
  if(!g||typeof g.createImageData!=='function')return null;
  /* 色带：暗底 → 主色 → 中频色 → 高频色 → 近白（32 级查表，避免逐像素算 HSL） */
  const LUT=32, lut=new Array(LUT);
  for(let i=0;i<LUT;i++){
    const t=i/(LUT-1);
    let rgb;
    if(t<0.35){ const k=t/0.35; rgb=mix(hslRgb(pn.bgH,pn.bgS,pn.bgL-2),hslRgb(pn.primaryH,pn.primaryS*0.9,pn.primaryL-6),k) }
    else if(t<0.7){ const k=(t-0.35)/0.35; rgb=mix(hslRgb(pn.midH,pn.midS,pn.midL),hslRgb(pn.highH,pn.highS,pn.highL),k) }
    else { const k=(t-0.7)/0.3; rgb=mix(hslRgb(pn.highH,pn.highS,pn.highL),hslRgb(pn.primaryH,30,96),k) }
    lut[i]=rgb;
  }
  const img=g.createImageData(W,H);
  const d=img.data;
  const cw=cols/W, ch=rows/H;
  for(let x=0;x<W;x++){
    const c0=Math.min(cols-1,Math.floor(x*cw)), c1=Math.max(c0+1,Math.min(cols,Math.floor((x+1)*cw)));
    for(let y=0;y<H;y++){
      const r0=Math.min(rows-1,Math.floor(y*ch)), r1=Math.max(r0+1,Math.min(rows,Math.floor((y+1)*ch)));
      let s=0,n=0;
      for(let c=c0;c<c1;c++){
        const base=c*rows;
        for(let r=r0;r<r1;r++){ s+=safe(sp[base+r],0); n++ }
      }
      const v=n?clamp(s/n,0,1):0;
      const col=lut[Math.min(LUT-1,Math.round(v*(LUT-1)))];
      const idx=((H-1-y)*W+x)*4;              // 行 0 = 低频 → 画在底部
      d[idx]=col[0]; d[idx+1]=col[1]; d[idx+2]=col[2]; d[idx+3]=255;
    }
  }
  g.putImageData(img,0,0);
  return {cv,W,H};
}
const mix=(a,b,k)=>[Math.round(a[0]+(b[0]-a[0])*k),Math.round(a[1]+(b[1]-a[1])*k),Math.round(a[2]+(b[2]-a[2])*k)];

function drawMidBand(ctx,f,pal,pn,x0,y0,w,h,rng){
  ctx.save();
  ctx.beginPath(); ctx.rect(x0,y0,w,h); ctx.clip();          // 频谱图只在带内出现
  const img=buildSpectroImage(f,w,h,pn);
  if(img){
    ctx.imageSmoothingEnabled=true;
    ctx.globalAlpha=0.92;
    ctx.drawImage(img.cv,0,0,img.W,img.H,x0,y0,w,h);
    ctx.globalAlpha=1;
  }else{
    ctx.fillStyle=hsl(pn.bgH,pn.bgS,pn.bgL+4,0.7);
    ctx.fillRect(x0,y0,w,h);
  }
  /* 前景：能量曲线（rmsCurve 归一化） */
  const rc=f.rmsCurve, n=rc&&rc.length?rc.length:0;
  if(n>1&&w>0){
    const mx=curveMax(rc,1)||1;
    const pad=h*0.12, usable=h-2*pad;
    const p=new Path2D();
    for(let i=0;i<n;i++){
      const x=x0+w*(i/(n-1));
      const v=clamp(safe(rc[i],0)/mx,0,1);
      const y=y0+pad+usable*(1-v);
      if(i===0)p.moveTo(x,y); else p.lineTo(x,y);
    }
    ctx.strokeStyle=hsl(pn.primaryH,12,10,0.55);             // 先描一层暗边，保证在任何底色上可读
    ctx.lineWidth=3.2; ctx.stroke(p);
    ctx.strokeStyle=hsl(pn.primaryH,18,97,0.92);
    ctx.lineWidth=1.6; ctx.stroke(p);
  }
  paintSegmentLines(ctx,f,pal,pn,x0,y0,h,w);
  ctx.restore();
  /* 带内标签 + 边框 */
  ctx.strokeStyle=hsl(pn.primaryH,pn.primaryS*0.4,pn.primaryL,0.18);
  ctx.lineWidth=1;
  ctx.strokeRect(x0+0.5,y0+0.5,w-1,h-1);
  ctx.textAlign='left'; ctx.textBaseline='top';
  ctx.font='600 10px "Segoe UI","Microsoft YaHei",system-ui,sans-serif';
  ctx.fillStyle=hsl(pn.primaryH,26,92,0.72);
  ctx.fillText('频谱图 + 能量曲线',x0+8,y0+6);
  ctx.textBaseline='alphabetic';
}

/* =========================================================================
   6. ③ 下带：起音竖线 + 小节刻度
   ========================================================================= */
function drawBottomBand(ctx,f,pal,pn,bs,x0,y0,w,h){
  ctx.fillStyle=hsl(pn.bgH,pn.bgS,pn.bgL+3,0.5);
  ctx.fillRect(x0,y0,w,h);
  const dur=Math.max(0.01,safe(f.duration,1));
  const rc=f.rmsCurve, rmx=curveMax(rc,1)||1;
  const rmsAt=(t)=>{
    if(!rc||!rc.length)return 0;
    const i=clamp(Math.round(t/dur*(rc.length-1)),0,rc.length-1);
    return clamp(safe(rc[i],0)/rmx,0,1);
  };
  /* 小节刻度：每小节一根，高度随该小节密度（barDensity=每拍音符数） */
  const bd=f.barDensity;
  const bars=bd&&bd.length?bd.length:Math.max(1,safe(f.bars,1)|0);
  if(bars>0&&w>0){
    let mx=0;
    for(let i=0;i<bars;i++){ const v=safe(bd&&bd[i],0); if(v>mx)mx=v }
    const p=new Path2D();
    for(let b=0;b<bars;b++){
      const x=x0+w*((b+0.5)/bars);
      const d=mx>1e-9?clamp(safe(bd&&bd[b],0)/mx,0,1):0.4;
      const hh=h*0.16+h*0.30*d;
      p.moveTo(x,y0+h-hh); p.lineTo(x,y0+h);
    }
    ctx.strokeStyle=hsl(pn.primaryH,pn.primaryS*0.6,pn.primaryL+10,0.30);
    ctx.lineWidth=1;
    ctx.stroke(p);
  }
  /* 起音竖线：从带顶往下，长度随该处能量 */
  const ons=f.onsets;
  if(ons&&ons.length&&w>0){
    const p=new Path2D();
    let n=0;
    for(let i=0;i<ons.length;i++){
      const t=safe(ons[i],-1);
      if(t<0||t>dur)continue;
      const x=x0+w*(t/dur);
      const e=rmsAt(t);
      const hh=h*(0.22+0.55*e);
      p.moveTo(x,y0+2); p.lineTo(x,y0+2+hh);
      n++;
    }
    if(n){
      ctx.strokeStyle=hsl(pn.accentH,pn.accentS,pn.accentL,0.72);
      ctx.lineWidth=1.3;
      ctx.stroke(p);
    }
  }
  /* 基线 + 标签 */
  ctx.strokeStyle=hsl(pn.primaryH,pn.primaryS*0.5,pn.primaryL,0.28);
  ctx.lineWidth=1;
  ctx.beginPath(); ctx.moveTo(x0,y0+h-0.5); ctx.lineTo(x0+w,y0+h-0.5); ctx.stroke();
  ctx.textAlign='left'; ctx.textBaseline='top';
  ctx.font='600 10px "Segoe UI","Microsoft YaHei",system-ui,sans-serif';
  ctx.fillStyle=hsl(pn.primaryH,26,88,0.55);
  ctx.fillText('起音 '+(ons?ons.length:0)+' · 小节 '+bars,x0+8,y0+6);
  ctx.textBaseline='alphabetic';
}

/* =========================================================================
   7. ④ 最右签名柱：12 音直方图 + 调式 + 统计 + seed
   参数 seed 必须显式传入：修复前这里读的是 f.__seed（从未被写入），所以永远显示 "seed 0"。
   ========================================================================= */
function drawSignature(ctx,f,pal,pn,rng,x0,y0,w,h,seed){
  /* 面板 */
  ctx.fillStyle=hsl(pn.bgH,pn.bgS,pn.bgL+6,0.85);
  ctx.fillRect(x0,y0,w,h);
  ctx.strokeStyle=hsl(pn.primaryH,pn.primaryS*0.6,pn.primaryL,0.30);
  ctx.lineWidth=1;
  ctx.strokeRect(x0+0.5,y0+0.5,w-1,h-1);
  paintTitleBlock(ctx,f,pn,rng,x0+9,y0+9,w-18);

  const pr=pitchRows(f);
  /* 行高上限 17.5：底部文字块占 y0+h-48 起（64px 预留：48 + 16 行高），保证直方图与文字不重叠 */
  const top=y0+52, rowH=Math.min(17.5,(h-52-64)/12);
  /* 12 行：音高从高到低，条形长度 = 计数占比 */
  const barX=x0+30, barMaxW=w-30-10;
  const bars=new Path2D();
  const labels=[];
  for(let i=0;i<pr.rows.length;i++){
    const r=pr.rows[i], y=top+i*rowH;
    const bw=Math.max(1.5,barMaxW*r.norm);
    bars.moveTo(barX,y+rowH*0.18);
    bars.lineTo(barX+bw,y+rowH*0.18);
    labels.push([NOTE_NAMES[r.pc],y+rowH*0.18,r.norm,r.count]);
  }
  ctx.strokeStyle=hsl(pn.midH,pn.midS,pn.midL,0.85);
  ctx.lineWidth=Math.max(3,rowH*0.52);
  ctx.lineCap='butt';
  ctx.stroke(bars);
  /* 行标签：音名 + 计数（只在有条目时写计数，避免噪声） */
  ctx.font='600 9px "Segoe UI","Microsoft YaHei",system-ui,sans-serif';
  ctx.textAlign='left'; ctx.textBaseline='middle';
  for(const [name,ly,norm,count] of labels){
    ctx.fillStyle=hsl(pn.primaryH,22,92,norm>0.02?0.92:0.42);
    ctx.fillText(name,x0+11,ly);
    if(norm>0.08&&count>0){
      ctx.font='500 8px ui-monospace,Consolas,monospace';
      ctx.fillStyle=hsl(pn.primaryH,18,88,0.55);
      ctx.fillText(String(count),Math.min(barX+barMaxW-14,barX+Math.max(1.5,barMaxW*norm)+4),ly);
      ctx.font='600 9px "Segoe UI","Microsoft YaHei",system-ui,sans-serif';
    }
  }
  ctx.textBaseline='alphabetic';
  /* 底部文字块：三行自下而上排，行高 16px；字号 11/9/8（原来是 11/9/8 但行距 30px 且从 y0+h-52 起排，
     最下一行贴到面板底、统计行又超宽被画布右边界裁掉）。现在：
       seed 行 y=372（底 380）· 统计行 y=356 · 调式行 y=340（底 351）
     三行的底边界都 ≤ 388（面板底）且在 400 画布内，右边界一律由 fitText/fitParts 约束在 w-18 内。 */
  const maxW=w-18;                                          // 左右各留 9px（100px 列宽 → 可用 82px）
  /* 字号取法：列宽只有 100px，11px 时一行只放得下约 7 个汉字，所以只有调式行用 11px，
     统计行与 seed 行用 8px —— 这样"音符 2.5k · 鼓 424 · 声场 42%"能一次放全，
     再多就由 fitParts 按"能放几项放几项"降级（宁可少一项信息，也不越界裁字）。 */
  const keyFont='700 11px "Segoe UI","Microsoft YaHei",system-ui,sans-serif';
  const statFont='500 8px "Segoe UI","Microsoft YaHei",system-ui,sans-serif';
  const seedFont='500 8px ui-monospace,Consolas,monospace';
  const yKey=y0+h-48, yStat=y0+h-32, ySeed=y0+h-16;         // = 340 / 356 / 372（h=380, y0=8）
  const keyName=(f.key&&f.key.name)||'调式未推断';
  ctx.textAlign='left'; ctx.textBaseline='top';
  ctx.fillStyle=hsl(pn.accentH,pn.accentS,pn.accentL,0.95);
  ctx.fillText(fitText(ctx,keyName,maxW,keyFont),x0+9,yKey);
  /* 统计行：数字用 2.5k 缩写，且"能放几项放几项"（放不下就少放一项，而不是越界） */
  const stats=fitParts(ctx,[
    (f.noteCount!=null?('音符 '+fmtK(f.noteCount)):''),
    (f.drumHits!=null?('鼓 '+fmtK(f.drumHits)):''),
    (f.stereoWidth!=null?('声场 '+Math.round(frac(f.stereoWidth)*100)+'%'):'')
  ],' · ',maxW,statFont);
  ctx.fillStyle=hsl(pn.primaryH,22,86,0.6);
  if(stats)ctx.fillText(stats,x0+9,yStat);
  ctx.fillStyle=hsl(pn.primaryH,16,80,0.45);
  ctx.fillText(fitText(ctx,'seed '+String(safe(seed,0)),maxW,seedFont),x0+9,ySeed);
  ctx.textBaseline='alphabetic';
}

/* =========================================================================
   8. 主入口
   ========================================================================= */
/**
 * 生成音乐指纹长图（就地绘制到传入 canvas）。
 * @param {HTMLCanvasElement} canvas 目标画布（尺寸由本函数按 1920×400×scale 设定）
 * @param {object} features analyzer.analyze() 的 FeatureObject（可为 null/空对象：只出版式骨架）
 * @param {number} seed 确定性种子（同 features+seed 必出同一张图）
 * @param {{scale?:number,title?:string}} [opts] scale 1|2（2 = 3840×800 导出用）
 * @returns {{width:number,height:number,scale:number,palette:object,onsets:number,bars:number,columns:number,bandSource:string,pitchSum:number}}
 */
export function generateFingerprint(canvas,features,seed,opts={}){
  if(!canvas||typeof canvas.getContext!=='function')throw new Error('generateFingerprint() 需要一个 HTMLCanvasElement');
  const ctx=canvas.getContext('2d');
  if(!ctx)throw new Error('generateFingerprint() 无法获取 2d 上下文');
  const scale=clamp(Math.round(safe(opts.scale,1))||1,1,2);
  const pw=Math.round(FP_W*scale), ph=Math.round(FP_H*scale);
  if(canvas.width!==pw)canvas.width=pw;
  if(canvas.height!==ph)canvas.height=ph;
  ctx.setTransform(scale,0,0,scale,0,0);
  ctx.clearRect(0,0,FP_W,FP_H);

  const f=features||{};
  if(typeof opts.title==='string')f.title=opts.title;          // 标题由调用方给（与 cover 的 opts.title 同约定）
  const pal=derivePalette(f,safe(seed,0),'bricks');            // 指纹固定用不偏移的原色
  const pn=paletteNumsLocal(f,safe(seed,0));
  const rng=mulberry32(safe(seed,0)>>>0);
  const bs=bandSeries(f);

  paintBackground(ctx,pal,pn,rng);

  const contentW=FP_W-PAD_L-PAD_R-SIG_W-10;
  const x0=PAD_L, yTop=PAD_T, yMid=yTop+H_TOP, yBot=yMid+H_MID;
  drawTopBand(ctx,f,pal,pn,bs,x0,yTop,contentW,H_TOP);
  drawMidBand(ctx,f,pal,pn,x0,yMid,contentW,H_MID,rng);
  drawBottomBand(ctx,f,pal,pn,bs,x0,yBot,contentW,H_BOT);
  drawSignature(ctx,f,pal,pn,rng,x0+contentW+10,yTop,SIG_W,H_TOP+H_MID+H_BOT,safe(seed,0));

  const pr=pitchRows(f);
  const barCount=(f.barDensity&&f.barDensity.length)||Math.max(0,safe(f.bars,0)|0);
  return {width:FP_W,height:FP_H,scale,palette:pal,
          onsets:(f.onsets&&f.onsets.length)||0,
          bars:barCount,
          columns:bs.n,
          bandSource:bs.src,
          pitchSum:pr.rows.reduce((a,r)=>a+r.count,0)};
}

/* 指纹自己的数值调色板：与 cover.js 的 paletteNums 同源，但 cover 没有导出它，
   所以这里用 derivePalette 的结果反推需要的几个数值（色相/饱和度/明度），避免重复推导逻辑。
   解析 `hsl(h,s%,l%)` 即可；格式由 cover.js 的 hsl() 保证。 */
function paletteNumsLocal(f,seed){
  const p=derivePalette(f,seed,'bricks');
  const parse=(s,def)=>{
    const m=/hsl\((-?[\d.]+),([\d.]+)%,([\d.]+)%\)/.exec(String(s||''));
    return m?{h:parseFloat(m[1]),s:parseFloat(m[2]),l:parseFloat(m[3])}:def;
  };
  const primary=parse(p.primary,{h:32,s:60,l:48});
  const secondary=parse(p.secondary,{h:70,s:50,l:34});
  const accent=parse(p.accent,{h:200,s:74,l:58});
  const low=parse(p.lowBand,{h:6,s:70,l:30});
  const mid=parse(p.midBand,{h:48,s:64,l:46});
  const high=parse(p.highBand,{h:96,s:72,l:62});
  const bg=parse(p.bg,{h:44,s:14,l:8});
  return {bgH:bg.h,bgS:bg.s,bgL:bg.l,
          primaryH:primary.h,primaryS:primary.s,primaryL:primary.l,
          secondH:secondary.h,secondS:secondary.s,secondL:secondary.l,
          accentH:accent.h,accentS:accent.s,accentL:accent.l,
          lowH:low.h,lowS:low.s,lowL:low.l,
          midH:mid.h,midS:mid.s,midL:mid.l,
          highH:high.h,highS:high.s,highL:high.l};
}
