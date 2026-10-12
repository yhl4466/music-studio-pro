/* [viz/main.js] 可视化页入口（visualizer.html）——只做编排：
   DOM 句柄 / 画布 DPR 自适应 / 单 rAF 主循环 / 渲染器注册表 / 数据装载 / 预渲染 → 播放接线。
   现状：数据层（第 2 步）、离线预渲染（第 3 步）、播放与 transport（第 4 步）已接入；
   渲染器仍为空（第 6 步注册实时波形），主循环暂时只清屏画基线。
   层级：viz → core（+ io/share 的纯解码函数）；不 import 主应用 ui/audio 模块。 */
import { $, clamp } from '../core/util.js';
import * as dataMod from './data.js';
import { proj, loadProject, showEmpty, hideEmpty, describe, info, makeDemoProject } from './data.js';
import { renderProject, diagnoseRender, analyzeNodes, exportProjectJson, cancelRender, isRendering, estimate, makeEta, workUnits, SAMPLE_RATE } from './audio.js';
import * as transport from './transport.js';
import { register, list, select, current, setSurface, setUI } from './registry.js';
import { createFeatures } from './features.js';   // FEAT-V2/T1：频域特征/节拍提取（纯计算，无 DOM）
import { analyze } from './analyzer.js';          // FEAT-V4/T2：整曲离线分析（V4 封面/指纹的数据源，纯计算）
import { bindCoverUI, invalidateCoverFeatures } from './coverUI.js';  // FEAT-V4/T3.5：封面预览弹窗（只画图与下载，无业务逻辑）
import * as qrMod from './qrcode.js';        // 真·二维码编码器（分享卡片用；__vz.qr.selfTest() 可自检）
import { buildShareHash } from '../io/share.js';        // 复用主应用的压缩编码（deflate/LZSS 择优）
import { resolveSiteBase, buildShareUrl, siteSourceLabel, readSiteOverride, writeSiteOverride } from '../io/siteUrl.js';  // 对外地址解析（不用 location.origin）
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

/* ---------- 画布尺寸（逻辑像素 → 后端像素），只在尺寸/缩放变化时重建变换 ----------
   ==========================================================================
   这里是可视化页"渲染很慢、像卡住"的根因：后端分辨率原来直接 = 逻辑尺寸 × devicePixelRatio
   （上限 3），而所有渲染器的成本都与**像素数**成正比（逐柱 fill / 逐粒 sprite / 逐帧 drawImage）。
   实测（headless Edge，1600×900 视口）：
     DPR=1 → 后端 1600×770 = 1.2M 像素，forest 60 FPS
     DPR=2 → 后端 3200×1488 = 4.8M 像素，forest 33 FPS（p50 30.6ms）
     DPR=3 → 后端 4800×2232 = 10.7M 像素，forest 17 FPS（p50 60ms）  ← 就是"卡住"
   而 JS 侧其实很轻：forest 的 draw 自报 2.96ms/帧，其余时间全在浏览器光栅化。
   所以对策是**控制后端像素总量**，而不是优化逐个渲染器的算法：
     ① 像素预算 MAX_BACKING_PX：后端像素数不超过它（1600×900 视口下 ≈1.55x 缩放，
        肉眼与 2x 几乎无差别，但光栅化工作量只剩 1/3）；
     ② 硬上限 MAX_SCALE：即使屏幕很大也不会自动放大到 2x 以上；
     ③ 自适应分辨率：帧耗时持续偏高时自动把缩放降一档（最多降到 MIN_SCALE），
        恢复正常后逐档升回 —— 高分屏 + 全屏 + 森林这种组合也能自己救回来。
   view.w/h 仍是**逻辑像素**（渲染器全部按逻辑坐标绘图），只是 ctx 的变换里多了一个分辨率系数，
   所以所有渲染器与参数都不用改。 */
const MAX_BACKING_PX=2900000;   // 后端像素预算（≈ 1600×900 @1.42x / 1920×1080 @1.18x）
const MAX_SCALE=2;              // 后端缩放硬上限（超过 2x 对观感几乎无收益，代价却是平方增长）
const MIN_SCALE=.6;             // 自适应下限（再低就开始糊了）
/* 自适应用"帧耗时 EMA"做判据，阈值刻意取得很保守：
   只有**持续**慢到 40ms/帧（<25 FPS）才降档，而 15ms（≈60 FPS）就逐步升回。
   为什么保守：这一层是给"高分辨率 + 慢显卡"的兜底，不是常规手段 ——
   常规收益来自上面的像素预算（确定性的、可预测的）。阈值太松会在软件光栅化环境里
   一路降到最低档还回不来，那比"稍微慢一点"更糟。 */
