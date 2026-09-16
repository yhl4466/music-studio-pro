/* [viz/analyzer.js] FEAT-V4 / T1：整曲离线音乐分析器（PCM + MIDI 网格 → FeatureObject）。
   用途：把 AudioBuffer（transport 里已渲染的整段干混）与工程 MIDI 网格压成一个特征对象，
   供 T3 专辑封面 / T4 音乐指纹消费，是 V4 唯一"重计算"模块。

   设计要点（与 T1 规格对应）：
   1) 纯计算 / 可独立自检：不碰 DOM、不读全局 proj、**不调用 rebuildEvents()**（那会写 proj._ev 造成副作用）。
      buffer 与 proj 全部由调用方传入，单独 import 本模块即可在 Console 或 Node 桩里跑完整分析。
   2) 依赖（FEAT-V4/T2 起）：core/util.js 的 clamp + core/theory.js 的纯数据/纯函数
      （SCALES / SCALE_NAMES / NOTE_SEMI / NOTE_NAMES / PREC_U_PER_STEP / degSemi / keyBaseMidi / trackRows）。
      行数不再各自镜像常量：鼓轨 = KIT.length、旋律轨默认 MEL_ROWS 这两条规则已由 theory.js 的
      trackRows(t) 统一表达，直接调用它即可（比单独 import KIT/MEL_ROWS 更难与本文件脱节）。
      不 import core/state.js 与 io/*：state.js 里与本模块相关的函数（SPB / stepsPerBeat / rowMidi / stepDurNow）
      都读模块级全局 proj，一旦引用就会破坏"纯函数、可独立自检、不产生副作用"的契约；
      本模块需要的一切都从入参 proj 上直接读（key/mode/keyOct/meterN/meterD/steps/tracks[].rows 等）。
   3) 内存：不为整段音频开单声道副本 —— 时域指标（peak/RMS/立体声）与 FFT 取窗都直接读声道的
      Float32Array 视图，常驻内存只有曲线数组（frames × 4B × 4）＋缩略频谱（≈1.6MB/72 秒），
      远低于 20MB 目标。FFT 的 zre/zim/频谱/窗/旋转因子全部模块级复用一个实例，帧内零分配。
   4) FFT：自写迭代式 radix-2（原地、非递归）。实数输入用标准"打包法"优化——
      N=2048 的实数谱由 1024 点复数 FFT + 后处理得到（运算量约为直接 2048 点复数 FFT 的 45%），
      幅度按 Hann 窗相干增益归一（在频点上的正弦，读出值 ≈ 其幅度）。旋转因子/位反转/窗首次调用时预计算一次。
   5) 主线程：每 YIELD_EVERY(24) 帧 await 一次 MessageChannel 让出（与 viz/audio.js 同款，不用 setTimeout），
      每 8 帧检查一次 signal.aborted；每次让出都回调 onProgress(pct,text) 且 pct 单调不减；被取消时**返回 null**。
   6) 时间基准：全部按"帧 × hop / sampleRate"换算，不读墙上时钟参与数值计算。

   返回值字段顺序与 T1 规格一致，额外补充 frames/hop/frameDur/overallRms/统计量，便于 T3/T4 与自检。
   异常约定：buffer 非法 → throw（编程错误）；用户取消 → 返回 null（调用方需判空）。 */

import { clamp } from '../core/util.js';
import { SCALES, SCALE_NAMES, NOTE_SEMI, NOTE_NAMES, PREC_U_PER_STEP,
         degSemi, keyBaseMidi, trackRows } from '../core/theory.js';

/* =========================================================================
   1. 常量
   ========================================================================= */
export const FFT_SIZE=2048;                 // FFT 长度（T1 固定值）
export const HOP_SIZE=1024;                 // 默认跳距（50% 重叠）
export const BIN_COUNT=FFT_SIZE>>1;         // 可用频点数 1024（不含 Nyquist bin）

export const YIELD_EVERY=24;                // 每处理 24 帧让出一次主线程（T1 规格）
const ABORT_EVERY=8;                        // 每 8 帧查一次取消标志（比让出更密，取消响应更快）
const SPECTRO_STEP=4;                       // 缩略频谱：每 4 帧存 1 列
const SPECTRO_ROWS=512;                     // 缩略频谱列高（bin 两两合并）
const SPECTRO_MIN_DB=-70;                   // 缩略频谱动态范围（-70dB → 0，0dB → 1）
/* 频段边界（Hz）：低 = 20–250（底鼓/贝斯基频区）、中 = 250–2000（人声/和弦主体）、高 = 2000+（镲/空气感） */
const LOW_LO_HZ=20, LOW_HI_HZ=250, MID_HI_HZ=2000;
/* 起音检测：非因果（离线可看前后 ±ONSET_WIN 帧）+ 双阈值（高阈值找峰、低阈值回溯细化时刻）。
   阈值建立在"起音强度"自身的局部均值上 —— 不能用低频包络均值当阈值：持续音（长衰减底鼓、贝斯）
   会把包络均值抬高到与起音峰同量级，实测会把 144 个鼓点里的 143 个挡掉。 */
