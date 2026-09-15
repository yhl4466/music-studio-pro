/* [viz/renderers/spectrogram.js] 频谱瀑布图（FEAT-V2 / T2，T2.1 视觉增强）。
   形态：低频在下、高频在上，时间自左向右流动（新数据从右边进），过去的历史保留"历史时长"秒。
   实现要点：
   - 模块内建一个普通 canvas 作"历史条带"：宽 = 历史秒数 × COL_RATE 列/秒、高 = 逻辑高度 × min(DPR,2)
     （设备像素对齐；DPR3 纵向封顶 2×，省 1/3 内存且不影响时间视野）。列率与 FPS 解耦（dt 累加器凑够
     1/COL_RATE 秒才落一列）。条带内存 = 列数 × 行数 × 4B，例如 30 秒 @DPR2（1800×1600）≈ 11.0MiB、
     @DPR3 封顶后同样是 1800×1600 ≈ 11.0MiB（不封顶会是 16.5MiB）。
   - 环形写指针 writeIndex 自增取模，每列用**复用的 1×高 ImageData** 直接 putImageData 到条带；
     绘制时把条带分两段 drawImage（writeIndex→末尾 = 最旧的一段，0→writeIndex = 最新的一段）缩放到主画布。
     每帧零分配（ImageData / LUT / 调色板 / 刻度文本全部复用）。
   - 频率轴对数化：预计算 bin→行 LUT（每行覆盖的 bin 取均值，比取单个 bin 稳）。
   - 强度映射（T2.1 提高对比）：analyser 的 byte 值按默认 min/maxDecibels = -100/-30dB 线性映射，
     先切成 -80dB 起的可视窗口（掐掉底噪），再乘灵敏度、减噪声门，然后过亮度曲线（u^0.75，查表）
     并对顶端加速，于是底噪透明、高频暗蓝、中频绿/青、低频黄红、最响处白闪。
   - 配色两种（colorScheme，select 声明）：'rainbow'（默认，蓝→青→绿→黄→红，峰值转白）与 'theme'（--acc2→--acc→--acc3）。
   - 清晰度（T2.2）：条带行数 = 逻辑高 × DPR = 主画布设备像素高 → 纵向天然 1:1；
     横向每列会被放大（主画布设备宽 / 列数）倍，若开插值就会把竖纹抹成雾状——所以默认关插值
     （imageSmoothingEnabled=false，由"锐化"开关控制，默认开），两段翻卷的接缝也对齐到设备像素栅格。
   契约与参数：params 是**纯声明对象**（键名即参数名），当前值放本模块的 values——
   参数面板按 for...in 遍历 params、并以键名读写 values，因此这里必须是对象而不是数组。
   已知限制：渲染器契约（audio）不含 sampleRate，频率刻度按 44.1kHz（与 viz/audio.js 的离线渲染同率）估算；
   若设备实际跑 48kHz，刻度整体偏低约 8%，瀑布形态不受影响。
   依赖：仅 ../../core/util.js 的 clamp 与 ../registry.js 的 register。 */
import { clamp } from '../../core/util.js';
import { register } from '../registry.js';

/* ---------- 常量 ---------- */
const COL_RATE=60;                 // 列率（列/秒），与 FPS 解耦；60 列/秒时 20 秒窗 = 1200 列（T2.3 由 30 提升）
const COL_MAX_STEP=6;              // 单帧最多补几列（= dt 上限 0.1s × 列率，长时间卡顿后不追补一大堆历史）
const NYQUIST=22050;               // 频率刻度参考：44.1kHz 的奈奎斯特（见文件头"已知限制"）
const GRID_HZ=[50,100,200,500,1000,2000,5000,10000];   // 频率刻度线位置（Hz）
const FALLBACK={acc:'#00d9ff',acc2:'#7c6cff',acc3:'#ff7ac8',txt:'#e9eefb'};
/* 强度映射常量。analyser 默认 min/maxDecibels = -100/-30dB，byte 值即线性映射：
   byte 0 = -100dB、byte 255 = -30dB，因此 byte 73 ≈ -80dB —— 可视窗口从 -80dB 起，掐掉底噪。 */
