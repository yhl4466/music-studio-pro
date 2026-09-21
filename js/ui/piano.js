/* [piano.js] source: Pro.html 3613-3769, 4952-4967（底部钢琴键盘：发声/键宽/八度/键盘事件） */
import { proj, actx, A, selTrack, rowMidi, uiZoom } from '../core/state.js';
import { NOTE_SEMI, NOTE_NAMES, ENGINE_DEF, keyBaseMidi, octRowsOf, trackRows, freqOf } from '../core/theory.js';
import { $, el, clamp, chance, toast, UI, hooks } from '../core/util.js';
import { ensureAudio, setGate } from '../audio/master.js';
import { synthVoice, auditionTrack } from '../audio/synth.js';
import { togglePlay } from '../audio/engine.js';
import { regionSel, clearRegionUI, updateRegionInfo, updClipUI } from './timeline.js';

/* ---------- 底部钢琴键盘 ---------- */
/* 键盘起点（= 最左边那个 C 的 MIDI）：默认 C4。Z/X 或 ± 按钮按整八度移动，范围 C2..C6。 */
export let pianoBase=60; // C4
export const PIANO_MIN=36, PIANO_MAX=84; // 起点范围：C2 .. C6
/* 视觉音域 3 个八度（C4..C7 共 37 键）：22 个白键 + 15 个黑键。
   白键偏移 = 相对起点的半音数（每个八度 0/2/4/5/7/9/11，末尾补一个高八度根音）；
   黑键偏移 = 每八度 1/3/6/8/10。键宽由 pianoUnitW() 按容器自适应（除以 PIANO_W.length）。 */
