/* [viz/main.js] 可视化页入口（visualizer.html）——只做编排：
   DOM 句柄 / 画布 DPR 自适应 / 单 rAF 主循环 / 渲染器注册表 / 数据装载 / 预渲染 → 播放接线。
   现状：数据层（第 2 步）、离线预渲染（第 3 步）、播放与 transport（第 4 步）已接入；
   渲染器仍为空（第 6 步注册实时波形），主循环暂时只清屏画基线。
   层级：viz → core（+ io/share 的纯解码函数）；不 import 主应用 ui/audio 模块。 */
import { $, clamp } from '../core/util.js';
import * as dataMod from './data.js';
import { proj, loadProject, showEmpty, hideEmpty, describe, info, makeDemoProject } from './data.js';
import { renderProject, diagnoseRender, analyzeNodes, exportProjectJson, cancelRender, isRendering, estimate } from './audio.js';
import * as transport from './transport.js';
import { register, list, select, current, setSurface, setUI } from './registry.js';
import { createFeatures } from './features.js';   // FEAT-V2/T1：频域特征/节拍提取（纯计算，无 DOM）
import { analyze } from './analyzer.js';          // FEAT-V4/T2：整曲离线分析（V4 封面/指纹的数据源，纯计算）
import { bindCoverUI, invalidateCoverFeatures } from './coverUI.js';  // FEAT-V4/T3.5：封面预览弹窗（只画图与下载，无业务逻辑）
/* 渲染器自注册：该模块顶层调用 registry.register()，不再形成循环导入 */
import './renderers/waveform.js';
import './renderers/spectrogram.js';
import './renderers/ecg.js';
import './renderers/radar.js';
import './renderers/radial.js';       // FEAT-V3/T1：径向频谱
import './renderers/particles.js';    // FEAT-V3/T2：粒子系统（自己不清屏，走半透明覆盖拖尾）
import './renderers/bounce.js';       // FEAT-V3/T3：跳动波形
import './renderers/forest.js';       // FEAT-V5：3D 频谱森林（伪 3D 透视投影，无 3D 库）

/* ---------- DOM 句柄 ---------- */
const stage=$('#vzStage'), cv=$('#vzCanvas'), overlay=$('#vzOverlay'), cardBody=$('#vzCardBody');
const hint=$('#vzHint'), fpsEl=$('#vzFps'), playBtn=$('#vzPlay'), stopBtn=$('#vzStop');
const seek=$('#vzSeek'), pick=$('#vzPick'), lenSel=$('#vzLen');
const posSub=$('#vzPosSub'), posMain=$('#vzPosMain'), timeEl=$('#vzTime');
const playIco=$('#vzPlayIco'), pauseIco=$('#vzPauseIco');
const cancelBtn=$('#vzCancel'), paramsBox=$('#vzParams');
const renderFill=$('#vzRenderFill'), renderLab=$('#vzRenderLab');

/* ============================================================================
   批 A 动效基础设施（可视化页）
   · 画布交叉淡入淡出：.fadeOut 120ms --ease-in → 中间点做事 → .fadeIn 280ms --ease-out
     （keyframes 在 theme.css，两页共用）；唯一允许的 setTimeout 就是那个 120ms 中间点。
   · 提示行：把 #vzHint 的内容换成"状态 + 详情"两个 span（HTML 不动，只新增 class）；
     状态变了才播 200ms 淡入，详情随时更新但不播动画（否则进度每 24 步闪一次）。
   · 数字 tick：交替两个同名动画的 class 来重播，避免 remove→强制回流→add。
   ============================================================================ */
let _fadeTimer=0;
function revealCanvas(){
  if(!cv)return;
  cv.classList.remove('fadeIn');
  cv.classList.add('fadeIn');                 // animation-name 变化即重播
}
/** 交叉淡入淡出：120ms 处执行 mid（换渲染器/重绘），随后淡入 */
function crossFadeCanvas(mid){
  if(!cv){ mid(); return }
  if(_fadeTimer){ clearTimeout(_fadeTimer); _fadeTimer=0 }   // 连点：旧定时器作废，避免 mid 跑两次
  cv.classList.remove('fadeIn');
  cv.classList.add('fadeOut');
  _fadeTimer=setTimeout(()=>{
    _fadeTimer=0;
    try{ mid() }finally{
      cv.classList.remove('fadeOut');
      revealCanvas();
    }
  },120);
}