const ONSET_WIN=15;                         // 局部均值窗口 ±15 帧 ≈ ±0.35 秒
const ONSET_RATIO_HI=2.5;                   // 高阈值 = 局部均值 × 2.5 + 底噪
const ONSET_RATIO_LO=1.2;                   // 低阈值 = 局部均值 × 1.2 + 底噪（回溯用）
const ONSET_BACK=6;                         // 回溯上限（帧）
const ONSET_FLOOR_RATIO=0.05;               // 底噪 = 起音强度峰值 × 5%
const ONSET_GATE_RATIO=0.08;                // 静音门限 = 低频包络峰值 × 8%
const ONSET_MIN_GAP=0.12;                   // 不应期（秒），挡住同一次击打被相邻帧重复触发
/* 段落分段：宏观能量（1s 平滑）→ 边界强度曲线（前后各 2s 均值差）→ 按强度贪心取峰（最小段长 2.5s）
   → 相似能量合并 → 边界门限复核 → 数量上限。
   演进过程（三轮，都是实测驱动的）：
   ① 初版用"能量门限 + 滞回"：收段阈值必须落在"次弱段"之上才收得回来，而次弱段与最弱段差距常常很小
      （实测 60 秒"安静-高潮-中段"结构里中段能量是最弱段的 4 倍、高潮段的 0.3 倍），单一阈值必漏边界。
   ② 第二版改"三级能量分类 + 游程 + 短段归并"：能切对三段结构，但分类是**全局固定档位**，很脆——
      实测某 72 秒结构里主歌 mrv=0.1061、中段门限=0.1076，只差 1.4% 就被判成"弱段"，
      于是"引子+主歌"在分类阶段就并成一段，后面的归并/门限再准也救不回一个从未产生的边界。
   ③ 现在：不再依赖固定档位，直接用"边界强度"当主检测器 —— 边界强度 = 前后各 SEG_EDGE_SEC 秒均值之差 / p90；
      只保留强度 > SEG_BOUNDARY_MIN 的候选，按强度从大到小贪心接受，并要求每个被接受的边界与
      已接受边界、曲首、曲尾都相距 ≥ SEG_MIN_SEC。这样"最强的那几个真实边界"一定保留，
      1-2 秒的过渡抖动与开头的起振尖峰因为挤不进 2.5 秒间距而自然被吸收，且天然保证每段 ≥ 2.5 秒。 */
const SEG_SMOOTH_SEC=1.0;                   // 宏观能量平滑窗（秒）：逐拍起伏不该被当成段落边界
                                            //（0.5s 时，kick/snare 交替的等能量循环会被切成 32 段）
const SEG_SPAN_MIN=0.15;                    // 相对跨度 = (p90-p10)/p90；低于此值视为"全程等能量"→ 整段算一段
const SEG_MIN_SEC=2.5;                      // 段落最短时长：既是贪心取峰的最小间距，也是"最短段"的保证
const SEG_BOUNDARY_MIN=0.25;                // 边界跳变门限：前后各 2 秒均值之差 ≤ 0.25 不算边界（0-1 量纲）
const SEG_EDGE_SEC=2.0;                     // 边界强度的取样窗（边界前后各 2 秒）：抑制 1-2 秒的过渡抖动
const SEG_MERGE_DE=0.20;                    // 相邻段平均能量差 < 0.20 → 合并（消除中段的小波动）
const SEG_MAX=32;                           // 段落数上限（封面同心环可用数量），超出时合并能量最低的相邻对
const MEL_ROWS_MAX=32;                      // 行数缓存上限：data.js 对 t.rows 没有上限校验，
                                            // 损坏/恶意载荷可能给出超大行数，这里夹一下避免缓存越界
const EPS=1e-9;

/* =========================================================================
   2. 自写 FFT（迭代式 radix-2，原地；实数输入走打包法）
   ========================================================================= */
const M=FFT_SIZE>>1;                           // 1024：打包实数 FFT 的长度
let _rev=null,_cosH=null,_sinH=null;           // HALF 点位反转表 / 旋转因子（复数 FFT 用）
let _cosW=null,_sinW=null;                     // FFT_SIZE 点后处理旋转因子 W_N^k
let _hann=null,_winSum=0,_magFactor=0;

