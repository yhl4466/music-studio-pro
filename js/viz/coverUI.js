/* [viz/coverUI.js] FEAT-V4 / T3.5：最小封面预览 UI（弹窗 + 3 风格 + 换一张 + 下载 PNG）。
   作用范围最小：只负责"点按钮 → 拿特征 → 画在弹窗画布上 → 下载"，不做完整模态（T5 再做）。

   依赖：core/util.js（$ / downloadBlob）、cover.js（generateCover）。**不 import registry / transport / data**。
   与入口的耦合靠 bindCoverUI(hooks) 注入，避免 main.js ⇄ coverUI.js 互相 import：
     hooks.ensureFeatures()  复用 T2 的 analyzeProject（含"是否全曲重渲染"询问、进度条复用、取消）
     hooks.getFeatures()     读入口缓存的 FeatureObject —— 有值就不再分析（第二次点击直接重绘）
     hooks.getTitle()        工程名（图内标题 + 下载文件名）
   自检句柄：window.__vzCoverUI = {open, close, render, setStyle, setSeed, download, state}
   注意：本文件里的 Math.random 只用于"换一张"的种子生成，cover.js 本身仍是纯确定性的。 */

import { $, downloadBlob } from '../core/util.js';
import { generateCover, COVER_STYLES } from './cover.js';
import { generateFingerprint } from './fingerprint.js';
import { generateShareCard } from './shareCard.js';      // FEAT-V6/T1：分享卡片（1200×630）

/* 顶部按钮图标：先试 emoji，运行时探测本机能不能画出来（画不出来就退回几何符号 ◆，绝不出现方块）。
   想手工固定：把 ICON 直接改成 '◆' 或任意字符即可（AUTO_ICON=false 关闭探测）。 */
const ICON='🎨';
const ICON_FALLBACK='◆';
const AUTO_ICON=true;

const STYLE_LABELS={ring:'同心声纹',bricks:'能量砖阵',ribbon:'波形缎带'};
const KIND_LABELS={cover:'专辑封面',fingerprint:'音乐指纹',sharecard:'分享卡片'};
const SEED_MAX=1e9;

let el=null;                       // DOM 句柄集合（bind 一次）
let hooks={};                      // 入口注入的回调
let features=null;                 // 本次会话拿到的特征（由 hooks.getFeatures 提供/缓存）
let kind='cover';                  // 产物：'cover' 专辑封面 | 'fingerprint' 音乐指纹
let style='ring', seed=1, rendering=false, hd=false;
let titleOverride=null;            // 用户在弹窗里改过的曲名（只影响出图，不改 proj.name）
let icon=ICON;                     // 实际使用的图标（bind 时确定）

/* ---------- 小工具 ---------- */
/** emoji 可用性探测：把候选字符与"一定没有字形"的码位各画一次，逐像素比较；
    完全一致说明 emoji 也退化成了豆腐块（或干脆没画出来）→ 判定不可用。
    任何异常（无 canvas / 无 getImageData）都按"不可用"处理，保证按钮永不出现方块。 */
