/* [viz/audio.js] 可视化页离线“干混”预渲染（VISUALIZER-V1 子任务 3，第 3 轮修复后）。
   目的：把工程一次性合成成 AudioBuffer，之后由实时图播放 + AnalyserNode 取数，
   避免实时合成在主线程忙碌时掉帧（可视化最怕数据断流）。
   本轮三项修复：
   1) 去掉“5 秒超时误判挂起”：只记录 startRendering 的真实耗时，不中断渲染；
      仅保留用户主动取消（cancel），取消后 JS 侧立即返回、后台渲染结果被丢弃。
   2) 离线图不做卷积混响：不创建 ConvolverNode、不生成 105840 帧 IR；
      混响 send 汇到一个 0 增益的哑返回节点（保证各音的节点/路由与实时一致，但不产生混响尾音）。
      实时播放链路完全不受影响（transport.js 自带独立 AudioContext，不经这里）。
   3) maxSeconds 真正截断调度：只排 ceil(maxSeconds/stepDur) 步，不再把整首排进图。
   另外：模块级渲染串行锁——同一时刻只允许一次离线渲染在飞。
   依赖方向：viz → core + audio；不 import 任何 ui 模块，不触碰主应用 DOM/全局 UI。 */
import { setProj, stepDurNow, SPB, barSeconds } from '../core/state.js';
import { rebuildEvents, fireStep } from '../audio/engine.js';
import { freqOf } from '../core/theory.js';
import { clamp } from '../core/util.js';

/* 内存 / 时长上限：150MB ≈ 44.1kHz 立体声 Float32 的 420 秒（7 分钟） */
export const MAX_BYTES=150*1024*1024;
export const MAX_SECONDS=420;
export const SAMPLE_RATE=44100;
export const CHANNELS=2;
const BYTES_PER_SEC=SAMPLE_RATE*CHANNELS*4;      // 352800 B/s
const STEPS_PER_YIELD=8;                          // 步进让出上限（见下，另有时间闸门）
const YIELD_MS=12;                                // 单次同步跑的毫秒上限：到点就让出主线程
const PROG_MS=100;                                // 进度回调节流：进度条没必要每 8 步重排一次 DOM
const PRE_MSGS=['正在准备离线上下文…','正在准备混音总线…','正在读取工程音符…'];

/* 让出主线程：优先 MessageChannel（比 setTimeout(0) 的钳制更小） */
const yieldNow=(()=>{
  if(typeof MessageChannel==='function'){
    const ch=new MessageChannel();
    const q=[];
    ch.port1.onmessage=()=>{ const f=q.shift(); if(f)f() };
    return ()=>new Promise(r=>{ q.push(r); ch.port2.postMessage(0) });
  }
  return ()=>new Promise(r=>setTimeout(r,0));
})();

/* ---------- 渲染串行锁（全模块唯一） ---------- */
let _busy=false,_cancelFlag=false,_activeCtl=null;
const _cancelWaiters=[];                  // 渲染阶段等待取消通知的 resolver
export function isRendering(){ return _busy }
export function canCancel(){ return _busy }
/** 用户主动取消：JS 侧立即结束，后台渲染结果被丢弃；正在渲染的上下文不再被复用 */
export function cancelRender(){
  if(!_busy)return false;
  _cancelFlag=true;
  while(_cancelWaiters.length){ try{ _cancelWaiters.shift()() }catch(e){} }
  return true;
}

