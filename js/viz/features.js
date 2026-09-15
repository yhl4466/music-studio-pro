/* [viz/features.js] 频域特征提取（FEAT-V2 / T1 骨架）。
   用途：把每帧的频域数据（analyser.getByteFrequencyData → Uint8Array(1024)）压成渲染器可直接消费的两类数据：
   - beat（每帧更新）：低频包络 env（bin 1..9 ≈ 22–194Hz @ fftSize=2048/44.1kHz）+ 自适应起音检测
     onset / strength / since / count / bpm → T3 心电图消费；
   - snapshot（500ms 节流）：音乐特征快照。T1 只有 energy/brightness，T4 追加 T4 雷达图需要的三个：
     flux（频谱通量）/ crest（波峰因数）/ pulseDensity（脉冲密度）；字段原地更新，不动引用。
   设计约束（V2 方案）：
   1) 纯计算：不碰 DOM，不 import 主应用模块，只 import core/util.js 的 clamp；
   2) 帧内零分配：累加器 / 环缓冲全部在 createFeatures() 内一次性分配，update() 只写既有字段，
      不 new 任何数组或对象、不创建闭包；
   3) 常驻对象：snapshot / beat 的引用自创建起不变（main.js 直接把这两个对象挂到 audioData 上）；
   4) BPM 只作读数：取最近 8 个起音间隔的中位数，不做歌单级精度承诺。
   时间基准：由 main.js 每帧传入的 dt（秒）累加得到，不读 performance.now()，便于暂停/隐藏标签页时自然停表。
   依赖方向：viz → core（纯函数）；不被 registry/DOM 引用。 */
import { clamp } from '../core/util.js';

/* ---------- 常量 ---------- */
/* fftSize=2048、44.1kHz → 每 bin ≈ 21.5Hz；bin 1..9 ≈ 22–194Hz（kick / 贝斯的基频区） */
const LOW_LO=1, LOW_HI=9;
const LOW_N=LOW_HI-LOW_LO+1;

const SNAP_MS=500;        // 快照节流周期（方案：features 每 500ms 算一次）
const EMA_TAU=.40;        // 慢线时间常数（秒）：跟随平均响度，用于起音阈值
const RISE_K=1.6;         // 起音阈值：env > 慢线 × RISE_K 且处于上升沿
const SILENT=.04;         // 包络低于此值视为静音，不参与起音判定（挡住底噪触发）
const MIN_GAP=.15;        // 不应期（秒）：挡住同一个鼓点被连续多帧重复触发
const GAP_MAX=2.0;        // 超过此间隔视为"断句"，不计入 BPM 间隔
const GAP_HIST=8;         // BPM 用的最近间隔数
const CENTROID_FULL=1024; // 亮度参考：频谱质心落在 Nyquist（bin 1024）视为最亮
const LOG_FULL=Math.log2(1+CENTROID_FULL);   // 预算常量：log 映射的分母
/* T4 追加特征的参考值（把原始量映射到 0-1，写在这里便于调） */
const FLUX_REF=.05;       // 频谱通量参考：相邻帧平均绝对差达到 0.05（≈ 12.8 个 byte 级）即视为 1.0
const CREST_REF=20;       // 波峰因数参考：峰值/RMS 达到 20 即视为 1.0（规格给定）
const PULSE_REF=8;        // 脉冲密度参考：最近 1 秒内 8 次起音即视为 1.0（规格给定）
const PULSE_SLOTS=100;    // 脉冲密度窗口 = 100 槽 × 10ms = 1 秒
const PULSE_DT=.01;

/**
 * 创建特征提取器（一个实例常驻；main.js 持有它并复用其 snapshot / beat 对象）。
 * @returns {{snapshot:object, beat:object, update:(freqData:Uint8Array,dt:number)=>void, reset:()=>void}}
 */
