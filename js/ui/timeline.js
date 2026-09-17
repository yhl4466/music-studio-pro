/* [timeline.js] source: Pro.html 1679-2134, 2135-2142, 2148-2299, 2827-2912, 3230-3396, 3423-3428, 4721-4722
   （时间线渲染/缓存/画格/选区/节奏细分/量化/缩放；find 见 STEP 0 计划） */
import { proj, uiZoom, setUiZoom, uiTab, selTrack, stepsPerQuarter, stepsPerBeat, meterN, meterD, SPB, beatSteps, stepWidth, effStepWidth, ensurePatSizes, pruneTrackPrec, patRows, allocPat, rowMidi, actx, A, MAX_BARS, ZOOM_MIN, CELL_MIN_PX, FIT_MIN_LONG } from '../core/state.js';
import { KIT, MEL_ROWS, NOTE_NAMES, ROLES, noteNameOf, trackRows, octRowsOf, PREC_U_PER_STEP } from '../core/theory.js';
import { $, $$, el, clamp, toast, debounce, UI, hooks } from '../core/util.js';
import { KIT_COLORS, drumVoice } from '../audio/drum.js';
import { auditionTrack } from '../audio/synth.js';
import { ensureAudio, setGate } from '../audio/master.js';
import { Play, rebuildEvents } from '../audio/engine.js';
import { beginEdit, commitEdit, markDirtyUI } from '../io/project.js';

/* 把池内一个格子从步 so 挪到步 sn：同步 cols/cells 索引（O(1)，避免整体重建） */
function reindexMove(c,ti,r,cell,so,sn){
  const tm=c.cells&&c.cells[ti];
  if(tm&&tm[r]){
    if(so>=0&&so<tm[r].length&&tm[r][so]===cell)tm[r][so]=undefined;
    if(sn>=0&&sn<tm[r].length)tm[r][sn]=cell;
  }
  const cols=c.cols&&c.cols[ti];
  if(cols){
    if(so>=0&&so<cols.length&&cols[so]){
      const a=cols[so],k=a.indexOf(cell);
      if(k>=0)a.splice(k,1);
    }
    if(sn>=0&&sn<cols.length)cols[sn].push(cell);
  }
}
/* 窗口整体滑动 k 列：**在 .pc 之间搬移 DOM 节点**（.lab 与偏移占位元素永不移动）
   右侧：最左 k 列搬到队尾；左侧：最右 k 列插到队首。槽位顺序 = DOM 顺序。 */
function rotateWindow(k){
  const c=proj._uiCache;if(!c||!c.win||!c.poolRows)return;
  k=Math.trunc(k)||0;
  const n=c.win.n,from=c.win.from;
  if(!k||Math.abs(k)>=n){resetWindow(from+k,n);return}
  const kk=Math.abs(k),right=k>0;
  proj.tracks.forEach((t,ti)=>{
    const rows=patRows(t);
    const rowEls=c.poolRowEls[ti]||[];
    for(let r=0;r<rows;r++){
      const pool=c.poolRows[ti]&&c.poolRows[ti][r];
      const row=rowEls[r];
      if(!pool||!row)continue;
      if(right){
        const moved=pool.splice(0,kk);
        for(const cell of moved)row.appendChild(cell); // 只搬 .pc，偏移占位元素留在原处
        pool.push.apply(pool,moved);
        for(let i=0;i<moved.length;i++){
          const so=from+i,sn=from+n+i;
          reindexMove(c,ti,r,moved[i],so,sn);tagCell(moved[i],ti,r,sn);
        }
      }else{
        const moved=pool.splice(n-kk,kk);
        const anchor=pool[0]||null;
        for(let i=0;i<moved.length;i++)row.insertBefore(moved[i],anchor); // 插到队首（占位元素之后）
        pool.unshift.apply(pool,moved);
        for(let i=0;i<moved.length;i++){
          const so=from+n-kk+i,sn=from-kk+i;
          reindexMove(c,ti,r,moved[i],so,sn);tagCell(moved[i],ti,r,sn);
        }
      }
    }
  });
  const ruler=UI.ruler;
  if(ruler&&c.rulerCells){
    const pool=c.rulerCells;
    if(right){
      const moved=pool.splice(0,kk);
      for(const cell of moved)ruler.appendChild(cell);
      pool.push.apply(pool,moved);
      for(let i=0;i<moved.length;i++)tagRulerCell(moved[i],from+n+i);
    }else{
      const moved=pool.splice(n-kk,kk);
      const anchor=pool[0]||null;
      for(let i=0;i<moved.length;i++)ruler.insertBefore(moved[i],anchor);
      pool.unshift.apply(pool,moved);
      for(let i=0;i<moved.length;i++)tagRulerCell(moved[i],from-kk+i);
    }
  }
  c.win.from=from+k;
  setPoolVars(c.win.from,n); // 单点写入：83 行模板不再逐个重写
}
/* 大跨度跳转：不搬节点，只把池内每个格子重新贴到新窗口的步号上 */
function resetWindow(from,n){
  const c=proj._uiCache;if(!c||!c.poolRows)return;
  proj.tracks.forEach((t,ti)=>{
    const rows=patRows(t);
    for(let r=0;r<rows;r++){
      const pool=c.poolRows[ti]&&c.poolRows[ti][r];
      if(!pool)continue;
      for(let i=0;i<pool.length;i++)tagCell(pool[i],ti,r,from+i);
    }
  });
  const ruler=UI.ruler;
  if(ruler&&c.rulerCells)for(let i=0;i<c.rulerCells.length;i++)tagRulerCell(c.rulerCells[i],from+i);
  setWindowIndex(c,from,n);
  setPoolVars(from,n);
}
/* 池列数变化（视口宽/缩放变化）：只增删 .pc/.rs 节点，tgroup/thead/lab 结构完全不动、min-width 不动 */
function reshapePool(n){
  const c=proj._uiCache;
  if(!c||!c.win||!c.poolRows)return false;
  const cw=effStepWidth()||CELL_MIN_PX;
  const inner=$('#tlInner');
  if(inner)inner.style.setProperty('--cw',cw+'px');
  let from=windowFrom(n);
  proj.tracks.forEach((t,ti)=>{
    const rows=patRows(t);
    for(let r=0;r<rows;r++){
      const pool=c.poolRows[ti]&&c.poolRows[ti][r];
      const row=(c.poolRowEls[ti]||[])[r];
      if(!pool||!row)continue;
      if(n>pool.length){ // 增列：新格子追加到行尾（.lab 与偏移占位元素始终在最前，不动）
        for(let i=pool.length;i<n;i++){
          const cell=makeCell(ti,r,from+i);
          pool.push(cell);row.appendChild(cell);
        }
      }else if(n<pool.length){ // 减列：从队尾回收节点
        const drop=pool.splice(n,pool.length-n);
        drop.forEach(cell=>{try{cell.remove()}catch(e){}});
      }else{
        for(let i=0;i<pool.length;i++){ // 列数不变但起点可能变
          if(pool[i]._s!==from+i)tagCell(pool[i],ti,r,from+i);
        }
      }
    }
  });
  const ruler=UI.ruler;
  if(ruler&&c.rulerCells){
    if(n>c.rulerCells.length){
      for(let i=c.rulerCells.length;i<n;i++){
        const cell=el('div','rs'+stepClass(from+i));
        cell.dataset.s=from+i;cell._s=from+i;
        if((from+i)%SPB()===0)cell.innerHTML='<span>'+((from+i)/SPB()+1)+'</span>';
        c.rulerCells.push(cell);ruler.appendChild(cell);
      }
    }else if(n<c.rulerCells.length){
      const drop=c.rulerCells.splice(n,c.rulerCells.length-n);
      drop.forEach(cell=>{try{cell.remove()}catch(e){}});
    }
  }
  c.win.n=n;c.win.cw=cw;c.win.viewW=measuredViewW();
  setWindowIndex(c,from,n);
  setPoolVars(from,n,cw);
  try{paintRegionUI()}catch(e){}
  try{markRhythmUI()}catch(e){}
  try{hooks.seek?.updateSeekUI?.(Play.step)}catch(e){}
  return true;
}
/* 缩放：只改 CSS 变量 --cw + 池列数重塑（不再整体重建 trackList），并保持播放头的视觉锚点 */
function applyZoomCw(){
  const c=proj._uiCache,tl=tlEl();
  if(!c||!c.win)return false;
  const cwOld=c.win.cw||effStepWidth();
  const anchor=cwOld?((tl&&tl.scrollLeft?tl.scrollLeft:0)/cwOld):0;
  const cwNew=effStepWidth()||CELL_MIN_PX;
  const inner=$('#tlInner');
  if(inner)inner.style.setProperty('--cw',cwNew+'px');
  const n=poolColsFor(measuredViewW(),cwNew);
  c.win.cw=cwNew;
  if(!reshapePool(n))return false;
  if(tl)tl.scrollLeft=Math.max(0,Math.round(anchor*cwNew));
  syncWindowNow(true);
  return true;
}
function tagRulerCell(cell,s){
  cell.dataset.s=s;
  cell.className='rs'+stepClass(s);
  cell.innerHTML=s%SPB()===0?'<span>'+(s/SPB()+1)+'</span>':'';
}
export function syncWindowNow(force){
  if(!VIRTUAL)return;
  const c=proj._uiCache;
  if(!c||!c.win||!c.win.n)return;
  const cw=effStepWidth()||CELL_MIN_PX;
  if(c.win.cw!==cw){applyZoomCw();return}       // 格子宽度变了（缩放）→ 只重塑池，不重建结构
  const n=poolCols();
  if(c.win.n!==n){                              // 池列数变化（真实 resize，带滞回）→ 只增删格子
    if(!reshapePool(n)){structural(true);return}
  }
  const nf=windowFrom(n);
  if(!force&&nf===c.win.from)return;
  const d=nf-c.win.from;
  if(Math.abs(d)<=Math.floor(n/2))rotateWindow(d); // 小跨度：order 复用池（零节点搬移）
  else resetWindow(nf,n);                          // 大跨度（拖滚动条/跳转）：原地重贴步号
  c.win.from=nf;c.win.n=n;c.win.cw=cw;
  if(!c.win.viewW)c.win.viewW=measuredViewW();
  setPoolVars(nf,n);
  try{paintRegionUI()}catch(e){}
  // 格子状态已由 applyCell 增量重贴（含清旧 tribar 标记），这里只需按 prec 重贴细分标记
  try{markRhythmUI()}catch(e){}
  try{hooks.seek?.updateSeekUI?.(Play.step)}catch(e){}
}
let _winRaf=0,_winBound=false;
function bindWindowScroll(){
  if(_winBound||!VIRTUAL)return;
  const tl=tlEl();if(!tl)return;
  _winBound=true;
  const kick=force=>{
    if(_winRaf)return;
    _winRaf=requestAnimationFrame(()=>{_winRaf=0;syncWindowNow(!!force)}); // 一帧最多一次窗口同步
  };
  tl.addEventListener('scroll',()=>kick(false),{passive:true});
  window.addEventListener('resize',()=>kick(true));
}
/* =========================================================================
   长曲虚拟滚动（FEAT-3a）：只渲染视口窗口内的列
   —— VIRTUAL=true ：.pc / .rs 按“窗口池”复用节点，长曲不再建十几万节点；
                    滚动用 requestAnimationFrame 合并，一帧最多一次窗口同步；
   —— VIRTUAL=false：回到旧的全量建格路径（一行常量即可回退）。
   ========================================================================= */
