/* [seek.js] source: Pro.html 1534-1546, 1590-1594, 1621-1656, 2913-3001（播放头/进度条/标尺拖拽）
   末尾自注册 hooks.seek 与 engine 的 playheadHooks（timeline/engine 反向调用） */
import { proj, actx, A, stepDurNow, fmtPos, stepWidth, effStepWidth, uiZoom } from '../core/state.js';
import { $, el, clamp, UI, hooks } from '../core/util.js';
import { Play, stopPlay, playheadHooks, beginScheduling } from '../audio/engine.js';
import { ensureAudio, setAudioBusy } from '../audio/master.js';
import { VIRTUAL, labWidthPx } from './timeline.js';
import { wakeViz } from './viz.js';

export let followOn=true; // 播放时自动跟随滚动
export function setFollowOn(v){followOn=v}
/* =========================================================================
   播放跟随滚动（DAW 式）—— 用户要求：
   "播放时指针移动至谱面 4/5 处时平滑地显示后面的谱面，指针相对界面静止"
   -------------------------------------------------------------------------
   旧实现是"跳页"：一旦指针越过 left+w-80 就把 scrollLeft 一把设成 x-w*0.35，
   指针会从右边缘瞬间弹回 35% 处 —— 就是"一跳一跳"的观感。
   新实现分两个阶段，和主流音乐制作软件一致：
     ① 指针未到阈值（视口 4/5）之前：**完全不动 scrollLeft**，指针自由右移；
     ② 越过阈值后：每帧把 scrollLeft 推 `step*cw - xAt`，于是**指针钉在 4/5 处不动**，
        谱面向左平滑滑过（scrollLeft 依赖步号，所以滚动本身是连续、不抖的）。
   -------------------------------------------------------------------------
   实现要点：
   · 必须在 **visLoop 的 rAF 里每帧**重算，不能只在"步号变化时"调（每步 150ms 才动一次 =
     仍然是一跳一跳）。所以这里自动滚动期间自己续期 rAF，与基于步号的那次调用解耦。
   · 不要在 x<=xAt 时把 scrollLeft 往回写，否则第一步会往回跳。
   · followPinRaf 只在需要时运行；停止播放 / 关闭跟随 / 换曲时由 stopFollowPin 收掉。
   ========================================================================= */
export const FOLLOW_FRAC=4/5;   // 指针触发自动滚动的横向位置（视口比例）
let lastFollowed=-1;
let followPinRaf=0;
let followPinOn=false;          // 是否已进入"钉住"阶段
function stopFollowPin(){
  followPinOn=false;
  if(followPinRaf){try{cancelAnimationFrame(followPinRaf)}catch(e){}followPinRaf=0}
}
function stepXAt(){
  const cw=effStepWidth()||8;
  const labW=labWidthPx()||96;          // 走布局缓存，不在这里 getComputedStyle
  return {cw,labW};
}
/* 每帧推进：把 scrollLeft 设成"让当前步停在 4/5 处"的值。
   若音频时刻已越过当前队首，用插值步号（更平滑）；否则退回最近已消费的步号。 */