/* 预计算：位反转表 / 两级旋转因子 / Hann 窗。首次调用时执行一次，之后复用。 */
function initTables(){
  if(_rev)return;
  const n=M, bits=Math.round(Math.log2(n));
  _rev=new Uint16Array(n);
  for(let i=0;i<n;i++){
    let r=0;
    for(let b=0;b<bits;b++)if(i&(1<<b))r|=1<<(bits-1-b);
    _rev[i]=r;
  }
  _cosH=new Float32Array(n>>1); _sinH=new Float32Array(n>>1);
  for(let k=0;k<(n>>1);k++){
    const a=2*Math.PI*k/n;
    _cosH[k]=Math.cos(a); _sinH[k]=Math.sin(a);
  }
  _cosW=new Float32Array(n); _sinW=new Float32Array(n);
  for(let k=0;k<n;k++){
    const a=2*Math.PI*k/FFT_SIZE;
    _cosW[k]=Math.cos(a); _sinW[k]=Math.sin(a);
  }
  _hann=new Float32Array(FFT_SIZE);
  let s=0;
  for(let i=0;i<FFT_SIZE;i++){ const v=0.5-0.5*Math.cos(2*Math.PI*i/(FFT_SIZE-1)); _hann[i]=v; s+=v }
  _winSum=s;
  _magFactor=2/s;      // 幅度归一：Hann 窗正弦的谱峰 = A·winSum/2 → 乘 2/winSum 后 ≈ 幅度 A
}
/** 原地复数 FFT，长度固定 M=1024。旋转因子取 e^{-iθ}，符号与标准正变换一致。 */
function fft(re,im){
  const rev=_rev, c=_cosH, s=_sinH;
  for(let i=1;i<M;i++){
    const j=rev[i];
    if(j>i){
      const tr=re[i]; re[i]=re[j]; re[j]=tr;
      const ti=im[i]; im[i]=im[j]; im[j]=ti;
    }
  }
  for(let size=2;size<=M;size<<=1){
    const half=size>>1, step=M/size;
    for(let i=0;i<M;i+=size){
      let k=0;
      for(let j=i;j<i+half;j++,k+=step){
        const cc=c[k], ss=s[k], jh=j+half;
        const br=re[jh], bi=im[jh];
        const tr=br*cc+bi*ss;          // 复数乘 (br+i·bi)·(cc - i·ss)
        const ti=bi*cc-br*ss;
        const ar=re[j], ai=im[j];
        re[j]=ar+tr;  im[j]=ai+ti;
        re[jh]=ar-tr; im[jh]=ai-ti;
      }
    }
  }
}
/**
 * 实信号幅度谱（热路径核心）：zre/zim 是已加窗并打包好的 1024 点复数（z[i]=x[2i]+i·x[2i+1]），
 * 本函数原地 FFT 后做实数谱后处理，把 FFT_SIZE/2=1024 个频点的幅度写进 outMag。
 * 后处理（标准 split 公式，E=偶部、O=奇部、W=e^{-2πik/N}）：
 *   A=Z[k]、B=conj(Z[(M-k)%M]) → X[k] = (A+B)/2 + W·(-i)(A-B)/2
 * 三个数组都由调用方复用，帧内零分配。
 */
function realMag(zre,zim,outMag){
  fft(zre,zim);
  const cw=_cosW, sw=_sinW, mf=_magFactor;
  outMag[0]=(zre[0]+zim[0])<0?-(zre[0]+zim[0])*mf:(zre[0]+zim[0])*mf;   // X[0] = Σx = ReZ0+ImZ0（直流，实数）
  for(let k=1;k<M;k++){
    const ar=zre[k], ai=zim[k];
    const mr=M-k;
    const br=zre[mr], bi=-zim[mr];                 // B = conj(Z[M-k])
    const er=(ar+br)*0.5, ei=(ai+bi)*0.5;          // E = (A+B)/2
    const tr=(ai-bi)*0.5, ti=-(ar-br)*0.5;         // T = -i·(A-B)/2
    const c=cw[k], s=sw[k];
    const xr=er+(c*tr+s*ti);                       // W·T（W=(c,-s)）
    const xi=ei+(c*ti-s*tr);
    outMag[k]=Math.sqrt(xr*xr+xi*xi)*mf;
  }
  return outMag;
}
/**
 * 诊断/自检用：对一段时域输入做 Hann 窗 + 实数 FFT，返回 1024 点幅度谱。
 * 频谱主路径不调用这里（避免每帧多一次函数调用与内存分配），自检与将来的单帧分析用。
 * @param {Float32Array} input 长度任意（不足 2048 时补零，超出截断）
 * @param {Float32Array} [dst] 输出缓冲（长度 ≥ 1024），缺省新建
 */
export function fftMagnitude(input,dst){
  initTables();
  const out=dst||new Float32Array(BIN_COUNT);
  const zre=new Float32Array(M), zim=new Float32Array(M);
  const n=input?Math.min(FFT_SIZE,input.length):0;
  for(let i=0;i<M;i++){
    const j=2*i;
    zre[i]=(j<n)?input[j]*_hann[j]:0;
    zim[i]=(j+1<n)?input[j+1]*_hann[j+1]:0;
  }
  return realMag(zre,zim,out);
}

/* =========================================================================
   3. 主线程让出（与 viz/audio.js 同款：MessageChannel 优先，不用 setTimeout）
   ========================================================================= */