let hintS=null, hintK=null, _hintFlip=0;
function ensureHintSpans(){
  if(!hint||hintS)return;
  hint.textContent='';
  hintS=document.createElement('span'); hintS.className='vz-hintS';
  hintK=document.createElement('span'); hintK.className='vz-hintK';
  hint.appendChild(hintS); hint.appendChild(hintK);
  hint.setAttribute('aria-live','polite');           // 状态变化会被读屏播报（可见文本即播报文本）
}
/** 提示行（批 B 任务 6）：status 变了才淡入一次；key 是"关键量"（可见）；detail 进 title + aria-label。
    这样首屏只有「状态 + 关键量」，长详情（notes/渲染 ms/排期步数）悬停或读屏时仍完整可查。 */
function setHint(status,key,detail){
  if(!hint)return;
  ensureHintSpans();
  const s=(status==null)?'':String(status);
  let k=(key==null)?'':String(key);
  const d=(detail==null)?'':String(detail);
  if(!k&&d)k=(d.length>24)?(d.slice(0,24)+'…'):d;     // 出错时没有关键量：把详情截断显示，错误必须看得见
  const full=[s,k,d].filter(Boolean).join(' · ');
  if(hint.title!==full)hint.title=full;
  if(hint.getAttribute('aria-label')!==full)hint.setAttribute('aria-label',full);
  if(hintS.textContent!==s){
    hintS.textContent=s;
    _hintFlip^=1;
    hintS.classList.toggle('hf',_hintFlip===1);      // hf / hf2 交替 → 动画重播，不需要回流
    hintS.classList.toggle('hf2',_hintFlip===0);
  }
  if(hintK.textContent!==k)hintK.textContent=k;
}
/** 数字/数值上滑淡入（拖动参数、进度百分比等） */
function tickText(el){
  if(!el)return;
  const on=el.classList.contains('numTick');
  el.classList.remove('numTick','numTickAlt');
  el.classList.add(on?'numTickAlt':'numTick');
}
/* ---------- 原生 <select> 的点击微反馈（批 C 补丁 2，方案 A + C） ----------
   原生下拉的展开动画由浏览器/OS 绘制，CSS 覆盖不到（专业工具里这也是常态，所以不改成自绘下拉）。
   这里做一件能做的事：按下时给外层容器一次 scale(.98→1)+淡入的 200ms 微反馈，让"我点到了"可感知。
   用交替类名重播（不强制回流、也不需要定时器摘类：动画播完即回常态）。 */
function bindSelectPulse(sel){
  if(!sel||sel.__pulseBound)return;
  sel.__pulseBound=true;
  const host=sel.parentElement||sel;
  const pulse=()=>{
    const on=host.classList.contains('selPulse');
    host.classList.remove('selPulse','selPulseAlt');
    host.classList.add(on?'selPulseAlt':'selPulse');
  };
  sel.addEventListener('pointerdown',pulse);
  sel.addEventListener('keydown',e=>{ if(e.key==='Enter'||e.key===' '||e.key==='ArrowDown'||e.key==='ArrowUp')pulse() });
}
/* 提示行的"关键量"文本变化时播一次上滑淡入（批 C 补丁：渲染 ETA 每秒变一次，看得到在动）。
   只在文本真的变化时播 —— 进度回调每 250ms 来一次，但 ETA 文案是秒级的，所以实际约 1 次/秒。 */
let _hintKeyText='';
function tickHintKey(text){
  const t=text||'';
  if(t===_hintKeyText)return;
  _hintKeyText=t;
  if(hintK)tickText(hintK);
}

/* ---------- FPS（批 B 任务 7）：默认隐藏，F 键切换；连续偏低时自动浮现 ---------- */
let fpsOn=false, fpsLow=0;
function toggleFps(){
  fpsOn=!fpsOn;
  if(!fpsEl)return;
  fpsEl.classList.toggle('on',fpsOn||fpsLow>=3);
  setHint('帧率显示',fpsOn?'已打开':'已关闭',fpsOn?'帧率数字显示在画布右下角（F 键再按一次关闭）':'连续低于 45 帧时仍会自动出现');
}

