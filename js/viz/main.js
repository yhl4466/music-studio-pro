/* [viz/main.js] 可视化页入口（visualizer.html）——只做编排：
   DOM 句柄 / 画布 DPR 自适应 / 单 rAF 主循环 / 渲染器注册表 / 数据装载 / 预渲染 → 播放接线。
   现状：数据层（第 2 步）、离线预渲染（第 3 步）、播放与 transport（第 4 步）已接入；
   渲染器仍为空（第 6 步注册实时波形），主循环暂时只清屏画基线。
   层级：viz → core（+ io/share 的纯解码函数）；不 import 主应用 ui/audio 模块。 */
import { $, clamp } from '../core/util.js';
import * as dataMod from './data.js';
import { proj, loadProject, showEmpty, hideEmpty, describe, info, makeDemoProject } from './data.js';
import { renderProject, diagnoseRender, analyzeNodes, exportProjectJson, cancelRender, isRendering } from './audio.js';
import * as transport from './transport.js';
import { register, list, select, current, setSurface, setUI } from './registry.js';
import { createFeatures } from './features.js';   // FEAT-V2/T1：频域特征/节拍提取（纯计算，无 DOM）
/* 渲染器自注册：该模块顶层调用 registry.register()，不再形成循环导入 */
import './renderers/waveform.js';
import './renderers/spectrogram.js';
import './renderers/ecg.js';
import './renderers/radar.js';
import './renderers/radial.js';       // FEAT-V3/T1：径向频谱
import './renderers/particles.js';    // FEAT-V3/T2：粒子系统（自己不清屏，走半透明覆盖拖尾）
import './renderers/bounce.js';       // FEAT-V3/T3：跳动波形

/* ---------- DOM 句柄 ---------- */
const stage=$('#vzStage'), cv=$('#vzCanvas'), overlay=$('#vzOverlay'), cardBody=$('#vzCardBody');
const hint=$('#vzHint'), fpsEl=$('#vzFps'), playBtn=$('#vzPlay'), stopBtn=$('#vzStop');
const seek=$('#vzSeek'), pick=$('#vzPick'), lenSel=$('#vzLen');
const posSub=$('#vzPosSub'), posMain=$('#vzPosMain'), timeEl=$('#vzTime');
const playIco=$('#vzPlayIco'), pauseIco=$('#vzPauseIco');
const cancelBtn=$('#vzCancel'), paramsBox=$('#vzParams');
const renderFill=$('#vzRenderFill'), renderLab=$('#vzRenderLab');

/* 顶层错误上报：独立页面没有主应用的 toast 容器，落到底部提示行 */
window.addEventListener('error',e=>{if(hint)hint.textContent='运行错误：'+(e.message||'未知')});
window.addEventListener('unhandledrejection',e=>{const r=e.reason;if(hint)hint.textContent='Promise 错误：'+(r&&r.message?r.message:String(r))});

/* ---------- 渲染器注册表：见 ./registry.js（渲染器自注册，入口只做编排） ---------- */
const ctx=cv?cv.getContext('2d'):null;
const view={w:0,h:0,dpr:1}; // 逻辑像素尺寸（draw 里用逻辑坐标绘图）

/* ---------- 画布尺寸（逻辑像素 → DPR 像素），只在尺寸变化时重建变换 ---------- */
function resize(){
  if(!cv||!ctx)return;
  const rect=cv.getBoundingClientRect();
  const dpr=clamp(window.devicePixelRatio||1,1,3);
  const w=Math.max(1,Math.round(rect.width)), h=Math.max(1,Math.round(rect.height));
  const pw=Math.round(w*dpr), ph=Math.round(h*dpr);
  if(cv.width!==pw||cv.height!==ph){
    cv.width=pw; cv.height=ph;      // 赋值会重置变换与状态
  }
  ctx.setTransform(dpr,0,0,dpr,0,0);
  view.w=w; view.h=h; view.dpr=dpr;
  setSurface(ctx,view);                  // 渲染器 resize 由 registry 转达
  resizeRenderer(ctx,view);
}
function resizeRenderer(c,v){
  const r=current();
  if(r&&r.resize){ try{ r.resize(c,v) }catch(e){} }
}

