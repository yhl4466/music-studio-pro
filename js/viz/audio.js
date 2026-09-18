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
const STEPS_PER_YIELD=24;                        // 步进让出 + 进度回调间隔（规格：每 24 步一次）
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

    const frames=Math.max(1,Math.ceil(est.seconds*SAMPLE_RATE));
    if(frames*CHANNELS*4>MAX_BYTES){
      return {status:'tooLong',estimate:est,seconds:est.seconds,bytes:frames*CHANNELS*4};
    }

    const OAC=(typeof OfflineAudioContext!=='undefined')?OfflineAudioContext
             :(typeof webkitOfflineAudioContext!=='undefined'?webkitOfflineAudioContext:null);
    if(!OAC){ console.error('[viz-render] 当前浏览器不支持 OfflineAudioContext'); return {status:'error',message:'当前浏览器不支持 OfflineAudioContext'} };

    off=new OAC(CHANNELS,frames,SAMPLE_RATE);
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
    for(let s=0;s<Sched;s++){
      if(_cancelFlag){ discard(); return {status:'cancelled'} }
      const nom=s*dur;
      const t=nom+((s%2===1&&sw>0)?dur*sw*.5:0);
      fireStep(s,t,off,G.master,nom);                // dest 必须传 G.master，否则延迟 send 不生效
      const row=(proj._ev&&proj._ev[s])?proj._ev[s]:null;
      if(row){ for(let i=0;i<row.length;i++)notes+=row[i]?row[i].length:0 }
      if((s+1)%STEPS_PER_YIELD===0||s===Sched-1){
        const done=(s+1)/Sched;
        prog(schedPct(done),'编写音符 '+(s+1)+'/'+Sched+' 步...');
        await yieldNow();
      }
    }
    const schedMs=Math.round(now()-schedT0);

    /* 渲染阶段：OfflineAudioContext 无法回报真实进度，改用时间估算驱动（每帧约两次 2D 空调用，开销可忽略）。
       估算器 makeEta 负责倍率（历史速度 + 每 500ms 动态校正）与文案，这里只把 frac 映到进度条区间。 */
    const eta=makeEta(est.seconds);
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
    /* 只有真正渲染成功才记录速度（取消/失败不记，免得把"被打断的短耗时"学成新基准） */
    const actualRatio=renderMs/1000/Math.max(0.001,est.seconds);
    const saved=writeRenderSpeed(actualRatio,est.seconds);
    return {status:'ok',buffer:buf,seconds:est.seconds,samples:buf.length,notes,
            partial:!!est.partial,cappedTo:est.cappedTo,elapsed:now()-t0,renderMs,estRenderMs:Math.round(eta.initialTotal*1000),
            etaRatio:+eta.ratio.toFixed(3),etaBaseRatio:+eta.baseRatio.toFixed(3),etaFrom:eta.from,
            actualRatio:+actualRatio.toFixed(3),speedSaved:saved,
            scheduledSteps:Sched,schedMs};
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
const RATIO_DEFAULT=1.2;                 // 首次 / 量级不匹配时的保守倍率
const RATIO_MIN=0.2, RATIO_MAX=5;        // 存下来的极端值要夹住（机器卡顿/后台节流都可能写出离谱值）
function readRenderSpeed(){
  try{
    const raw=localStorage.getItem(SPEED_KEY);
    if(!raw)return null;
    const o=JSON.parse(raw);
    const r=Number(o&&o.ratio), d=Number(o&&o.audioDuration);
    if(!isFinite(r)||r<=0||!isFinite(d)||d<=0)return null;
    return {ratio:clamp(r,RATIO_MIN,RATIO_MAX),audioDuration:d,ts:Number(o&&o.ts)||0};
  }catch(e){ return null }      // 隐私模式/坏数据都不该影响渲染
}
function writeRenderSpeed(ratio,audioDuration){
  try{
    if(!isFinite(ratio)||ratio<=0||!isFinite(audioDuration)||audioDuration<=0)return false;
    localStorage.setItem(SPEED_KEY,JSON.stringify({
      ratio:+clamp(ratio,RATIO_MIN,RATIO_MAX).toFixed(3),
      audioDuration:+Number(audioDuration).toFixed(2),
      ts:Date.now()
    }));
    return true;
  }catch(e){ return false }
}
/** 本次该用哪个倍率：上次的音频时长与本次相差 <50% 才复用历史，否则回到保守值 */
function pickRatio(seconds){
  const h=readRenderSpeed();
  if(!h)return {ratio:RATIO_DEFAULT,from:'default'};
  const diff=Math.abs(h.audioDuration-seconds)/Math.max(h.audioDuration,seconds);
  if(diff<0.5)return {ratio:h.ratio,from:'history',lastAudioSec:h.audioDuration};
  return {ratio:RATIO_DEFAULT,from:'default',lastAudioSec:h.audioDuration};
}
/**
 * ETA 估算器（纯计算，导出以便单测）：给出音频时长，反复调用 step(已用毫秒) 得到
 * { frac, left, text, total, ratio, late, overdue }。渲染循环只用它的输出，不再自己算。
 *
 * 显示层（永不反弹，方案 A）：
 *   · 剩余秒数只许变小：外推把 total 推高时，显示值取"历史最小"，不会从 6 秒弹回 15 秒；
 *   · 一旦进入末期（剩余 ≤5 秒 或 已用 > 估算的 90%）就锁住，改成"即将完成"，不再报数字；
 *   · 远超估算（已用 > 估算的 150%）改说"仍在渲染，请稍候"；
 *   · 前 2 秒只说"启动中"（不报数字）。
 * 学习层（方案 B）：渲染中的外推只用于进度条曲率与"下次的基准"（成功时按真实倍率写库，
 *   见文件开头那段说明），不再拿来改当前显示的数字 —— 这正是"倒计时突然变大"的根因。
 */