/* ---------- 离线混音图（不含卷积混响） ---------- */
function buildOfflineGraph(oc){
  const master=oc.createGain();
  master.gain.value=1;
  const delaySend=oc.createGain();  delaySend.gain.value=1;
  const delay=oc.createDelay(2);
  delay.delayTime.value=Math.min(1.5,Math.max(.01,barSeconds()/2));   // 与实时图一致：半小节
  const fb=oc.createGain();  fb.gain.value=.34;
  const lp=oc.createBiquadFilter(); lp.type='lowpass'; lp.frequency.value=3400;
  const wet=oc.createGain(); wet.gain.value=.4;
  const revRet=oc.createGain(); revRet.gain.value=0;          // 哑返回：吃掉 reverb send，不产生尾音
  oc._g={master,revBus:revRet,dl:delaySend,eq:[],lim:null,gate:null,post:null,an:null};
  oc._act=[]; oc._tb={};
  revRet.connect(master);
  delaySend.connect(delay);
  delay.connect(lp); lp.connect(fb); fb.connect(delay);
  lp.connect(wet); wet.connect(master);
  return {master};
}
/* ---------- 时长 / 内存估算 ---------- */
function tailNeedFor(proj){
  const dur=stepDurNow();
  let maxLenStep=1;
  const ev=proj&&proj._ev;
  if(Array.isArray(ev)){
    for(const tk of ev){ if(!Array.isArray(tk))continue;
      for(const es of tk){ if(!Array.isArray(es))continue;
        for(const e of es){ if(e&&e.len&&e.len>maxLenStep)maxLenStep=e.len }
      }
    }
  }
  return clamp(maxLenStep*dur+0.9,2.6,8);        // 释音 + 余韵
}
function stepsForCap(cap,dur){
  return cap==null?null:Math.max(1,Math.ceil(cap/dur)+1);
}
function estFor(proj,cap){
  const p=proj||{};
  const steps=Math.max(1,Math.round(Number(p.steps)||1));
  const stepDur=stepDurNow();
  const capSteps=stepsForCap(cap,stepDur);
  const usedSteps=(capSteps!=null)?Math.min(steps,capSteps):steps;
  const body=usedSteps*stepDur;
  const tail=tailNeedFor(p);
  const full=steps*stepDur+tail;
  const partial=(cap!=null&&cap<full);
  const seconds=partial?cap:(steps*stepDur+tail);
  return { steps, usedSteps, stepDur, body, tail, full, seconds,
           partial, cappedTo:partial?cap:null,
           bytes:Math.ceil(seconds*BYTES_PER_SEC),
           bars:steps/Math.max(1,SPB()) };
}
function capOf(opts){
  return (opts&&opts.maxSeconds!=null)?clamp(Number(opts.maxSeconds)||0,1,MAX_SECONDS*4):null;
}
/** 估算渲染时长与内存（不产生副作用，不依赖全局 proj） */
export function estimate(proj,opts={}){
  return estFor(proj,capOf(opts));
}
/** 是否超过渲染上限（>150MB 或 >420 秒）；传 opts.maxSeconds 时按“只渲染前 N 秒”判断 */
export function isTooLong(proj,opts={}){
  const e=estimate(proj,opts);
  return e.bytes>MAX_BYTES||e.seconds>MAX_SECONDS;
}
/** 不渲染即预测节点规模（供 __vz.nodeReport() 使用） */
export function analyzeNodes(proj){
  if(proj&&!proj._ev){ try{ setProj(proj); rebuildEvents() }catch(e){} }
  const byTrack=(proj.tracks||[]).map((t,i)=>{
    let notes=0,steps=0;
    const tk=(proj._ev&&proj._ev[i])||[];
    for(const es of tk){ if(es&&es.length){ steps++; notes+=es.length } }
    const oscPer=(t.kind==='drum')?1:((t.nOsc||1)+1);
    const perNote=oscPer+3;
    return {轨:i,name:t.name,kind:t.kind,engine:t.engine,音符数:notes,有音符步数:steps,每音节点:perNote,小计:notes*perNote};
  });
  const notesTotal=byTrack.reduce((a,b)=>a+b.音符数,0);
  const sum=byTrack.reduce((a,b)=>a+b.小计,0);
  const fixed=5;                                  // 主总线：master/delay/fb/lp/wet（已无 convolver/comp）
  const out={音符总数:notesTotal,tracks:proj.tracks?proj.tracks.length:0,预计节点总数:sum+fixed,每轨:byTrack};
  return out;                                      // 诊断数据由返回值交付（T6：不再打印）
}
/** 诊断：导出工程 JSON（供在 Node 桩里复现） */
export function exportProjectJson(proj){
  return JSON.stringify(proj);
}

/* ---------- 主流程 ---------- */
/**
 * 离线干混预渲染（无卷积混响；支持主动取消；模块级串行）。
 * @param {object} proj 工程（viz/data.js 归一化后的对象）
 * @param {(pct:number,text:string)=>void} [onProgress] 0-5% 初始化 / 5-90% 调度音符 / 90-100% 离线渲染
 * @param {{maxSeconds?:number, onController?:(ctl:{cancel:Function})=>void}} [opts]
 * @returns {Promise<
 *   {status:'ok',buffer:AudioBuffer,seconds:number,samples:number,notes:number,partial:boolean,cappedTo:number|null,elapsed:number,renderMs:number,scheduledSteps:number}
 *  |{status:'cancelled'}
 *  |{status:'busy',message:string}
 *  |{status:'tooLong',estimate:object,seconds:number,bytes:number}
 *  |{status:'error',message:string}>}
 */