const FLOOR_N=73/255;              // 可视窗口下沿（≈ -80dB）
const WIN=1-FLOOR_N;               // 窗口宽度（≈ -80…-30dB）
const GAMMA=.75;                   // 亮度曲线（<1 提亮中段，避免中频掉进最暗的几档）
const HOT=.7;                      // 顶端加速阈值：以上再乘 1.5 倍斜率 → 峰值"跳"出来
const PEAK=.88;                    // 峰值阈值：以上朝白/发光过渡（≈ 最响的 9%）
const MAX_DPR=3;                   // 与 main.js 的 clamp(dpr,1,3) 对齐

/* 模块内缓存（全部在 init/resize/参数变化时重建，draw 内不分配） */
const _c={
  strip:null,sctx:null,          // 历史条带 canvas 与它的 2D 上下文
  col:null,                      // 复用的 1×rows ImageData
  pal:null,txt:[233,238,251],    // 256 级 RGBA 调色板 / 刻度颜色
  gridStroke:'',gridFill:'',     // 刻度线/文字颜色字符串（重建时拼好，帧内不再拼接）
  lutStart:null,lutEnd:null,     // 每行覆盖的 bin 区间 [start,end)
  gammaLut:null,                 // 亮度曲线 LUT（0-255 → 0..1），避免每行调 Math.pow
  rows:0,width:0,sw:0,sh:0,bins:0,
  write:0,acc:0,                 // 环形写指针 / 列率累加器（秒）
  scheme:'rainbow',              // 当前配色方案
  grid:[],                       // 预计算的刻度线：{yn,text} 数组（yn = 0 顶部 … 1 底部）
  lastHist:-1,lastMin:-1,lastBins:-1,lastRows:-1,lastScheme:''
};

/* ---------- 主题色 → 调色板 ---------- */
function readCss(name,fb){
  try{
    const v=getComputedStyle(document.documentElement).getPropertyValue(name);
    const s=(v||'').trim();
    if(s)return s;
  }catch(e){}
  return fb;
}
/* 只在 init/resize 调用：解析 #rgb / #rrggbb / rgb()，其余回落默认色 */
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
    const p=m2[1].split(',');
    return [Number(p[0])||0,Number(p[1])||0,Number(p[2])||0];
  }
  return fb;
}
/* HSL → RGB（只在重建调色板时用；结果写进调用方给的 3 元数组，避免临时对象满天飞） */
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
/* 调色板重建（init/resize/配色切换时调用）：
   - 'rainbow'：色相 200°→0°（蓝→青→绿→黄→红），亮度递增，峰值段朝白过渡 —— 热力图/Audacity 频谱风格；
   - 'theme'：沿用主题三色 --acc2 → --acc →（--acc3 混白）。
   两种方案都由同一套强度下标（0-255）驱动，alpha 随强度 0→96% 单调上升，峰值（≥PEAK）再加一档白。 */