export const VIRTUAL=true;
const WIN_BUF=32;   // 视口左右各预留的列数（避免快速滚动白屏）
const WIN_SHIFT=16; // 每次窗口滑动的最小列数（块对齐，减少重排次数）
const POOL_W_TOL=24;// 视口宽变化小于该值视为滚动条抖动，不触发池重塑
function tlEl(){return document.getElementById('timeline')}
function measuredViewW(){
  const tl=tlEl();
  return (tl&&tl.clientWidth)?tl.clientWidth:((typeof window!=='undefined'&&window.innerWidth)||1200);
}
function viewColsFor(w,cw){return Math.max(8,Math.ceil(w/cw)+2)}
function poolColsFor(w,cw){return Math.max(1,Math.min(proj.steps,viewColsFor(w,cw)+2*WIN_BUF))}
function poolCols(){ // 池列数：视口宽用“滞回”取值，滚动条出现/消失造成的 ±20px 抖动不触发重塑
  const c=proj._uiCache, cw=effStepWidth()||CELL_MIN_PX;
  let w=measuredViewW();
  if(c&&c.win&&c.win.viewW&&Math.abs(w-c.win.viewW)<=POOL_W_TOL)w=c.win.viewW;
  return poolColsFor(w,cw);
}
function windowFrom(pool){ // 窗口起点（0 … steps-pool），带左侧缓冲；按 WIN_SHIFT 列对齐以减少重排
  const tl=tlEl();
  const cw=effStepWidth()||CELL_MIN_PX;
  const sc=(tl&&tl.scrollLeft)?tl.scrollLeft:0;
  const n=pool||poolCols();
  let from=Math.floor(sc/cw)-WIN_BUF;
  from=Math.floor(from/WIN_SHIFT)*WIN_SHIFT;
  from=Math.max(0,Math.min(from,Math.max(0,proj.steps-n)));
  return from;
}
/* 池偏移/池宽改成 #tlInner 上的 CSS 变量：滚动时只写 1~2 个变量，
   行的 grid-template-columns 字符串恒定不变（→ 不再每行重写、不再触发整片重排） */
const ROW_TPL='var(--labW) var(--poolOff) repeat(var(--poolN), var(--cw))';
const RULER_TPL='calc(var(--labW) + 5px) var(--poolOff) repeat(var(--poolN), var(--cw))';
function rowTemplate(win){return ROW_TPL}
function rulerTemplate(win){return RULER_TPL}
function setPoolVars(from,n,cw){
  const inner=$('#tlInner');if(!inner)return;
  const c=effStepWidth();
  inner.style.setProperty('--poolOff',((from||0)*(cw||c))+'px');
  inner.style.setProperty('--poolN',String(n));
}
function stepClass(s){return s%SPB()===0?' bar':(s%beatSteps()===0?' beat':'')}
function glowStepNow(){ // 当前“已点亮”的播放列（未点亮返回 -1）
  try{const g=hooks.seek?.glowCol?.();return (g==null?-1:g)}catch(e){return -1}
}
/* 一个格子的全部可视状态（增量：步号没变且标记未置位时不做任何 DOM 写入） */
function applyCell(cell,ti,r,s){
  const t=proj.tracks[ti];if(!t||!cell)return;
  const v=(t.pat[s]&&t.pat[s][r])||0;
  const on=v>0,velH=v>=.85;
  if(cell.classList.contains('on')!==on)cell.classList.toggle('on',on);
  if(cell.classList.contains('velH')!==velH)cell.classList.toggle('velH',velH);
  if(cell._mk){cell.classList.remove('tribar');cell.style.removeProperty('--tx');cell.style.removeProperty('--tw');cell._mk=0}
  const bar=s%SPB()===0,beat=!bar&&(s%beatSteps()===0);
  if(cell.classList.contains('bar')!==bar)cell.classList.toggle('bar',bar);
  if(cell.classList.contains('beat')!==beat)cell.classList.toggle('beat',beat);
  const inSel=!!(regionSel&&regionSel.ti===ti&&s>=regionSel.from&&s<=regionSel.to);
  if(cell.classList.contains('sel')!==inSel)cell.classList.toggle('sel',inSel);
  const lit=glowStepNow()===s;
  if(cell.classList.contains('playCol')!==lit)cell.classList.toggle('playCol',lit);
}
function tagCell(cell,ti,r,s){
  if(cell._s===s&&cell._ti===ti&&cell._r===r)return;
  cell._s=s;cell._ti=ti;cell._r=r;
  cell.dataset.ti=ti;cell.dataset.r=r;cell.dataset.s=s;
  applyCell(cell,ti,r,s);
}
/* 新建一个格子（只有此路径会创建 .pc 节点） */
function makeCell(ti,r,s){
  const c=el('div','pc'+stepClass(s));
  c.dataset.ti=ti;c.dataset.r=r;c.dataset.s=s;
  c._s=s;c._ti=ti;c._r=r;
  applyCell(c,ti,r,s);
  return c;
}
/* 窗口池内的索引重建（cols / cells 只用窗口内的步，其它步保持空数组，旧读取方自动成为空操作） */
function setWindowIndex(c,from,n){
  const steps=proj.steps;
  c.cols=proj.tracks.map(()=>Array.from({length:steps},()=>[]));
  c.cells=[];
  proj.tracks.forEach((t,ti)=>{
    const rows=patRows(t);
    const tm=Array.from({length:rows},()=>new Array(steps));
    const pool=(c.poolRows&&c.poolRows[ti])||[];
    for(let r=0;r<rows;r++){
      const arr=pool[r];if(!arr)continue;
      for(let i=0;i<arr.length;i++){
        const s=from+i;if(s<0||s>=steps)continue;
        tm[r][s]=arr[i];
        c.cols[ti][s].push(arr[i]);
      }
    }
    c.cells.push(tm);
  });
}
export function zoomLabel(z){return Math.round(z*100)+'%'}
/* 缩放按钮/标签的 UI 同步（不含重绘） */
function syncZoomUI(){
  const v=document.getElementById('zoomV');
  if(v){v.textContent=zoomLabel(uiZoom);v.title='每个格子约 '+effStepWidth()+'px · Ctrl+滚轮/Ctrl± 快速缩放';}
  const o=document.getElementById('zoomOut'),i=document.getElementById('zoomIn');
  if(o)o.disabled=uiZoom<=ZOOM_MIN;
  if(i)i.disabled=uiZoom>=8;
}
export function setZoomUI(z,noRender){
  setUiZoom(clamp(z,ZOOM_MIN,8));
  syncZoomUI();
  if(noRender)return; // 调用方自行统一重绘（避免长曲下重复 structural）
  if(VIRTUAL&&proj._uiCache&&proj._uiCache.win)applyZoomCw(); // 缩放只重塑池 + 改 CSS 变量，不再整体重建
  else structural(true);
  try{hooks.seek?.updateSeekUI?.(Play.step)}catch(e){}
}
export function zoomAround(z){ // z: 目标倍率
  const tl=document.getElementById('timeline');
  const keep=(tl&&proj._uiCache&&proj._uiCache.cols)?(tl.scrollLeft/ (effStepWidth()||1)):0;
  setZoomUI(z);
  if(tl&&keep)tl.scrollLeft=keep*effStepWidth();
}
/* 曲长变长后的“自动适配”：只缩小、不放大，保持用户手动放大过的视图
   —— ≥64 小节起改为横向滚动 + 虚拟渲染，不再自动缩到“全屏可见”，只保证不低于 50% */