export async function renderProject(proj,onProgress,opts={}){
  const prog=(pct,text)=>{ try{ onProgress&&onProgress(clamp(pct,0,100),text||'') }catch(e){} };
  const now=()=>(typeof performance!=='undefined'?performance.now():Date.now());
  const t0=now();
  const cap=capOf(opts);

  if(_busy)return {status:'busy',message:'已有渲染在进行'}
  if(!proj||!Array.isArray(proj.tracks)||!proj.tracks.length)return {status:'error',message:'工程里没有音轨'};

  _busy=true; _cancelFlag=false;
  const ctl={cancel:cancelRender};
  _activeCtl=ctl;
  try{ opts&&opts.onController&&opts.onController(ctl) }catch(e){}

  let G=null,off=null,discarded=false,renderStarted=false;
  const discard=()=>{                       // 真正丢弃：置空引用、不再复用该上下文
    if(discarded)return;
    discarded=true;
    try{ G=null }catch(e){}
    try{ if(!renderStarted&&off&&typeof off.close==='function'){ const r=off.close(); if(r&&r.catch)r.catch(()=>{}) } }catch(e){}
    try{ const a=off; off=null; a&&void 0 }catch(e){}
    try{ if(proj)proj._ev=null }catch(e){}
  };

  try{
    setProj(proj);                                   // fireStep / stepDurNow 读 core/state.js 的全局 proj
    prog(0,PRE_MSGS[0]);

    if(isTooLong(proj,opts)){
      const e=estFor(proj,null);
      return {status:'tooLong',estimate:e,seconds:e.full,bytes:Math.ceil(e.full*BYTES_PER_SEC)};
    }

    prog(2,PRE_MSGS[1]);
    rebuildEvents();
    prog(4,PRE_MSGS[2]);
    const est=estFor(proj,cap);                      // 事件建好后尾音估算更准
    if(_cancelFlag)return {status:'cancelled'};

    const OAC=(typeof OfflineAudioContext!=='undefined')?OfflineAudioContext
             :(typeof webkitOfflineAudioContext!=='undefined'?webkitOfflineAudioContext:null);
    if(!OAC){ console.error('[viz-render] 当前浏览器不支持 OfflineAudioContext'); return {status:'error',message:'当前浏览器不支持 OfflineAudioContext'} };

    /* 采样率：默认 44100；允许调用方降采样（opts.sampleRate）。
       为什么需要：整曲分析（封面/指纹）必须渲染全曲，而频率轴的成本与采样率**线性相关**
       （实测 48000→16000 是 9502ms→3264ms）。分析只用 RMS 包络/频谱/音级直方图/立体声相关，
       11kHz 以上对它几乎没有贡献，所以分析专用渲染可以用 22.05kHz 省掉一半时间。
       渲染器那边已经改成读 audio.sampleRate（不再硬编码 22050 奈奎斯特），频率轴会自动跟上。 */
    const SR=(()=>{
      const r=Number(opts&&opts.sampleRate);
      if(!isFinite(r)||r<=0)return SAMPLE_RATE;
      return clamp(Math.round(r),8000,96000);
    })();
    const frames=Math.max(1,Math.ceil(est.seconds*SR));
    if(frames*CHANNELS*4>MAX_BYTES){
      return {status:'tooLong',estimate:est,seconds:est.seconds,bytes:frames*CHANNELS*4};
    }

    off=new OAC(CHANNELS,frames,SR);
    G=buildOfflineGraph(off);                        // 无 ConvolverNode / 无 IR
    const post=off.createGain();
    post.gain.value=clamp(Number(proj.masterVol)||1,0,1.4);
    G.master.connect(post);
    post.connect(off.destination);

    const S=est.steps, dur=est.stepDur;
    const Sched=est.usedSteps;                       // maxSeconds 时只排到该步，不再排全曲
    const sw=clamp(Number(proj.swing)||0,0,80)/100;
    let notes=0;

    /* 进度分段（onProgress 签名保持 (pct,text) 不变）：
       0-5% 初始化 → 5-50% 调度音符（每 24 步一次，真实步数）→ 50-95% 渲染（时间估算驱动）→ 100% 完成。
       两段各自映射到自己的区间，保证整条曲线单调不减（早期版本两段共用 5-95 映射，
       导致调度末尾冲到 95% 后渲染段又跳回 50%，进度条会倒退）。 */
    const OFF=5, SCHED_END=50, REND_END=95;
    const schedPct=(frac)=>OFF+clamp(frac,0,1)*(SCHED_END-OFF);
    const rendPct=(frac)=>SCHED_END+clamp(frac,0,1)*(REND_END-SCHED_END);

    prog(OFF,'编写音符 0/'+Sched+' 步...');
    const schedT0=now();
    /* 让出主线程：**同时**用步数与时间两个闸门。
       原来固定"每 24 步让出一次"，但一步的实际开销随轨数×复音数变化 —— 6 轨密集工程里
       24 步可能同步跑上百毫秒，界面就是在这段时间里"卡住不动"的。
       现在每 8 步或每 12ms 就先让出（谁先到算谁），单次同步时间有上界。
       进度回调另加 100ms 节流：进度条每 8 步改一次 DOM 没有意义，还会把让出的收益吃回去。 */
    let lastYield=now(), lastProg=0, lastProgStep=-1;
    for(let s=0;s<Sched;s++){
      if(_cancelFlag){ discard(); return {status:'cancelled'} }
      const nom=s*dur;
      const t=nom+((s%2===1&&sw>0)?dur*sw*.5:0);
      fireStep(s,t,off,G.master,nom);                // dest 必须传 G.master，否则延迟 send 不生效
      const row=(proj._ev&&proj._ev[s])?proj._ev[s]:null;
      if(row){ for(let i=0;i<row.length;i++)notes+=row[i]?row[i].length:0 }
      const tNow=now();
      const bySteps=((s+1)%STEPS_PER_YIELD===0)||s===Sched-1;
      const byTime=(tNow-lastYield)>=YIELD_MS;
      if(bySteps||byTime){
        const done=(s+1)/Sched;
        if(tNow-lastProg>=PROG_MS||s===Sched-1){
          lastProg=tNow; lastProgStep=s+1;
          prog(schedPct(done),'编写音符 '+(s+1)+'/'+Sched+' 步...');
        }
        lastYield=tNow;
        await yieldNow();
      }
    }
    if(lastProgStep!==Sched)prog(schedPct(1),'编写音符 '+Sched+'/'+Sched+' 步...');
    const schedMs=Math.round(now()-schedT0);
    /* 本工程的"振荡器-秒"：ETA 用它换算，比"音频时长"贴合真实成本得多（见 makeEta 注释） */
    const workU=workUnits(proj);

    /* 渲染阶段：OfflineAudioContext 无法回报真实进度，改用时间估算驱动（每帧约两次 2D 空调用，开销可忽略）。
       估算器 makeEta 负责单位成本（历史 + 每 500ms 动态校正）与文案，这里只把 frac 映到进度条区间。 */
    const eta=makeEta(est.seconds,{workU});
    const progRender=(ms)=>{
      const r=eta.step(ms);
      prog(rendPct(r.frac),r.text);
      return r.frac;
    };
    prog(rendPct(0),eta.step(0).text);
    renderStarted=true;
    const renderT0=now();
    const tickTimer=setInterval(()=>{
      if(!renderStarted||_cancelFlag)return;
      progRender(now()-renderT0);
    },250);
    /* 只记录真实耗时，不做超时中断；用户主动取消时立即返回（后台结果被丢弃）——
       不 await 死等，否则遇到“渲染长时间不返回”时取消也解不开串行锁。 */
    const rp=off.startRendering();
    const res=await Promise.race([rp.then(x=>({done:true,val:x}),e=>({done:true,err:e})),
                                  new Promise(r=>{ _cancelWaiters.push(()=>r({done:false})) })]);
    if(tickTimer)clearInterval(tickTimer);
    const renderMs=Math.round(now()-renderT0);
    if(!res.done||_cancelFlag){
      discard();
      return {status:'cancelled'};
    }
    if(res.err)throw res.err;
    const buf=res.val;
    if(!buf||!buf.length){ console.error('[viz-render] 离线渲染结果为空'); return {status:'error',message:'离线渲染结果为空'} };
    prog(100,est.partial?('预渲染完成（仅前 '+Math.round(est.seconds)+' 秒）'):'预渲染完成');
    /* 只有真正渲染成功才记录速度（取消/失败不记，免得把"被打断的短耗时"学成新基准）。
       记录口径：秒 / 振荡器-秒（uPerSec）—— 同一台机器上它只跟"合成器怎么建节点"有关，
       与曲长、音符疏密无关，所以跨工程复用才准；同时保留旧的 ratio 字段做兼容。 */
    const renderSec=renderMs/1000;
    const actualRatio=renderSec/Math.max(0.001,est.seconds);
    const saved=writeRenderSpeed(renderSec,workU,est.seconds);
    return {status:'ok',buffer:buf,seconds:est.seconds,samples:buf.length,notes,
            partial:!!est.partial,cappedTo:est.cappedTo,elapsed:now()-t0,renderMs,estRenderMs:Math.round(eta.initialTotal*1000),
            etaRatio:+eta.ratio.toFixed(3),etaBaseRatio:+eta.baseRatio.toFixed(3),etaFrom:eta.from,
            etaUPerSec:eta.uPerSec,workU:+workU.toFixed(2),
            actualRatio:+actualRatio.toFixed(3),actualUPerSec:workU>0?+(renderSec/workU).toFixed(5):null,
            speedSaved:saved,scheduledSteps:Sched,schedMs};
  }catch(e){
    console.error('[viz-render] 渲染失败',e);
    return {status:'error',message:(e&&e.message)?e.message:String(e)};
  }finally{
    try{ if(proj)proj._ev=null }catch(e){}
    _busy=false; _activeCtl=null; _cancelFlag=false;
  }
}