const ADAPT_DOWN_MS=40;         // 帧耗时 EMA 超过它才降一档
const ADAPT_UP_MS=15;           // 低于它就尝试升回一档
const ADAPT_COOLDOWN_MS=1200;   // 两次调整之间的最小间隔（避免抖动）
const ADAPT_SETTLE_MS=2500;     // 切渲染器/开始播放后，先让它稳定这么久再动分辨率
let adaptiveScale=MAX_SCALE;    // 自适应系数（1 = 只用像素预算，不额外降级）
let lastAdaptAt=0;
let adaptHoldUntil=0;           // 在此之前不做任何调节（并让 EMA 重新收敛）

function computeScale(rect){
  const dpr=clamp(window.devicePixelRatio||1,1,MAX_SCALE);
  let s=dpr;
  const budget=Math.sqrt(MAX_BACKING_PX/Math.max(1,rect.width*rect.height));
  if(s>budget)s=budget;
  if(s>adaptiveScale)s=adaptiveScale;
  return clamp(s,MIN_SCALE,MAX_SCALE);
}
function resize(){
  if(!cv||!ctx)return;
  const rect=cv.getBoundingClientRect();
  const w=Math.max(1,Math.round(rect.width)), h=Math.max(1,Math.round(rect.height));
  const scale=computeScale(rect);
  const pw=Math.max(1,Math.round(w*scale)), ph=Math.max(1,Math.round(h*scale));
  if(cv.width!==pw||cv.height!==ph){
    cv.width=pw; cv.height=ph;      // 赋值会重置变换与状态
  }
  ctx.setTransform(scale,0,0,scale,0,0);
  view.w=w; view.h=h; view.dpr=scale;
  setSurface(ctx,view);                  // 渲染器 resize 由 registry 转达
  resizeRenderer(ctx,view);
}
/* 让自适应重新开始：回到满分辨率、丢掉被污染的帧耗时 EMA、并给一段稳定期。
   必须存在，否则这个机制会变成一个"单向棘轮" —— 加载音频/切渲染器时那几帧的
   长耗时会把 EMA 顶高，于是永久停在低分辨率（实测会一路降到 0.6 再也升不回来）。 */
function resetAdaptive(){
  adaptiveScale=MAX_SCALE;
  frameMsEma=0;
  adaptHoldUntil=nowMs()+ADAPT_SETTLE_MS;
  lastAdaptAt=0;
}
/* 自适应分辨率调节：在主循环里按帧耗时 EMA 调 adaptiveScale。
   只在真正需要重设画布尺寸时调用 resize()（改 adaptiveScale 本身不触发）。 */