function emojiSupported(ch){
  try{
    if(typeof document==='undefined'||typeof document.createElement!=='function')return false;
    const c=document.createElement('canvas');
    c.width=16; c.height=16;
    /* willReadFrequently：这块画布只用来读像素，不加这个属性浏览器会警告
       "Multiple readback operations using getImageData are faster with willReadFrequently" */
    const g=c.getContext('2d',{willReadFrequently:true});
    if(!g||typeof g.getImageData!=='function')return false;
    const sig=(txt)=>{
      g.clearRect(0,0,16,16);
      g.font='12px sans-serif'; g.textBaseline='top'; g.fillStyle='#fff';
      g.fillText(txt,1,1);
      const d=g.getImageData(0,0,16,16).data;
      let h=0,ink=0;
      for(let i=0;i<d.length;i+=4){ const a=d[i+3]; h=(h*31+a)>>>0; if(a)ink++ }
      return h+':'+ink;
    };
    const a=sig(ch), pua=sig('\uE000'), ffff=sig('\uFFFF');   // 私用区与 U+FFFF 正常字体都无字形
    return a!==pua&&a!==ffff;
  }catch(e){ return false }
}
function setNote(text){
  if(el&&el.note)el.note.textContent=text||'';
}
function safeName(s){
  const t=String(s==null?'':s).replace(/[\\/:*?"<>|]+/g,'_').replace(/\s+/g,' ').trim();
  return (t||'未命名工程').slice(0,40);
}
/** 出图用的曲名：用户编辑过的覆盖值 → 入口给的工程名 → 兜底 */
function titleOf(){
  if(typeof titleOverride==='string'&&titleOverride.trim())return titleOverride;
  return (typeof hooks.getTitle==='function'?hooks.getTitle():null)||'未命名工程';
}
/** 工程 BPM（FeatureObject 里没有这一项，由入口注入 hooks.getBpm；缺失返回 0 = 图上不显示） */
function bpmOf(){
  if(typeof hooks.getBpm==='function'){
    try{ const b=Number(hooks.getBpm()); if(isFinite(b)&&b>0)return b }catch(e){}
  }
  return 0;
}
/** 印在分享卡片上的链接：优先入口注入，否则用当前页面地址（**去掉 hash** ——
    工程分享用的 hash 可能有几十上百 KB，印在卡片上没意义；hash 体积另用一行小字说明）。 */
function shareUrlOf(){
  if(typeof hooks.getShareUrl==='function'){
    try{ const u=hooks.getShareUrl(); if(u)return String(u) }catch(e){}
  }
  try{
    if(typeof location!=='undefined')return location.origin+location.pathname;
  }catch(e){}
  return '';
}
function isOpen(){ return !!(el&&el.modal&&!el.modal.classList.contains('off')) }
function setStyleButtons(){
  if(!el)return;
  for(const b of el.tabs)if(b&&b.classList)b.classList.toggle('on',b.dataset&&b.dataset.style===style);
}
function setKindButtons(){
  if(!el)return;
  for(const b of el.kindTabs)if(b&&b.classList)b.classList.toggle('on',b.dataset&&b.dataset.kind===kind);
}
/** 产物模式：
    · 封面：显示风格子 tab，画布 800×800 正方形；
    · 指纹：隐藏子 tab，画布 1920×400 横向铺满弹窗；
    · 分享卡片：隐藏子 tab（固定用 bricks 调色板），画布 1200×630 横向铺满弹窗。 */
function applyKindLayout(){
  if(!el)return;
  if(el.styles)el.styles.classList.toggle('vz-hide',kind!=='cover');
  if(el.body){
    el.body.classList.toggle('fp',kind==='fingerprint');
    el.body.classList.toggle('sc',kind==='sharecard');
  }
  if(el.card){
    el.card.classList.toggle('fp',kind==='fingerprint');
    el.card.classList.toggle('sc',kind==='sharecard');
  }
  if(el.download){
    el.download.title=(kind==='sharecard')?'导出 1200×630 PNG（高清勾选后 2400×1260）'
                     :(kind==='fingerprint')?'导出 1920×400 PNG（高清勾选后 3840×800）'
                     :'导出 800×800 PNG（高清勾选后 1600×1600）';
  }
  if(el.hd&&el.hd.parentElement)el.hd.parentElement.title=(kind==='sharecard')
    ?'以 2× 分辨率离屏重绘后导出（分享卡片 2400×1260）'
    :'以 2× 分辨率离屏重绘后导出（封面 1600×1600 / 指纹 3840×800）';
  void 0;
}
function setBtnBusy(on){
  if(!el||!el.btn)return;
  el.btn.disabled=!!on;
  if(on)el.btn.dataset.busy='1'; else delete el.btn.dataset.busy;   // 批 A：忙碌时前置旋转弧
  if(el.btnLabel)el.btnLabel.textContent=on?'分析中…':'生成封面';
}

/* ---------- 批 A：产物/风格切换与种子换图的交叉淡入淡出 ----------
   .fadeOut/.fadeIn 的 keyframes 在 theme.css（与渲染器切换共用）；唯一允许的 setTimeout 是 120ms 中间点。 */
let _fadeTimer=0;
function crossFadeCover(mid){
  const body=el&&el.body, cv=el&&el.canvas;
  if(!body||!cv){ mid(); return }
  if(_fadeTimer){ clearTimeout(_fadeTimer); _fadeTimer=0 }        // 连点：旧定时器作废
  cv.classList.remove('fadeIn');
  cv.classList.add('fadeOut');
  body.classList.add('pk');                                       // 外壳 120ms 底闪，遮住"尺寸硬跳"
  _fadeTimer=setTimeout(()=>{
    _fadeTimer=0;
    try{ mid() }finally{
      cv.classList.remove('fadeOut');
      cv.classList.add('fadeIn');
      body.classList.remove('pk');
    }
  },120);
}

/* ---------- 绘制 ---------- */
function render(){
  if(!el||!el.canvas)return null;
  if(!features){ setNote('还没有分析结果'); return null }
  if(rendering)return null;                    // 简单防重入：一次只画一张
  rendering=true;
  const t0=(typeof performance!=='undefined'&&performance.now)?performance.now():0;
  let info=null;
  try{
    const title=titleOf();
    features.title=title;                      // 规格要求：曲名编辑同步到 features.title（cover/fingerprint/sharecard 都会读它）
    if(kind==='sharecard'){
      info=generateShareCard(el.canvas,features,{
        title, seed,
        bpm:bpmOf(),
        shareUrl:shareUrlOf()
      });
    }else if(kind==='fingerprint'){
      info=generateFingerprint(el.canvas,features,seed,{title});
    }else{
      info=generateCover(el.canvas,features,style,seed,{title,showTitle:true});
    }
    const ms=t0?Math.round(((performance.now?performance.now():0)-t0)):0;
    const what=(kind==='sharecard')?'分享卡片':((kind==='fingerprint')?'音乐指纹':(STYLE_LABELS[style]||style));
    setNote(what+' · 种子 '+seed+(ms?(' · '+ms+' ms'):'')+' · '+el.canvas.width+'×'+el.canvas.height+
            (hd?' · 导出将用 2×':''));
  }catch(e){
    setNote('生成失败：'+((e&&e.message)||e));
    console.error('[viz-cover-ui] 生成失败',e);
  }finally{
    rendering=false;
  }
  return info;
}
function setStyle(s){
  if(COVER_STYLES.indexOf(s)<0)return;
  const changing=(s!==style);
  style=s;
  setStyleButtons();
  if(changing)crossFadeCover(()=>render()); else render();
}
function setKind(k){
  if(!KIND_LABELS[k])return;
  const changing=(k!==kind);
  kind=k;
  setKindButtons();
  if(changing)crossFadeCover(()=>{ applyKindLayout(); render() });   // 批 A：宽度与画面一起换，中间点对齐
  else{ applyKindLayout(); render() }
}
function setSeed(n){
  const v=Math.max(0,Math.min(SEED_MAX,Math.round(Number(n)||0)));
  seed=v;
  if(el&&el.seed)el.seed.value=String(v);
  render();
}

/* ---------- 打开 / 关闭 ---------- */
function show(on){
  if(!el||!el.modal)return;
  el.modal.classList.toggle('off',!on);
  if(on){
    setStyleButtons();
    setKindButtons();
    applyKindLayout();
    syncTitleInput();
    /* 打开瞬间先用旧特征画一版（若已有），避免"白框等分析"的观感 */
    if(features)render();
  }
}
function close(){ show(false) }

/** 把当前曲名回填到输入框（用户尚未编辑过时才覆盖，避免打断输入） */
function syncTitleInput(){
  if(!el||!el.title)return;
  if(typeof titleOverride==='string'&&titleOverride.length)return;
  el.title.value=String((typeof hooks.getTitle==='function'?hooks.getTitle():null)||'未命名工程');
}

async function ensureFeatures(){
  if(features)return features;                        // 本次会话已拿到特征 → 直接复用（第二次点击不重复分析）
  const cached=(typeof hooks.getFeatures==='function')?hooks.getFeatures():null;
  if(cached){ features=cached; return cached }        // 入口已有分析结果（例如先在 Console 里跑过 analyze）→ 不重复分析
  if(typeof hooks.ensureFeatures!=='function'){ setNote('封面功能未接线（缺少 ensureFeatures 钩子）'); return null }
  setBtnBusy(true);
  setNote('正在分析整曲（首次较慢，可用底部取消按钮中止）…');
  try{
    /* forceFull：封面是"整曲肖像"，不足整曲时由入口静默做全曲重渲染，不再弹确认框 */
    const f=await hooks.ensureFeatures({forceFull:true});
    if(!f){ setNote('没有可用的分析结果（已取消或工程为空）'); return null }
    features=f;
    return f;
  }catch(e){
    setNote('分析失败：'+((e&&e.message)||e));
    console.error('[viz-cover-ui] 分析失败',e);
    return null;
  }finally{
    setBtnBusy(false);
  }
}

async function open(){
  if(!el)return;
  /* 已有特征：立刻开模态并重绘；没有特征：先分析（进度在底部工具条），**分析完才显示模态** */
  if(features){
    show(true);
    render();
    return;
  }
  const f=await ensureFeatures();
  show(true);
  if(f)render();
}

/** 换工程/重新渲染后清掉封面用的特征缓存（T5 会调用；Console 里也可用 __vzCoverUI.invalidate()） */
export function invalidateCoverFeatures(){ features=null }

/* ---------- 下载（支持 2× 离屏导出） ---------- */
/** 导出用的画布：勾了高清（或本次强制 2×）就用离屏画布以 scale=2 重绘（不动预览），否则直接用预览画布 */
function exportCanvas(force2x){
  const scale=(hd||force2x)?2:1;
  if(scale===1||typeof document==='undefined'||typeof document.createElement!=='function')return el.canvas;
  const off=document.createElement('canvas');
  try{
    if(kind==='sharecard')generateShareCard(off,features,{scale:2,title:titleOf(),seed,bpm:bpmOf(),shareUrl:shareUrlOf()});
    else if(kind==='fingerprint')generateFingerprint(off,features,seed,{scale:2,title:titleOf()});
    else generateCover(off,features,style,seed,{scale:2,title:titleOf()});
    return off;
  }catch(e){
    console.warn('[viz-cover-ui] 2× 重绘失败，回退 1× 导出',e);
    return el.canvas;
  }
}
function download(force2x){
  if(!el||!el.canvas){ setNote('还没有可下载的画布'); return }
  if(!features){ setNote('还没有分析结果，无法导出'); return }
  const name=safeName(titleOf())+(kind==='sharecard'?'-sharecard.png'
              :(kind==='fingerprint'?'-fingerprint.png':('-cover-'+style+'.png')));
  const src=exportCanvas(force2x);
  try{
    src.toBlob(blob=>{
      if(!blob){ setNote('导出失败：toBlob 返回空'); return }
      downloadBlob(blob,name);
      setNote('已导出 '+src.width+'×'+src.height+' · '+name);
    },'image/png');
  }catch(e){
    setNote('导出失败：'+((e&&e.message)||e));
    console.error('[viz-cover-ui] 导出失败',e);
  }
}
/* ---------- 下载选项菜单（批 B 任务 8）：2× 高清与"以 2× 下载"从控件行收进头部 ▾ 菜单 ---------- */
let dlOpen=false;
function setDlMenu(on){
  if(!el||!el.dlMenu)return;
  dlOpen=!!on;
  el.dlMenu.classList.toggle('open',dlOpen);
  if(el.dlMore)el.dlMore.setAttribute('aria-expanded',dlOpen?'true':'false');
}
function closeDlMenu(){ if(dlOpen)setDlMenu(false) }

/* =========================================================================
   绑定（boot 里调用一次；重复调用只生效一次）
   ========================================================================= */
/**
 * @param {{ensureFeatures?:Function,getFeatures?:Function,getTitle?:Function}} [h]
 *        ensureFeatures：走 T2 的分析入口（返回 FeatureObject 或 null）
 *        getFeatures：读入口缓存的 FeatureObject（有值就不再分析）
 *        getTitle：工程名
 * @returns {object|null} DOM 句柄集合（页面缺少按钮/弹窗时返回 null 并打一条提示，不抛异常）
 */
export function bindCoverUI(h){
  if(h)hooks=h;
  if(el)return el;
  const btn=$('#vzCoverBtn'), modal=$('#vzCoverModal');
  if(!btn||!modal){
    console.warn('[viz-cover-ui] 未接线：页面缺少 #vzCoverBtn 或 #vzCoverModal');   // 页面结构被破坏才出现，属必要告警
    return null;
  }
  el={
    btn, modal,
    btnLabel:btn.querySelector?btn.querySelector('span.vz-btn-txt'):null,
    btnIco:$('#vzCoverIco'),
    card:modal.querySelector?modal.querySelector('.vz-cover-card'):null,
    canvas:$('#vzCoverCanvas'),
    body:$('#vzCoverBody'),
    styles:$('#vzCoverStyles'),
    note:$('#vzCoverNote'),
    title:$('#vzCoverTitle'),
    seed:$('#vzCoverSeed'),
    hd:$('#vzCoverHd'),
    shuffle:$('#vzCoverShuffle'),
    download:$('#vzCoverDownload'),
    dlMore:$('#vzDlMore'),
    dlMenu:$('#vzDlMenu'),
    dl2x:$('#vzDl2x'),
    close:$('#vzCoverClose'),
    kindTabs:(modal.querySelectorAll?Array.from(modal.querySelectorAll('.vz-cover-kinds button')):[]),
    tabs:(modal.querySelectorAll?Array.from(modal.querySelectorAll('.vz-cover-tabs button')):[])
  };
  /* 图标：探测通过就用 emoji，否则用几何符号（Windows 上 emoji 缺字形时不会出现方块） */
  icon=(AUTO_ICON&&emojiSupported(ICON))?ICON:ICON_FALLBACK;
  if(el.btnIco)el.btnIco.textContent=icon;
  applyKindLayout();
  btn.addEventListener('click',()=>{ void open() });
  if(el.close)el.close.addEventListener('click',()=>close());
  if(el.modal)el.modal.addEventListener('click',e=>{ if(e.target===el.modal)close() });   // 点遮罩空白处即关闭
  for(const b of el.kindTabs)b.addEventListener('click',()=>setKind(b.dataset&&b.dataset.kind));
  for(const b of el.tabs)b.addEventListener('click',()=>setStyle(b.dataset&&b.dataset.style));
  if(el.shuffle)el.shuffle.addEventListener('click',()=>setSeed((Math.random()*SEED_MAX)|0));
  if(el.hd)el.hd.addEventListener('change',()=>{ hd=!!el.hd.checked; render() });
  if(el.title){
    syncTitleInput();
    const onTitle=()=>{ titleOverride=String(el.title.value||''); if(features)render() };   // 只影响出图，不写 proj.name
    el.title.addEventListener('input',onTitle);
    el.title.addEventListener('change',onTitle);
  }
  if(el.seed){
    if(el.seed.value)seed=Math.max(0,Math.round(Number(el.seed.value)||1));
    el.seed.addEventListener('change',()=>setSeed(el.seed.value));
  }
  if(el.download)el.download.addEventListener('click',()=>download());
  /* 下载选项菜单（批 B 任务 8）：▾ 开关；「以 2× 下载」= 临时 2× 导出一次，不改变上面的勾选状态 */
  if(el.dlMore)el.dlMore.addEventListener('click',e=>{ e.stopPropagation(); setDlMenu(!dlOpen) });
  if(el.dl2x)el.dl2x.addEventListener('click',()=>{ setDlMenu(false); download(true) });
  if(document.addEventListener)document.addEventListener('pointerdown',e=>{
    if(!dlOpen)return;
    if((el.dlMenu&&el.dlMenu.contains(e.target))||(el.dlMore&&el.dlMore.contains(e.target)))return;
    setDlMenu(false);
  });
  /* .fadeIn 播完摘类（省一个定时器），下次再加即可重播 */
  if(el.canvas)el.canvas.addEventListener('animationend',e=>{ if(e.animationName==='fadeIn')el.canvas.classList.remove('fadeIn') });
  /* Esc 关闭：用捕获阶段抢在 main.js 的"Esc=停止播放"之前。
     优先级：先收下载菜单 → 再关弹窗（菜单开着时按 Esc 不应该把弹窗一起关掉）。 */
  window.addEventListener('keydown',e=>{
    if(e.key!=='Escape'||!isOpen())return;
    e.preventDefault(); e.stopPropagation();
    if(dlOpen){ setDlMenu(false); return }
    close();
  },true);
  return el;
}

/* 自检句柄：Console 里可直接 __vzCoverUI.open() / setStyle('bricks') / download() */
if(typeof window!=='undefined'){
  window.__vzCoverUI={
    open,close,render,setStyle,setKind,setSeed,download,invalidate:invalidateCoverFeatures,
    setTitle:(t)=>{ titleOverride=String(t==null?'':t); if(el&&el.title)el.title.value=titleOverride; if(features)render() },
    setHd:(v)=>{ hd=!!v; if(el&&el.hd)el.hd.checked=hd; render() },
    get state(){ return {bound:!!el,open:isOpen(),kind,style,seed,hd,icon,title:titleOf(),
                         hasFeatures:!!features,
                         featuresTitle:features?features.title:null,
                         featuresFrames:features&&features.stats?features.stats.frames:0,
                         size:el&&el.canvas?el.canvas.width+'x'+el.canvas.height:null,
                         styleTabsHidden:!!(el&&el.styles&&el.styles.classList.contains('vz-hide'))} }
  };
}