/* 顶层错误上报：独立页面没有主应用的 toast 容器，落到底部提示行 */
window.addEventListener('error',e=>setHint('运行错误','',(e&&e.message)||'未知错误'));
window.addEventListener('unhandledrejection',e=>{const r=e.reason;setHint('Promise 错误','',(r&&r.message)?r.message:String(r))});

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
/* 单个参数 → 一行控件（.vz-p）。idx 用于交错入场的 --i。 */
function buildParam(r,name,s,idx){
  const lab=document.createElement('label');
  lab.className='vz-p';
  lab.style.setProperty('--i',String(Math.min(idx,8)));
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
    bindSelectPulse(sel);                      // 批 C 补丁 2：原生下拉的点击微反馈
    lab.appendChild(sel);
  }else{
    const inp=document.createElement('input');
    inp.type='range'; inp.className='vz-pRange';
    inp.min=String(s.min); inp.max=String(s.max);
    inp.step=String(s.step==null?0.01:s.step);
    inp.value=String(paramValue(name,s));
    const val=document.createElement('span');
    val.className='vz-pVal';
    let shown='';
    const show=()=>{
      const t=(+inp.value).toFixed(s.fixed==null?2:s.fixed);
      if(t===shown)return;                    // 值真的变了才播动画（拖动时按帧回调很密）
      shown=t; val.textContent=t; tickText(val);
    };
    show();
    inp.addEventListener('input',()=>{ setParamValue(name,+inp.value); show(); markDirty() });
    lab.appendChild(inp); lab.appendChild(val);
  }
  return lab;
}
function renderParams(){
  if(!paramsBox)return;
  while(paramsBox.firstChild)paramsBox.removeChild(paramsBox.firstChild);
  const r=current();
  const spec=r&&r.params?r.params:null;
  if(!spec)return;
  /* 批 B 任务 5：常用参数（声明里 isPrimary:true）常驻；其余收进「更多参数 (N)」折叠区。
     一个参数都不删；若某渲染器没标 isPrimary，就全部当常用（向后兼容，面板不会变空）。 */
  const prim=[],more=[];
  for(const name in spec){ const s=spec[name]; if(!s)continue; (s.isPrimary?prim:more).push([name,s]) }
  const list=prim.length?prim:more.slice();
  const rest=prim.length?more:[];
  list.forEach(([n,s],i)=>paramsBox.appendChild(buildParam(r,n,s,i)));
  if(rest.length){
    const btn=document.createElement('button');
    btn.type='button'; btn.className='vz-moreBtn';
    btn.setAttribute('aria-expanded',moreOpen?'true':'false');
    btn.title='展开/收起其余参数（全部参数都保留，只是默认收起）';
    const txt=document.createElement('span');
    txt.className='vz-moreTxt';
    txt.textContent='更多参数 ('+rest.length+')';
    const car=document.createElement('span');
    car.className='vz-caret'; car.setAttribute('aria-hidden','true');
    btn.appendChild(txt); btn.appendChild(car);
    const wrap=document.createElement('div');
    wrap.className='vz-more'+(moreOpen?' open':'');
    const inner=document.createElement('div');
    rest.forEach(([n,s],i)=>inner.appendChild(buildParam(r,n,s,i)));
    wrap.appendChild(inner);
    btn.addEventListener('click',()=>{
      moreOpen=!moreOpen;
      wrap.classList.toggle('open',moreOpen);
      btn.setAttribute('aria-expanded',moreOpen?'true':'false');
    });
    paramsBox.appendChild(btn);
    paramsBox.appendChild(wrap);
  }
}
let moreOpen=false;                    // 「更多参数」的展开状态：跨渲染器切换保留（用户的偏好）
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
/** 时间（批 B 任务 1）：只在大时钟一处显示"当前 / 总长"—— 大写当前、小写总长，层级不变但只占一半宽。
    #vzTime 仍同步写入（id 与逻辑保留，视觉上是隐藏的），兼容任何外部读取。 */