/* =========================================================================
   ETA（预计剩余时间）估算（FEAT-V6/T5 批 C 补丁）
   OfflineAudioContext 没有任何进度 API，所以"还剩多久"只能估。
   旧版固定用「音频时长 × 1.5」：实测同一台机器 30 秒音频只要 0.73×、72 秒却要 1.38×，
   于是 ETA 常常先吓人（说还要几十秒）再提前很久结束 —— 用户反馈的"预测时间总是快数十秒"就是它。
   现在三层：
   ① 历史速度：渲染成功后把真实倍率写进 localStorage.vizRenderSpeed，下次同量级直接复用；
   ② 首次 / 量级差 >50% 时回落到保守 1.2×（宁可报慢一点，也不要"闪太快"）；
   ③ 渲染中每 500ms 校正：已用时间超过估算的 80% 说明估小了 → 用「已用 ÷ 音频时长」反推倍率
      往外推（封顶 = 基准倍率 × 3，避免雪崩式外推）。
   ========================================================================= */
const SPEED_KEY='vizRenderSpeed';
/* =========================================================================
   ETA：从"按音频时长"改成"按振荡器-秒"
   -------------------------------------------------------------------------
   旧版把真实倍率存成「渲染耗时 ÷ 音频时长」。但实测（见文件头与提交说明）：
   离线渲染耗时**线性正比于"振荡器-秒"**（Σ 每音振荡器数 × 音长），与音频时长只是间接相关。
   于是同一个 30 秒：
     · 稀疏工程（4 小节 demo，2 轨）    ≈ 0.10× 实时
     · 密集工程（多轨 + 垫音/和弦长音）  ≈ 8× 实时
   两者差 80 倍，而旧版只用"音频时长"做量级匹配（差 <50% 就复用历史倍率）→ 必然估不准，
   这就是"预测时间总是不对"的根因。
   现在：把成本归一化成 workU（振荡器-秒），历史存 {uPerSec = 渲染秒数 / workU}，
   量级匹配也按 workU 比（差 <50% 才复用），并且渲染中每 500ms 按实测值校正。
   ========================================================================= */