/* ---------- 底部参数面板：按当前渲染器的 params 声明动态生成 ---------- */
/* 重绘调度：参数变化只置 dirty 标志（markDirty），由 rAF 主循环每帧消费该标志后重绘。
   说明：此处仍保持每帧重绘（空闲时只画一条渐隐基线，成本约 0.8ms），
   不做“仅在 dirty 时绘制”的进一步省电优化——那会让暂停时画面停止刷新，
   而波形/后续渲染器需要持续反映最新一帧数据。 */
let needRedraw=false;
function markDirty(){ needRedraw=true }
/** 渲染器的 params 是纯声明；当前值存 r.values[name]（缺省回落到声明里的 def） */
function paramValue(name,spec){
  const r=current();
  const pv=(r&&r.values)?r.values[name]:undefined;
  return (pv!=null&&isFinite(Number(pv)))?Number(pv):Number(spec.def);
}
function setParamValue(name,val){
  const r=current(); if(!r)return;
  if(!r.values)r.values={};
  r.values[name]=val;
}
function renderParams(){
  if(!paramsBox)return;
  while(paramsBox.firstChild)paramsBox.removeChild(paramsBox.firstChild);
  const r=current();
  const spec=r&&r.params?r.params:null;
  if(!spec)return;
  for(const name in spec){
    const s=spec[name]; if(!s)continue;
    const lab=document.createElement('label');
    lab.className='vz-p';
    const span=document.createElement('span');
    span.className='vz-pLabel';
    span.textContent=s.label||name;
    lab.appendChild(span);
    if(s.type==='toggle'){
      const cb=document.createElement('input');
      cb.type='checkbox'; cb.className='vz-pCheck';
      cb.checked=!!paramValue(name,s);
      cb.addEventListener('change',()=>{ setParamValue(name,cb.checked); markDirty() });
      lab.appendChild(cb);
    }else if(s.type==='select'&&Array.isArray(s.options)){
      /* 下拉参数（T2.2）：options 为二维数组 [[value,label],...]；值是字符串，
         不能走 paramValue()（那是给数值滑块用的，会把 'rainbow' 变 NaN），所以这里直接读 values 原值。
         样式复用 viz.css 的 .vz-select（顶部渲染器/渲染长度下拉同款），不新增 CSS。 */
      const sel=document.createElement('select');
      sel.className='vz-select';
      sel.title=s.label||name;
      const raw=(r&&r.values&&r.values[name]!=null)?r.values[name]:s.def;
      for(let i=0;i<s.options.length;i++){
        const op=s.options[i]; if(!op)continue;
        const o=document.createElement('option');
        o.value=String(op[0]);
        o.textContent=String(op[1]==null?op[0]:op[1]);
        sel.appendChild(o);
      }
      sel.value=String(raw);
      sel.addEventListener('change',()=>{ setParamValue(name,sel.value); markDirty() });
      lab.appendChild(sel);
    }else{
      const inp=document.createElement('input');
      inp.type='range'; inp.className='vz-pRange';
      inp.min=String(s.min); inp.max=String(s.max);
      inp.step=String(s.step==null?0.01:s.step);
      inp.value=String(paramValue(name,s));
      const val=document.createElement('span');
      val.className='vz-pVal';
      const show=()=>{ val.textContent=(+inp.value).toFixed(s.fixed==null?2:s.fixed) };
      show();
      inp.addEventListener('input',()=>{ setParamValue(name,+inp.value); show(); markDirty() });
      lab.appendChild(inp); lab.appendChild(val);
    }
    paramsBox.appendChild(lab);
  }
}
/* 渲染器下拉：用注册表填充（保留已有选中项） */
function renderPicker(){
  if(!pick)return;
  const keep=pick.value;
  while(pick.firstChild)pick.removeChild(pick.firstChild);
  for(const r of list()){
    const o=document.createElement('option');
    o.value=r.id; o.textContent=r.label||r.id;
    pick.appendChild(o);
  }
  const all=list();
  if(all.some(r=>r.id===keep))pick.value=keep;
  else if(all.length)pick.value=all[0].id;
}
/* ---------- 时间显示 / 进度条 ---------- */
export function fmtTime(sec){
  const s=Math.max(0,Math.floor(Number(sec)||0));
  return Math.floor(s/60)+':'+String(s%60).padStart(2,'0');
}
const SEEK_MAX=1000;                 // 进度条刻度（整数，避免浮点抖动）
let seeking=false;                   // 用户正在拖拽时，屏蔽播放位置的回写
function paint(t,dur){
  if(posMain)posMain.textContent=fmtTime(t);
  if(timeEl)timeEl.textContent=fmtTime(t)+' / '+fmtTime(dur||transport.getDuration());
  if(seek&&dur)seek.value=String(Math.round(clamp(t,0,dur)/dur*SEEK_MAX));
}
function seekToUserValue(commit){
  const dur=transport.getDuration();
  if(!dur)return;
  const t=clamp((Number(seek.value)||0)/SEEK_MAX,0,1)*dur;
  if(commit)transport.seek(t);
  paint(t,dur);                      // 拖拽过程中的即时反馈
}
function onTime(t,dur){
  if(seeking){ paint(t,dur); return }  // 拖拽中不回写进度条，避免和手指打架
  paint(t,dur);
}
/* ---------- 播放状态 → 按钮外观 ---------- */
const STATE_TIP={
  idle:'就绪 · 按播放开始', loading:'预渲染中…',
  playing:'播放中', paused:'已暂停', ended:'已播完 · 按播放从头开始'
};
let hintTimer=0;                       // >0 时保留“预渲染摘要”这段时间，之后交还给状态提示
function setHintInfo(text,holdMs){
  if(!hint)return;
  hint.textContent=text;
  hintTimer=holdMs?(performance.now()+holdMs):0;
}
function onState(s){
  const playing=(s==='playing');
  if(playIco)playIco.style.display=playing?'none':'';
  if(pauseIco)pauseIco.style.display=playing?'':'none';
  if(playBtn){
    playBtn.disabled=!(s==='playing'||s==='paused'||s==='ended'||s==='idle')||transport.getDuration()<=0;
    playBtn.classList.toggle('on',playing);
    playBtn.title=playing?'暂停':'播放';
  }
  const has=transport.getDuration()>0;
  if(stopBtn)stopBtn.disabled=!has||s==='loading';
  if(seek)seek.disabled=!has;
  if(hint&&STATE_TIP[s]&&!hint.dataset.busy&&hintTimer<=performance.now())
    hint.textContent=STATE_TIP[s]+(has?(' · '+transport.getDuration().toFixed(1)+' 秒'):'');
}
transport.onStateChange(onState);
transport.onTimeUpdate(onTime);