export const PIANO_W=[0,2,4,5,7,9,11,12,14,16,17,19,21,23,24,26,28,29,31,33,35,36];
export const PIANO_B=[1,3,6,8,10,13,15,18,20,22,25,27,30,32,34];
export const KMAP={a:0,w:1,s:2,e:3,d:4,f:5,t:6,g:7,y:8,h:9,u:10,j:11,k:12,o:13,l:14,p:15,';':16};
export const KMAP_NAMES=['C','C#','D','D#','E','F','F#','G','G#','A','A#','B','C','C#','D','D#','E'];
/* 某个 MIDI 的音名（如 60 → C4）：钢琴起点标签与状态回显共用 */
export function pianoNameOf(midi){return NOTE_NAMES[((midi%12)+12)%12]+(Math.floor(midi/12)-1)}
export let pianoKeys={};
export let pianoHold={}; // off -> 持续发声句柄
export function pianoNoteOn(off,vel){
  if(!ensureAudio())return null;
  setGate(true,true);
  const midi=pianoBase+off;
  if(pianoHold[off]){try{pianoHold[off].kill()}catch(e){}} // 同音重按：先放旧
  const t=selTrack();
  const eng=(t&&t.kind==='mel'&&t.engine)?t.engine:'pluck';
  const def=ENGINE_DEF[eng];
  const h=synthVoice(actx,A.master,actx.currentTime+.012,{
    freq:freqOf(midi),vel:vel||.9,engine:eng,
    osc:(t&&t.osc)||def.osc,cut:(t&&t.cut)||def.cut,res:(t&&t.res)||def.res,
    env:{a:.004,d:.1,s:.82,r:.14}, // 键盘按住时用“类风琴持续”包络，松手才快速释音
    detune:(t&&t.detune)||def.detune,nOsc:(t&&t.nOsc)||def.nOsc,
    pan:0,rev:.16,dly:0,vol:.85,releaseOn:'manual'
  });
  pianoHold[off]=h;
  return h;
}
export function pianoNoteOff(off){
  const h=pianoHold[off];
  if(h){try{h.kill()}catch(e){}}
  delete pianoHold[off];
}
export function pianoPlay(off,vel){ // 兼容旧调用（短音）
  const h=pianoNoteOn(off,vel);
  if(h)setTimeout(()=>{try{h.kill()}catch(e){}},150);
  return h;
}
export let pianoDrag=null; // 键盘拖动滑奏状态 {off,id}
export function pianoUnitW(){
  const host=UI.pianoBar&&UI.pianoBar.clientWidth?UI.pianoBar.clientWidth:760;
  const avail=Math.max(180,Math.min(host,920));
  return clamp(Math.floor(avail/PIANO_W.length),12,34);
}
/* 自适应键宽 + 黑键定位（窗口变化时调用） */
export function sizePianoKeys(){
  const pk=UI.pKeys;if(!pk)return;
  const unit=pianoUnitW();
  pk.style.setProperty('--kw',unit+'px');
  // 3 个八度 = 22 个白键，窄屏下键宽可能只有 12~15px：名字会互相压字 → 只留每个 C 的名字（新 class，不改既有命名）
  pk.classList.toggle('narrow',unit<16);
  pk.querySelectorAll('.bkey').forEach(k=>{
    const off=+k.dataset.off;let before=0;
    for(const w of PIANO_W){if(w<off)before++}
    k.style.left=(before*unit-Math.round(unit*.31))+'px';
  });
}
/* 让键盘起点 C 对准所选旋律轨的音区（用于跟弹） */
export function alignPianoToTrack(){
  const t=selTrack();
  if(!t||t.kind!=='mel'){toast('请先选中一条旋律类音轨','err');return}
  const m0=rowMidi(t,0);
  pianoBase=clamp(Math.floor(m0/12)*12,PIANO_MIN,PIANO_MAX);
  renderPiano();
  statusOct('键盘已对准「'+(t.name||'音轨')+'」的音区，可直接跟弹');
  toast('键盘已对准「'+(t.name||'音轨')+'」的音区，可直接跟弹','ok');
}
/* 走带区状态行回显键盘起点（toolbar 的 setPosStatus 经 hooks 反向调用；不可用时静默忽略） */
function statusOct(extra){
  const name=pianoNameOf(pianoBase);
  try{hooks.toolbar?.setPosStatus?.(extra||('键盘起点：'+name),1400)}catch(e){}
}
export function renderPiano(){
  const pk=UI.pKeys;pk.innerHTML='';
  // 若仍有按住未释放的音（例如切换八度），先收声
  Object.keys(pianoHold).forEach(off=>{try{pianoHold[off].kill()}catch(e){}});
  pianoHold={};
  pianoKeys={};
  const off2name=off=>{
    const m=pianoBase+off;return NOTE_NAMES[((m%12)+12)%12]+(Math.floor(m/12)-1);
  };
  PIANO_W.forEach(off=>{
    const k=el('div','wkey'+(off%12===0?' C':''));
    k.textContent=off2name(off);
    k.dataset.off=off;
    pk.appendChild(k);
    pianoKeys[off]=k;
  });
  PIANO_B.forEach(off=>{
    const k=el('div','bkey','');
    k.dataset.off=off;
    pk.appendChild(k);
    pianoKeys[off]=k;
  });
  const ov=document.getElementById('pianoOctV');
  if(ov){ov.textContent=off2name(0);ov.title='起始音 '+off2name(0)+' 至 '+off2name(36)+'（共 3 个八度，37 键）'}
  // 事件委托：按下后可在键上左右滑动连奏（滑到哪个键就发哪个音）
  if(!pk._bound){
    pk._bound=true;
    pk.addEventListener('pointerdown',e=>{
      const k=e.target&&e.target.closest?e.target.closest('.wkey,.bkey'):null;
      if(!k)return;
      e.preventDefault();
      try{pk.setPointerCapture&&pk.setPointerCapture(e.pointerId)}catch(err){}
      const off=+k.dataset.off;
      k.classList.add('down');
      pianoNoteOn(off,.92);
      pianoDrag={off,id:e.pointerId};
    });
    pk.addEventListener('pointermove',e=>{
      if(!pianoDrag||e.pointerId!==pianoDrag.id)return;
      const under=document.elementFromPoint?document.elementFromPoint(e.clientX,e.clientY):null;
      const k=under&&under.closest?under.closest('.wkey,.bkey'):null;
      if(!k)return;
      const off=+k.dataset.off;
      if(off===pianoDrag.off)return;
      const old=pianoKeys[pianoDrag.off];
      if(old)old.classList.remove('down');
      pianoNoteOff(pianoDrag.off);
      k.classList.add('down');
      pianoNoteOn(off,.92);
      pianoDrag.off=off;
    });
    const pianoUp=e=>{
      if(!pianoDrag||e.pointerId!==pianoDrag.id)return;
      const k=pianoKeys[pianoDrag.off];
      if(k)k.classList.remove('down');
      pianoNoteOff(pianoDrag.off);
      pianoDrag=null;
    };
    pk.addEventListener('pointerup',pianoUp);
    pk.addEventListener('pointercancel',pianoUp);
  }
  sizePianoKeys();
}
export function pianoOctMove(d){
  const before=pianoBase;
  pianoBase=clamp(pianoBase+d*12,PIANO_MIN,PIANO_MAX);
  renderPiano();
  const name=pianoNameOf(pianoBase);
  statusOct(pianoBase===before
    ? ('键盘起点已是 '+name+'（'+(pianoBase>=PIANO_MAX?'上限 C6':'下限 C2')+'）')
    : ('键盘起点：'+name));
}
export const heldPiano={};
export function onKey(e){
  const tag=(e.target.tagName||'').toLowerCase();
  if(tag==='input'||tag==='select'||tag==='textarea'||e.ctrlKey||e.metaKey||e.altKey)return;
  const k=e.key.toLowerCase();
  if(k===' '){e.preventDefault();togglePlay();return}
  if(k==='escape'){
    if(regionSel){clearRegionUI();updateRegionInfo();updClipUI();toast('已取消选区','ok');return}
  }
  if(k==='c'&&!e.shiftKey){e.preventDefault();hooks.toolbar?.clearSelTrack?.();return}
  /* Z / X：键盘起点按整八度移动（范围 C2..C6）。按住不放不连发，免得一口气滑到边界。 */
  if(k==='z'){if(!e.repeat){e.preventDefault();pianoOctMove(-1)}return}
  if(k==='x'){if(!e.repeat){e.preventDefault();pianoOctMove(1)}return}
  /* 原“随机音高试听”从 X 挪到 R（X 已让给八度切换；该快捷键本来就没写进帮助弹窗） */
  if(k==='r'){e.preventDefault();const t=selTrack();if(t&&t.kind==='mel'){const r=Math.floor(Math.random()*trackRows(t));const m=rowMidi(t,r);auditionTrack(t,m,.9)}return}
  if(KMAP[k]!=null&&!e.repeat){
    e.preventDefault();
    heldPiano[k]=1;
    const off=KMAP[k];
    if(pianoKeys[off])pianoKeys[off].classList.add('down');
    pianoNoteOn(off,chance(.2)?.95:.8);
  }
}
export function onKeyUp(e){
  const k=e.key.toLowerCase();
  if(KMAP[k]!=null){
    heldPiano[k]=0;
    const off=KMAP[k];
    if(pianoKeys[off])pianoKeys[off].classList.remove('down');
    pianoNoteOff(off);
  }
}
export function bindPiano(){
  $('#pianoOctDown').addEventListener('click',()=>pianoOctMove(-1));
  $('#pianoOctUp').addEventListener('click',()=>pianoOctMove(1));
  const pAlign=document.getElementById('pianoAlign');
  if(pAlign)pAlign.addEventListener('click',alignPianoToTrack);
  /* Z/X 的按键说明已写进 index.html 的 .pinfo 静态文案（「…黑键 · Z/X 切八度」），
     这里不再追加 JS 提示，避免同一行出现两遍相同文字。 */
  // 窗口变化时自适应钢琴键宽（不重建，不影响正在发声的音）
  let _pianoSzT=null;
  window.addEventListener('resize',()=>{
    clearTimeout(_pianoSzT);
    _pianoSzT=setTimeout(()=>{if(UI.pKeys&&UI.pKeys.children.length)sizePianoKeys()},90);
  });
  $('#audBtn').addEventListener('click',()=>{
    const t=selTrack();
    const m=t&&t.kind==='mel'?rowMidi(t,Math.floor(trackRows(t)/2)):72;
    auditionTrack(t&&t.kind==='mel'?t:null,m,.92);
  });
}