function adaptResolution(ms){
  if(!cv||!ctx)return;
  const t=nowMs();
  if(t<adaptHoldUntil)return;
  if(t-lastAdaptAt<ADAPT_COOLDOWN_MS)return;
  let next=adaptiveScale;
  if(ms>ADAPT_DOWN_MS)next=Math.max(MIN_SCALE,adaptiveScale-.15);
  else if(ms<ADAPT_UP_MS&&adaptiveScale<MAX_SCALE)next=Math.min(MAX_SCALE,adaptiveScale+.1);
  next=Math.round(next*100)/100;
  if(Math.abs(next-adaptiveScale)<.005)return;
  adaptiveScale=next; lastAdaptAt=t;
  resize();
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
 * @param {{forceFull?:boolean, sampleRate?:number, restoreAudio?:boolean}} [opts]
 *        forceFull=true 时不弹确认框、直接全曲重渲染
 *        （封面/指纹这类"整曲肖像"用途：只渲染前 30 秒没有意义，见 T3.5 修复 2）
 *        sampleRate：分析专用渲染的采样率。封面/指纹要渲染**整曲**，而频率轴成本与采样率线性相关，
 *                    分析又只用 RMS/频谱/音级直方图这些低频为主的特征 →
 *                    用 22050 能把整曲渲染时间砍掉约一半（渲染器频率轴已改为读实际采样率）。
 *        restoreAudio：分析完成后是否自动把播放缓冲恢复成"用户选的播放长度 + 全采样率"
 *                      （默认 true）。否则可视化页会一直播着 11kHz 上限的分析音频。
 */
const ANALYSIS_SR=22050;              // 整曲分析专用采样率（约省一半时间，见上）
async function analyzeProject(opts={}){
  if(analyzing){ setHint('分析中','已有一个分析任务在进行'); return null }
  if(!dataOk||!proj||!Array.isArray(proj.tracks)||!proj.tracks.length){
    setHint('无可用工程','先回主应用生成或载入一个工程');
    return null;
  }
  const forceFull=!!(opts&&opts.forceFull);
  const wantSr=(opts&&opts.sampleRate!=null)?opts.sampleRate:ANALYSIS_SR;
  const restoreAudio=(opts&&opts.restoreAudio===false)?false:true;
  const est=estimate(proj,{});
  let buf=transport.getBuffer();
  const have=buf?transport.getDuration():0;
  let partial=false;
  let lowQualityBuf=false;            // 本次是否为了分析而渲染了低采样率缓冲

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
      /* 整曲 + 分析专用采样率：这是封面/指纹耗时的主要来源，降采样直接省掉约一半 */
      const r=await renderAndLoad(proj,{maxSeconds:null,sampleRate:wantSr});
      if(!r||r.status!=='ok'){
        setHint('分析已取消','全曲渲染未完成'+(r&&r.message?('：'+r.message):''));
        return null;
      }
      buf=transport.getBuffer();
      if(!buf){ setHint('分析已取消','全曲渲染没有产出音频'); return null }
      lowQualityBuf=!!(wantSr&&wantSr<SAMPLE_RATE);
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
    /* 分析用的是降采样缓冲（11kHz 上限），不能就这样留给播放 —— 恢复到"用户选的播放长度 + 全采样率"。
       特征已经在 lastFeatures 里了，所以恢复失败也不影响封面/指纹（只影响播放质量）。 */
    if(lowQualityBuf&&restoreAudio){
      try{
        setHintInfo('分析完成','正在恢复播放音质…','按你选的长度重新渲染 44.1kHz 版本',3000);
        const rr=await renderAndLoad(proj,lenOpts());
        if(!rr||rr.status!=='ok')setHintInfo('提示','播放音质未恢复','可重新选择渲染长度来恢复',4000);
      }catch(e){ /* 恢复失败不影响已产出的特征 */ }
    }
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
}

/* =========================================================================
   分享卡片上的链接 / 二维码
   -------------------------------------------------------------------------
   两个曾经同时存在的致命问题：
     ① 用了 location.origin → 本地起服务时印出 http://localhost:8123/...，别人打不开；
     ② 卡片文案写"扫码即还原工程"，但传给卡片的是**剥掉 hash 的裸地址**，
        二维码里根本没有工程数据，从来没有"还原"过。
   现在：
     · 基址走 io/siteUrl 的对外地址（手填 > meta/canonical > 非本机的当前地址 > 线上兜底）；
     · 把工程数据一起编码进 hash（复用主应用的 deflate/LZSS 择优）；
     · 二维码容量只有 213 字节（v10-M），而实测最小工程压完也有 851 字节 ——
       所以**装不下是常态**。装不下就退化成"只指向应用"，并由卡片文案如实说明，
       不再谎称扫码能还原谱子。
   ========================================================================= */
const QR_BYTE_LIMIT=qrMod.QR_MAX_BYTES;   // 213
let shareInfoCache=null;                  // {url,fullUrl,dataBytes,fitsQR,siteFrom,codec,kb}
let shareInfoBusy=false;
/** 同步取"当前可用的分享链接"。数据未就绪时先返回不含数据的应用地址（绝不再回落到 localhost） */
function shareUrlForCard(){
  if(shareInfoCache&&shareInfoCache.url)return shareInfoCache.url;
  return buildShareUrl('');
}
/** 异步算出"带工程数据"的分享链接与二维码适配情况 */
async function refreshShareInfo(){
  if(shareInfoBusy)return shareInfoCache;
  /* 工程还没载入时不能去序列化（serializeProject 会读 proj.tracks 并 map）——
     那时先给出"只指向应用"的链接，等数据就绪后再算完整版。 */
  if(!proj||!Array.isArray(proj.tracks)||!proj.tracks.length){
    shareInfoCache={url:buildShareUrl(''),fullUrl:'',dataBytes:0,fitsQR:false,
      siteFrom:resolveSiteBase().from,siteLabel:siteSourceLabel(resolveSiteBase().from),
      codec:'',kb:0,limit:QR_BYTE_LIMIT,notReady:true};
    return shareInfoCache;
  }
  shareInfoBusy=true;
  try{
    const base=resolveSiteBase();
    const h=await buildShareHash();
    const fullUrl=buildShareUrl(h.hash);
    const dataBytes=h.hash.length;                        // 含 '#' 的字符数（hash 基本是 ASCII，≈字节数）
    const fitsQR=(dataBytes<=QR_BYTE_LIMIT);
    const url=fitsQR?fullUrl:buildShareUrl('');            // 装不下就只印应用地址，绝不印一个扫不开的码
    shareInfoCache={url,fullUrl,dataBytes,fitsQR,siteFrom:base.from,siteLabel:siteSourceLabel(base.from),
      codec:h.codec,kb:h.kb,limit:QR_BYTE_LIMIT};
  }catch(e){
    shareInfoCache={url:buildShareUrl(''),fullUrl:'',dataBytes:0,fitsQR:false,
      siteFrom:'error',siteLabel:'解析失败',codec:'',kb:0,limit:QR_BYTE_LIMIT};
  }finally{
    shareInfoBusy=false;
  }
  return shareInfoCache;
}

/* FEAT-V4/T3.5：封面预览弹窗。用钩子把 T2 的分析入口注入，避免 main ⇄ coverUI 循环 import：
   ensureFeatures 走完整流程（含全曲重渲染询问/进度/取消），getFeatures 让第二次点击直接复用结果。 */
function bindCoverHooks(){
  bindCoverUI({
    ensureFeatures:(o)=>analyzeProject(o),     // coverUI 会传 {forceFull:true}：封面强制整曲
    getFeatures:()=>lastFeatures,
    getTitle:()=>(proj&&proj.name)||'未命名工程',
    getBpm:()=>(proj&&isFinite(+proj.bpm))?Math.round(+proj.bpm):0,
    /* FEAT-V6/T1：分享卡片要印 BPM（FeatureObject 里没有这项）与可用的分享链接；
       入口持有 proj 与 location，所以由这里注入，coverUI 不 import data/io。

       ⚠ 这里**不能用 location.origin**：本地起服务时它是 localhost，
       卡片二维码/链接印出去别人根本打不开（实测用户反馈的致命问题）。
       改用 io/siteUrl 解析「对外地址」：手填设置 > meta/canonical 声明 >
       当前地址（仅当不是内网/本机）> 默认线上地址。
       同时把**工程数据一起编码进 hash**（能装下就装）：装得下时扫码直接还原工程，
       装不下时只指向应用本身 —— 由卡片文案如实说明是哪一种，不再谎称"扫码即还原"。 */
    getShareUrl:()=>{ try{ return shareUrlForCard() }catch(e){ return '' } },
    getShareInfo:()=>shareInfoCache
  });
}
/* 封面弹窗之后继续 boot 的其余接线（拆出来只是为了让上面这段钩子独立可读） */
function bootAfterCoverUI(){
  setUI({renderParams});                   // 注入参数面板钩子（registry 不依赖 DOM）
  renderPicker();                          // 用注册表填充渲染器下拉
  /* 渲染器切换：V1 只有一项下拉时漏了这条监听，导致选中项改了却不换渲染器。
     select() 内部完成 dispose → init → 参数面板重建，主循环每帧重读 current()，下一帧即生效。
     切渲染器时重置自适应（各渲染器成本差一个量级，沿用上一个的档位会平白糊一屏）。 */
  if(pick)pick.addEventListener('change',()=>{ resetAdaptive(); crossFadeCanvas(()=>select(pick.value)) });
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
}/* ---------- 预渲染进度条 / 状态灯（底部 #vzRenderBar） ---------- */
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

/* ---------- 预渲染长度（默认跟随曲长；用户改过就记住） ----------
   旧版把默认写死 30 秒，于是：
     · 10 秒的短曲也要渲染 30 秒（多等 3 倍，而且后 20 秒全是静音）；
     · 5 分钟的长曲又只渲染前 30 秒，用户得自己再去菜单里改。
   现在：首次进页面用「全曲」（超过 AUTO_FULL_MAX_SEC 的曲子改用 30 秒，避免一进来就等太久），
   用户一旦手动选过就写进 localStorage.vizRenderLen，以后按选择走（'full' 也记）。
   另外把"预计渲染多久"提前算出来放在提示行里 —— 不用等到点下去才知道要等一分钟。 */
const DEFAULT_MAX_SECONDS=30;             // 长曲的首次默认值
const MAX_SECONDS_UI=600;                 // 下拉里可输入/可选的上限（秒）
const AUTO_FULL_MAX_SEC=60;               // 曲长不超过它 → 首次默认渲染全曲
const LEN_KEY='vizRenderLen';
let maxSeconds=DEFAULT_MAX_SECONDS;
let lenTouched=false;                     // 用户是否手动选过（选过就不再自动跟随曲长）
/* 返回值语义（三者必须分清，之前把"无存档"和"用户选了全曲"混成同一个 null，
   导致长曲永远拿不到默认的 30 秒预览）：
     undefined → 没有有效存档（交给"跟随曲长"的自动默认）
     null      → 用户明确选过"全曲"
     number    → 用户选过的秒数 */
function readSavedLen(){
  try{
    const v=localStorage.getItem(LEN_KEY);
    if(v==null||v==='')return undefined;   // 无存档
    if(v==='full')return null;             // 明确选了全曲
    const n=Number(v);
    return (isFinite(n)&&n>0)?n:undefined; // 非法值当作无存档
  }catch(e){ return undefined }
}
function writeSavedLen(){
  try{ localStorage.setItem(LEN_KEY,maxSeconds==null?'full':String(maxSeconds)) }catch(e){}
}
/** 载入工程后决定这次渲染多长；返回是否因此改动了长度 */
function chooseRenderLength(p){
  const saved=readSavedLen();
  if(saved!==undefined){                  // 有有效存档：按用户上次的选择
    maxSeconds=saved; lenTouched=true;
    return false;
  }
  const fullSec=Number(estimate(p,{}).seconds)||0;
  const want=(fullSec>0&&fullSec<=AUTO_FULL_MAX_SEC)?null:DEFAULT_MAX_SECONDS;
  const changed=(want!==maxSeconds);
  maxSeconds=want; lenTouched=false;
  if(lenSel)lenSel.value=(maxSeconds==null?'full':String(maxSeconds));
  return changed;
}
function lenOpts(){ return maxSeconds==null?{}:{maxSeconds} }
/** 长度文案（下拉用/提示行用） */
function lenLabel(){
  if(maxSeconds==null)return '全曲';
  return maxSeconds+' 秒';
}
/** 预渲染预计耗时：用 ETA 的口径（振荡器-秒）估算，给人一个"要等多久"的预期 */
function predictRenderText(p){
  try{
    const e=estimate(p,lenOpts());
    const sec=Math.max(0.1,Number(e.seconds)||0);
    const eta=makeEta(sec,{workU:workUnits(p)});
    const total=Math.round(eta.initialTotal*1000);
    const partial=!!e.partial;
    return (partial?'渲染前 '+Math.round(sec)+' 秒':'渲染整曲 '+Math.round(sec)+' 秒')+
           ' · 预计约 '+Math.max(1,Math.round(total/1000))+' 秒'+
           (eta.from==='history-u'?'（按本机历史速度）':'');
  }catch(err){ return '' }
}
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
  bindSiteUrlUI();                  // 分享地址设置（见下）
  if(document.addEventListener)document.addEventListener('pointerdown',e=>{
    if(!menus.length)return;
    for(const m of menus){ if(m.menu.contains(e.target)||m.btn.contains(e.target))return }
    closeMenus(null);
  });
  if(!lenSel)return;
  /* 下拉初值必须在**这里**就与存档对齐：bindLengthUI 早于 chooseRenderLength 运行
     （后者要等工程载入才知道曲长），否则刷新后下拉会先显示默认的 30 秒，
     与"上次选的全曲"不一致 —— 用户会以为选择没被记住。 */
  {
    const saved0=readSavedLen();
    if(saved0!==undefined){ maxSeconds=saved0; lenTouched=true }
    lenSel.value=(maxSeconds==null?'full':String(maxSeconds));
  }
  lenSel.addEventListener('change',()=>{
    const v=lenSel.value;
    maxSeconds=(v==='full')?null:clamp(Number(v)||DEFAULT_MAX_SECONDS,5,MAX_SECONDS_UI);
    lenTouched=true;
    writeSavedLen();                                    // 记住这次选择，下次进页面就用它
    closeMenus(null);                                   // 选完就收起菜单，动作与结果在同一拍
    if(!dataOk){ setHint('渲染长度已设好','载入工程后生效','当前：'+lenLabel()); return }
    if(rendering){ setHint('渲染进行中','取消后再切换长度',''); return }
    const pred=predictRenderText(proj);
    if(pred)setHint('渲染长度：'+lenLabel(),pred,'');
    void renderAndLoad(proj,lenOpts());
  });
  void rec;
}