/* ---------- 预渲染 → 载入 transport（重试按钮在渲染期间充当“取消”） ---------- */
let rendering=false, renderCtl=null;
function setBusyUI(on){
  rendering=on;
  if(hint){ if(on)hint.dataset.busy='1'; else delete hint.dataset.busy }
  if(playBtn)playBtn.disabled=true;              // 渲染期间不可播放
  if(stopBtn)stopBtn.disabled=true;
  if(seek)seek.disabled=true;
  if(cancelBtn){
    cancelBtn.disabled=!on;
    cancelBtn.textContent=on?'取消渲染':'取消';
    cancelBtn.title=on?'取消正在进行的离线渲染':'没有正在进行的渲染';
  }
}
async function renderAndLoad(p,opts){
  if(rendering)return {status:'busy',message:'正在渲染中'};
  setBusyUI(true);
  setBar(0,'0%');
  console.log('[viz-main] auto-render start','steps='+(p&&p.steps),'bpm='+(p&&p.bpm),'tracks='+(p&&p.tracks&&p.tracks.length));
  try{
    const o=Object.assign({},opts||{},{onController:c=>{ renderCtl=c }});
    /* onProgress 签名仍是 (pct,text)：进度条按 pct 推进，提示行与进度条标签同步显示文字 */
    const r=await renderProject(p,(pct,text)=>{
      const p=clamp(Number(pct)||0,0,100);
      if(renderFill)renderFill.style.width=p.toFixed(1)+'%';
      if(renderLab)renderLab.textContent=p.toFixed(0)+'%';
      if(hint)hint.textContent=text||'';
    },o);
    console.log('[viz-main] auto-render done',r&&r.status,r&&r.notes,r&&r.seconds,r&&r.message);
    if(r&&r.status==='ok'){
      setBarDone();
      transport.dispose();              // 丢弃旧图与旧 buffer，保证计时从新 AudioContext 起算
      transport.load(r.buffer);
      onState('idle');
      setHintInfo('预渲染完成 · notes='+r.notes+' · 音频 '+r.seconds.toFixed(1)+' 秒'+
                  (r.partial?('（仅前 '+Math.round(r.seconds)+' 秒，可在顶部「渲染长度」切换）'):'')+
                  ' · 渲染 '+Math.round(r.renderMs||r.elapsed)+' ms（排期 '+r.scheduledSteps+' 步）· 按播放开始',3000);
    }else if(r&&r.status==='cancelled'){
      setBarCancelled();
      setHintInfo('已取消渲染（工程仍可用）',2500);
    }else if(r&&r.status==='tooLong'){
      if(hint)hint.textContent='工程过长（'+Math.round(r.seconds)+' 秒 / '+Math.round(r.bytes/1048576)+'MB），超过 7 分钟上限';
      setBar(0,'超限');
    }else if(r&&r.status!=='busy'){
      if(hint)hint.textContent='预渲染失败：'+((r&&r.message)||'未知原因');
      setBar(0,'失败');
    }
    return r;
  }finally{
    renderCtl=null;
    setBusyUI(false);
    if(hint&&!hint.dataset.busy)onState(transport.state());
  }
}