function buildPalette(scheme){
  const rainbow=(scheme!=='theme');
  _c.scheme=rainbow?'rainbow':'theme';
  _c.lastScheme=_c.scheme;
  _c.txt=parseColor(readCss('--txt',FALLBACK.txt),[233,238,251]);
  /* 刻度用的 CSS 颜色字符串也在重建时拼好，draw 里不再做字符串拼接（保持帧内零分配） */
  const tx=_c.txt;
  _c.gridStroke='rgba('+tx[0]+','+tx[1]+','+tx[2]+',.22)';
  _c.gridFill='rgba('+tx[0]+','+tx[1]+','+tx[2]+',.62)';
  const pal=_c.pal||(_c.pal=new Uint8ClampedArray(256*4));
  /* 亮度曲线 LUT：u^GAMMA，只在重建时算 256 次 */
  const gl=_c.gammaLut||(_c.gammaLut=new Float32Array(256));
  for(let i=0;i<256;i++)gl[i]=Math.pow(i/255,GAMMA);
  const rgb=[0,0,0];
  let a2=null,a1=null,dark=null,hot=null;
  if(!rainbow){
    a2=parseColor(readCss('--acc2',FALLBACK.acc2),[124,108,255]);
    a1=parseColor(readCss('--acc',FALLBACK.acc),[0,217,255]);
    const a3=parseColor(readCss('--acc3',FALLBACK.acc3),[255,122,200]);
    dark=[a2[0]*.22,a2[1]*.22,a2[2]*.22];
    hot=[(a3[0]+255)*.5,(a3[1]+255)*.5,(a3[2]+255)*.5];
  }
  for(let i=0;i<256;i++){
    const t=i/255,o=i<<2;
    let r,g,b,k;
    if(rainbow){
      /* 色相走法：220°→180°（蓝→青，占低强度 0-0.35）→0°（青→绿→黄→红，占 0.35-1）。
         低频能量通常落在低强度区，因此把蓝/青留给安静段、暖色留给响段，接近 Audacity 频谱观感。 */
      const hue=(t<.35)?(220-40*(t/.35)):(180-180*((t-.35)/.65));
      hsl2rgb(hue,1,.12+.42*t,rgb);            // 亮度 0.12→0.54 同步递增
      r=rgb[0]; g=rgb[1]; b=rgb[2];
    }else if(t<.25){ k=t/.25; r=dark[0]+(a2[0]-dark[0])*k; g=dark[1]+(a2[1]-dark[1])*k; b=dark[2]+(a2[2]-dark[2])*k }
    else if(t<.65){ k=(t-.25)/.4; r=a2[0]+(a1[0]-a2[0])*k; g=a2[1]+(a1[1]-a2[1])*k; b=a2[2]+(a1[2]-a2[2])*k }
    else { k=(t-.65)/.35; r=a1[0]+(hot[0]-a1[0])*k; g=a1[1]+(hot[1]-a1[1])*k; b=a1[2]+(hot[2]-a1[2])*k }
    if(t>PEAK){                                 // 峰值：加速变亮 + 朝白过渡（"发光"）
      k=(t-PEAK)/(1-PEAK);
      r=r+(255-r)*k; g=g+(255-g)*k; b=b+(255-b)*k;
    }
    pal[o]=r; pal[o+1]=g; pal[o+2]=b;
    pal[o+3]=255*Math.pow(t,.75)*.96;
  }
}

/* ---------- 对数频率轴：bin → 行 LUT ---------- */
/* 行 0 = 顶部 = 奈奎斯特；行 rows-1 = 底部 = minFreq。每行取覆盖 bin 的均值。 */
function buildLut(rows,minFreq,bins){
  const n=Math.max(1,rows|0);
  if(!_c.lutStart||_c.lutStart.length!==n){ _c.lutStart=new Int32Array(n); _c.lutEnd=new Int32Array(n) }
  const lo=clamp(Number(minFreq)||60,20,NYQUIST*.8);
  const ratio=NYQUIST/lo;
  const span=Math.max(1e-6,Math.log(ratio));
  for(let r=0;r<n;r++){
    const kLo=n-1-r;                                   // 该行的下边界（第 kLo 条对数刻度）
    const fLo=lo*Math.exp(kLo/n*span);
    const fHi=lo*Math.exp((kLo+1)/n*span);
    let b0=Math.floor(fLo/NYQUIST*bins);
    let b1=Math.ceil(fHi/NYQUIST*bins);
    b0=clamp(b0,0,bins-1); b1=clamp(b1,b0+1,bins);
    _c.lutStart[r]=b0; _c.lutEnd[r]=b1;
  }
  /* 刻度线：位置用归一化 yn（0 顶部 … 1 底部）存，绘制时再乘逻辑高度——
     因为条带分辨率是设备像素（rows = 逻辑高 × DPR），不能把行号直接当逻辑 y 用。 */
  const g=_c.grid; g.length=0;
  for(let i=0;i<GRID_HZ.length;i++){
    const f=GRID_HZ[i];
    if(f<=lo||f>=NYQUIST)continue;
    const yn=1-Math.log(f/lo)/span;
    g.push({yn,text:f>=1000?((f/1000)+'k'):String(f)});
  }
  _c.rows=n; _c.bins=bins; _c.lastMin=lo; _c.lastBins=bins; _c.lastRows=n;
}