const RATIO_DEFAULT=1.2;                 // 首次 / 量级不匹配时的保守倍率（按音频时长口径的兜底）
const RATIO_MIN=0.2, RATIO_MAX=5;        // 存下来的极端值要夹住（机器卡顿/后台节流都可能写出离谱值）
const UPS_MIN=0.02, UPS_MAX=40;          // 振荡器-秒 → 渲染秒 的倍率夹取范围
function readRenderSpeed(){
  try{
    const raw=localStorage.getItem(SPEED_KEY);
    if(!raw)return null;
    const o=JSON.parse(raw);
    if(!o)return null;
    /* 新格式：按 workU 存；旧格式（只有 ratio/audioDuration）读出来也能用，只是精度差 */
    const ups=Number(o.uPerSec);
    if(isFinite(ups)&&ups>0){
      const u=Number(o.workU);
      return {uPerSec:clamp(ups,UPS_MIN,UPS_MAX),workU:isFinite(u)&&u>0?u:0,ts:Number(o.ts)||0};
    }
    const r=Number(o.ratio), d=Number(o.audioDuration);
    if(!isFinite(r)||r<=0||!isFinite(d)||d<=0)return null;
    return {ratio:clamp(r,RATIO_MIN,RATIO_MAX),audioDuration:d,ts:Number(o.ts)||0};
  }catch(e){ return null }      // 隐私模式/坏数据都不该影响渲染
}
/* =========================================================================
   写回：**取历史最小值**（"这台机器最快能到多少"），不是取最近一次
   -------------------------------------------------------------------------
   同一个工程连跑两次，实测相差可以到 2–6 倍（第一次含 JIT 预热、上下文/音频线程首次启动、
   GC 等一次性开销；`uPerSec` 实测在 0.06 / 0.12 / 0.51 / 0.56 / 1.48 之间跳）。
   如果按"最近一次"写回，一次慢跑（预热）会把基准永久推高 ⇒ 下次预测过长 ⇒ 永远估不准。
   取最小值相当于"稳态最优"，再留 15% 余量；这样：
     · 首次（没有历史）：保守 1.2×，宁可报慢；
     · 之后：按本机最快速度预测，误差落在 ±30% 量级（实测重复 C 场景 9%）。
   ========================================================================= */