/* ---------- UI 接线 ---------- */
function bindTransportUI(){
  if(playBtn)playBtn.addEventListener('click',()=>{ transport.toggle(); if(posMain)posMain.textContent=fmtTime(transport.getCurrentTime()) });
  if(stopBtn)stopBtn.addEventListener('click',()=>transport.stop());
  if(cancelBtn)cancelBtn.addEventListener('click',()=>{ cancelRender() });
  if(seek){
    seek.min='0'; seek.max=String(SEEK_MAX); seek.step='1';
    seek.addEventListener('pointerdown',()=>{ seeking=true });
    seek.addEventListener('input',()=>{ seeking=true; seekToUserValue(false) });
    const commit=()=>{ if(!seeking)return; seekToUserValue(true); seeking=false };
    seek.addEventListener('change',commit);
    seek.addEventListener('pointerup',commit);
    seek.addEventListener('pointercancel',commit);
    seek.addEventListener('keyup',()=>{ if(seeking){ seekToUserValue(true); seeking=false } });
  }
  window.addEventListener('keydown',e=>{
    const tag=(e.target&&e.target.tagName)||'';
    if(tag==='INPUT'||tag==='SELECT'||tag==='TEXTAREA')return;
    if(e.code==='Space'){ e.preventDefault(); transport.toggle() }
    else if(e.code==='Home'){ e.preventDefault(); transport.seek(0) }
    else if(e.code==='Escape'){ e.preventDefault(); transport.stop() }
  });
  window.addEventListener('pagehide',()=>transport.dispose());
}