function paintTime(t,dur){
  const d=(dur!=null&&isFinite(dur))?dur:transport.getDuration();
  const cur=fmtTime(t),tot=fmtTime(d);
  if(posMain)posMain.innerHTML=cur+'<span class="vz-of"> / '+tot+'</span>';
  if(timeEl)timeEl.textContent=cur+' / '+tot;
}
function paint(t,dur){
  paintTime(t,dur);
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
/* 提示行的两个可见 span（hintS 状态 / hintK 关键量）在文件上方创建；这里只放状态表与忙碌标记。
   首屏字符 = 状态 + 关键量，控制在 30 字以内；长详情进 title / aria-label。 */
/* 位置区副行（批 B 任务 1）：改作状态提示；工程摘要（describe()）移进它的 title，
   这样"同一屏报三次时间/一次摘要"变成"一次时间 + 一条状态"，摘要仍随手可查。 */
const STATE_WORD={idle:'就绪',loading:'预渲染中',playing:'播放中',paused:'已暂停',ended:'已播完'};
let busyNow=false;
const STATE_TIP={
  idle:['就绪','按播放开始',''], loading:['预渲染中','',''],
  playing:['播放中','',''], paused:['已暂停','',''], ended:['已播完','按播放从头开始','']
};
let hintTimer=0;                       // >0 时保留“预渲染摘要”这段时间，之后交还给状态提示
/** 显示一条有保留时间的提示（holdMs 后交还给播放状态提示） */
function setHintInfo(status,key,detail,holdMs){
  if(!hint)return;
  setHint(status,key,detail);
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
  if(hint&&STATE_TIP[s]&&!hint.dataset.busy&&hintTimer<=performance.now()){
    const t=STATE_TIP[s];
    setHint(t[0],(t[1]?t[1]+(has?' · ':''):'')+(has?transport.getDuration().toFixed(1)+' 秒':''),t[2]);
  }
  /* 位置区副行（批 B）：改作状态提示 —— 状态词（+ 工程摘要进 title） */
  if(posSub&&!busyNow)posSub.textContent=STATE_WORD[s]||posSub.textContent;
}
transport.onStateChange(onState);
transport.onTimeUpdate(onTime);

/* ---------- 预渲染 → 载入 transport（重试按钮在渲染期间充当“取消”） ---------- */
let rendering=false, renderCtl=null;
/** 渲染/分析期间锁定播放控件。
    label 可选：分析阶段把同一个取消按钮改叫“取消分析”（T5 之前不新增任何控件）。 */
function setBusyUI(on,label){
  rendering=on;
  busyNow=!!on;
  if(hint){ if(on)hint.dataset.busy='1'; else delete hint.dataset.busy }
  if(stage)stage.classList.toggle('busy',!!on);      // 舞台顶部的 2px 不确定进度线（批 A 任务 2）
  if(cancelBtn){
    /* 批 B 任务 2：非忙碌时 display:none（不占顶栏），忙碌时才出现并淡入；元素/禁用逻辑/键盘焦点都保留 */
    if(on)cancelBtn.dataset.busy='1'; else delete cancelBtn.dataset.busy;
  }
  if(on&&posSub)posSub.textContent=(label&&label.indexOf('分析')>=0)?'分析中':'渲染中';
  if(playBtn)playBtn.disabled=true;              // 渲染期间不可播放
  if(stopBtn)stopBtn.disabled=true;
  if(seek)seek.disabled=true;
  if(cancelBtn){
    cancelBtn.disabled=!on;
    cancelBtn.textContent=on?(label||'取消渲染'):'取消';
    cancelBtn.title=on?'取消正在进行的离线渲染或分析':'没有正在进行的渲染或分析';
  }
}
async function renderAndLoad(p,opts){
  if(rendering)return {status:'busy',message:'正在渲染中'};
  setBusyUI(true);
  setBar(0,'0%');
  setHint('渲染中','准备离线渲染…');            // 徽标立刻到位，之后进度只改详情（不闪）
  try{
    const o=Object.assign({},opts||{},{onController:c=>{ renderCtl=c }});
    /* onProgress 签名仍是 (pct,text)：进度条按 pct 推进，提示行与进度条标签同步显示文字 */
    const r=await renderProject(p,(pct,text)=>{
      const p=clamp(Number(pct)||0,0,100);
      if(renderFill)renderFill.style.width=p.toFixed(1)+'%';
      if(renderLab)renderLab.textContent=p.toFixed(0)+'%';
      /* 徽标保持"渲染中"（只在开始淡入一次），变化的是详情 —— 否则进度每 24 步就闪一次。
         百分比不重复写：进度条右侧的标签已经在报数了；ETA 文字变化时给一次上滑淡入。 */
      tickHintKey(text||'');
      setHint('渲染中',text||'');
    },o);
    if(r&&r.status==='ok'){
      setBarDone();
      transport.dispose();              // 丢弃旧图与旧 buffer，保证计时从新 AudioContext 起算
      transport.load(r.buffer);
      invalidateCoverFeatures();        // FEAT-V4/T5：音频换了（换工程/换渲染长度/全曲重渲染）→ 封面/指纹的特征缓存作废
      onState('idle');
      setHintInfo('预渲染完成',
                  r.seconds.toFixed(1)+' 秒 · '+r.notes+' 音符',
                  'notes='+r.notes+' · 音频 '+r.seconds.toFixed(1)+' 秒'+
                  (r.partial?('（仅前 '+Math.round(r.seconds)+' 秒，可在顶部齿轮菜单里切换渲染长度）'):'')+
                  ' · 渲染 '+Math.round(r.renderMs||r.elapsed)+' ms（排期 '+r.scheduledSteps+' 步）· 按播放开始',3000);
    }else if(r&&r.status==='cancelled'){
      setBarCancelled();
      setHintInfo('已取消','','渲染已停止 · 工程与播放器状态不变',2500);
    }else if(r&&r.status==='tooLong'){
      setHint('工程过长','约 '+Math.round(r.seconds)+' 秒 / '+Math.round(r.bytes/1048576)+'MB，超过 7 分钟上限');
      setBar(0,'超限');
    }else if(r&&r.status!=='busy'){
      setHint('预渲染失败',(r&&r.message)||'未知原因');
      setBar(0,'失败');
    }
    return r;
  }finally{
    renderCtl=null;
    setBusyUI(false);
    if(hint&&!hint.dataset.busy)onState(transport.state());
  }
}

/* ---------- FEAT-V4 / T2：整曲分析入口（T3 专辑封面 / T4 音乐指纹的数据源） ----------
   两条既有约束必须照顾：
   1) renderProject 是模块级串行锁，且 renderAndLoad 内部会 transport.dispose()+load() 换掉播放缓冲，
      所以重渲染前先 transport.pause()，并接受“播放位置归零”（V4 方案第 7 节的取舍）。
   2) 进度不新增控件：渲染阶段由 renderAndLoad 写 #vzRenderBar/#vzHint，分析阶段由本函数写，两段各自 0→100%。
   数据来源判定：transport 里只有“已渲染的 N 秒”，默认渲染长度就是 30 秒，短于整曲时必须问用户是否全曲重渲染，
   否则 72 秒的工程永远只分析到前 30 秒。 */
let analyzing=false, analyzeCtl=null, lastFeatures=null;
/** 进度：与 audio.js 的 onProgress(pct,text) 对齐，写进度条与提示行（setBar 会清空提示行，故随后补写） */
function paintAnalyzeProgress(pct,text){
  setBar(pct,Math.round(clamp(Number(pct)||0,0,100))+'%');
  tickHintKey(text||'');
  setHint('分析中',text||'');        // 百分比交给进度条标签，详情只放阶段文字
}
/**
 * 整曲分析入口。
 * @param {{forceFull?:boolean}} [opts] forceFull=true 时不弹确认框、直接全曲重渲染
 *        （封面/指纹这类"整曲肖像"用途：只渲染前 30 秒没有意义，见 T3.5 修复 2）
 */
async function analyzeProject(opts={}){
  if(analyzing){ setHint('分析中','已有一个分析任务在进行'); return null }
  if(!dataOk||!proj||!Array.isArray(proj.tracks)||!proj.tracks.length){
    setHint('无可用工程','先回主应用生成或载入一个工程');
    return null;
  }
  const forceFull=!!(opts&&opts.forceFull);
  const est=estimate(proj,{});
  let buf=transport.getBuffer();
  const have=buf?transport.getDuration():0;
  let partial=false;

  if(!buf||have<est.full-0.5){
    const msg=(buf
      ?'当前只渲染了前 '+have.toFixed(1)+' 秒（全曲约 '+est.full.toFixed(1)+' 秒）。\n\n是否重新渲染整曲后再分析？'
      :'还没有可用的音频。\n\n是否渲染整曲后再分析？')
      +'\n（重新渲染会重新生成音频，播放位置归零）';
    let doRender=false;
    if(forceFull)doRender=true;                       // 整曲肖像用途：静默全曲重渲染，不打扰用户
    else if(window.confirm(msg))doRender=true;
    if(doRender){
      transport.pause();
      const r=await renderAndLoad(proj,{maxSeconds:null});
      if(!r||r.status!=='ok'){
        setHint('分析已取消','全曲渲染未完成'+(r&&r.message?('：'+r.message):''));
        return null;
      }
      buf=transport.getBuffer();
      if(!buf){ setHint('分析已取消','全曲渲染没有产出音频'); return null }
    }else if(!buf){
      setHint('分析已取消','没有可用音频');
      return null;
    }else{
      partial=true;                      // 用户选择用现有的一段
    }
  }

  analyzing=true;
  analyzeCtl=(typeof AbortController!=='undefined')?new AbortController():null;
  setBusyUI(true,'取消分析');
  setHint('分析中','正在分析整曲…');
  const t0=(typeof performance!=='undefined'?performance.now():Date.now());
  try{
    const feat=await analyze(buf,proj,{
      signal:analyzeCtl?analyzeCtl.signal:undefined,
      onProgress:(pct,text)=>paintAnalyzeProgress(pct,text)
    });
    if(!feat){                              // 被取消（analyzer 约定：取消返回 null）
      setBar(0,'已取消');
      setHintInfo('已取消','分析已停止 · 工程与播放器状态不变',2500);
      return null;
    }
    lastFeatures=feat;
    const ms=Math.round((typeof performance!=='undefined'?performance.now():Date.now())-t0);
    setBarDone();
    setHintInfo('分析完成',
                feat.duration.toFixed(1)+' 秒 · '+feat.segments.length+' 段 · '+feat.noteCount+' 音符',
                '起音 '+feat.onsets.length+' · 调式 '+(feat.key?feat.key.name:'未推断')+
                ' · 鼓点 '+feat.drumHits+(partial?' · 仅已渲染部分':'')+
                ' · 耗时 '+ms+' ms · 结果见 __vz.cover.last',5000);
    return feat;
  }catch(e){
    setBar(0,'失败');
    setHint('分析失败',(e&&e.message)||String(e));
    console.error('[viz-cover] 分析失败',e);
    return null;
  }finally{
    analyzing=false; analyzeCtl=null;
    setBusyUI(false);
    if(hint&&!hint.dataset.busy)onState(transport.state());
  }
}

/* ---------- UI 接线 ---------- */
function bindTransportUI(){
  /* 返回主应用（批 C 第一部分）：支持 View Transitions 时走一次跨页淡入淡出（logo 会飞），
     不支持就直接跳转；带修饰键的点击交还浏览器，保留"新标签页打开"。 */
  const back=$('#vzBack');
  if(back)back.addEventListener('click',e=>{
    if(e.defaultPrevented||e.button!==0||e.metaKey||e.ctrlKey||e.shiftKey||e.altKey)return;
    const href=back.getAttribute('href')||'./index.html';
    try{
      if(typeof document.startViewTransition==='function'){
        e.preventDefault();
        document.startViewTransition(()=>{ location.href=href });
      }
    }catch(err){
      /* 过渡起不来也绝不能把用户卡住：已经 preventDefault 了，就自己补上这次跳转 */
      location.href=href;
    }
  });
  if(playBtn)playBtn.addEventListener('click',()=>{ transport.toggle(); paintTime(transport.getCurrentTime()) });
  if(stopBtn)stopBtn.addEventListener('click',()=>transport.stop());
  if(cancelBtn)cancelBtn.addEventListener('click',()=>{
    if(analyzing&&analyzeCtl){ analyzeCtl.abort(); return }   // 分析中：同一个按钮改作“取消分析”
    cancelRender();
  });
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
    else if(e.code==='KeyF'){ e.preventDefault(); toggleFps() }          // 批 B 任务 7：F 键显示/隐藏帧率
    else if(e.code==='Escape'){
      e.preventDefault();
      /* Esc 的优先级：先关顶栏菜单 → 再停播放（此前 Esc 一按就停播，菜单开着时会"顺带停播"） */
      if(menus.some(m=>m.menu.classList.contains('open'))){ closeMenus(null); return }
      transport.stop();
    }
  });
  window.addEventListener('pagehide',()=>transport.dispose());
  /* FEAT-V4/T6：离开页面（例如点左上角"返回主应用"）时，如果正在渲染/分析就弹一次浏览器原生确认，
     避免误点丢掉几分钟的渲染进度。只在真忙时打扰，空闲时完全不介入。 */
  window.addEventListener('beforeunload',e=>{
    if(!rendering&&!analyzing&&!isRendering())return;
    e.preventDefault();
    e.returnValue='';                 // 现代浏览器忽略自定义文案，用默认提示（"离开此网站？"）
  });
}

