/* [seek.js] source: Pro.html 1534-1546, 1590-1594, 1621-1656, 2913-3001（播放头/进度条/标尺拖拽）
   末尾自注册 hooks.seek 与 engine 的 playheadHooks（timeline/engine 反向调用） */
import { proj, actx, A, stepDurNow, fmtPos, stepWidth, effStepWidth, uiZoom } from '../core/state.js';
import { $, el, clamp, UI, hooks } from '../core/util.js';
import { Play, stopPlay, tickSched, playheadHooks } from '../audio/engine.js';
import { ensureAudio, setGate } from '../audio/master.js';
import { VIRTUAL } from './timeline.js';

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
export function visLoop(){
  requestAnimationFrame(visLoop);
  if(Play.playing&&actx){
    const now=actx.currentTime;
    let advanced=false;
    while(Play.q.length&&Play.q[0].time<=now+0.004){
      const e=Play.q.shift();
      Play.uiStep=e.step;advanced=true;
      glowStepCells(e.step);updatePos(e.step);followScroll(e.step);
    }
    // 若 long idle（例如系统卡顿）保持最后状态
    void advanced;
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
  if(!ensureAudio())return;
  setGate(true,true);
  Play.nom=actx.currentTime+.06;Play.q=[];Play.uiStep=-1;
  Play.hasStarted=true;   // 已经开始走过带：之后暂停再播放要从当前位置继续，而不是归零
  Play.playing=true;setPlayUI(true);
  tickSched();
  Play.timer=setInterval(tickSched,30);
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
hooks.seek={updateSeekUI,resetGlow,glowCol};
Object.assign(playheadHooks,{setPlayUI,clearStepGlow,updatePos,glowStepCells,followScroll,visLoop});