/* ---------- 启动 ---------- */
function boot(){
  if(!cv||!ctx||!stage){ if(hint)hint.textContent='页面结构缺失：canvas 未找到'; return; }
  const ro=(typeof ResizeObserver!=='undefined')?new ResizeObserver(()=>resize()):null;
  if(ro)ro.observe(stage);
  window.addEventListener('resize',resize);
  resize();
  if(pauseIco)pauseIco.style.display='none';
  if(playBtn)playBtn.disabled=true;
  if(stopBtn)stopBtn.disabled=true;
  if(cancelBtn)cancelBtn.disabled=true;
  if(seek)seek.disabled=true;
  bindTransportUI();
  bindLengthUI();
  setUI({renderParams});                   // 注入参数面板钩子（registry 不依赖 DOM）
  renderPicker();                          // 用注册表填充渲染器下拉
  /* 渲染器切换：V1 只有一项下拉时漏了这条监听，导致选中项改了却不换渲染器。
     select() 内部完成 dispose → init → 参数面板重建，主循环每帧重读 current()，下一帧即生效。 */
  if(pick)pick.addEventListener('change',()=>select(pick.value));
  {
    const all=list();
    if(all.length&&!current())select(all[0].id);
  }
  renderParams();
  if(!list().length){
    if(cardBody)cardBody.textContent='正在读取工程数据…';
    if(hint)hint.textContent='V1 步骤 4/7 · 正在初始化…';
  }
  if(fpsT===0)fpsT=performance.now();
  raf=requestAnimationFrame(frame);
  void initData();
}

/* ---------- 预渲染进度条 / 状态灯（底部 #vzRenderBar） ---------- */
function setBar(pct,label){
  const p=clamp(Number(pct)||0,0,100);
  if(renderFill){ renderFill.style.width=p.toFixed(1)+'%'; renderFill.style.background='' }
  if(renderLab)renderLab.textContent=label||(Math.round(p)+'%');
  if(hint)hint.textContent='';
}
function setBarCancelled(){
  if(renderFill){ renderFill.style.width='100%'; renderFill.style.background='var(--dim)' }
  if(renderLab)renderLab.textContent='已取消';
}
function setBarDone(){
  if(renderFill){ renderFill.style.width='100%'; renderFill.style.background='' }
  if(renderLab)renderLab.textContent='100%';
}

/* ---------- 预渲染长度下拉（默认 30 秒：秒见效果；切换即用新长度重渲染） ---------- */
const DEFAULT_MAX_SECONDS=30;
const MAX_SECONDS_UI=600;
let maxSeconds=DEFAULT_MAX_SECONDS;
function lenOpts(){ return maxSeconds==null?{}:{maxSeconds} }
function bindLengthUI(){
  if(!lenSel)return;
  lenSel.value=maxSeconds==null?'full':String(maxSeconds);
  lenSel.addEventListener('change',()=>{
    const v=lenSel.value;
    maxSeconds=(v==='full')?null:clamp(Number(v)||DEFAULT_MAX_SECONDS,5,MAX_SECONDS_UI);
    if(!dataOk){ if(hint)hint.textContent='渲染长度已设为 '+(maxSeconds==null?'全曲':maxSeconds+' 秒')+'（载入工程后生效）'; return }
    if(rendering){ if(hint)hint.textContent='渲染进行中，取消后再切换长度'; return }
    void renderAndLoad(proj,lenOpts());
  });
}

/* ---------- 第 2 步：数据装载（hash 优先 → localStorage.vizProject）→ 第 3/4 步：预渲染并载入 ---------- */
let dataOk=false;
async function initData(){
  let p=null;
  try{ p=await loadProject() }catch(e){ p=null }
  if(!p){
    dataOk=false;
    showEmpty();
    if(hint)hint.textContent='V1 步骤 4/7 · 无可用数据（'+(info.reason||'未知原因')+'）';
    return;
  }
  dataOk=true;
  hideEmpty();
  if(posSub)posSub.textContent=describe();
  if(cardBody)cardBody.textContent='';
  await renderAndLoad(p,lenOpts());
}