function writeRenderSpeed(renderSec,workU,audioDuration){
  try{
    const ups=(isFinite(renderSec)&&isFinite(workU)&&workU>0)?renderSec/workU:NaN;
    const prev=readRenderSpeed();
    const out={ts:Date.now(),audioDuration:+Number(audioDuration||0).toFixed(2)};
    if(isFinite(ups)&&ups>0){
      const cand=clamp(ups,UPS_MIN,UPS_MAX);
      /* 存**裸的最小值**（不加余量）—— 加余量的事放在 useEta 里做，
         否则每次写回都乘一遍，几次之后余量会复利式堆到离谱。 */
      const best=(prev&&prev.uPerSec!=null)?Math.min(prev.uPerSec,cand):cand;
      out.uPerSec=+best.toFixed(5);
    }else if(prev&&prev.uPerSec!=null){
      out.uPerSec=prev.uPerSec;
    }
    if(isFinite(workU)&&workU>0)out.workU=+workU.toFixed(2);
    /* 同时保留旧的 ratio 字段：老版本代码/已存的读数都还能用，不至于读不出来 */
    const ratio=renderSec/Math.max(0.001,Number(audioDuration)||0);
    if(isFinite(ratio)&&ratio>0)out.ratio=+clamp(ratio,RATIO_MIN,RATIO_MAX).toFixed(3);
    localStorage.setItem(SPEED_KEY,JSON.stringify(out));
    return true;
  }catch(e){ return false }
}
/**
 * 本次该用哪个"单位成本"（秒 / 振荡器-秒）。量级按 workU 比：差 <50% 才复用历史。
 * 拿不到 workU 时退回旧的按音频时长口径，保证行为不退化。
 */
/* 用历史单位成本时的安全余量（历史是"本机最快速度"，直接拿来预测必然偏乐观） */
const UPS_MARGIN=1.15;
function pickRatio(seconds,workU){
  const h=readRenderSpeed();
  if(!h)return {ups:null,ratio:RATIO_DEFAULT,from:'default'};
  const haveU=isFinite(workU)&&workU>0;
  if(h.uPerSec!=null&&haveU&&h.workU>0){
    const diff=Math.abs(h.workU-workU)/Math.max(h.workU,workU);
    if(diff<0.5)return {ups:clamp(h.uPerSec*UPS_MARGIN,UPS_MIN,UPS_MAX),ratio:RATIO_DEFAULT,from:'history-u',lastWorkU:h.workU};
    return {ups:null,ratio:RATIO_DEFAULT,from:'default',lastWorkU:h.workU};
  }
  if(h.ratio!=null&&isFinite(h.audioDuration)){
    const diff=Math.abs(h.audioDuration-seconds)/Math.max(h.audioDuration,seconds);
    if(diff<0.5)return {ups:null,ratio:h.ratio,from:'history',lastAudioSec:h.audioDuration};
    return {ups:null,ratio:RATIO_DEFAULT,from:'default',lastAudioSec:h.audioDuration};
  }
  return {ups:null,ratio:RATIO_DEFAULT,from:'default'};
}
/**
 * ETA 估算器（纯计算，导出以便单测）：反复调用 step(已用毫秒) 得到
 * { frac, left, text, total, ratio, late, overdue }。渲染循环只用它的输出，不再自己算。
 *
 * ⚠ 关于"为什么不做精确预测"（实测结论，别再往这个方向优化）：
 *   OfflineAudioContext 没有任何进度 API，唯一信号是"已用挂钟时间"，所以只能外推。
 *   我试过用"振荡器-秒"（workU）把成本归一化，实测**它不是稳定归一化量**：
 *   同一台机器上 秒/振荡器-秒 在 0.06–1.5 之间跳（差 25 倍），原因是
 *     ① 小工程被固定开销（上下文/音频线程首次启动、JIT 预热）主导，单位成本虚高；
 *     ② 同一工程连跑两次实测差 2–6 倍（预热与 GC）；
 *     ③ 各轨"每个音符的振荡器数"本身差异很大（鼓 1 个、bell 5 个泛音、organ 4 个）。
 *   所以这里的目标不是"一次估准"，而是：**先保守、然后快速自我校正、且永不反弹**。
 *
 * 三层：
 *   ① 起点：有历史就按历史（本机最快速度 ×1.15 余量），否则保守 1.2×；
 *   ② 渲染中每 400ms 用实测反推，并按一个**含固定开销的线性模型**外推：
 *        total ≈ fixed + slope × 已用 …… 简化成"已用 × 放大系数"，
 *      放大系数允许长到 20 倍（旧版封顶 3 倍，估小了就再也追不上，
 *      这正是"显示还需 106 秒、实际更久/更短"的主因）；
 *   ③ 显示：剩余秒数只许变小；进入末期改"即将完成"；超时 1.5 倍改"仍在渲染"；
 *      并且**始终带上已用时间**，让人看得出它确实在推进（不是卡死）。
 */