/* ---------- 启动 ---------- */
function boot(){
  if(!cv||!ctx||!stage){ setHint('页面结构缺失','canvas 未找到'); return; }
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
  /* FEAT-V4/T3.5：封面预览弹窗。用钩子把 T2 的分析入口注入，避免 main ⇄ coverUI 循环 import：
     ensureFeatures 走完整流程（含全曲重渲染询问/进度/取消），getFeatures 让第二次点击直接复用结果。 */
  bindCoverUI({
    ensureFeatures:(o)=>analyzeProject(o),     // coverUI 会传 {forceFull:true}：封面强制整曲
    getFeatures:()=>lastFeatures,
    getTitle:()=>(proj&&proj.name)||'未命名工程',
    /* FEAT-V6/T1：分享卡片要印 BPM（FeatureObject 里没有这项）与非 hash 的分享链接；
       入口持有 proj 与 location，所以由这里注入，coverUI 不 import data/io。 */
    getBpm:()=>(proj&&isFinite(+proj.bpm))?Math.round(+proj.bpm):0,
    getShareUrl:()=>{ try{ return location.origin+location.pathname }catch(e){ return '' } }
  });
  setUI({renderParams});                   // 注入参数面板钩子（registry 不依赖 DOM）
  renderPicker();                          // 用注册表填充渲染器下拉
  /* 渲染器切换：V1 只有一项下拉时漏了这条监听，导致选中项改了却不换渲染器。
     select() 内部完成 dispose → init → 参数面板重建，主循环每帧重读 current()，下一帧即生效。 */
  if(pick)pick.addEventListener('change',()=>crossFadeCanvas(()=>select(pick.value)));
  {
    const all=list();
    if(all.length&&!current())select(all[0].id);      // 首次选中：入场淡入留给"数据就绪"那一刻（见 initData）
  }
  renderParams();
  if(!list().length){
    if(cardBody)cardBody.textContent='正在读取工程数据…';
    setHint('正在初始化','读取工程数据','第 4/7 步 · 主题 / 注册表 / 数据层已就绪');
  }
  if(fpsT===0)fpsT=performance.now();
  /* .fadeIn 播完就摘掉类（不必再开一个 700ms 的定时器）：下一次再加就能重播 */
  if(cv)cv.addEventListener('animationend',e=>{ if(e.animationName==='fadeIn')cv.classList.remove('fadeIn') });
  raf=requestAnimationFrame(frame);
  void initData();
}