export function autoFitZoom(){
  const tl=document.getElementById('timeline');
  if(!tl||!proj.steps)return;
  const bars=proj.steps/Math.max(1,SPB());
  if(bars>=64){
    if(uiZoom<FIT_MIN_LONG)setZoomUI(FIT_MIN_LONG,true);
    return;
  }
  const base=stepWidth();
  const avail=Math.max(200,tl.clientWidth-40); // 与 zoomFitWindow 同一口径（去除左右留白）
  const w=Math.max(CELL_MIN_PX,Math.floor(avail/proj.steps)); // 整曲可见所需每格像素
  if(w>=base)return; // 本来就装得下 → 不动
  setZoomUI(w/base,true); // 只改缩放值，由调用方 structural 统一重绘
}
/* ⤢适配：<64 小节缩到全屏可见；≥64 小节只保证不低于 50%（横向滚动查看） */
export function zoomFitWindow(){
  const tl=document.getElementById('timeline');
  if(!tl||!proj.steps)return;
  const bars=proj.steps/Math.max(1,SPB());
  const avail=Math.max(200,tl.clientWidth-40); // 除去左右留白/标签列后可用宽度
  const base=stepWidth()*proj.steps;
  let z=base>0?avail/base:1;
  if(bars>=64)z=Math.max(z,FIT_MIN_LONG);
  z=clamp(z,ZOOM_MIN,8);
  setZoomUI(z);
}
/* 重新渲染整个时间线结构 */
export function structural(full){
  ensurePatSizes();
  const S=proj.steps, cw=effStepWidth();
  const inner=$('#tlInner');
  inner.style.setProperty('--cw',cw+'px');
  inner.style.setProperty('--stepsN',S);
  // 虚拟路径：显式撑出整曲滚动宽度（窗口池只有一屏多宽，不再靠内容撑宽）
  // 用 CSS 变量表达 → 只写一次字符串，缩放/滚动都不再改它（消除宽度抖动导致的布局偏移）
  if(VIRTUAL)inner.style.minWidth='calc(var(--labW) + var(--stepsN) * var(--cw) + 32px)';
  else inner.style.removeProperty('min-width');
  // 行名（左侧 .lab）依赖：调性/调式/基音八度 + 每轨 shift/keyOct/行数；缓存 rev 只覆盖前者
  const labSig=proj.key+'|'+proj.mode+'|'+proj.keyOct+'|'+proj.tracks.map(t=>(t.shift||0)+','+(t.keyOct||0)+','+patRows(t)).join(';');
  if(full||!proj._uiCache||proj._uiCache.steps!==S||proj._uiCache.rev!==(proj.tracks.length+'-'+proj.mode+'-'+proj.key+'-'+proj.keyOct)){
    /* 修复 Bug 2 的保险（方案 B）：重建缓存/行池之前先把旧 DOM 上的 playCol 清干净。
       必须放在替换 proj._uiCache 之前 —— clearStepGlow() 需要读的还是旧缓存里的 cols。 */
    try{hooks.seek?.clearStepGlow?.()}catch(e){}
    proj._uiCache={steps:S,rev:proj.tracks.length+'-'+proj.mode+'-'+proj.key+'-'+proj.keyOct,labSig};
    const _n=VIRTUAL?poolCols():0;
    const _from=VIRTUAL?windowFrom(_n):0;
    proj._uiCache.win=VIRTUAL?{from:_from,n:_n,cw:effStepWidth(),viewW:measuredViewW()}:null;
    if(VIRTUAL)setPoolVars(_from,_n,cw); // 先写池变量，行模板随即生效
    renderRuler();
    renderTrackList();
    buildCaches();
    paintAll();
    refreshEmpty();
    rebuildEvents();
  }else{
    paintAll();
    // 行名 DOM 刷新（原版漏调用 relabelRows：改调性/音区后左侧音名会留旧值）
    if(proj._uiCache.labSig!==labSig){ proj._uiCache.labSig=labSig; relabelRows(); }
  }
  bindWindowScroll();
  try{hooks.seek?.updateSeekUI?.(Play.step)}catch(e){}
  try{paintRegionUI()}catch(e){} // 重建后恢复“选区”高亮
  try{refreshRhythmMarkers()}catch(e){} // 重建后同步节奏细分标记
}
export function refreshEmpty(){
  UI.emptyTip.classList.toggle('hidden',proj.tracks.length>0);
}
export function renderRuler(){
  const S=proj.steps;
  const r=UI.ruler;r.innerHTML='';
  const win=VIRTUAL&&proj._uiCache?proj._uiCache.win:null;
  const from=win?win.from:0, to=win?(win.from+win.n):S;
  // 轨道内容因组边框(1px)+左侧色条(4px)整体右移 5px，标尺补上同样的偏移保持列对齐
  r.style.gridTemplateColumns=win?rulerTemplate(win):'calc(var(--labW) + 5px) repeat(var(--stepsN), var(--cw))';
  const sp=el('div','rl','');
  r.appendChild(sp);
  if(win)r.appendChild(el('div','')); // 与行同理：占住标尺的偏移轨道，避免整条标尺左移一列
  if(win)proj._uiCache.rulerCells=[];
  for(let s=from;s<to;s++){
    const c=el('div', s%SPB()===0?'rs bar':(s%beatSteps()===0?'rs beat':'rs plain'));
    if(s%SPB()===0)c.innerHTML='<span>'+(s/SPB()+1)+'</span>';
    if(win){c.dataset.s=s;proj._uiCache.rulerCells.push(c)}
    r.appendChild(c);
  }
}
export function renderTrackList(){
  const list=UI.trackList;list.innerHTML='';
  proj.tracks.forEach((t,ti)=>buildTrackGroup(t,ti,list));
}
/* 单条音轨的整组 DOM（表头 + 各行格子）。抽成独立函数供同步/分块两条路径共用 */
export function buildTrackGroup(t,ti,list){
  {
    const win=VIRTUAL&&proj._uiCache?proj._uiCache.win:null;
    const from=win?win.from:0, to=win?(win.from+win.n):proj.steps;
    const grp=el('div','tgroup');grp.dataset.ti=ti;
    const col=el('div','tgColor');col.style.background=t.color;
    grp.appendChild(col);
    const main=el('div','tgMain');
    // ---- 表头（左侧信息横向冻结）----
    const head=el('div','thead'+(ti===proj.sel?' sel':''));
    const headLeft=el('div','theadLeft');head.appendChild(headLeft);
    const R=ROLES[t.role]||ROLES.custom;
    const colArrow=el('span','collapse','▾');
    colArrow.title=t.collapsed?'展开':'折叠';
    colArrow.addEventListener('click',ev=>{
      ev.stopPropagation();
      t.collapsed=!t.collapsed;
      grp.classList.toggle('closed',t.collapsed);
      colArrow.title=t.collapsed?'展开':'折叠';
      if(!t.collapsed){ // 懒加载：展开时才补建格点行
        const bd=grp.querySelector('.tgBody');
        if(bd&&!bd.children.length){structural(true)}
      }
    });
    headLeft.appendChild(colArrow);
    const ico=el('div','tgIcon',R.icon);ico.style.background=t.color+'33';ico.style.color=t.color;
    headLeft.appendChild(ico);
    const nm=el('input','tname');nm.value=t.name;nm.title=t.name;
    nm.addEventListener('focus',e=>e.stopPropagation());
    nm.addEventListener('click',e=>e.stopPropagation()); // 编辑名称时别触发“选中切页”
    nm.addEventListener('change',()=>{t.name=nm.value||t.name;nm.value=t.name;nm.title=t.name;markDirtyUI()});
    headLeft.appendChild(nm);
    const tag=el('span','roleTag',t.kind==='drum'?'鼓组':'· '+(R.name));
    tag.style.color=t.color;tag.style.borderColor=t.color+'55';
    headLeft.appendChild(tag);
    headLeft.appendChild(el('span','tag-mini','#'+String(ti+1).padStart(2,'0')));
    head.appendChild(el('div','',{style:'flex:1'}));
    if(t.kind==='mel'){
      const sh=el('div','tgShift');
      const octv=el('span','octv',(t.shift>=0?'+':'')+t.shift+'st');
      const bm=el('button','hchip','−');bm.title='音区下移';
      const bp=el('button','hchip','+');bp.title='音区上移';
      bm.addEventListener('click',ev=>{ev.stopPropagation();changeShift(ti,-1)});
      bp.addEventListener('click',ev=>{ev.stopPropagation();changeShift(ti,1)});
      sh.appendChild(bm);sh.appendChild(octv);sh.appendChild(bp);
      head.appendChild(sh);
    }
    const tgFill=el('div','tgFill');
    const M=el('button','hchip'+(t.mute?' on':''),'M');
    M.addEventListener('click',ev=>{ev.stopPropagation();t.mute=!t.mute;M.classList.toggle('on',t.mute);markDirtyUI()});
    const So=el('button','hchip solo'+(t.solo?' solo on':''),'S');
    So.addEventListener('click',ev=>{ev.stopPropagation();t.solo=!t.solo;So.classList.toggle('on',t.solo);markDirtyUI()});
    tgFill.appendChild(M);tgFill.appendChild(So);
    head.appendChild(tgFill);
    head.addEventListener('click',()=>{
      proj.sel=ti;
      structural(true);
      if(uiTab!=='track')hooks.inspector?.selectTab?.('track'); // 点哪条轨就看到它的混音/编辑面板
      else hooks.inspector?.render?.();
    });
    main.appendChild(head);
    // ---- 琴键行（折叠轨不建 DOM，节省大量节点；展开时懒重建） ----
    const body=el('div','tgBody');
    body.classList.add(t.kind==='mel'?'mel':'drum');
    if(!t.collapsed){
      const rows=patRows(t);
      for(let r=0;r<rows;r++){
        const row=el('div','row'+(t.kind==='mel'?' melRowH':' drumRowH'));
        row.style.gridTemplateColumns=win?rowTemplate(win):'var(--labW) repeat(var(--stepsN), var(--cw))';
        row.style.setProperty('--tc',t.kind==='drum'?KIT_COLORS[r]:t.color);
        const lab=el('div','lab'+(t.kind==='mel'&&r%7===0?' root':''));
        if(t.kind==='drum'){
          const k=KIT[r];
          lab.innerHTML='<span style="color:'+KIT_COLORS[r]+'">'+k.icon+'</span>'+k.name;
        }else{
          lab.innerHTML=noteNameOf(rowMidi(t,r));
        }
        lab.addEventListener('click',()=>{
          if(t.kind==='mel'){
            const m=rowMidi(t,r);
            auditionTrack(t,m,.95);
          }else{
            previewDrum(r);
          }
        });
        row.appendChild(lab);
        // 虚拟路径：行模板是 [labW][poolOff][repeat(poolN)] 共 n+2 条轨道，而行内元素只有 lab+n 格，
        // CSS 自动放置不会为空轨道留位 → 必须放一个“占位元素”占住偏移轨道，否则整行左移一列。
        if(win)row.appendChild(el('div','')); // 无类名的空占位：宽度由所属轨道(--poolOff)决定
        for(let s=from;s<to;s++){ // 虚拟路径只建窗口内的列（池），旧路径为全曲
          row.appendChild(makeCell(ti,r,s)); // 走统一建格路径：缓存 _s/_ti/_r，状态一次算好
        }
        body.appendChild(row);
      }
    }
    main.appendChild(body);
    grp.appendChild(main);
    if(t.collapsed)grp.classList.add('closed');
    list.appendChild(grp);
  }
}
export function changeShift(ti,delta){
  const t=proj.tracks[ti];
  t.shift=clamp((t.shift||0)+delta*12,-48,48);
  structural(true);
  if(proj.sel===ti)hooks.inspector?.render?.();
}
/* 每轨独立音域：宽度（2/3/4 八度）与锚点八度（行0=该八度主音） */
export function setTrackWidth(oct){
  const t=selTrack();if(!t||t.kind!=='mel')return;
  const nr=octRowsOf(oct),old=trackRows(t);
  if(nr===old)return;
  if(nr<old){
    for(let s=0;s<proj.steps;s++)for(let r=nr;r<old;r++)
      if(t.pat[s]&&t.pat[s][r]>0){toast('缩小音域前，请先把上方八度的音符移走/删除','err');return}
  }
  beginEdit();
  t.rows=nr;
  ensurePatSizes();
  if(t.prec&&t.prec.length)t.prec=t.prec.filter(p=>p.row<nr);
  commitEdit();
  structural(true);rebuildEvents();markDirtyUI();
  if(proj.sel===proj.tracks.indexOf(t))hooks.inspector?.render?.();
}
export function setTrackAnchor(oct){
  const t=selTrack();if(!t||t.kind!=='mel')return;
  if(oct===(t.keyOct||proj.keyOct))return;
  beginEdit();
  t.keyOct=oct;
  commitEdit();
  structural(true);rebuildEvents();markDirtyUI();
  if(proj.sel===proj.tracks.indexOf(t))hooks.inspector?.render?.();
}
export function buildCaches(){
  const c=proj._uiCache;
  c.cols=proj.tracks.map(()=>Array.from({length:proj.steps},()=>[]));
  c.cells=[];c.poolRows=[];c.poolRowEls=[];
  proj.tracks.forEach((t,ti)=>{
    const rows=patRows(t);
    const tm=Array.from({length:rows},()=>new Array(proj.steps));
    const group=$$('#trackList .tgroup')[ti]||null;
    const rowEls=group?Array.from(group.querySelectorAll('.row')):[];
    c.poolRows[ti]=[];c.poolRowEls[ti]=rowEls;
    rowEls.forEach((row,rIdx)=>{
      const cells=Array.from(row.querySelectorAll('.pc'));
      c.poolRows[ti][rIdx]=cells; // 池内槽位顺序（滑动/复用用）
      cells.forEach(cell=>{
        const s=parseInt(cell.dataset.s);
        tm[rIdx][s]=cell;
        c.cols[ti][s].push(cell);
      });
    });
    c.cells.push(tm);
  });
  hooks.seek?.resetGlow?.(); // DOM 缓存重建（单元格全新）→ 强制下次 glowStepCells 重绘当前列
}
/* 当前渲染窗口 [from,to)：虚拟路径下只有这些步有格子；旧路径为全曲 */
function winRange(){
  const c=proj._uiCache;
  const win=VIRTUAL&&c?c.win:null;
  return win?[win.from,win.from+win.n]:[0,proj.steps];
}
export function paintOne(ti,r,s){
  const t=proj.tracks[ti];if(!t)return;
  const cells=proj._uiCache&&proj._uiCache.cells?proj._uiCache.cells[ti]:null;
  const cell=cells&&cells[r]&&cells[r][s];
  if(!cell)return;
  const v=t.pat[s]&&t.pat[s][r]||0;
  cell.classList.toggle('on',v>0);
  cell.classList.toggle('velH',v>=.85);
}
export function paintAll(){
  const rng=winRange();
  proj.tracks.forEach((t,ti)=>{
    const rows=patRows(t);
    for(let r=0;r<rows;r++)for(let s=rng[0];s<rng[1];s++)paintOne(ti,r,s);
  });
  try{refreshRhythmMarkers()}catch(e){} // 每次整画后同步节奏细分标记
}
/* 节奏细分标记：先清掉旧标记再按当前 prec 重画（避免擦了音标记还残留） */
export function refreshRhythmMarkers(){
  try{
    if(proj._uiCache&&proj._uiCache.cols){
      const cols=proj._uiCache.cols;
      const rng=winRange();
      for(let ti=0;ti<cols.length;ti++){
        const row=cols[ti];if(!row)continue;
        for(let s=rng[0];s<rng[1];s++){
          const arr=row[s];if(!arr)continue;
          arr.forEach(c=>{c.classList.remove('tribar');c.style.removeProperty('--tx');c.style.removeProperty('--tw')});
        }
      }
    }
    markRhythmUI();
  }catch(e){}
}
/* 重新标注琴键行（调式变化后）*/
export function relabelRows(){
  const groups=$$('#trackList .tgroup');
  groups.forEach((g,ti)=>{
    const t=proj.tracks[ti];if(t.kind!=='mel')return;
    const labs=g.querySelectorAll('.row .lab');
    labs.forEach((lb,r)=>{
      lb.className='lab'+(r%7===0?' root':'');
      lb.textContent=noteNameOf(rowMidi(t,r));
    });
  });
  markDirtyUI();
}
/* ---------- 音符绘制交互 ---------- */
export const paint={on:false,erase:false};
export let drawTool='paint'; // 'paint' | 'erase' | 'select'
export function setDrawTool(v){drawTool=v}
let shiftSel=null; // Shift 框选：{ti,r,s,cur,done} —— 任何工具下按住 Shift 拖 = 框选
/* ---------- 区域复制 / 粘贴 ---------- */
export let regionSel=null; // {ti, from, to} —— from<=to（含两端），仅 UI 高亮
export const clip={cells:null,prec:null,len:0,kind:null,srcTi:-1}; // 内部剪贴板
export function addSelHighlight(sel){
  if(!sel||!proj._uiCache||!proj._uiCache.cols)return;
  const arrs=proj._uiCache.cols[sel.ti];
  if(!arrs)return;
  for(let s=sel.from;s<=sel.to;s++){const arr=arrs[s];if(arr)arr.forEach(c=>c.classList.add('sel'))}
}
export function removeSelHighlight(sel){
  if(!sel||!proj._uiCache||!proj._uiCache.cols)return;
  const arrs=proj._uiCache.cols[sel.ti];
  if(!arrs)return;
  for(let s=sel.from;s<=sel.to;s++){const arr=arrs[s];if(arr)arr.forEach(c=>c.classList.remove('sel'))}
}
export function clearRegionUI(){
  if(!regionSel)return;
  removeSelHighlight(regionSel);
  regionSel=null;
  try{refreshRegionState()}catch(e){}
}
export function paintRegionUI(){
  if(regionSel)addSelHighlight(regionSel);
}
export function updateQuantHint(){
  const q=document.getElementById('quantBtn');
  if(!q)return;
  if(regionSel&&regionSel.ti>=0&&proj.tracks[regionSel.ti]){
    // 按钮文案跟着作用范围变，用户一眼就知道点了会量化什么
    q.textContent='🎯 量化选中段';
    q.title='只量化你框选的这段：第 '+(Math.floor(regionSel.from/SPB())+1)+' 小节起 · '+(regionSel.to-regionSel.from+1)+' 步（想改回整首：Esc 取消选区）';
  }else{
    q.textContent='🎯 吸附';
    q.title='把音符对齐到 1/8 或 1/4 网格：默认整首；想只量化一小段，就按住左键在格子上拖出选区（或用 🔲 工具）';
  }
}
/* 选区节奏细分按钮：有可转换的选区才可用 */
export function updateRhythmUI(){
  const b=document.getElementById('rhythmBtn');
  if(!b)return;
  const t=regionSel&&regionSel.ti>=0?proj.tracks[regionSel.ti]:null;
  const ok=!!(t&&(t.kind==='mel'||t.kind==='drum'));
  b.disabled=!ok;
  b.title=ok
    ?'把框选的整数拍改成 N 等分精确时值，或还原成普通网格（可 Ctrl+Z 撤销）'
    :'请先在旋律轨/鼓组轨上框选整数拍：点 🔲 选区（或按住 Shift 拖），再点这里应用细分';
}
export function refreshRegionState(){
  updateRegionInfo();
  updClipUI();
  updateQuantHint();
  updateQuantEst();
  updateRhythmUI();
}
export function updateRegionInfo(){
  try{
    const el=document.getElementById('regionInfo');
    if(!el)return;
    let txt='';
    if(regionSel){
      const n=regionSel.to-regionSel.from+1;
      // 附带显示区域内实际音符数，方便知道会复制/量化什么
      let notes=0,tri=0;
      const t=proj.tracks[regionSel.ti];
      if(t){
        for(let s=regionSel.from;s<=regionSel.to;s++){
          const col=t.pat[s];if(!col)continue;
          for(let r=0;r<col.length;r++)if(col[r]>0)notes++;
        }
        // 选区里的精确时值音符也计入（它们没有格子，但确实“有内容”）
        if(t.prec&&t.prec.length){
          t.prec.forEach(p=>{
            const st=Math.floor((p.u||0)/PREC_U_PER_STEP);
            if(st>=regionSel.from&&st<=regionSel.to)tri++;
          });
        }
      }
      txt='第'+(Math.floor(regionSel.from/SPB())+1)+'节·'+(n>=SPB()?(n/SPB())+'节':n+'步')+'·'+(notes+tri)+'音'+(tri?'(含'+tri+'细分)':'');
    }else if(clip.cells){
      txt='已复制 '+(clip.len>=SPB()?(clip.len/SPB())+' 小节':clip.len+' 步');
    }
    el.textContent=txt;
  }catch(e){}
}
export function beginRegionSel(ti,s){
  clearRegionUI();
  regionSel={ti,from:s,to:s};
  paintRegionUI();
  refreshRegionState();
}
export function extendRegionSel(ti,s){
  if(!regionSel||regionSel.ti!==ti){beginRegionSel(ti,s);return}
  removeSelHighlight(regionSel);
  const lo=Math.min(regionSel.from,s),hi=Math.max(regionSel.from,s);
  regionSel.from=lo;regionSel.to=hi;
  paintRegionUI();
  refreshRegionState();
}
export function updClipUI(){
  const cb=document.getElementById('copyBtn'),pb=document.getElementById('pasteBtn');
  if(cb){
    cb.title=regionSel?'复制选区 '+(regionSel.to-regionSel.from+1)+' 步 (Ctrl+C)':'框选一段再复制：点 🔲 选区拖，或按住 Shift 在格子上拖 (Ctrl+C)';
  }
  if(pb){
    const tri=(clip.prec&&clip.prec.length)?(' · '+clip.prec.length+' 个细分音'):'';
    pb.title=clip.cells?'粘贴 '+(clip.len>=SPB()?(clip.len/SPB())+' 小节':clip.len+' 步')+tri+' 到播放头 (Ctrl+V)':'还没有复制内容，先复制一段 (Ctrl+V)';
  }
}
export function copyRegion(){
  if(!regionSel||regionSel.ti<0){toast('请先框选一段：点 🔲 选区工具拖，或按住 Shift 在格子上拖选要复制的一段','err');return}
  const t=proj.tracks[regionSel.ti];
  if(!t){toast('目标音轨不存在','err');return}
  const lo=regionSel.from,hi=regionSel.to;
  const rows=patRows(t);
  const cells=[];
  for(let s=lo;s<=hi;s++){
    const col=new Array(rows);
    for(let r=0;r<rows;r++)col[r]=(t.pat[s]&&t.pat[s][r])||0;
    cells.push(col);
  }
  // 连精确时值音符一起复制（转换成选区相对位置）
  const precs=[];
  if((t.kind==='mel'||t.kind==='drum')&&t.prec&&t.prec.length){
    const uLo=lo*PREC_U_PER_STEP,uHi=(hi+1)*PREC_U_PER_STEP;
    t.prec.forEach(p=>{
      const st=Math.floor(p.u/PREC_U_PER_STEP);
      if(st>=lo&&st<=hi&&p.u>=uLo&&p.u<uHi){
        precs.push({row:p.row,u:p.u-uLo,durU:p.durU||PREC_U_PER_STEP,vel:p.vel==null?.8:p.vel});
      }
    });
  }
  clip.cells=cells;clip.prec=precs;clip.len=hi-lo+1;clip.kind=t.kind;clip.srcTi=regionSel.ti;
  const barsTxt=clip.len>=SPB()?(clip.len/SPB())+' 小节':clip.len+' 步';
  toast('📋 已复制「'+(t.name||'音轨')+'」的 '+barsTxt+'（'+clip.len+' 步'+(precs.length?' · 含 '+precs.length+' 个细分音':'')+'）→ 把播放头移到目标处，或按住 Alt 点目标轨的起始格，再 粘贴 / Ctrl+V','ok');
  clearRegionUI(); // 复制后清掉源选区，粘贴默认落到播放头
  updateRegionInfo();
  updClipUI();
}
export function pasteRegion(){
  if(!clip.cells){toast('还没有复制内容（先框选 → 复制）','err');return}
  const t=selTrack();
  if(!t){toast('请先点选要粘贴的音轨','err');return}
  if(t.kind!==clip.kind){
    toast('不能粘贴：复制的是'+(clip.kind==='drum'?'鼓组':'旋律')+'内容，目标却是'+(t.kind==='drum'?'鼓组':'旋律')+'轨','err');
    return;
  }
  const rows=patRows(t);
  let at=-1;
  if(regionSel&&regionSel.ti===proj.sel)at=regionSel.from; // 目标轨上已框选 → 从框选起点贴
  if(at<0)at=Math.round(Play.step)||0;                         // 否则从当前播放头贴
  at=Math.max(0,at);
  if(t.prec&&t.prec.length){ // 覆盖粘贴段内的精确时值音符，避免双音
    const lo=at*PREC_U_PER_STEP,hi=(at+clip.len)*PREC_U_PER_STEP;
    t.prec=t.prec.filter(p=>p.u<lo||p.u>=hi);
  }
  const need=at+clip.len;
  if(need>proj.steps){
    const nb=Math.ceil(need/SPB());
    if(nb>MAX_BARS){toast('粘贴后超过 '+MAX_BARS+' 小节上限，无法放入','err');return}
    beginEdit();
    proj.steps=nb*SPB();ensurePatSizes();
  }else beginEdit();
  let wrote=0;
  clip.cells.forEach((col,k)=>{
    const s=at+k;
    for(let r=0;r<Math.min(rows,col.length);r++){
      const v=col[r]||0;
      if((t.pat[s]&&t.pat[s][r])!==v){t.pat[s][r]=v;wrote++}
    }
  });
  // 把剪贴板里的精确时值音符按目标位置一起贴上
  if(clip.prec&&clip.prec.length&&(t.kind==='mel'||t.kind==='drum')){
    const rowsL=patRows(t),base=at*PREC_U_PER_STEP;
    clip.prec.forEach(p=>{
      if(p.row==null||p.row<0||p.row>=rowsL)return;
      t.prec.push({row:p.row,u:base+(p.u||0),durU:p.durU||PREC_U_PER_STEP,vel:p.vel==null?.8:p.vel});
    });
  }
  commitEdit();
  if(regionSel&&regionSel.ti===proj.sel)clearRegionUI(); // 目标框选用完了就清掉
  structural(true);rebuildEvents();markDirtyUI();
  updateRegionInfo();
  updClipUI();
  const b0=Math.floor(at/SPB())+1;
  toast('📌 已粘贴 '+clip.len+' 步到「'+(t.name||'音轨')+'」第 '+b0+' 小节起'+(wrote?'':'（内容与原位相同）'),'ok');
}
export function clearRegionAndClipUI(){
  clearRegionUI();
  updateRegionInfo();
  updClipUI();
}
/* ================= 选区节奏细分（音符级精确时值） =================
   prec 的 u 单位：1 步 = PREC_U_PER_STEP(60)u、1 拍 = 240u。
   把选区里每拍的起音改成 N 等分精确时值：N=2/3/4/5/6 → 每音 120/80/60/48/40 u（整数，无浮点误差），
   N=0 表示“还原成网格”（精确音符落回最近的格子）。由 fireStep 按 u 精确排时，其它轨不受影响。 */