function pinStep(){
  const tl=document.getElementById('timeline');
  if(!tl){stopFollowPin();return}
  const {cw,labW}=stepXAt();
  const w=tl.clientWidth||0;
  if(!w||!cw){stopFollowPin();return}
  /* 指针的"连续"位置 —— 从队列队首正向插值。
     推导：Play.uiStep 是**最后一个已被消费**的步（visLoop 里 shift 出来的），
     而 Play.q[0] 正是"下一步（uiStep+1）将要生效"的时刻。所以
         progress = (now − q[0].time) / dur   ∈ (0, 1] 左右
         s        = uiStep + progress
     即 uiStep 与 uiStep+1 之间的连续插值。
     ⚠ 两个踩过的坑，别再改回去：
     ① 不能用 q[0].step 当基准再往回插 —— 那算的是"下一步已经走了多少"，
        结果会偏后一整列（实测指针停在 0.854 而不是 0.80）。
     ② 不能只取整列 Play.uiStep（不插值）—— 滚动会一档一档跳
        （实测每帧中位增量 36px，正是"一跳一跳"的观感）。 */
  let s=(Play.uiStep!=null&&Play.uiStep>=0)?Play.uiStep:0;
  const dur=stepDurNow();
  const head=Play.q.length?Play.q[0]:null;
  if(head&&actx&&dur>0){
    /* 上限放到 4 而不是 1.2：q[0] 是"刚到期、还没被 visLoop 消费"的步，
       而 uiStep 是"最后一个已消费的步"，所以 uiStep 天生落后 currentTime 1~2 步。
       实测 prog（含下面的 +1）落在 2.3~3.1；原来钳到 1.2 会把位置压平、破坏连续性。
       下限 0：如果队列超前一帧（prog<0 不该发生）也不要往回拖。 */
    const prog=clamp((actx.currentTime-head.time)/dur+1,0,4);
    s+=prog;
  }
  const x=labW+s*cw;
  const xAt=labW+w*FOLLOW_FRAC;
  const max=Math.max(0,proj.steps*cw+labW-w);
  /* 用"当前 scrollLeft 下指针相对 4/5 的偏差"来推，而不是直接 x-xAt：
     这样后退（seek 到更早 / 循环回到开头）也能被纠回阈值处，不会让指针悄悄停在阈值左边。 */
  const target=clamp(x-xAt,0,max);
  if(Math.abs(target-(tl.scrollLeft||0))>=0.5)tl.scrollLeft=target;
}
function followPinLoop(){
  followPinRaf=0;
  if(!followOn||!(Play.playing&&actx)){followPinOn=false;return}
  pinStep();
  followPinRaf=requestAnimationFrame(followPinLoop);
}
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
  const tl=document.getElementById('timeline');
  if(!tl)return;
  const {cw,labW}=stepXAt();
  const w=tl.clientWidth||0;
  if(!w||!cw)return;
  const x=labW+step*cw;
  const xAt=labW+w*FOLLOW_FRAC;
  /* 未到阈值：只有**已经从左侧接近**时才不干预（否则会往回跳）。
     已经处于钉住态时即使 x 略小于阈值也继续推进，pinStep 会把位置纠回阈值。 */
  if(x<xAt&&!followPinOn)return;
  followPinOn=true;
  /* 进入钉住态后交给 rAF 每帧推进（见 pinStep 注释：只在步号变化时推 = 仍会一跳一跳）。
     这里先立即推一次，避免"越过阈值的那一帧"还没动。 */
  pinStep();
  if(!followPinRaf)followPinRaf=requestAnimationFrame(followPinLoop);
}
/* 停止/换曲时收掉自动滚动的 rAF（engine 经 playheadHooks 调用，见文件末尾注册） */
export function stopFollowScroll(){ stopFollowPin(); lastFollowed=-1 }
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
  if (!(Play.playing && actx) || (typeof document !== 'undefined' && document.hidden)) { stopFollowPin(); _visOn = false; return; }
  requestAnimationFrame(visLoop);
  wakeViz();                        // 顶栏频谱只有播放时才有意义，跟着播放头一起跑
  /* 队列排空：**合并成一帧一次 DOM 更新**。
     原实现在 while 里对每个到期步都调一遍 glowStepCells+updatePos+followScroll ——
     正常每帧只有 0~1 步，看不出问题；但主线程一旦被卡住（GC / 布局重算 / 用户操作），
     队列会积压好几步，于是一帧内连着做 N 次 DOM 写 + N 次滚动重定位 =
     "越卡越卡"的正反馈（这也是用户反馈"操作太快也会卡"的一部分成因）。
     现在只取**最后一个到期步**做一次 UI 更新：中间那些步的视觉效果本来也会被同一帧覆盖掉，
     合并后画面完全等价，但 DOM 写入次数从 N 次降到 1 次。 */
  const now = actx.currentTime;
  let last = null;
  while (Play.q.length && Play.q[0].time <= now + 0.004) last = Play.q.shift();
  if (last) {
    Play.uiStep = last.step;
    glowStepCells(last.step); updatePos(last.step); followScroll(last.step);
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
  const labW=labWidthPx()||96;   // 同上：走布局缓存，不在这里 getComputedStyle
  const x=clientX-r.left-(labW+5); // 标尺最左侧的空白格(--labW+5px)之后的第一个步进列
  let s=Math.floor(x/cw);
  if(x<0)s=0;
  seekToStep(s);
}
/* 起播（seek 后从指定位置开始）============================================
   起播的异步等待/令牌/超时兜底统一收敛在 engine.js 的 beginScheduling()，
   这里只负责"立起正在播的标记 + 设好起点 + 交给它排程"。
   注意顺序：先把 Play.playing 立起来再 ensureAudio（它会 cancelAudioSleep），
   否则排队中的挂起回调可能把刚唤醒的上下文又挂起（表现为"播放头在动但没声音"）。 */
export function startFromStep(){
  setAudioBusy(true);
  if(!ensureAudio()){setAudioBusy(false);return}
  Play.hasStarted=true;   // 已经开始走过带：之后暂停再播放要从当前位置继续，而不是归零
  Play.playing=true;
  setPlayUI(true);
  wakeVis();              // 播放头 UI 循环按需点火（见 visLoop 注释）
  beginScheduling();      // 见 engine.js：await resume 确认 running 后才 setGate + 排第一批音符
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
/* 点火 / 收火：**所有**进入播放的路径最后都会调 setPlayUI(true)
   （togglePlay 走它、startFromStep 走它），所以把 wakeVis 挂在这里最稳 ——
   挂在 updatePos 上会漏掉 togglePlay（它只调 setPlayUI，不调 updatePos），
   挂在 startFromStep 上则会漏掉主播放按钮。
   反过来，**所有**停止路径（pausePlay / stopPlay / finishSong）都会调 setPlayUI(false)，
   所以自动滚动的 rAF 也在这里收掉 —— 只挂在 setPlayUI 上不会打断滚动中的续期
   （glowStepCells 每步都调 clearStepGlow，不能挂那儿，否则每步重置跟随状态）。 */
function setPlayUIAndWake(on){ if(on)wakeVis(); else stopFollowScroll(); setPlayUI(on); }
hooks.seek={updateSeekUI,resetGlow,glowCol};
Object.assign(playheadHooks,{setPlayUI:setPlayUIAndWake,clearStepGlow,updatePos,glowStepCells,followScroll,visLoop,wakeVis});