/* ---------- 小工具 ---------- */
/* 条带行数 = 逻辑高度 × min(DPR,2)（设备像素对齐；DPR3 屏幕纵向封顶 2×，省 1/3 内存、时间视野不变）。
   封顶后 DPR3 下纵向是 1.5× 放大（锐化模式即隔行复制），在 3 倍密度屏上不可辨。LUT 行数同源。 */
function rowsOf(view){
  const h=(view&&view.h)?view.h:1;
  const dpr=clamp((view&&view.dpr)?view.dpr:1,1,MAX_DPR);
  return Math.max(1,Math.round(h*Math.min(dpr,2)));
}
/* 配色取值归一化：'theme'/false → 主题色；其余（'rainbow'/true/未定义）→ 彩虹 */
function _schemeOf(v){
  return (v===false||v===0||v==='theme'||v==='0')?'theme':'rainbow';
}
/* 锐化：关掉画布插值（imageSmoothingEnabled=false → 最近邻采样，边缘不糊）。
   注意主画布 ctx 每次尺寸变化都会被 main.js 重置状态，"锐化"开关也可能随时被拖动，
   所以每帧在 draw 里设一次（纯属性写入，零分配），init/resize 里也顺手设一次。 */
function applySmoothing(ctx,sharpen){
  if(ctx)ctx.imageSmoothingEnabled=!sharpen;
}

/* ---------- 历史条带（普通 canvas；宽随历史时长、高随画布） ---------- */
/* histSec 变化或 resize 时重建：历史丢弃（条带尺寸变了，像素无法无损搬迁） */
function buildStrip(histSec,rows){
  const cols=Math.max(COL_RATE,Math.round(clamp(Number(histSec)||20,5,30)*COL_RATE));
  const h=Math.max(1,rows|0);
  const cv=document.createElement('canvas');
  cv.width=cols; cv.height=h;
  const cx=cv.getContext('2d');
  _c.strip=cv; _c.sctx=cx;
  _c.sw=cols; _c.sh=h; _c.width=cols;
  _c.write=0; _c.acc=0;
  _c.col=cx.createImageData(1,h);
  _c.lastHist=clamp(Number(histSec)||20,5,30);
}

/* ---------- 一列数据 → 条带 ---------- */
/* 强度映射：byte 归一 → 切 -80dB 可视窗口 → 灵敏度/噪声门 → 亮度曲线（查表）+ 顶端加速。
   返回 true 表示真的落了这一列；整列都是数字静音（暂停/停止时 analyser 只吐 0）时返回 false，
   不推进写指针——这样暂停后画面会冻结在最后一次有声音的历史上，而不是把画面刷成空白。 */