export function dropTrackPrec(ti){
  const t=proj.tracks[ti];
  if(t&&t.prec&&t.prec.length)t.prec=[];
}
/* 统计某拍(4 步 b..b+3)内的旋律起音（同一行连续只算 1 个） */
export function beatOnsets(t,b){
  const out=[];const S=proj.steps;const e=Math.min(S-1,b+3);
  for(let r=0;r<patRows(t);r++){
    for(let s=b;s<=e;s++){
      if(t.pat[s]&&t.pat[s][r]>0){
        const prev=(s===b)?0:(t.pat[s-1]&&t.pat[s-1][r])||0;
        if(!prev)out.push({row:r,step:s,vel:t.pat[s][r]});
      }
    }
  }
  out.sort((a,c)=>a.step-c.step||a.row-c.row);
  return out;
}
export function runEndRow(t,row,s0){
  const S=proj.steps;let s=s0;
  while(s<S&&t.pat[s]&&t.pat[s][row]>0&&(s%SPB()!==0||s===s0))s++;
  return s; // 独占区间 [s0,end)
}
/* n=2/3/4/5/6：每拍 N 等分；n=0：还原成普通网格 */
export function convertRegionRhythm(n){
  n=(n===2||n===3||n===4||n===5||n===6)?n:0;
  const trk=selTrack();
  if(!trk||(trk.kind!=='mel'&&trk.kind!=='drum')){toast('请先点选一条旋律轨或鼓组轨','err');return}
  const isDrum=trk.kind==='drum';
  if(!regionSel||regionSel.ti!==proj.sel){toast('请先在'+(isDrum?'鼓组':'旋律')+'轨上框选“整数拍”区域：点 🔲 选区（或按住 Shift 拖），例如从第 1 拍起点拖到该拍结尾（4 格）','err');return}
  const from=regionSel.from,to=regionSel.to;
  if(from%4!==0||(to-from+1)%4!==0){toast('请框选整数拍：起点对齐拍的步 0/4/8/12…，长度是 4 的倍数（1 拍=4 格）','err');return}
  for(let b=from;b<=to;b+=4){
    if(Math.floor(b/SPB())!==Math.floor((b+3)/SPB())){toast('选区里有拍跨过小节线（例如 7/8 每小节 14 步）：请改在小节内框选完整拍','err');return} // 7/8 等末组不跨小节
  }
  const U=PREC_U_PER_STEP,per=U*4,part=n?per/n:0; // 每拍 240u；N 等分时值
  const uLo=from*U,uHi=(to+1)*U;
  beginEdit();
  // 先清掉选区内该轨已有的精确时值音符（避免与本次结果叠加残留）
  const kept=[],old=[];
  (trk.prec||[]).forEach(p=>{const u=(p.u||0);if(u>=uLo&&u<uHi)old.push(p);else kept.push(p)});
  trk.prec=kept;
  let changed=0,skipped=0;
  if(!n){
    // 还原成网格：每个精确音符按 round(u/U) 落到最近的格子，力度沿用原值
    const seen={};
    old.forEach(p=>{
      if(p.row==null||p.row<0||p.row>=patRows(trk))return;
      const s=clamp(Math.round((p.u||0)/U),from,to);
      if(trk.pat[s])trk.pat[s][p.row]=clamp(p.vel==null?.8:p.vel,.05,1);
      const b=from+Math.floor((s-from)/4)*4;
      if(!seen[b]){seen[b]=1;changed++}
    });
  }else if(!isDrum){
    /* 选“来源音”：优先“正好 N 个起音”，其次“一个完整落在本拍内的音”；
       同一行上首尾相接的音会先合并成 1 个，所以已细分过的拍可以再细分（3 连音 → 5 连音）。
       来源音同时包含网格起音与本次摘掉的精确音符，避免“转换一次后网格空了就丢音”。 */
    const pickSource=(src,bE)=>{
      if(!src.length)return null;
      if(src.length===n&&src.every(o=>o.eU<=bE))return src;
      if(src.length===1&&src[0].eU<=bE)return src;
      const mg=[];
      src.forEach(o=>{
        const last=mg[mg.length-1];
        if(last&&last.row===o.row&&last.eU===o.sU){last.eU=Math.max(last.eU,o.eU);last.vel=o.vel}
        else mg.push({row:o.row,vel:o.vel,sU:o.sU,eU:o.eU});
      });
      if(mg.length===1&&mg[0].eU<=bE)return mg;
      if(mg.length===n&&mg.every(o=>o.eU<=bE))return mg;
      return null;
    };
    for(let b=from;b<=to;b+=4){
      const bU=b*U,bE=bU+per;
      const pn=old.filter(p=>{const u=p.u||0;return u>=bU&&u<bE}); // 本拍内原有（已被摘掉）的精确音符
      const src=[];
      beatOnsets(trk,b).forEach(o=>src.push({row:o.row,vel:o.vel,sU:o.step*U,eU:runEndRow(trk,o.row,o.step)*U,grid:true,step:o.step}));
      pn.forEach(p=>src.push({row:p.row,vel:p.vel,sU:p.u||0,eU:(p.u||0)+(p.durU||U)}));
      if(!src.length)continue;                       // 空拍：不算“跳过”
      src.sort((a,c)=>a.sU-c.sU||a.row-c.row);
      const use=pickSource(src,bE);
      if(!use){pn.forEach(p=>trk.prec.push(p));skipped++;continue} // 转不了就原样放回，不丢音
      src.forEach(o=>{if(o.grid){const e=Math.round(o.eU/U);for(let s=o.step;s<e;s++)if(trk.pat[s])trk.pat[s][o.row]=0}});
      // N 个来源音 → 一一对应；只有 1 个来源音（含合并后的）→ 同音 N 等分
      const emit=(use.length===n)?use:Array.from({length:n},()=>({row:use[0].row,vel:use[0].vel}));
      emit.forEach((o,i)=>{trk.prec.push({row:o.row,u:bU+i*part,durU:part,vel:o.vel})});
      changed++;
    }
  }else{
    // 鼓：同一拍内某一行恰好 N 个点（网格点 + 已细分的精确音符）→ 改成 N 等分；其余行/拍不动
    for(let b=from;b<=to;b+=4){
      const bU=b*U,bE=bU+per;
      const pn=old.filter(p=>{const u=p.u||0;return u>=bU&&u<bE});
      const rest=pn.slice();
      let hit=false;
      for(let r=0;r<KIT.length;r++){
        const src=[];
        for(let s=b;s<=b+3;s++){if(trk.pat[s]&&trk.pat[s][r]>0)src.push({s:s,vel:trk.pat[s][r],grid:true})}
        pn.forEach(p=>{if(p.row===r)src.push({vel:p.vel,prec:p})});
        if(src.length!==n)continue;
        src.forEach(o=>{if(o.grid)trk.pat[o.s][r]=0});
        src.forEach((o,i)=>{trk.prec.push({row:r,u:bU+i*part,durU:part,vel:o.vel})});
        src.forEach(o=>{if(o.prec){const i=rest.indexOf(o.prec);if(i>=0)rest.splice(i,1)}});
        changed++;hit=true;
      }
      rest.forEach(p=>trk.prec.push(p));            // 没转换的行：原样放回
      let had=pn.length>0;
      for(let r=0;r<KIT.length&&!had;r++)for(let s=b;s<=b+3;s++){if(trk.pat[s]&&trk.pat[s][r]>0){had=true;break}}
      if(!hit&&had)skipped++;
    }
  }
  pruneTrackPrec(trk);
  commitEdit();
  structural(true);rebuildEvents();markDirtyUI();
  const what=n?(isDrum?'改成 '+n+' 等分（每音 '+part+'u = 1/'+n+' 拍）':'改成 '+n+' 连音（每音 '+part+'u = 1/'+n+' 拍）'):'还原成网格';
  toast(changed
    ?'♫ 已把 '+(isDrum?changed+' 个鼓行':changed+' 拍')+what+' · 转换 '+changed+(isDrum?' 行':' 拍')+' / 跳过 '+skipped+' 拍，其余声部不变'
    :'没有可转换的拍（转换 0 拍 / 跳过 '+skipped+' 拍）：'+(n?(isDrum?'每行需要正好 '+n+' 个点（该拍内）':'每拍准备 '+n+' 个起音，或 1 个完整落在拍内的音（自动同音 '+n+' 等分）'):'选区内没有精确时值音符')+'，再试一次','ok');
}
/* 在格子上把精确时值音符画成“按格内实际位置/时值”的细条标记 */
export function markRhythmUI(){
  try{
    if(!proj._uiCache||!proj._uiCache.cells)return;
    const rowsOf=patRows;
    proj.tracks.forEach((t,ti)=>{
      if((t.kind!=='mel'&&t.kind!=='drum')||!t.prec||!t.prec.length)return;
      const rows=rowsOf(t);
      t.prec.forEach(p=>{
        if(p.row==null||p.row<0||p.row>=rows)return;
        const durU=Math.max(1,p.durU||PREC_U_PER_STEP);
        let uStart=p.u,rem=durU;
        while(rem>0&&uStart>=0){
          const step=Math.floor(uStart/PREC_U_PER_STEP);
          if(step<0||step>=proj.steps)break;
          const fracIn=(uStart%PREC_U_PER_STEP)/PREC_U_PER_STEP; // 本格内已走过的比例
          const room=1-fracIn;                                  // 本格剩余宽度(以格为单位)
          const take=Math.min(room,rem/PREC_U_PER_STEP);        // 本格内覆盖宽度
          const cell=proj._uiCache.cells[ti]&&proj._uiCache.cells[ti][p.row]&&proj._uiCache.cells[ti][p.row][step];
          if(cell){cell.classList.add('tribar');cell.style.setProperty('--tx',(fracIn*100).toFixed(1)+'%');cell.style.setProperty('--tw',Math.max(2,take*100).toFixed(1)+'%')}
          uStart+=take*PREC_U_PER_STEP;rem-=take*PREC_U_PER_STEP;
        }
      });
    });
  }catch(e){}
}
export function trimPrecAt(ti,r,s){
  const t=proj.tracks[ti];
  if(t&&t.prec&&t.prec.length)t.prec=t.prec.filter(p=>!(p.row===r&&Math.floor(p.u/PREC_U_PER_STEP)===s));
}
export function setCellVal(ti,r,s,val,noPaint){
  const t=proj.tracks[ti];if(!t)return;
  if(!t.pat[s])return;
  trimPrecAt(ti,r,s); // 手改该格 → 清掉同格的精确音符
  t.pat[s][r]=clamp(val,0,1);
  if(!noPaint)paintOne(ti,r,s);
  rebuildSoon();
}
export function cellPaintStart(ev){
  const pc=ev.target.closest('.pc');if(!pc)return;
  const ti=+pc.dataset.ti,s=+pc.dataset.s;
  if(ev.altKey){ // Alt+单击 = 给“粘贴”定位一个起点（不画画）
    ev.preventDefault();
    beginRegionSel(ti,s);
    toast('📍 已定位粘贴起点：第 '+(Math.floor(s/SPB())+1)+' 小节第 '+(s%SPB()+1)+' 步，按 📌粘贴 / Ctrl+V','ok');
    return;
  }
  if(ev.shiftKey&&ev.button!==2&&drawTool!=='select'){ // Shift 按住 = 直接框选（任何工具下），拖出去选一段
    ev.preventDefault();
    const rRow=+pc.dataset.r;
    const t=proj.tracks[ti];
    shiftSel={ti,r:rRow,s,cur:(t&&t.pat[s]&&t.pat[s][rRow])||0,done:false};
    return;
  }
  if(drawTool==='select'){ // 选区：只框不编辑
    ev.preventDefault();
    beginRegionSel(ti,s);
    return;
  }
  beginEdit();
  if(regionSel)clearRegionUI(); // 切回画/擦时清掉旧选区高亮
  const r=+pc.dataset.r;
  const t=proj.tracks[ti];
  const cur=t.pat[s]?t.pat[s][r]:0;
  if(ev.button===2){ // 右键擦除
    setCellVal(ti,r,s,0);
    commitEdit();
    return;
  }
  ev.preventDefault();
  paint.on=true;
  if(drawTool==='erase'){
    paint.erase=true;
    setCellVal(ti,r,s,0);
  }else{
    paint.erase=cur>0; // 从已激活格开始拖 = 擦除
    setCellVal(ti,r,s,paint.erase?0:.8);
  }
}
export function cellPaintMove(ev){
  // 文件管理器式：只有“按住左键（或触屏/笔按下）”拖动才算框选/绘制；仅悬停不触发任何选择
  const pressed=ev.buttons!==undefined?!!(ev.buttons&1):true;
  if(!pressed)return;
  if(drawTool==='select'){
    const pc=ev.target.closest('.pc');if(!pc)return;
    extendRegionSel(+pc.dataset.ti,+pc.dataset.s);
    return;
  }
  if(shiftSel){
    const pc=ev.target.closest('.pc');if(!pc)return;
    const ti=+pc.dataset.ti;
    if(!shiftSel.done){
      shiftSel.done=true;
      beginRegionSel(shiftSel.ti,shiftSel.s); // 从按下的那一格开始框
    }
    extendRegionSel(ti,+pc.dataset.s); // 跨轨自动另起
    return;
  }
  if(!paint.on)return;
  const pc=ev.target.closest('.pc');if(!pc)return;
  const ti=+pc.dataset.ti,r=+pc.dataset.r,s=+pc.dataset.s;
  const val=paint.erase?0:.8;
  const t=proj.tracks[ti];
  if(t.pat[s][r]===val)return;
  setCellVal(ti,r,s,val);
}
export function cellPaintEnd(){
  if(shiftSel){
    const ss=shiftSel;shiftSel=null;
    if(!ss.done){ // 原地单击：亮音=切重音/普通；空位或橡皮=选中这一格或擦除
      const t=proj.tracks[ss.ti];
      if(drawTool==='erase'){
        beginEdit();setCellVal(ss.ti,ss.r,ss.s,0);commitEdit();
      }else if(ss.cur>0){
        beginEdit();setCellVal(ss.ti,ss.r,ss.s,ss.cur>=.9?.8:.95);commitEdit();
      }else{
        beginRegionSel(ss.ti,ss.s);
      }
    }
    return;
  }
  if(paint.on){paint.on=false;rebuildEvents();try{refreshRhythmMarkers()}catch(e){}}
  commitEdit();
}
/* ---------- 量化：把音符吸附到 1/16 · 1/8 · 1/4 网格（保留力度）
   支持“区域量化”：先用 🔲 选区（或按住 Shift 拖选）框选一段，再点 🎯 吸附 就只量化这段；
   没有选区则量化整首。量化前实时预估，量化后把被移动的音符闪绿提示。---------- */