export function createFeatures(){
  /* 常驻输出对象：引用不变，只改字段 */
  const snapshot={ t:0, energy:0, brightness:0, flux:0, crest:0, pulseDensity:0, frames:0 };
  const beat={ env:0, onset:false, strength:0, since:999, count:0, bpm:0, bpmSrc:'none' };

  /* 内部状态（全部在创建时分配，帧内不再分配） */
  let tSec=0;                       // 内部时间基准（秒），由 dt 累加
  let projBpm=0;                    // 工程 BPM（main.js 每帧传入；>0 时优先作为心率读数）
  let slow=0;                       // 慢线（一阶 EMA）
  let prevEnv=0;                    // 上一帧包络（上升沿判定）
  let sinceOnset=999;               // 距上次起音的秒数
  let accMs=0, accE=0, accC=0, accN=0;   // 快照累加器：毫秒 / 每帧平均能量 / 每帧质心 / 帧数
  let accFlux=0, accCrest=0;        // 快照累加器：每帧通量 / 每帧波峰因数（T4）
  let prev=null;                    // 上一帧频谱副本（算通量用；只在 fftSize 变化时重建）
  let pulseRing=new Uint8Array(PULSE_SLOTS), pulseIdx=0, pulseSum=0, pulseAcc=0;   // 脉冲密度环（T4）
  let gapIdx=0, gapN=0;             // 间隔环缓冲写指针与有效个数
  const gaps=new Float32Array(GAP_HIST);    // 起音间隔（秒）
  const sorted=new Float32Array(GAP_HIST);  // 求中位数的暂存（插入排序，无分配）

  /* 快照落盘：把累加器折算成 0-1 的特征值（t/frames 同时给出可验证的时间证据） */
  function flush(){
    snapshot.energy=accN?clamp(accE/accN,0,1):0;
    /* 亮度用 log 映射（bin 线性除以 256 会让明亮混音直接顶格 1.0）：
       典型音乐质心 1–4kHz ≈ bin 46–186 → 0.55–0.73；暗混音（≈300Hz）≈0.39。 */
    const c=accN?accC/accN:0;
    snapshot.brightness=(accN&&c>0)?clamp(Math.log2(1+c)/LOG_FULL,0,1):0;
    snapshot.flux=accN?clamp(accFlux/accN,0,1):0;              // T4：频谱通量（每帧平均）
    snapshot.crest=accN?clamp(accCrest/accN,0,1):0;            // T4：波峰因数（每帧平均）
    snapshot.pulseDensity=clamp(pulseSum/PULSE_REF,0,1);       // T4：最近 1 秒起音次数 / 8
    snapshot.frames=accN;
    snapshot.t=tSec;
    accMs=0; accE=0; accC=0; accN=0; accFlux=0; accCrest=0;
  }

  /* 起音间隔 → BPM。两条路径：
     ① 主路径：main.js 传进来的工程 BPM（本应用自产工程，读数即真值，不做任何推测）；
     ② 兜底：从起音间隔中位数检测，再做倍频修正 —— 60/中位数 量的是"起音频率"而非"拍速"，
        kick 只落在半数拍子（如 1、3 拍）时会读到真值的一半，所以 <70 翻倍、>160 减半。
     中位数（不是均值）保证被漏掉或多余的个别起音不会带偏读数。 */
  function updateBpm(){
    if(gapN<3)return;                       // 间隔太少，保留上次读数
    for(let i=0;i<gapN;i++)sorted[i]=gaps[i];
    for(let i=1;i<gapN;i++){
      const v=sorted[i];
      let j=i-1;
      while(j>=0&&sorted[j]>v){ sorted[j+1]=sorted[j]; j-- }
      sorted[j+1]=v;
    }
    const med=(gapN&1)?sorted[(gapN-1)>>1]:(sorted[(gapN>>1)-1]+sorted[gapN>>1])*.5;
    if(med<=0)return;
    const raw=60/med;                                          // 检测原始值（起音频率）
    let fixed=raw;
    if(raw<70)fixed=raw*2;                                     // 倍频修正：多数情况下是漏了半数拍子
    else if(raw>160)fixed=raw/2;                               // 反向：起音过密（如双踩/加花）
    const det=clamp(fixed,40,220);
    const useProject=(projBpm>=40&&projBpm<=220);
    beat.bpm=useProject?projBpm:det;
    beat.bpmSrc=useProject?'project':'detect';
  }

  return {
    snapshot, beat,
    /**
     * 每帧调用一次（无 analyser 时不调用，走 reset）。
     * @param {Uint8Array} freqData getByteFrequencyData 的结果（本函数只读）
     * @param {number} dt 距上一帧的秒数（main.js 传入，已 clamp）
     * @param {number} [projectBpm] 工程 BPM（main.js 传入的 proj.bpm；0/缺省 = 无，走检测兜底）
     */
    update(freqData,dt,projectBpm){
      const n=freqData?freqData.length:0;
      if(!n)return;
      projBpm=(projectBpm>=40&&projectBpm<=220)?projectBpm:0;   // 工程 BPM 优先作为心率读数
      if(projBpm&&beat.bpm!==projBpm){ beat.bpm=projBpm; beat.bpmSrc='project' }
      const d=clamp(Number(dt)||0,0,.25);   // 掉帧/切标签页时封顶，避免慢线一次跳变
      tSec+=d;

      /* 单遍扫描：低频求和（包络）+ 全带求和（能量）+ 加权求和（质心）+ 峰值/平方和（波峰因数）
         + 与上一帧的绝对差（频谱通量）。全部在一次循环里完成，不额外分配。 */
      if(!prev||prev.length!==n)prev=new Uint8Array(n);         // 只在 fftSize 变化时重建，不是每帧
      let low=0,p=0,w=0,mx=0,sq=0,df=0;
      for(let i=0;i<n;i++){
        const v=freqData[i];
        p+=v; w+=i*v; sq+=v*v;
        if(v>mx)mx=v;
        const d=v-prev[i]; df+=d<0?-d:d;
        if(i>=LOW_LO&&i<=LOW_HI)low+=v;
      }
      const inv=1/255;
      const env=clamp((low/LOW_N)*inv,0,1);          // 低频包络 0-1
      const binSum=p*inv;                            // 全带线性幅度和（用于均值/质心）
      const rms=Math.sqrt(sq/n);                     // 频谱 RMS（byte 量级）
      accE+=binSum/n;                                // 每帧平均能量（0-1）
      accC+=(binSum>0)?(w/p):0;                       // 每帧频谱质心（bin）
      accFlux+=clamp((df/n)*inv/FLUX_REF,0,1);        // T4：每帧通量（相邻帧平均绝对差 / 参考值）
      accCrest+=clamp((rms>0?(mx/rms):0)/CREST_REF,0,1);   // T4：每帧波峰因数 = 峰值/RMS
      prev.set(freqData);                            // 供下一帧算通量（TypedArray.set 无分配）

      /* 路径 A0：脉冲密度环推进（100 槽 × 10ms = 最近 1 秒），先推进再判定起音，
         这样本帧的起音一定落在刚清空的那个槽里，不会被立刻挤掉。 */
      pulseAcc+=d;
      let slots=0;
      while(pulseAcc>=PULSE_DT&&slots<PULSE_SLOTS){ pulseAcc-=PULSE_DT; slots++ }
      if(pulseAcc>PULSE_DT*PULSE_SLOTS)pulseAcc=PULSE_DT*PULSE_SLOTS;
      for(let k=0;k<slots;k++){
        pulseIdx=(pulseIdx+1)%PULSE_SLOTS;
        pulseSum-=pulseRing[pulseIdx];
        pulseRing[pulseIdx]=0;
      }

      /* 路径 A：每帧——慢线 + 起音检测 */
      slow+=(env-slow)*(1-Math.exp(-d/EMA_TAU));
      sinceOnset+=d;
      beat.env=env;
      beat.onset=false;
      if(env>SILENT&&env>slow*RISE_K&&env>=prevEnv&&sinceOnset>=MIN_GAP){
        const gap=sinceOnset;
        beat.onset=true;
        beat.strength=clamp((env-slow)/Math.max(.05,1-slow),0,1);
        beat.count++;
        pulseRing[pulseIdx]=1; pulseSum++;                    // T4：计入脉冲密度（1 秒窗口）
        if(gap<GAP_MAX){                             // 断句后的第一个起音不计入 BPM
          gaps[gapIdx]=gap; gapIdx=(gapIdx+1)%GAP_HIST;
          if(gapN<GAP_HIST)gapN++;
          updateBpm();
        }
        sinceOnset=0;
      }
      beat.since=sinceOnset;
      prevEnv=env;

      /* 路径 B：500ms 节流——特征快照 */
      accN++;
      accMs+=d*1000;
      if(accMs>=SNAP_MS)flush();
    },
    /** 无 analyser（预渲染中 / 未播放 / 已释放）时调用：清零但保持对象引用不变 */
    reset(){
      tSec=0; slow=0; prevEnv=0; sinceOnset=999;
      accMs=0; accE=0; accC=0; accN=0; accFlux=0; accCrest=0;
      if(prev)prev.fill(0);
      pulseRing.fill(0); pulseIdx=0; pulseSum=0; pulseAcc=0;
      gapIdx=0; gapN=0;
      snapshot.t=0; snapshot.energy=0; snapshot.brightness=0; snapshot.frames=0;
      snapshot.flux=0; snapshot.crest=0; snapshot.pulseDensity=0;
      beat.env=0; beat.onset=false; beat.strength=0; beat.since=999; beat.count=0;
      beat.bpm=projBpm; beat.bpmSrc=projBpm?'project':'none';
    }
  };
}