/* ---------- 预渲染进度条 / 状态灯（底部 #vzRenderBar） ---------- */
function setBar(pct,label){
  const p=clamp(Number(pct)||0,0,100);
  if(renderFill){ renderFill.style.width=p.toFixed(1)+'%'; renderFill.style.background='' }
  if(renderLab)renderLab.textContent=label||(Math.round(p)+'%');
  /* 注意：这里**不动**提示行。进度每次回调都清空徽标再写回，会让徽标每 24 步重播一次淡入。
     徽标由调用方用 setHint(status,detail) 负责，进度只改 detail。 */
}
function setBarCancelled(){
  if(renderFill){ renderFill.style.width='100%'; renderFill.style.background='var(--dim)' }
  if(renderLab)renderLab.textContent='已取消';
}
function setBarDone(){
  if(renderFill){ renderFill.style.width='100%'; renderFill.style.background='' }
  if(renderLab)renderLab.textContent='100%';
}

/* ---------- 预渲染长度下拉（默认 30 秒：秒见效果；切换即用新长度重渲染） ----------
   批 B 任务 4：下拉本身移进齿轮菜单（#vzLen 原样保留，逻辑不变），这里顺带接线菜单开关。 */
const DEFAULT_MAX_SECONDS=30;
const MAX_SECONDS_UI=600;
let maxSeconds=DEFAULT_MAX_SECONDS;
function lenOpts(){ return maxSeconds==null?{}:{maxSeconds} }
/* 顶栏菜单（设置 / 下载）统一开关：点按钮切、点外面关、Esc 关（Esc 优先关菜单，不停播放） */
const menus=[];
function closeMenus(except){
  for(const m of menus){
    if(m.menu===except)continue;
    m.menu.classList.remove('open');
    if(m.btn)m.btn.setAttribute('aria-expanded','false');
  }
}
function bindMenu(btn,menu){
  if(!btn||!menu)return null;
  const rec={btn,menu};
  menus.push(rec);
  btn.addEventListener('click',e=>{
    e.stopPropagation();
    const open=!menu.classList.contains('open');
    closeMenus(menu);
    menu.classList.toggle('open',open);
    btn.setAttribute('aria-expanded',open?'true':'false');
  });
  return rec;
}
function bindLengthUI(){
  const setBtn=$('#vzSetBtn'), setMenu=$('#vzSetMenu');
  const rec=bindMenu(setBtn,setMenu);
  bindSelectPulse(lenSel);          // 批 C 补丁 2：渲染长度下拉的点击微反馈
  bindSelectPulse(pick);            // 渲染器下拉同理
  if(document.addEventListener)document.addEventListener('pointerdown',e=>{
    if(!menus.length)return;
    for(const m of menus){ if(m.menu.contains(e.target)||m.btn.contains(e.target))return }
    closeMenus(null);
  });
  if(!lenSel)return;
  lenSel.value=maxSeconds==null?'full':String(maxSeconds);
  lenSel.addEventListener('change',()=>{
    const v=lenSel.value;
    maxSeconds=(v==='full')?null:clamp(Number(v)||DEFAULT_MAX_SECONDS,5,MAX_SECONDS_UI);
    closeMenus(null);                                   // 选完就收起菜单，动作与结果在同一拍
    if(!dataOk){ setHint('渲染长度已设好','载入工程后生效','当前：'+(maxSeconds==null?'全曲':maxSeconds+' 秒')); return }
    if(rendering){ setHint('渲染进行中','取消后再切换长度',''); return }
    void renderAndLoad(proj,lenOpts());
  });
  void rec;
}