/* ---------- rAF 主循环：全屏重绘，保证切换渲染器无残影 ---------- */
function drawEmpty(){
  const w=view.w,h=view.h;
  ctx.clearRect(0,0,w,h);
  ctx.save();
  ctx.strokeStyle='rgba(255,255,255,.07)';
  ctx.lineWidth=1;
  ctx.beginPath();ctx.moveTo(0,Math.round(h/2)+.5);ctx.lineTo(w,Math.round(h/2)+.5);ctx.stroke();
  ctx.restore();
}
let frames=0,fpsT=0,raf=0,lastTs=0;      // lastTs：上一帧时间戳，用于算 dt（特征节流/EMA）
/* 子任务 5：共享 analyser 数据管线——每帧只取一次时域数据，复用同一个 Uint8Array，绝不在帧内分配对象 */
/* FEAT-V2/T1：同一管线再扩一路频域 + 特征（缓冲与 tdBuf 同生命周期，帧内仍零分配）
   第三参数契约：{timeDomain, freqData, features, beat, dt, frameNo}；V1 波形只读 timeDomain，不受影响 */
const feats=createFeatures();             // 常驻实例：snapshot/beat 的对象引用自创建起不变
const audioData={timeDomain:null,freqData:null,features:feats.snapshot,beat:feats.beat,dt:0,frameNo:0,projectBpm:0};
let tdBuf=null, fdBuf=null, tdSize=0, tdAnalyser=null;
function frame(ts){
  raf=requestAnimationFrame(frame);
  if(!ctx)return;
  if(transport.isPlaying()){
    transport.notifyTime();          // 播放时每帧按 actx.currentTime 刷新位置/进度条/时间显示
    if(hintTimer>0&&ts>=hintTimer){ hintTimer=0; if(hint&&!hint.dataset.busy)onState(transport.state()) }
  }
  const an=transport.getAnalyser();
  const dt=clamp((ts-lastTs)/1000,0,.25); lastTs=ts;   // 帧间隔（秒），封顶 0.25s
  if(an){
    if(an!==tdAnalyser||tdSize!==an.fftSize){   // 仅当 analyser 或 fftSize 变化时重建缓冲
      tdAnalyser=an; tdSize=an.fftSize;
      tdBuf=new Uint8Array(tdSize);
      fdBuf=new Uint8Array(an.frequencyBinCount);            // 1024 频点，与 tdBuf 同生命周期
      audioData.timeDomain=tdBuf; audioData.freqData=fdBuf;
    }
    an.getByteTimeDomainData(tdBuf);           // 复用同一实例，无每帧分配
    an.getByteFrequencyData(fdBuf);
    audioData.projectBpm=(proj&&proj.bpm>=40&&proj.bpm<=220)?proj.bpm:0;   // 工程 BPM：心率读数优先用它
    feats.update(fdBuf,dt,audioData.projectBpm);   // 频域 → 包络/起音/特征快照（内部零分配）
    audioData.dt=dt; audioData.frameNo++;
  }else if(audioData.timeDomain){
    audioData.timeDomain=null; audioData.freqData=null; audioData.dt=0; audioData.frameNo=0;
    tdBuf=null; fdBuf=null; tdAnalyser=null; tdSize=0;
    feats.reset();                             // 保持 snapshot/beat 对象引用不变，只清零字段
  }
  if(current()&&current().draw)current().draw(ctx,view,an?audioData:null);
  else drawEmpty();
  needRedraw=false;                        // 消费本帧的参数变更标志（markDirty 置位）
  frames++;
  if(fpsEl&&ts-fpsT>=500){ fpsEl.textContent=Math.round(frames*1000/(ts-fpsT))+' FPS'; frames=0; fpsT=ts; }
}

if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot,{once:true});
else boot();