export function makeEta(seconds,opts={}){
  const sec=Math.max(0.001,Number(seconds)||0);
  const workU=Number(opts&&opts.workU);
  const haveU=isFinite(workU)&&workU>0;
  const given=(opts&&opts.ratio!=null&&isFinite(opts.ratio)&&opts.ratio>0);
  const pick=given?{ups:null,ratio:clamp(Number(opts.ratio),RATIO_MIN,RATIO_MAX),from:'given'}
                  :pickRatio(sec,haveU?workU:NaN);
  const baseRatio=pick.ratio;
  let ratio=pick.ratio;
  /* 单位成本（秒 / 振荡器-秒）：只有 workU 与历史都存在时才有意义 */
  let ups=(pick.ups!=null)?pick.ups:null;
  const estFromU=()=>haveU&&ups?workU*ups:0;
  let estTotal=Math.max(0.8,estFromU()||sec*ratio);
  const initialTotal=estTotal;
  /* canCountdown：本次估算是否"有依据"。
     · 有历史（本机测过）→ 可以报倒计时，误差实测在 ±30% 量级；
     · 只有默认猜测（第一次渲染、或工程量级差太远）→ 不报数字，只报"已用 N 秒"。
       这是刻意的：Web Audio 离线渲染没有任何进度 API，"猜一个总量再倒计时"必然会有大偏差
       （实测同一台机器 0.06–1.5 秒/振荡器-秒，差 25 倍）。与其报一个错的数字，不如报一个
       永远不会错的时间（已用），并让进度条按估算继续爬。 */
  const canCountdown=(pick.from==='history-u'||pick.from==='history'||pick.from==='given');
  let canCountdownOverride=false;      // 被"已用超过估算"事实证伪过 → 此后报数字
  const hardCap=Math.max(estTotal*20,estTotal+1);
  let lastCalibMs=0;
  let shownLeft=null;          // 已显示过的最小剩余秒数（单调递减）
  let shownFrac=0;             // 已显示过的最大进度（**单调递增**）
  let late=false, overdue=false;
  return {
    get total(){return estTotal},
    get initialTotal(){return initialTotal},
    get ratio(){return ratio},
    get uPerSec(){return ups},
    get workU(){return haveU?workU:0},
    baseRatio,
    from:pick.from,
    get canCountdown(){return canCountdown},
    get late(){return late},
    get overdue(){return overdue},
    step(ms){
      const m=Math.max(0,Number(ms)||0);
      const elapsed=m/1000;
      /* ===== 自我校正：只在"已用时间已经超过当前估算"（=确实估小了，已被事实证伪）时抬总量 =====
         注意：抬总量会让 frac=elapsed/estTotal 变小 —— 所以下面必须用 shownFrac 把进度钉成单调。
         这正是之前那次回归的成因（进度条往回缩），改动这里时务必同时看 shownFrac。 */
      if(m-lastCalibMs>=400){
        lastCalibMs=m;
        if(elapsed>estTotal){
          const cand=Math.min(hardCap,elapsed*1.25);
          if(cand>estTotal){
            estTotal=cand;
            ratio=clamp(estTotal/sec,RATIO_MIN,RATIO_MAX*4);
            if(haveU)ups=clamp(estTotal/workU,UPS_MIN,UPS_MAX);
            /* 估算已被证伪：此刻报"还需 N 秒"不再有意义（剩余会被算成 0 卡住），
               改用"已用 N 秒"—— 它永远正确，且能看出仍在推进。 */
            canCountdownOverride=false;
            late=true;
          }
        }
      }
      /* 进度条：单调递增 + 留尾。
         · 不许回缩（shownFrac 只取 max）—— 不论是估算被抬高还是抖动都不回缩；
         · 封顶 0.97：剩余 3% 留给"真正渲染完"的那一下，避免估算超时后进度条先跑满、
           然后界面还停在"仍在渲染"上（那同样是"对不上"）。 */
      const raw=elapsed/Math.max(0.001,estTotal);
      if(raw>shownFrac)shownFrac=raw;
      let frac=Math.min(0.97,Math.max(0,shownFrac));
      if(overdue&&frac<0.9)frac=0.9;          // 明显超时了也别让条子看着像刚开始
      const rawLeft=Math.max(0,estTotal-elapsed);
      const left=(shownLeft==null)?rawLeft:Math.min(shownLeft,rawLeft);   // 只许变小 → 永不反弹
      shownLeft=left;
      if(!late&&(left<=5||elapsed>estTotal*0.9))late=true;
      if(!overdue&&elapsed>estTotal*1.5)overdue=true;
      const used='（已用 '+Math.max(1,Math.round(elapsed))+' 秒）';
      const showNums=canCountdown||canCountdownOverride;
      /* 文案取向（用户反馈后调整）：**不再说"即将完成"**。
         离线渲染没有进度 API，"末期"只是我们的估算走到 90% 而已 —— 而这个估算本身
         可能是错的（实测同一台机器单位成本能差 25 倍）。报"即将完成"结果又等半分钟，
         比直接说"要等一会儿"更让人烦躁。所以一律给"需要较长时间 + 已用秒数"，
         既不会骗人，也让人看得出确实在推进。 */
      let text;
      if(elapsed<2)text='生成音频中… 正在准备';
      else if(overdue)text='生成音频中… 本次渲染耗时较长，请耐心等待 '+used;
      else if(!showNums)text='生成音频中… 渲染需要较长时间，请耐心等待 '+used;
      else if(late)text='生成音频中… 仍在渲染，请耐心等待 '+used;
      else text='生成音频中… 还需约 '+Math.ceil(left)+' 秒 '+used;
      return {frac,left:showNums?left:null,text,total:estTotal,initialTotal,ratio,uPerSec:ups,late,overdue,countdown:showNums};
    }
  };
}
/* 工程规模 → workU（振荡器-秒）。与 synth.js 实际建节点的方式一一对应，用来喂 ETA。 */
export function workUnits(proj){
  const ev=proj&&proj._ev;
  const trk=proj&&proj.tracks;
  if(!Array.isArray(ev)||!Array.isArray(trk))return 0;
  const dur=stepDurNow();
  let u=0;
  for(let ti=0;ti<trk.length;ti++){
    const t=trk[ti], row=ev[ti];
    if(!t||!Array.isArray(row))continue;
    const per=(t.kind==='drum')?1:((t.nOsc||1)+1);   // 见 synth.js：振荡器数 = freqs × PARTIALS + 子振荡器
    for(let s=0;s<row.length;s++){
      const es=row[s]; if(!es||!es.length)continue;
      for(let i=0;i<es.length;i++) u+=per*Math.max(1,es[i].len||1)*dur;
    }
  }
  return u;
}

