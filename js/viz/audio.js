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
  console.log('[viz-render] cancel 请求已发出（后台渲染可能仍在进行，结果将被丢弃）');
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
  console.log('[viz-diag] 节点预测：音符总数='+notesTotal+' 预计节点总数≈'+(sum+fixed),byTrack);
  return out;
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

  if(_busy){ console.log('[viz-render] 已有渲染在进行，拒绝并发请求'); return {status:'busy',message:'已有渲染在进行'} }
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
    console.log('[viz-render] start','steps='+proj.steps,'bpm='+proj.bpm,'tracks='+proj.tracks.length,'maxSeconds='+(cap==null?'全曲':cap));

    if(isTooLong(proj,opts)){
      const e=estFor(proj,null);
      console.log('[viz-render] tooLong',Math.round(e.full)+'s /',Math.round(e.bytes/1048576)+'MB');
      return {status:'tooLong',estimate:e,seconds:e.full,bytes:Math.ceil(e.full*BYTES_PER_SEC)};
    }

    prog(2,PRE_MSGS[1]);
    rebuildEvents();
    prog(4,PRE_MSGS[2]);
    const est=estFor(proj,cap);                      // 事件建好后尾音估算更准
    if(_cancelFlag)return {status:'cancelled'};

    const frames=Math.max(1,Math.ceil(est.seconds*SAMPLE_RATE));
    if(frames*CHANNELS*4>MAX_BYTES){
      console.log('[viz-render] error','缓冲超过上限');
      return {status:'tooLong',estimate:est,seconds:est.seconds,bytes:frames*CHANNELS*4};
    }

    const OAC=(typeof OfflineAudioContext!=='undefined')?OfflineAudioContext
             :(typeof webkitOfflineAudioContext!=='undefined'?webkitOfflineAudioContext:null);
    if(!OAC){ console.log('[viz-render] error','当前浏览器不支持 OfflineAudioContext'); return {status:'error',message:'当前浏览器不支持 OfflineAudioContext'} };

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
      if(_cancelFlag){ console.log('[viz-render] cancelled during scheduling at step',s); discard(); return {status:'cancelled'} }
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
    console.log('[viz-render] scheduled',Sched,'/',S,'步 ·',notes,'音符 ·',schedMs+'ms');

    /* 渲染阶段：OfflineAudioContext 无法回报真实进度，改用时间估算驱动（每帧约两次 2D 空调用，开销可忽略）。
       estDuration = 音频时长 × 1.5（实测约 1.4× 实时，1.5 保守），封顶 95%，渲染真正结束才跳 100%。 */
    const estDuration=Math.max(0.8,est.seconds*1.5);
    const progRender=(ms)=>{
      const frac=clamp(ms/1000/Math.max(0.001,estDuration),0,1);
      const eta=Math.max(0,Math.ceil(estDuration-ms/1000));
      prog(rendPct(frac),'生成音频中... 预计还需 '+eta+' 秒');
      return frac;
    };
    prog(rendPct(0),'生成音频中... 预计还需 '+Math.ceil(estDuration)+' 秒');
    console.log('[viz-render] rendering...',frames,'帧',SAMPLE_RATE,'Hz（无卷积混响）',
                '预计渲染时长≈'+estDuration.toFixed(1)+'s（按 1.5× 实时估算）');
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
      console.log('[viz-render] 已取消：放弃该上下文的结果（渲染可能仍在后台进行）','renderMs='+renderMs);
      discard();
      return {status:'cancelled'};
    }
    if(res.err)throw res.err;
    const buf=res.val;
    console.log('[viz-render] done',buf?buf.length:'null','startRendering 实测耗时='+renderMs+'ms',
                '（音频 '+est.seconds.toFixed(1)+'s，'+(renderMs/1000/Math.max(.001,est.seconds)).toFixed(2)+'× 实时；估算 '+estDuration.toFixed(1)+'s）');
    if(!buf||!buf.length){ console.log('[viz-render] error','离线渲染结果为空'); return {status:'error',message:'离线渲染结果为空'} };
    prog(100,est.partial?('预渲染完成（仅前 '+Math.round(est.seconds)+' 秒）'):'预渲染完成');
    return {status:'ok',buffer:buf,seconds:est.seconds,samples:buf.length,notes,
            partial:!!est.partial,cappedTo:est.cappedTo,elapsed:now()-t0,renderMs,estRenderMs:Math.round(estDuration*1000),
            scheduledSteps:Sched,schedMs};
  }catch(e){
    console.log('[viz-render] error',e);
    return {status:'error',message:(e&&e.message)?e.message:String(e)};
  }finally{
    try{ if(proj)proj._ev=null }catch(e){}
    _busy=false; _activeCtl=null; _cancelFlag=false;
    console.log('[viz-render] cleanup');
  }
}

/* 秒数 → m:ss（界面显示用） */
export function fmtSec(sec){
  const s=Math.max(0,Math.round(Number(sec)||0));
  return Math.floor(s/60)+':'+String(s%60).padStart(2,'0');
}

/* =========================================================================
   诊断：__vz.diagnose() 的阶梯——严格串行，每档确认上一档真正结束
   ========================================================================= */
export async function diagnoseRender(proj,onStep){
  const out={ladder:[],est:null};
  console.log('===== [viz-diag] 诊断开始（串行阶梯） =====');
  const est=estimate(proj,{});
  out.est={seconds:est.seconds,bytes:est.bytes,bars:est.bars,steps:est.steps};
  console.log('[viz-diag] 工程:',proj.name,'steps='+proj.steps,'bpm='+proj.bpm,'tracks='+proj.tracks.length,
              '预计音频='+est.seconds.toFixed(1)+'s');
  for(const sec of [1,5,10,30,60]){
    if(sec>est.seconds+1)break;
    const t0=Date.now();
    const r=await renderProject(proj,()=>{}, {maxSeconds:sec});
    const ms=Date.now()-t0;
    out.ladder.push({sec,status:r.status,ms,renderMs:r.renderMs||0,scheduledSteps:r.scheduledSteps||0});
    console.log('[viz-diag] 阶梯 seconds='+sec+' → status='+r.status+' 墙钟='+ms+'ms'+
                ' 渲染='+(r.renderMs||0)+'ms 排期步数='+(r.scheduledSteps||0));
    if(onStep)try{ onStep(out.ladder[out.ladder.length-1]) }catch(e){}
    if(r.status!=='ok'){ console.log('[viz-diag] 阶梯在 '+sec+' 秒档中断：'+(r.message||r.status)); break }
    await new Promise(res=>setTimeout(res,120));     // 串行间隔，确保上一档彻底收尾
  }
  console.log('===== [viz-diag] 诊断结束 =====',out);
  return out;
}