/* 自检句柄：Console 里确认循环 / 尺寸 / 数据层 / 播放状态（第 4 步起含 transport） */
window.__vz={view,list,current,select,register,data:dataMod,transport,registry:{register,list,select,current},
  dom:{stage,cv,overlay,hint,playBtn,stopBtn,cancelBtn,seek,pick,lenSel,posSub,posMain,timeEl,paramsBox},
  get renderParams(){return current()?current().params:null},
  get dataOk(){return dataOk},
  get rendering(){return rendering},
  get audioBusy(){return isRendering()},
  get audio(){return audioData},              // 自检：freqData 长度 / features / beat / dt / frameNo
  cancelRender,
  fmtTime,
  /* 播放链路的可验证证据：AudioContext 状态、输出节点、缓冲峰值/RMS、Analyser 参数 */
  audioReport(){
    const b=transport.getBuffer();
    let peak=0,rms=0;
    if(b){
      const d=b.getChannelData(0);
      const step=Math.max(1,Math.floor(d.length/200000));
      let sum=0,n=0;
      for(let i=0;i<d.length;i+=step){ const v=d[i]; if(Math.abs(v)>peak)peak=Math.abs(v); sum+=v*v; n++ }
      rms=Math.sqrt(sum/Math.max(1,n));
    }
    const an=transport.getAnalyser();
    return {
      ctxState:transport.getAudioContextState(),
      needsGesture:transport.needsGesture(),
      duration:transport.getDuration(),
      channels:b?b.numberOfChannels:0,
      sampleRate:b?b.sampleRate:0,
      peak:+peak.toFixed(4), rms:+rms.toFixed(4),
      analyser:transport.getAnalyserParams()
    };
  },
  /* 内存内演示工程 → 预渲染 → 直接载入播放器（不写 localStorage） */
  async loadDemo(){
    const p=makeDemoProject();
    if(!p){ if(hint)hint.textContent='演示工程构造失败'; return {status:'error',message:'演示工程构造失败'} }
    dataOk=true;
    hideEmpty();
    if(posSub)posSub.textContent=describe();
    const r=await renderAndLoad(p);
    console.log('[viz] loadDemo →',r&&r.status,'notes=',r&&r.notes);
    return r;
  },
  /* 诊断（临时）：导出当前工程 JSON（供在 Node 桩里完整复现） */
  exportJson(){
    if(!dataOk||!proj||!proj.tracks){ console.log('[viz-diag] 未载入工程'); return null }
    const s=exportProjectJson(proj);
    try{
      const a=document.createElement('a');
      a.href=URL.createObjectURL(new Blob([s],{type:'application/json'}));
      a.download=(proj.name||'viz-project')+'.json';
      document.body.appendChild(a); a.click();
      setTimeout(()=>{ try{ a.remove() }catch(e){} },0);
      console.log('[viz-diag] 已触发下载，字节数='+s.length);
    }catch(e){ console.log('[viz-diag] 下载失败，改从返回值复制：',e&&e.message) }
    return s;
  },
  /* 诊断（临时）：跑 A 超时复现 + D 阶梯二分，定位卡死起点；不改变正常渲染流程 */
  async diagnose(){
    if(!dataOk){ console.log('[viz-diag] 未载入工程'); return null }
    return await diagnoseRender(proj,x=>console.log('[viz-diag] 结果',x));
  },
  /* 诊断（临时）：不渲染即预测节点规模（需先 rebuildEvents，此处用当前已建事件） */
  nodeReport(){
    if(!proj||!proj.tracks)return null;
    return analyzeNodes(proj);
  },
  /* 实测预渲染耗时（并把结果载入播放器） */
  async measure(maxSeconds){
    if(!dataOk)return '未载入工程';
    const t0=performance.now();
    const r=await renderAndLoad(proj,(maxSeconds!=null)?{maxSeconds}:{});
    const ms=Math.round(performance.now()-t0);
    return {status:r&&r.status,ms,seconds:r&&r.seconds,samples:r&&r.samples,notes:r&&r.notes,partial:r&&r.partial};
  }};