const yieldNow=(()=>{
  if(typeof MessageChannel==='function'){
    const ch=new MessageChannel();
    const q=[];
    ch.port1.onmessage=()=>{ const f=q.shift(); if(f)f() };
    return ()=>new Promise(r=>{ q.push(r); ch.port2.postMessage(0) });
  }
  if(typeof requestAnimationFrame==='function')return ()=>new Promise(r=>requestAnimationFrame(()=>r()));
  return ()=>Promise.resolve();
})();

const now=()=>(typeof performance!=='undefined'&&performance.now)?performance.now():Date.now();

/* =========================================================================
   4. 工具
   ========================================================================= */
/** 把曲线按自身峰值归一化到 0-1（T3/T4 画图直接可用）；全零曲线返回全零，不产生 NaN。 */
export function normalizeCurve(src,dst){
  const n=src?src.length:0;
  const out=(dst&&dst.length>=n)?dst:new Float32Array(n);
  let mx=0;
  for(let i=0;i<n;i++){ const v=src[i]; const a=v<0?-v:v; if(a>mx)mx=a }
  const inv=mx>EPS?1/mx:0;
  for(let i=0;i<n;i++)out[i]=src[i]*inv;
  return out;
}

/* =========================================================================
   5. MIDI 侧分析（只读遍历 pat / prec，不调 rebuildEvents）
   ========================================================================= */
/** 12 音直方图 → 最可能的调式。返回 {tonic,tonicName,mode,modeName,name,confidence,detected,declared} */
function inferKey(hist,noteCount,proj){
  const declared=(proj&&typeof proj.key==='string'&&NOTE_SEMI[proj.key]!=null&&SCALES[proj.mode])
    ?{tonic:NOTE_SEMI[proj.key],mode:proj.mode}:null;
  const fix=(o,conf,detected)=>({
    tonic:o.tonic, tonicName:NOTE_NAMES[o.tonic], mode:o.mode,
    modeName:SCALE_NAMES[o.mode]||o.mode,
    name:NOTE_NAMES[o.tonic]+' '+(SCALE_NAMES[o.mode]||o.mode),
    confidence:conf, detected,
    declared:declared?(NOTE_NAMES[declared.tonic]+' '+(SCALE_NAMES[declared.mode]||declared.mode)):null
  });
  if(noteCount<3)return declared?fix(declared,0,false):null;   // 音符太少：不做统计推断（有声明就照抄）
  let best=null,second=null;
  for(let t=0;t<12;t++){
    for(const mode in SCALES){
      const cum=SCALES[mode];
      let score=0;
      for(let p=0;p<12;p++){
        const deg=((p-t)%12+12)%12;
        score+=hist[p]*(cum.indexOf(deg)>=0?1:-1.3);      // 音阶内加分、音阶外扣分
      }
      score+=hist[t]*0.5+hist[(t+7)%12]*0.25;             // 主音、属音额外加权
      const cand={tonic:t,mode,score};
      if(!best||score>best.score){ second=best; best=cand }
      else if(!second||score>second.score)second=cand;
    }
  }
  const gap=(best.score-(second?second.score:0))/Math.max(1,noteCount);
  return fix(best,clamp(gap,0,1),true);
}
/**
 * MIDI 网格分析：音高直方图 / 调式推断 / 每小节音符密度。
 * 只读 proj.tracks[].pat 与 .prec —— pat 与 prec 在主应用 engine 里是**各自独立发声**的
 * （rebuildEvents → fireStep 两者都排），所以两者都计入，音符数才等于实际听到的击打数。
 * 鼓轨行号是 KIT 音色索引、没有音高，故只计入密度与鼓点计数，不进音高直方图。
 */