/* ---------- 第 2 步：数据装载（hash 优先 → localStorage.vizProject）→ 第 3/4 步：预渲染并载入 ---------- */
let dataOk=false;
async function initData(){
  let p=null;
  try{ p=await loadProject() }catch(e){ p=null }
  if(!p){
    dataOk=false;
    showEmpty();
    setHint('无可用数据','','没有找到工程：'+(info.reason||'原因未知')+'。可回主应用点「可视化」把当前工程移交过来。');
    return;
  }
  dataOk=true;
  hideEmpty();
  /* 批 B 任务 1：位置区副行改作状态提示，工程摘要（describe()）进它的 title —— 信息不丢，只是不再占版面 */
  if(posSub){ posSub.textContent=STATE_WORD.idle; posSub.title=describe() }
  if(cardBody)cardBody.textContent='';
  revealCanvas();                     // 画布入场（批 A 任务 7）：数据就绪这一刻淡入 + 轻推镜
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
  if(fpsEl&&ts-fpsT>=500){
    const v=Math.round(frames*1000/(ts-fpsT));
    fpsEl.textContent=v+' FPS';
    /* 批 B 任务 7：默认隐藏；F 键可开；连续 3 次低于 45 帧自动浮现（性能告警），恢复后自动收起 */
    if(v<45)fpsLow=Math.min(fpsLow+1,4); else fpsLow=Math.max(fpsLow-1,0);
    fpsEl.classList.toggle('on',fpsOn||fpsLow>=3);
    fpsEl.classList.toggle('low',fpsLow>=3);
    frames=0; fpsT=ts;
  }
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
  /* FEAT-V4/T2：整曲分析自检句柄（T3/T4 会在此基础上加封面/指纹）
     - __vz.cover.analyze()：走完整流程（不足整曲时会弹 confirm 询问是否全曲重渲染）
     - __vz.cover.last：最近一次成功的 FeatureObject
     - __vz.cover.needRender：只看“是否必须重渲染”而不执行（便于先确认判定分支） */
  cover:{
    analyze:analyzeProject,
    get last(){ return lastFeatures },
    get busy(){ return analyzing },
    get needRender(){
      const est=estimate(proj,{});
      const have=transport.getBuffer()?transport.getDuration():0;
      return {have,full:est.full,need:!(have>=est.full-0.5)};
    }
  },
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
    if(!p){ setHint('演示工程失败','',( '构造内存演示工程时出错：')); return {status:'error',message:'演示工程构造失败'} }
    dataOk=true;
    hideEmpty();
    if(posSub){ posSub.textContent=STATE_WORD.idle; posSub.title=describe() }
    revealCanvas();
    const r=await renderAndLoad(p);
    return r;
  },
  /* 诊断（按需）：导出当前工程 JSON（供在 Node 桩里完整复现）。T6 起不打印，返回值即结果 */
  exportJson(){
    if(!dataOk||!proj||!proj.tracks)return null;
    const s=exportProjectJson(proj);
    try{
      const a=document.createElement('a');
      a.href=URL.createObjectURL(new Blob([s],{type:'application/json'}));
      a.download=(proj.name||'viz-project')+'.json';
      document.body.appendChild(a); a.click();
      setTimeout(()=>{ try{ a.remove() }catch(e){} },0);
    }catch(e){ console.error('[viz-diag] 导出 JSON 失败',e) }
    return s;
  },
  /* 诊断（按需）：串行阶梯二分，定位渲染卡死起点；不改变正常渲染流程。
     现在只返回数据（Console 里直接看 __vz.diagnose() 的结果，含 ladder 数组） */
  async diagnose(){
    if(!dataOk)return null;
    return await diagnoseRender(proj);
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