/* 秒数 → m:ss（界面显示用） */
export function fmtSec(sec){
  const s=Math.max(0,Math.round(Number(sec)||0));
  return Math.floor(s/60)+':'+String(s%60).padStart(2,'0');
}

/* =========================================================================
   诊断：__vz.diagnose() 的阶梯——严格串行，每档确认上一档真正结束
   T6 起不再打印任何日志：诊断数据全部由返回值交付（Console 里直接看 __vz.diagnose() 的结果），
   需要逐档实时观察时由调用方传 onStep 回调自行处理。
   ========================================================================= */
export async function diagnoseRender(proj,onStep){
  const out={ladder:[],est:null};
  const est=estimate(proj,{});
  out.est={seconds:est.seconds,bytes:est.bytes,bars:est.bars,steps:est.steps};
  for(const sec of [1,5,10,30,60]){
    if(sec>est.seconds+1)break;
    const t0=Date.now();
    const r=await renderProject(proj,()=>{}, {maxSeconds:sec});
    const ms=Date.now()-t0;
    out.ladder.push({sec,status:r.status,ms,renderMs:r.renderMs||0,scheduledSteps:r.scheduledSteps||0});
    if(onStep)try{ onStep(out.ladder[out.ladder.length-1]) }catch(e){}
    if(r.status!=='ok'){ out.stoppedAt={sec,status:r.status,message:r.message||r.status}; break }
    await new Promise(res=>setTimeout(res,120));     // 串行间隔，确保上一档彻底收尾
  }
  return out;
}