function analyzeMidi(proj){
  const hist=new Array(12).fill(0);
  const out={pitchHistogram:hist,key:null,barDensity:new Float32Array(1),
             noteCount:0,drumHits:0,bars:1,stepsPerBar:16,meterN:4,mode:'major'};
  if(!proj||!Array.isArray(proj.tracks))return out;

  const mode=SCALES[proj.mode]?proj.mode:'major';
  const keyName=(typeof proj.key==='string'&&NOTE_SEMI[proj.key]!=null)?proj.key:'C';
  const keyOct=Number.isFinite(+proj.keyOct)?Math.round(+proj.keyOct):4;
  const meterN=clamp(Math.round(Number(proj.meterN)||4),1,16);
  const meterD=Number(proj.meterD)||4;
  /* 每小节步数：与 core/state.js SPB() 一致的算法（每拍 4 格十六分网格，分母不为 4 时换算） */
  let stepsPerBeat=4*4/meterD;
  if(!Number.isInteger(stepsPerBeat)||stepsPerBeat<1)stepsPerBeat=4;
  const stepsPerBar=Math.max(1,meterN*stepsPerBeat);
  const steps=Math.max(1,Math.round(Number(proj.steps)||stepsPerBar));
  const bars=Math.max(1,Math.ceil(steps/stepsPerBar));
  const density=new Float32Array(bars);
  const kb=keyBaseMidi(keyName,keyOct);

  let noteCount=0,drumHits=0;
  const rowSemi=new Int16Array(MEL_ROWS_MAX);     // 逐轨复用的"行 → 相对半音"缓存，避免内层循环重复查表

  for(const t of proj.tracks){
    if(!t)continue;
    const isDrum=(t.kind==='drum');
    const rows=Math.min(MEL_ROWS_MAX,trackRows(t));  // 行数与显示逻辑一致（鼓轨 = KIT.length），只夹上限防越界
    const shift=Number(t.shift)||0;
    for(let r=0;r<rows;r++)rowSemi[r]=shift+(isDrum?0:degSemi(mode,r));
    const pat=Array.isArray(t.pat)?t.pat:[];
    const lim=Math.min(pat.length,steps);
    for(let s=0;s<lim;s++){
      const col=pat[s];
      if(!col)continue;
      const nr=Math.min(rows,col.length);
      for(let r=0;r<nr;r++){
        if(!(col[r]>0))continue;
        const bar=clamp(Math.floor(s/stepsPerBar),0,bars-1);
        if(isDrum){ density[bar]+=1; drumHits++ }
        else{ const m=kb+rowSemi[r]; hist[((m%12)+12)%12]++; density[bar]+=1; noteCount++ }
      }
    }
    const prec=Array.isArray(t.prec)?t.prec:[];
    for(const p of prec){
      if(!p)continue;
      const r=Math.round(Number(p.row));
      if(!Number.isFinite(r)||r<0||r>=rows)continue;
      const u=Number(p.u);
      const step=Number.isFinite(u)?Math.floor(u/PREC_U_PER_STEP):0;
      const bar=clamp(Math.floor(step/stepsPerBar),0,bars-1);
      if(isDrum){ density[bar]+=1; drumHits++ }
      else{ const m=kb+rowSemi[r]; hist[((m%12)+12)%12]++; density[bar]+=1; noteCount++ }
    }
  }
  for(let i=0;i<bars;i++)density[i]=density[i]/meterN;   // 归一成"每拍音符数"（与拍号无关，便于跨工程比较）

  out.pitchHistogram=hist;
  out.key=inferKey(hist,noteCount,proj);
  out.noteCount=noteCount; out.drumHits=drumHits;
  out.bars=bars; out.stepsPerBar=stepsPerBar; out.meterN=meterN; out.mode=mode;
  out.barDensity=density;
  return out;
}

/* =========================================================================
   6. 主入口：analyze(buffer, proj, opts)
   ========================================================================= */
/**
 * 分析整段音乐。耗时与音频时长成正比（72 秒 ≈ 0.7 秒级），期间每 24 帧让出主线程。
 * @param {AudioBuffer} buffer 已渲染的音频（transport.getBuffer()），只用 length/numberOfChannels/sampleRate/getChannelData
 * @param {object} [proj] 归一化后的工程（viz/data.js 的 proj），只读；缺失时 MIDI 部分返回空结果
 * @param {{onProgress?:(pct:number,text:string)=>void, signal?:AbortSignal, hopSize?:number}} [opts]
 * @returns {Promise<object|null>} FeatureObject；被 signal 取消时返回 null
 */