export function quantScope(){
  const hasSel=regionSel&&regionSel.ti>=0&&!!proj.tracks[regionSel.ti];
  return {
    hasSel,
    qFrom:hasSel?regionSel.from:0,
    qTo:hasSel?regionSel.to:proj.steps-1,
    grid:parseInt(($('#quantGrid')||{}).value)||1,
    str:(()=>{const raw=parseFloat(($('#quantStr')||{}).value);return (isNaN(raw)?100:raw)/100})(),
    S:proj.steps
  };
}
/* 吸附目标：只在本小节内部找网格点（不跨小节），再按强度靠拢 */
export function snapToGrid(s,grid,str,qFrom,qTo){
  const barLen=SPB();
  const bar=Math.floor(s/barLen);
  let g=Math.round((s%barLen)/grid);
  while(g*grid>barLen-1)g--;
  const target=bar*barLen+Math.max(0,g*grid);
  const t=Math.max(qFrom,Math.min(qTo,target));
  return Math.max(qFrom,Math.min(qTo,s+Math.round((t-s)*str)));
}
/* 预估：范围内有多少个音符“不在所选网格上”（只读、不修改） */
// ⚠ 与 applyQuantize / estimateQuantMoves 保持同步
export function estimateQuantMoves(){
  try{
    const sc=quantScope();
    if(sc.grid===1||!proj||!proj.tracks.length)return 0;
    const {qFrom,qTo,grid,str,S}=sc;
    const snap=s=>snapToGrid(s,grid,str,qFrom,qTo);
    const tracks=sc.hasSel?[proj.tracks[regionSel.ti]]:proj.tracks;
    let n=0;
    tracks.forEach(t=>{
      if(!t)return;
      const rows=patRows(t);
      if(t.kind==='mel'){
        for(let r=0;r<rows;r++){
          let s=0;
          while(s<S){
            if(s>qTo)break;
            if(t.pat[s]&&t.pat[s][r]>0){
              const runStart=s;let len=1;
              while(s+len<S&&(s+len)%SPB()!==0&&t.pat[s+len][r]>0)len++;
              if(runStart>=qFrom){
                const ns=snap(runStart);
                const ns2=Math.min(ns,Math.max(qFrom,qTo-len+1));
                if(ns2!==runStart)n++;
              }
              s=runStart+len;
            }else s++;
          }
        }
      }else{
        for(let r=0;r<rows;r++)for(let s=qFrom;s<=qTo;s++){
          if(t.pat[s]&&t.pat[s][r]>0&&snap(s)!==s)n++;
        }
      }
    });
    return n;
  }catch(e){return 0}
}
export function updateQuantEst(){
  try{
    const el=document.getElementById('quantEst');
    if(!el)return;
    const sc=quantScope();
    if(sc.grid===1){el.textContent='选 1/8 或 1/4 才能吸附';el.style.color='var(--mut)';el.title='当前 1/16=原始网格，无法吸附';return}
    const n=estimateQuantMoves();
    const head=sc.hasSel?'选中段':'整曲';
    el.textContent=n>0?head+' · 预计移 ~'+n+' 处':head+' · ✓ 已对齐';
    el.style.color=n>0?'var(--good)':'#35b97c';
    el.title=(sc.hasSel?'只量化框选的这一段':'量化整首')+' · '+(sc.grid===2?'1/8':(sc.grid===4?'1/4':'1/16'))+' 网格 · 强度 '+Math.round(sc.str*100)+'%';
  }catch(e){}
}
/* 量化结果：把被移动的音符闪绿，便于确认动了哪里 */
export function flashQuantCells(cells){
  if(!cells||!cells.length)return;
  const list=[];
  cells.forEach(ci=>{
    if(!proj._uiCache||!proj._uiCache.cells)return;
    const arrs=proj._uiCache.cells[ci.ti];
    const cell=arrs&&arrs[ci.r]&&arrs[ci.r][ci.s];
    if(cell){list.push(cell);cell.classList.add('qflash')}
  });
  setTimeout(()=>{list.forEach(c=>c.classList.remove('qflash'))},1600);
}
// ⚠ 与 applyQuantize / estimateQuantMoves 保持同步
export function applyQuantize(){
  const sc=quantScope();
  const {hasSel,qFrom,qTo,grid,str,S}=sc;
  if(grid===1){toast('当前网格选的是 1/16（原样），无需吸附','ok');return}
  const need=estimateQuantMoves();
  if(need===0){
    toast('✓ '+(hasSel?'选中区域内':'当前音符')+'都已在 '+ (grid===2?'1/8':(grid===4?'1/4':'1/16')) +' 网格上，无需移动','ok');
    return;
  }
  beginEdit();
  let moved=0,merged=0;
  const movedCells=[];
  const snap=s=>snapToGrid(s,grid,str,qFrom,qTo);
  const tracks=hasSel?[proj.tracks[regionSel.ti]]:proj.tracks;
  const canPlace=(pat,r,oldStart,newStart,len)=>{
    for(let i=0;i<len;i++){
      const st=newStart+i;
      if(st<qFrom||st>qTo)return false;
      if(pat[st][r]>0&&(st<oldStart||st>=oldStart+len))return false;
    }
    return true;
  };
  tracks.forEach(t=>{
    if(!t)return;
    const ti=proj.tracks.indexOf(t);
    const rows=patRows(t);
    if(t.kind==='mel'){
      for(let r=0;r<rows;r++){
        let s=0;
        while(s<S){
          if(s>qTo)break;
          const v=t.pat[s]&&t.pat[s][r];
          if(v>0){
            const runStart=s;
            let len=1;while(s+len<S&&(s+len)%SPB()!==0&&t.pat[s+len][r]>0)len++;
            const wholeIn=runStart>=qFrom&&runStart+len-1<=qTo; // 整段都在区域里才处理
            if(wholeIn){
              const ns=snap(runStart);
              const ns2=Math.min(ns,Math.max(qFrom,qTo-len+1));
              if(ns2!==runStart){
                if(canPlace(t.pat,r,runStart,ns2,len)){ // 目标空位 → 移动
                  const vals=[];for(let i=0;i<len;i++)vals.push(t.pat[runStart+i][r]);
                  for(let i=0;i<len;i++)t.pat[runStart+i][r]=0;
                  for(let i=0;i<len;i++)t.pat[ns2+i][r]=vals[i];
                  moved++;movedCells.push({ti,r,s:ns2});s=ns2;
                }else{ // 目标已被同音占住 → 标准“去重”：移除这段重复离格音（可撤销）
                  for(let i=0;i<len;i++)t.pat[runStart+i][r]=0;
                  merged++;movedCells.push({ti,r,s:runStart,rm:true});
                }
              }
            }
            s=runStart+len;
          }else s++;
        }
      }
    }else{
      for(let r=0;r<rows;r++)for(let s=qFrom;s<=qTo;s++){
        const v=t.pat[s]&&t.pat[s][r];
        if(!v)continue;
        const ns=snap(s);
        if(ns===s)continue;
        if(!(t.pat[ns]&&t.pat[ns][r])){ // 目标空位 → 移动
          t.pat[s][r]=0;t.pat[ns][r]=v;moved++;movedCells.push({ti,r,s:ns});
        }else{ // 与网格上同音重复 → 去掉这颗离格音
          t.pat[s][r]=0;merged++;movedCells.push({ti,r,s,rm:true});
        }
      }
    }
  });
  paintAll();rebuildEvents();commitEdit();
  flashQuantCells(movedCells);
  const gName=grid===2?'1/8':(grid===4?'1/4':'1/16');
  const where=hasSel?'第 '+(Math.floor(qFrom/SPB())+1)+((Math.floor(qFrom/SPB())!==Math.floor(qTo/SPB()))?'–'+(Math.floor(qTo/SPB())+1):'')+' 小节':'整曲';
  const leftOver=need-moved-merged;
  updateQuantEst();
  const leftTxt=(merged>0?'、去重合并 '+merged+' 处':'')+(leftOver>0?'，'+leftOver+' 处位置放不下已保留':'');
  toast('🎯 量化完成：'+where+' 内 '+need+' 处离网格 → 移动 '+moved+' 处（绿闪）'+leftTxt+' · '+gName+' · 强度 '+Math.round(str*100)+'%','ok');
}
export function previewDrum(idx){
  if(!ensureAudio())return;
  setGate(true,true);
  const k=KIT[idx];
  drumVoice(actx,A.master,actx.currentTime+.01,k.id,.95,{vol:.9,rev:.12});
}
/* 变更节流：重建事件 + 自动存档 */
export const rebuildSoon=debounce(()=>{if(proj._ev)rebuildEvents();try{refreshRhythmMarkers()}catch(e){}},90);