function writeColumn(freqData,gain,gate){
  const rows=_c.rows,pal=_c.pal,data=_c.col.data;
  const lutS=_c.lutStart,lutE=_c.lutEnd,gl=_c.gammaLut;
  const inv=1/255, win=1/WIN;
  let anyRaw=0;
  for(let r=0;r<rows;r++){
    const b0=lutS[r],b1=lutE[r];
    let s=0;
    for(let b=b0;b<b1;b++)s+=freqData[b];
    const avg=s/(b1-b0);                       // 行值 = 该行覆盖 bin 的均值
    if(avg>0)anyRaw=1;
    /* 可视窗口：把 -80dB 以下掐掉（底噪透明），窗口内归一后再乘灵敏度、减噪声门 */
    let u=(avg*inv-FLOOR_N)*win;
    if(u<=0)u=0;
    else{
      u=u*gain-gate;
      if(u<=0)u=0;
      else{
        if(u>1)u=1;
        u=gl[(u*255)|0];                       // 亮度曲线（查表，无 pow）
        if(u>HOT){ u+=(u-HOT)*.5; if(u>1)u=1 } // 顶端加速：峰值段更亮、闪动更明显
      }
    }
    const pi=((u*255)|0)<<2, o=r<<2;
    data[o]=pal[pi]; data[o+1]=pal[pi+1]; data[o+2]=pal[pi+2]; data[o+3]=pal[pi+3];
  }
  if(!anyRaw)return false;
  _c.sctx.putImageData(_c.col,_c.write,0);
  _c.write=(_c.write+1)%_c.width;
  return true;
}

