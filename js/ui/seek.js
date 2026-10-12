/* [seek.js] source: Pro.html 1534-1546, 1590-1594, 1621-1656, 2913-3001（播放头/进度条/标尺拖拽）
   末尾自注册 hooks.seek 与 engine 的 playheadHooks（timeline/engine 反向调用） */
import { proj, actx, A, stepDurNow, fmtPos, stepWidth, effStepWidth, uiZoom } from '../core/state.js';
import { $, el, clamp, UI, hooks } from '../core/util.js';
import { Play, stopPlay, tickSched, playheadHooks } from '../audio/engine.js';
import { ensureAudio, setGate, setAudioBusy } from '../audio/master.js';
import { VIRTUAL } from './timeline.js';
import { wakeViz } from './viz.js';

export let followOn=true; // 播放时自动跟随滚动
export function setFollowOn(v){followOn=v}
let lastFollowed=-1;
export function followScroll(step){
  if(!followOn||step===lastFollowed)return;
  lastFollowed=step;
  if(!VIRTUAL){ // 旧路径：格子全量存在，沿用 scrollIntoView
    if(!proj._uiCache||!proj._uiCache.cols)return;
    let cell=null;
    for(let i=0;i<proj._uiCache.cols.length;i++){
      const arr=proj._uiCache.cols[i][step];
      if(arr&&arr.length){cell=arr[0];break;}
    }
    if(cell){try{cell.scrollIntoView({block:'nearest',inline:'nearest',behavior:'auto'})}catch(e){}}
    return;
  }
  // 虚拟渲染：格子只在窗口内存在 → 直接按步号算目标滚动位置，
  // 滚动事件由 timeline.js 用 requestAnimationFrame 合并后同步窗口列。
  const tl=document.getElementById('timeline');
  if(!tl)return;
  const cw=effStepWidth()||8;
  const labW=parseFloat(getComputedStyle(tl).getPropertyValue('--labW'))||96;
  const x=labW+step*cw;
  const left=tl.scrollLeft||0, w=tl.clientWidth||0;
  if(x<left+labW+40||x>left+w-80){
    const max=Math.max(0,proj.steps*cw+labW-w);
    tl.scrollLeft=Math.max(0,Math.min(max,x-w*0.35));
  }
}
export function setPlayUI(on){
  $('#playIco').style.display=on?'none':'block';
  $('#stopIco').style.display=on?'block':'none';
  $('#playBtn').title=on?'停止 (空格)':'播放 (空格)';
}
/* UI 播放指示（rAF）*/
let lastGlowStep=-1; // 当前点亮的列；只做增量清除，避免每步全量扫格
export function glowStepCells(step){
  // 更新列高亮：先清除旧列
  if(step===lastGlowStep)return;
  clearStepGlow();
  if(!proj._uiCache||proj._uiCache.steps!==proj.steps)return;
  const cols=proj._uiCache.cols;
  cols.forEach(c=>{const ce=c[step];if(ce)ce.forEach(e=>e.classList.add('playCol'))});
  lastGlowStep=step;
}
export function clearStepGlow(){
  /* 修复 Bug 2（双播放头）：原来这里用 if(lastGlowStep>=0) 找到"上一次点亮的那一列"来清，
     但 buildCaches() 重建行池后会调用 resetGlow() 把 lastGlowStep 置 -1，旧列上的 playCol 就永远清不掉了；
     虚拟窗口复用池里的 DOM 格子时类名会残留 → 新播放再点一格 = 两条播放头。
     现在不再依赖 lastGlowStep：全量扫一遍缓存里的所有轨道 × 所有列，把残留的 playCol 一律移除。
     规模只有虚拟窗口那一屏（轨数 × 窗内步数），相对一个十六分音符的间隔开销可忽略。 */
  const cols=proj._uiCache&&proj._uiCache.cols;
  if(cols){
    for(let ti=0;ti<cols.length;ti++){
      const c=cols[ti];
      if(!c)continue;
      for(let s=0;s<c.length;s++){
        const ce=c[s];
        if(!ce)continue;
        for(let k=0;k<ce.length;k++){
          const e=ce[k];
          if(e&&e.classList)e.classList.remove('playCol');
        }
      }
    }
  }
  lastGlowStep=-1;
}
export function updatePos(step){
  UI.posMain.textContent=fmtPos(step,proj.steps);
  updateSeekUI(step);
}
/* UI 播放指示：**只在播放时驱动**（按需 rAF），停着的时候一帧都不跑。
   --------------------------------------------------------------------------
   原来这里是常驻 `requestAnimationFrame(visLoop)`，即使没在播放也每帧空转。
   实测（headless Edge / 5 秒空闲）：把两个常驻 rAF 循环停掉，主线程忙时从 700ms(17.4%)
   掉到 36ms(0.9%) —— 也就是说"页面静止但在以 60fps 反复触发渲染"，就是任务管理器里
   那 20~30% 的 CPU 来源。播放时才需要每帧走播放头，所以改成：
     · Play.playing 为真时自续期；
     · 停止/暂停/页面隐藏时退出循环（不再注册下一帧）；
     · 重新播放/seek 时由 wakeVis() 重新点火。
   停止路径自己会调 updatePos/clearStepGlow，所以退出前画面已经是终态。 */