export function makeEta(seconds,opts={}){
  const sec=Math.max(0.001,Number(seconds)||0);
  const given=(opts&&opts.ratio!=null&&isFinite(opts.ratio)&&opts.ratio>0);
  const pick=given?{ratio:clamp(Number(opts.ratio),RATIO_MIN,RATIO_MAX),from:'given'}:pickRatio(sec);
  const baseRatio=pick.ratio;
  let ratio=pick.ratio;
  let estTotal=Math.max(0.8,sec*ratio);
  const initialTotal=estTotal;
  let lastCalibMs=0;
  let shownLeft=null;          // 已显示过的最小剩余秒数（单调递减的唯一来源）
  let late=false, overdue=false;
  return {
    get total(){return estTotal},
    get initialTotal(){return initialTotal},
    get ratio(){return ratio},
    baseRatio,
    from:pick.from,
    get late(){return late},
    get overdue(){return overdue},
    step(ms){
      const m=Math.max(0,Number(ms)||0);
      const elapsed=m/1000;
      /* 每 500ms 校正一次：估小了就把倍率温和推高（封顶 = 基准 × 3），只影响进度条爬升 */
      if(m-lastCalibMs>=500){
        lastCalibMs=m;
        if(elapsed>estTotal*0.8){
          const observed=elapsed/sec;
          ratio=clamp(Math.max(ratio,observed*1.25),RATIO_MIN,baseRatio*3);
          estTotal=Math.max(estTotal,sec*ratio);
        }
      }
      const frac=clamp(elapsed/Math.max(0.001,estTotal),0,1);
      const rawLeft=Math.max(0,estTotal-elapsed);
      const left=(shownLeft==null)?rawLeft:Math.min(shownLeft,rawLeft);   // 只许变小 → 永不反弹
      shownLeft=left;
      if(!late&&(left<=5||elapsed>estTotal*0.9))late=true;                // 进入末期就锁住，不再回头报数字
      if(!overdue&&elapsed>estTotal*1.5)overdue=true;
      let text;
      if(elapsed<2)text='生成音频中… 启动中';
      else if(overdue)text='生成音频中… 仍在渲染，请稍候';
      else if(late)text='生成音频中… 即将完成';
      else text='生成音频中… 还需 '+Math.ceil(left)+' 秒';
      return {frac,left,text,total:estTotal,initialTotal,ratio,late,overdue};
    }
  };
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