export const spectrogram={
  id:'spectrogram',
  label:'频谱瀑布',
  /* params = 纯声明（键名即参数名）；当前值在 values（缺省回落 def） */
  params:{
    gain:       {type:'range',min:.5,max:3,step:.1,def:1,label:'灵敏度',fixed:2},
    minFreq:    {type:'range',min:20,max:500,step:10,def:60,label:'最低频率',fixed:0},
    historySec: {type:'range',min:5,max:30,step:1,def:20,label:'历史时长',fixed:0},
    noiseGate:  {type:'range',min:0,max:.3,step:.01,def:.05,label:'噪声门',fixed:2},
    colorScheme:{type:'select',label:'配色',options:[['rainbow','彩虹'],['theme','主题色']],def:'rainbow'},
    sharpen:    {type:'toggle',def:true,label:'锐化'},
    showGrid:   {type:'toggle',def:false,label:'频率刻度'}
  },
  values:{ gain:1, minFreq:60, historySec:20, noiseGate:.05, colorScheme:'rainbow', sharpen:true, showGrid:false },

  /* 配色取值归一化：兼容布尔（toggle 现状）与字符串（将来面板支持 select 时可用 'rainbow'/'theme'） */
  _scheme(){ return _schemeOf(this.values.colorScheme) },

  init(ctx,view){
    buildPalette(_schemeOf(this.values.colorScheme));
    const rows=rowsOf(view);
    buildStrip(this.values.historySec,rows);
    buildLut(rows,this.values.minFreq,1024);
    applySmoothing(ctx,this.values.sharpen!==false);
  },
  /* resize：条带与 LUT 都按新尺寸重建（历史丢弃，规格允许）；画布尺寸变化会重置 ctx 状态，此处补设一次 */
  resize(ctx,view){
    buildPalette(_schemeOf(this.values.colorScheme));
    const rows=rowsOf(view);
    buildStrip(this.values.historySec,rows);
    buildLut(rows,this.values.minFreq,1024);
    applySmoothing(ctx,this.values.sharpen!==false);
  },
  dispose(){
    _c.strip=null; _c.sctx=null; _c.col=null;
    _c.lutStart=null; _c.lutEnd=null; _c.grid.length=0;
    _c.rows=0; _c.width=0; _c.sw=0; _c.sh=0; _c.write=0; _c.acc=0;
    _c.lastHist=-1; _c.lastMin=-1; _c.lastBins=-1; _c.lastRows=-1; _c.lastScheme='';
  },

  draw(ctx,view,audio){
    const w=view.w,h=view.h,rows=rowsOf(view);
    const v=this.values;
    const hist=clamp(Number(v.historySec)||20,5,30);
    const minF=clamp(Number(v.minFreq)||60,20,500);
    const scheme=_schemeOf(v.colorScheme);
    const fd=(audio&&audio.freqData)?audio.freqData:null;
    const binsNow=(fd&&fd.length)?fd.length:1024;

    /* 自愈：尺寸/参数被外部改动（或 init 时画布还没尺寸）时按需重建，重建只在值真的变了时发生 */
    if(!_c.strip||_c.sh!==rows)buildStrip(hist,rows);
    if(_c.lastHist!==hist)buildStrip(hist,rows);
    if(_c.lastScheme!==scheme)buildPalette(scheme);
    if(_c.lastMin!==minF||_c.lastRows!==rows||_c.lastBins!==binsNow)buildLut(rows,minF,binsNow);
    if(!_c.sctx)return;

    if(fd&&fd.length){
      /* 列率累加：dt 封顶 0.1s、单帧最多补 COL_MAX_STEP 列，避免卡顿后追补一大段 */
      const dt=clamp(Number(audio&&audio.dt)||1/60,0,.1);
      _c.acc+=dt;
      const step=1/COL_RATE;
      let guard=0;
      while(_c.acc>=step&&guard<COL_MAX_STEP){
        _c.acc-=step; guard++;
        writeColumn(fd,Number(v.gain)||1,Number(v.noiseGate)||0);
      }
      if(_c.acc>step*COL_MAX_STEP)_c.acc=step*COL_MAX_STEP;
    }

    ctx.clearRect(0,0,w,h);                     // 无数据时条带自然是空的 → 画面为空白

    /* 锐化：关插值（默认）。条带行数 = 逻辑高×DPR = 主画布设备像素高，纵向天然 1:1；
       横向每列要放大（主画布设备宽 / 列数）倍，插值就会把一条竖纹抹成雾状渐变——这就是"糊"的主因。 */
    const dpr=clamp((view&&view.dpr)?view.dpr:1,1,MAX_DPR);
    applySmoothing(ctx,v.sharpen!==false);

    /* 两段 drawImage：writeIndex→末尾是最旧的一段（放左边），0→writeIndex 是最新的一段（放右边）。
       分段宽度对齐到设备像素栅格（避免两段接缝落在半个像素上，锐化模式下会露一条缝）。 */
    const W=_c.width,wr=_c.write;
    if(W>0&&_c.sw>0){
      const devW=w*dpr;
      const leftCols=W-wr;
      if(leftCols>0&&wr>0){
        const dw1=Math.round(devW*(leftCols/W))/dpr;
        const dw2=w-dw1;
        ctx.drawImage(_c.strip,wr,0,leftCols,_c.sh,0,0,dw1,h);
        ctx.drawImage(_c.strip,0,0,wr,_c.sh,w-dw2,0,dw2,h);
      }else if(leftCols>0){
        ctx.drawImage(_c.strip,wr,0,leftCols,_c.sh,0,0,w,h);
      }else{
        ctx.drawImage(_c.strip,0,0,wr,_c.sh,0,0,w,h);
      }
    }

    if(v.showGrid&&_c.grid.length){
      ctx.save();
      ctx.font='10px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace';
      ctx.textBaseline='bottom';
      ctx.lineWidth=1;
      ctx.strokeStyle=_c.gridStroke;
      ctx.fillStyle=_c.gridFill;
      ctx.beginPath();
      for(let i=0;i<_c.grid.length;i++){
        const g=_c.grid[i];
        const y=g.yn*h;                      // yn 归一化坐标 → 逻辑像素（条带是设备像素，需换算）
        if(y<8||y>h-4)continue;
        ctx.moveTo(0,y); ctx.lineTo(w,y);
      }
      ctx.stroke();
      for(let i=0;i<_c.grid.length;i++){
        const g=_c.grid[i];
        const y=g.yn*h;
        if(y<8||y>h-4)continue;
        ctx.fillText(g.text,4,y-2);
      }
      ctx.restore();
    }
  }
};

/* 自注册：main.js import 本文件即完成注册 */
register(spectrogram);