export async function analyze(buffer,proj,opts={}){
  if(!buffer||typeof buffer.getChannelData!=='function'||!buffer.length)
    throw new Error('analyze() 需要一个有效的 AudioBuffer');
  const onProgress=(typeof opts.onProgress==='function')?opts.onProgress:null;
  const signal=opts.signal||null;
  const rep=(pct,text)=>{ if(onProgress)try{ onProgress(clamp(pct,0,100),text||'') }catch(e){} };
  const aborted=()=>!!(signal&&signal.aborted);

  const t0=now();
  initTables();
  const sampleRate=Number(buffer.sampleRate)||44100;
  const samples=Math.max(0,Math.floor(buffer.length||0));
  const hop=Math.max(1,Math.round(Number(opts.hopSize)||HOP_SIZE));
  const frameDur=hop/sampleRate;
  /* frames 恒等于 floor(samples/hop)（T1 自检 2）；仅当音频短于一个 hop 这种退化情况才兜到 1 帧 */
  const frames=Math.max(1,Math.floor(samples/hop));

  const ch0=buffer.getChannelData(0);
  const ch1=(buffer.numberOfChannels>1)?buffer.getChannelData(1):null;

  /* ---------- 6.1 时域一趟过：per-hop RMS 曲线 / peak / 总体 RMS / 立体声相关 ---------- */
  rep(0,'准备分析…');
  const rmsCurve=new Float32Array(frames);
  let peak=0,sumSq=0,sumLR=0,sumL2=0,sumR2=0;
  for(let f=0;f<frames;f++){
    if((f&63)===0&&aborted())return null;
    const start=f*hop;
    let end=start+hop;
    if(end>samples)end=samples;
    let acc=0;
    for(let i=start;i<end;i++){
      const l=ch0[i];
      let m;
      if(ch1){
        const r=ch1[i];
        m=(l+r)*0.5;
        sumLR+=l*r; sumL2+=l*l; sumR2+=r*r;
      }else m=l;
      const a=m<0?-m:m;
      if(a>peak)peak=a;
      acc+=m*m;
    }
    rmsCurve[f]=Math.sqrt(acc/Math.max(1,end-start));
    sumSq+=acc;
  }
  const overallRms=Math.sqrt(sumSq/Math.max(1,samples));
  const crest=overallRms>EPS?peak/overallRms:0;
  let stereoWidth=0;
  if(ch1){
    const den=Math.sqrt(sumL2*sumR2);
    if(den>EPS)stereoWidth=clamp(1-(sumLR/den),0,1);   // 完全同相 → 0；左右不相关 → 1
  }
  if(aborted())return null;

  /* ---------- 6.2 逐帧 FFT：频段能量 / 质心 / rolloff / 通量 / 低频包络 / 缩略频谱 ---------- */
  const zre=new Float32Array(M), zim=new Float32Array(M);
  const mag=new Float32Array(BIN_COUNT), prev=new Float32Array(BIN_COUNT);
  const brightnessCurve=new Float32Array(frames);
  const rolloffCurve=new Float32Array(frames);
  const fluxCurve=new Float32Array(frames);
  const lowEnv=new Float32Array(frames);
  const spectroCols=Math.max(1,Math.ceil(frames/SPECTRO_STEP));
  const spectrogram=new Float32Array(spectroCols*SPECTRO_ROWS);
  const binHz=sampleRate/FFT_SIZE;
  const hiLow=Math.max(1,Math.round(LOW_HI_HZ/binHz));
  const hiMid=Math.max(hiLow+1,Math.round(MID_HI_HZ/binHz));
  const hann=_hann;
  let bandLow=0,bandMid=0,bandHigh=0,yields=0;

  rep(2,'频谱分析… 0%（0/'+frames+' 帧）');
  for(let f=0;f<frames;f++){
    if((f%ABORT_EVERY)===0&&aborted())return null;
    if((f%YIELD_EVERY)===0&&f>0){
      await yieldNow(); yields++;
      rep(2+(f/frames)*66,'频谱分析… '+Math.round(f/frames*100)+'%（'+f+'/'+frames+' 帧）');
    }
    /* 取窗 + 打包：整窗可用时走快路径；尾部不足一窗时逐点判边界补零（保证所有曲线长度一致） */
    const off=f*hop;
    if(off+FFT_SIZE<=samples){
      if(ch1)for(let i=0;i<M;i++){
        const j=off+2*i;
        zre[i]=(ch0[j]+ch1[j])*0.5*hann[2*i];
        zim[i]=(ch0[j+1]+ch1[j+1])*0.5*hann[2*i+1];
      }
      else for(let i=0;i<M;i++){
        const j=off+2*i;
        zre[i]=ch0[j]*hann[2*i];
        zim[i]=ch0[j+1]*hann[2*i+1];
      }
    }else{
      for(let i=0;i<M;i++){
        const j=off+2*i, j2=j+1;
        zre[i]=(j<samples)?((ch1?(ch0[j]+ch1[j])*0.5:ch0[j])*hann[2*i]):0;
        zim[i]=(j2<samples)?((ch1?(ch0[j2]+ch1[j2])*0.5:ch0[j2])*hann[2*i+1]):0;
      }
    }
    realMag(zre,zim,mag);

    let total=0,wnum=0,low=0,mid=0,high=0,df=0;
    for(let b=0;b<BIN_COUNT;b++){
      const m=mag[b];
      total+=m;
      const d=m-prev[b]; if(d>0)df+=d;            // 半波整流：只统计"新增能量"（起音是正向变化）
      if(b===0)continue;                          // bin 0 是直流分量：计入总能量与通量，但不进频段/质心
      wnum+=b*binHz*m;
      if(b<=hiLow)low+=m; else if(b<=hiMid)mid+=m; else high+=m;
    }
    lowEnv[f]=low;
    bandLow+=low; bandMid+=mid; bandHigh+=high;
    brightnessCurve[f]=total>EPS?wnum/total:0;                       // 频谱质心（Hz）
    let cum=0,rb=0;                                                  // 85% rolloff（Hz）
    const target=total*0.85;
    for(let b=1;b<BIN_COUNT;b++){ cum+=mag[b]; if(cum>=target){ rb=b; break } }
    rolloffCurve[f]=rb*binHz;
    fluxCurve[f]=df/BIN_COUNT;
    prev.set(mag);

    if((f%SPECTRO_STEP)===0){                                        // 缩略频谱列（0=静 → 1=满刻度）
      const base=((f/SPECTRO_STEP)|0)*SPECTRO_ROWS;
      for(let k=0;k<SPECTRO_ROWS;k++){
        const b0=2*k+1, b1=Math.min(b0+1,BIN_COUNT-1);
        const v=(mag[b0]+mag[b1])*0.5;
        const db=20*Math.log10(v+1e-7);
        spectrogram[base+k]=clamp((db-SPECTRO_MIN_DB)/(-SPECTRO_MIN_DB),0,1);
      }
    }
  }
  if(aborted())return null;

  /* ---------- 6.3 起音检测：起音强度 + 非因果双阈值（高阈值找峰、低阈值回溯）+ 峰值拾取 ---------- */
  rep(70,'检测起音…');
  const onsets=[];
  {
    const diff=new Float32Array(frames), sm=new Float32Array(frames);
    for(let i=1;i<frames;i++){ const d=lowEnv[i]-lowEnv[i-1]; diff[i]=d>0?d:0 }
    for(let i=1;i<frames-1;i++)sm[i]=(diff[i-1]+2*diff[i]+diff[i+1])*0.25;   // 轻微平滑，抑制单帧抖动
    const preS=new Float64Array(frames+1);
    let maxS=0,maxLow=0;
    for(let i=0;i<frames;i++){
      preS[i+1]=preS[i]+sm[i];
      if(sm[i]>maxS)maxS=sm[i];
      if(lowEnv[i]>maxLow)maxLow=lowEnv[i];
    }
    const floorThr=maxS*ONSET_FLOOR_RATIO;
    const gate=maxLow*ONSET_GATE_RATIO;
    const minGapFrames=Math.max(1,Math.round(ONSET_MIN_GAP/frameDur));
    let last=-1e9;
    for(let i=1;i<frames-1;i++){
      if(lowEnv[i]<gate)continue;                       // 静音段不产生起音
      if(!(sm[i]>=sm[i-1]&&sm[i]>sm[i+1]))continue;      // 局部极大
      const a=Math.max(0,i-ONSET_WIN), b=Math.min(frames-1,i+ONSET_WIN);
      const mean=(preS[b+1]-preS[a])/Math.max(1,b-a+1);   // 非因果：用前后 ±0.35s 的起音强度均值当基准
      if(!(sm[i]>mean*ONSET_RATIO_HI+floorThr))continue;
      let j=i;                                           // 回溯到低阈值穿越点，得到更准的起音时刻
      const lim=Math.max(1,i-ONSET_BACK);
      const thrLo=mean*ONSET_RATIO_LO+floorThr;
      while(j>lim&&sm[j-1]>thrLo)j--;
      if(j-last<minGapFrames)continue;                    // 不应期
      last=j;
      onsets.push((j*hop)/sampleRate);
    }
  }
  if(aborted())return null;

  /* ---------- 6.4 段落分段：宏观能量（1s 平滑）→ 边界强度曲线 → 按强度贪心取峰（最小段长 2.5s）
     → 相似能量合并 → 边界门限复核 → 数量上限 ---------- */
  rep(78,'划分段落…');
  const segments=[];
  {
    const win=Math.max(1,Math.round(SEG_SMOOTH_SEC/frameDur));
    const mrv=new Float32Array(frames);
    const pre=new Float64Array(frames+1);
    for(let i=0;i<frames;i++)pre[i+1]=pre[i]+rmsCurve[i];
    for(let i=0;i<frames;i++){
      const a=Math.max(0,i-(win>>1)), b=Math.min(frames,i+(win>>1)+1);
      mrv[i]=(pre[b]-pre[a])/Math.max(1,b-a);
    }
    const sorted=Float32Array.from(mrv);
    sorted.sort();
    const nf=sorted.length;
    const p10=sorted[Math.min(nf-1,Math.floor(nf*0.10))];
    const p90=sorted[Math.min(nf-1,Math.floor(nf*0.90))];
    const span=p90-p10;
    if(p90>1e-5){
      if(span<=p90*SEG_SPAN_MIN){
        segments.push({start:0,end:samples/sampleRate,energy:1});     // 全程等能量：整段算一段
      }else{
        const ref=p90>EPS?p90:1;
        const minF=Math.max(2,Math.round(SEG_MIN_SEC/frameDur));
        const edgeF=Math.max(1,Math.round(SEG_EDGE_SEC/frameDur));
        const acc=new Float64Array(frames+1);                         // mrv 前缀和：任意区间均值 O(1)
        for(let f=0;f<frames;f++)acc[f+1]=acc[f]+mrv[f];
        const meanOf=(a,b)=>(acc[b]-acc[a])/Math.max(1,b-a);
        const stepAt=(b)=>{                                           // 边界强度（0-1 量纲）
          const a0=Math.max(0,b-edgeF), b1=Math.min(frames,b+edgeF);
          return Math.abs(meanOf(a0,b)-meanOf(b,b1))/ref;
        };

        /* ① 候选边界：只取"前后都至少有一个最短段"的位置（b ≥ minF 且 frames-b ≥ minF），
              强度必须 > SEG_BOUNDARY_MIN。开头的起振尖峰因此天然被排除（它距曲首不足 2.5 秒）。 */
        const cand=[];
        for(let b=minF;b<=frames-minF;b++){
          const s=stepAt(b);
          if(s>SEG_BOUNDARY_MIN)cand.push([b,s]);
        }

        /* ② 按强度从大到小贪心接受，要求与已接受边界相距 ≥ minF。
              这样"最强的几个真实边界"一定保留（副歌进出、强弱对比），而 1-2 秒的过渡抖动
              挤不进 2.5 秒间距、自然被吸收（这正是上一版 13 段/6 段 ≤2 秒的成因）。 */
        cand.sort((x,y)=>y[1]-x[1]);
        const cuts=[];
        for(const [b] of cand){
          let ok=true;
          for(const c of cuts){ if(Math.abs(c-b)<minF){ ok=false; break } }
          if(ok&&b>=minF&&frames-b>=minF)cuts.push(b);
        }
        cuts.sort((x,y)=>x-y);
        const runs=[];
        let prevCut=0;
        for(const c of cuts){ runs.push([prevCut,c]); prevCut=c }
        runs.push([prevCut,frames]);

        /* ③ 相似能量合并（差 < SEG_MERGE_DE）：消除"切开了但两段响度几乎一样"的伪边界 */
        for(let changed=true;changed;){
          changed=false;
          for(let i=0;i<runs.length-1;i++){
            const d=Math.abs(meanOf(runs[i][0],runs[i][1])-meanOf(runs[i+1][0],runs[i+1][1]))/ref;
            if(d<SEG_MERGE_DE){ runs[i][1]=runs[i+1][1]; runs.splice(i+1,1); changed=true; break }
          }
        }

        /* ④ 边界门限复核：合并改变了邻接关系，可能出现"新边界跳变 ≤ 0.25"的情况，再扫一遍剔除 */
        for(let changed=true;changed;){
          changed=false;
          for(let i=0;i<runs.length-1;i++){
            if(stepAt(runs[i][1])<=SEG_BOUNDARY_MIN){
              runs[i][1]=runs[i+1][1]; runs.splice(i+1,1); changed=true; break;
            }
          }
        }

        let merged=runs;
        while(merged.length>SEG_MAX){                                 // ⑤ 超标时反复合并"能量最低的相邻对"
          let bi=0,bv=Infinity;
          for(let i=0;i<merged.length-1;i++){
            const e=meanOf(merged[i][0],merged[i+1][1]);
            if(e<bv){ bv=e; bi=i }
          }
          merged[bi][1]=merged[bi+1][1];
          merged.splice(bi+1,1);
        }
        for(const r of merged){
          segments.push({start:(r[0]*hop)/sampleRate, end:(r[1]*hop)/sampleRate,
                         energy:clamp(meanOf(r[0],r[1])/ref,0,1)});
        }
        if(!segments.length)segments.push({start:0,end:samples/sampleRate,energy:1});   // 兜底：宁少不多
      }
    }
  }

  /* ---------- 6.5 MIDI 侧 ---------- */
  rep(88,'读取工程音符…');
  const mid=analyzeMidi(proj);
  if(aborted())return null;

  const btot=bandLow+bandMid+bandHigh;
  const feat={
    /* —— T1 规格字段 —— */
    duration:samples/sampleRate,
    sampleRate,
    rmsCurve,
    peak,
    crest,
    bandEnergy:{low:btot>EPS?bandLow/btot:0, mid:btot>EPS?bandMid/btot:0, high:btot>EPS?bandHigh/btot:0},
    brightnessCurve,
    rolloffCurve,
    fluxCurve,
    onsets,
    segments,
    stereoWidth,
    spectrogram,
    pitchHistogram:mid.pitchHistogram,
    key:mid.key,
    barDensity:mid.barDensity,
    /* —— 附加（T3/T4 与自检需要，免去重复推导）—— */
    frames,
    hop,
    frameDur,
    overallRms,
    spectroCols,
    spectroRows:SPECTRO_ROWS,
    spectroStep:SPECTRO_STEP,
    binHz,
    bands:{lowHiHz:LOW_HI_HZ, midHiHz:MID_HI_HZ},
    bars:mid.bars,
    stepsPerBar:mid.stepsPerBar,
    meterN:mid.meterN,
    mode:mid.mode,
    noteCount:mid.noteCount,
    drumHits:mid.drumHits,
    aborted:false,
    stats:{frames,yields,onsets:onsets.length,segments:segments.length,noteCount:mid.noteCount,
           drumHits:mid.drumHits,spectroCols,elapsedMs:Math.round(now()-t0)}
  };
  rep(100,'分析完成');
  return feat;
}