/* ---------- 分享地址设置（forks / 自建部署）----------
   分享卡片上的二维码必须是**别人点得开**的地址。默认走 index.html 里的 canonical/meta 声明
   （= 本仓库的线上地址），但别人 fork 到自己域名后需要能改。这里给一个输入框，
   存 localStorage（mpSiteUrl），改完立即重算分享信息并刷新卡片。
   在 localhost 上打开时也靠这个纠正 —— 否则卡片会印出 localhost。 */
function bindSiteUrlUI(){
  const inp=$('#vzSiteUrl'),save=$('#vzSiteSave'),reset=$('#vzSiteReset'),hintEl=$('#vzSiteHint');
  if(!inp)return;
  const paint=()=>{
    const b=resolveSiteBase();
    inp.value=readSiteOverride()||'';
    inp.placeholder=b.url;
    if(hintEl){
      const local=(()=>{try{return location.hostname==='localhost'||location.hostname==='127.0.0.1'}catch(e){return false}})();
      hintEl.textContent='当前生效：'+b.url+'（'+siteSourceLabel(b.from)+'）'
        +(local?'　⚠ 你在本机访问，已自动改用对外地址':'');
    }
  };
  paint();
  save.addEventListener('click',()=>{
    const v=inp.value.trim();
    if(!v){ setHint('分享地址不能为空','例如 https://example.com/music-studio-pro/'); return }
    if(!writeSiteOverride(v)){ setHint('保存失败','浏览器存储不可用（隐私模式？）'); return }
    const b=resolveSiteBase();
    /* 可视化页没有主应用那套 toast 容器，反馈统一走底部提示行。
       setHintInfo(status,key,detail,holdMs) —— 4 个参数，第三个才是详情。 */
    setHintInfo('分享地址已保存',b.url,'卡片二维码将使用该地址',3000);
    paint();
    void refreshShareInfo();
  });
  reset.addEventListener('click',()=>{
    writeSiteOverride('');
    const b=resolveSiteBase();
    setHintInfo('已恢复默认分享地址',b.url,'',3000);
    paint();
    void refreshShareInfo();
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
    setHint('无可用数据','','没有找到工程：'+(info.reason||'原因未知')+'。可回主应用点「可视化」把当前工程移交过来。');
    return;
  }
  dataOk=true;
  hideEmpty();
  /* 批 B 任务 1：位置区副行改作状态提示，工程摘要（describe()）进它的 title —— 信息不丢，只是不再占版面 */
  if(posSub){ posSub.textContent=STATE_WORD.idle; posSub.title=describe() }
  if(cardBody)cardBody.textContent='';
  /* 渲染长度：先读存档，没有存档就按曲长自动决定（短曲直接全曲，长曲用 30 秒预览），
     并把"预计要等多久"写进提示行 —— 不用点下去才知道。 */
  chooseRenderLength(p);
  const pred=predictRenderText(p);
  revealCanvas();                     // 画布入场（批 A 任务 7）：数据就绪这一刻淡入 + 轻推镜
  if(pred)setHint('渲染长度：'+lenLabel(),pred,info.steps?('工程 '+info.steps+' 步'):'');
  await renderAndLoad(p,lenOpts());
  /* 工程数据就绪后再算分享链接（要把工程编码进去，所以必须等载入完成）。
     不阻塞渲染：算完刷新一下卡片文案/二维码即可。 */
  void refreshShareInfo();
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
const audioData={timeDomain:null,freqData:null,features:feats.snapshot,beat:feats.beat,dt:0,frameNo:0,projectBpm:0,
  sampleRate:44100};   // 频率轴用：可视化预渲染允许非 44.1kHz（见 renderProject 的 sampleRate 选项）
let tdBuf=null, fdBuf=null, tdSize=0, tdAnalyser=null;
let frameMsEma=0;                          // 帧耗时 EMA（自适应分辨率用）
let wasPlaying=false;                      // 播放状态沿（开始播放时重置自适应）
function nowMs(){ return (typeof performance!=='undefined'&&performance.now)?performance.now():Date.now() }
function frame(ts){
  raf=requestAnimationFrame(frame);
  if(!ctx)return;
  const playing=transport.isPlaying();
  /* 开始播放这一刻重置自适应：加载/起播的几帧本来就长，不该被算成"这台机器跑不动"。
     顺带保证"暂停→改分辨率→播放"这条路径不会把上次的降级一直带着。 */
  if(playing&&!wasPlaying)resetAdaptive();
  wasPlaying=playing;
  if(playing){
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
    /* 实际采样率（给渲染器的频率轴用）：读 actx.sampleRate 是纯属性访问，无布局开销。
       必须每帧填 —— 预渲染可能用 22.05kHz 出图，之后又换回 44.1kHz。 */
    audioData.sampleRate=(an.context&&an.context.sampleRate)||44100;
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
  /* 自适应分辨率：用"到上一帧的间隔"做 EMA（ts-lastTs 在下一帧才更新，这里用 dt 还原毫秒）。
     只在页面可见时调节 —— 后台标签页 rAF 被暂停，量出来的"帧耗时"没有意义。
     dt 上限截到 80ms：一次加载/切渲染器的长帧不该把 EMA 顶到几百毫秒，否则会误判成"需要降档"。 */
  if(!document.hidden){
    const fms=Math.min(dt*1000,80);
    if(fms>0)frameMsEma=frameMsEma?frameMsEma*.9+fms*.1:fms;
    adaptResolution(frameMsEma);
  }
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

/* 启动：boot 负责建立视图/渲染器/UI 接线，随后接上封面弹窗钩子与数据装载。
   （拆成三段只是因为分享卡片那段钩子注释较长，执行顺序必须保持 boot → hooks → UI → 数据。） */
/* 启动链：boot 建视图/渲染器/UI 接线 → 封面弹窗钩子 → 其余 UI 接线与数据装载。
   ⚠ 三者顺序不能变。拆成三段是因为分享卡片那段钩子注释较长；
   把它们的定义误写进 boot() 内部会导致整个模块语法错误（实测踩过，整页白屏）。 */
function startViz(){
  boot();
  bindCoverHooks();
  bootAfterCoverUI();
}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',()=>{ try{ startViz() }catch(e){ console.error('[viz] 启动失败',e); throw e } },{once:true});
else { try{ startViz() }catch(e){ console.error('[viz] 启动失败',e); throw e } }

/* 自检句柄：Console 里确认循环 / 尺寸 / 数据层 / 播放状态（第 4 步起含 transport） */
window.__vz={view,list,current,select,register,data:dataMod,transport,registry:{register,list,select,current},
  dom:{stage,cv,overlay,hint,playBtn,stopBtn,cancelBtn,seek,pick,lenSel,posSub,posMain,timeEl,paramsBox},
  get renderParams(){return current()?current().params:null},
  get dataOk(){return dataOk},
  /* 自适应分辨率状态（自检用）：当前后端缩放 / 帧耗时 EMA / 后端像素数 */
  get resolution(){ return {scale:+view.dpr.toFixed(3),logical:view.w+'x'+view.h,
    backing:cv?cv.width+'x'+cv.height:'-', px:cv?cv.width*cv.height:0, frameMs:+frameMsEma.toFixed(1)} },
  get rendering(){return rendering},
  get audioBusy(){return isRendering()},
  get audio(){return audioData},              // 自检：freqData 长度 / features / beat / dt / frameNo
  cancelRender,
  fmtTime,
  /* 二维码自检句柄：__vz.qr.selfTest() 校验编码器（格式信息 BCH / 定位角 / 时序 / 掩码 / 容量边界）。
     分享卡片右下角现在印的是**真码**（可扫），所以这个自检值得留着随时能跑。 */
  qr:qrMod,
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