let _visOn = false;
export function wakeVis() {
  if (typeof document !== 'undefined' && document.hidden) return;
  if (_visOn) { wakeViz(); return; }
  _visOn = true;
  requestAnimationFrame(visLoop);   // 顶栏频谱由 visLoop 内部经 wakeViz 点火
}
export function visLoop() {
  // 停止态 / 后台标签页：不再续期，循环自然结束
  if (!(Play.playing && actx) || (typeof document !== 'undefined' && document.hidden)) { _visOn = false; return; }
  requestAnimationFrame(visLoop);
  wakeViz();                        // 顶栏频谱只有播放时才有意义，跟着播放头一起跑
  const now = actx.currentTime;
  while (Play.q.length && Play.q[0].time <= now + 0.004) {
    const e = Play.q.shift();
    Play.uiStep = e.step;
    glowStepCells(e.step); updatePos(e.step); followScroll(e.step);
  }
}
/* ---------- 播放进度条（可拖拽 UI + 标尺同步） ---------- */
let scrubDragging=false;
export function fmtSeek(sec){
  sec=Math.max(0,Math.round(sec));
  const m=Math.floor(sec/60),s=sec%60;
  return m+':'+(s<10?'0'+s:s);
}
export function seekTotalSec(){return proj.steps*stepDurNow()}
export function updateSeekUI(step){
  try{
    const fill=document.getElementById('seekFill');
    const knob=document.getElementById('seekKnob');
    const lbl=document.getElementById('seekLbl');
    if(!fill)return;
    const S=Math.max(1,proj.steps);
    const st=clamp(step||0,0,S-1);
    const total=seekTotalSec();
    const ratio=S>1?st/(S-1):0;
    fill.style.width=(ratio*100)+'%';
    if(knob){knob.style.left=(ratio*100)+'%'}
    if(lbl){lbl.textContent=fmtSeek(st*stepDurNow())+' / '+fmtSeek(total)}
  }catch(e){}
}
export function seekToStep(s){
  s=clamp(Math.round(s),0,proj.steps-1);
  const wasPlaying=Play.playing;
  if(wasPlaying)stopPlay();
  Play.step=s;
  Play.hasStarted=true;   // seek = "我要从这里开始"：即使从未播放过，之后按播放也从 s 起（不被 togglePlay 归零）
  updatePos(s);
  glowStepCells(s);
  if(wasPlaying)startFromStep();
}
export function seekByClientX(clientX,el){
  const r=(el||document.getElementById('seekTrack')).getBoundingClientRect();
  const ratio=clamp((clientX-r.left)/Math.max(1,r.width),0,1);
  const s=Math.round(ratio*(proj.steps-1));
  seekToStep(s);
}
export function scrubSeek(clientX){
  const ruler=UI.ruler;
  if(!ruler||!proj.steps)return;
  const r=ruler.getBoundingClientRect();
  const cw=effStepWidth();
  const labW=parseFloat(getComputedStyle(ruler).getPropertyValue('--labW'))||96;
  const x=clientX-r.left-(labW+5); // 标尺最左侧的空白格(--labW+5px)之后的第一个步进列
  let s=Math.floor(x/cw);
  if(x<0)s=0;
  seekToStep(s);
}
export function startFromStep(){
  /* 与 togglePlay 同一套顺序：先立"正在播"标记再 ensureAudio，
     避免排队中的挂起回调把刚唤醒的上下文又挂起（会变成"有播放头没声音"）。 */
  setAudioBusy(true);
  if(!ensureAudio()){setAudioBusy(false);return}
  setGate(true,true);
  Play.nom=actx.currentTime+.06;Play.q=[];Play.uiStep=-1;
  Play.hasStarted=true;   // 已经开始走过带：之后暂停再播放要从当前位置继续，而不是归零
  Play.playing=true;setPlayUI(true);
  tickSched();
  Play.timer=setInterval(tickSched,30);
  wakeVis();              // 播放头 UI 循环按需点火（见 visLoop 注释）
}
export function bindScrubber(){
  const ruler=UI.ruler;
  if(!ruler)return;
  ruler.style.cursor='pointer';
  ruler.addEventListener('pointerdown',e=>{
    scrubDragging=true;
    try{ruler.setPointerCapture(e.pointerId)}catch(err){}
    scrubSeek(e.clientX);
    e.preventDefault();
  });
  ruler.addEventListener('pointermove',e=>{if(scrubDragging)scrubSeek(e.clientX)});
  ruler.addEventListener('pointerup',()=>{scrubDragging=false});
  ruler.addEventListener('pointercancel',()=>{scrubDragging=false});
  // 顶部可视进度条：点击/拖动定位
  const track=document.getElementById('seekTrack');
  if(track){
    const knob=document.getElementById('seekKnob');
    let dragging=false;
    track.addEventListener('pointerdown',e=>{
      dragging=true;
      track.setPointerCapture&&track.setPointerCapture(e.pointerId);
      knob&&knob.classList.add('drag');
      seekByClientX(e.clientX,track);
      e.preventDefault();
    });
    track.addEventListener('pointermove',e=>{if(dragging)seekByClientX(e.clientX,track)});
    const end=()=>{dragging=false;knob&&knob.classList.remove('drag')};
    track.addEventListener('pointerup',end);
    track.addEventListener('pointercancel',end);
  }
  updateSeekUI(0);
}

/* 自注册（STEP 6c 收敛）：timeline.js 经 hooks.seek 反向调用；engine.js 经 playheadHooks 反向调用 */
export function resetGlow(){ lastGlowStep=-1; }
/* 当前已点亮的播放列（虚拟窗口重排后据此恢复 playCol 高亮；未点亮返回 -1） */
export function glowCol(){ return lastGlowStep; }
/* 点火：**所有**进入播放的路径最后都会调 setPlayUI(true)
   （togglePlay 走它、startFromStep 走它），所以把 wakeVis 挂在这里最稳 ——
   挂在 updatePos 上会漏掉 togglePlay（它只调 setPlayUI，不调 updatePos），
   挂在 startFromStep 上则会漏掉主播放按钮。 */
function setPlayUIAndWake(on){ if(on)wakeVis(); setPlayUI(on); }
hooks.seek={updateSeekUI,resetGlow,glowCol};
Object.assign(playheadHooks,{setPlayUI:setPlayUIAndWake,clearStepGlow,updatePos,glowStepCells,followScroll,visLoop,wakeVis});
