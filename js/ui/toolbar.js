/* [toolbar.js] source: Pro.html 870-921, 3002-3229, 4593-4607, 4881-4950, 4952-5002
   （顶栏控件/菜单/音轨按钮/拍号/帮助/快捷键；最上层 UI 模块，可 import 其余 ui 模块） */
import { proj, setProj, actx, A, uiZoom, setUiZoom, uiTab, setUiTab, selTrack, stepsPerQuarter, stepsPerBeat, meterN, meterD, meterLabel, SPB, beatSteps, barSeconds, isStraightFourFour, aiMeterOK, fmtPos, stepDurNow, stepWidth, effStepWidth, ensurePatSizes, pruneTrackPrec, patRows, allocPat, rowMidi, newTrack, uid, blankProject, applyTrackPatSize, demoProject, MAX_BARS, ZOOM_MIN } from '../core/state.js';
import { PREC_U_PER_STEP, KIT, ROLES, ENGINE_NAMES, ENGINE_DEF, ROLE_VOL, KEY_NAMES, SCALES, SCALE_NAMES, MEL_ROWS, noteNameOf, keyBaseMidi, midiOfRow, octRowsOf, trackRows, setAcc } from '../core/theory.js';
import { $, $$, el, clamp, ri, rf, pick, chance, lerp, pad2, debounce, makeRng, toast, icon, UI, downloadBlob, exportProgressElEnsure, exportProgressStart, exportProgressSet, exportProgressStop, hooks } from '../core/util.js';
import { LS_KEY, LIB_KEY, libRead, libWrite, libMeta } from '../core/storage.js';
import { eqState, applyEqUI, getTrackBus, numSafe, noiseBuf, makeIR, buildGraph, applyTrackVolBus, ensureAudio, setMasterVol, setGate } from '../audio/master.js';
import { VOICE_LIMIT, PARTIALS, ORG_GAIN, synthVoice, clickVoice, auditionTrack } from '../audio/synth.js';
import { KIT_COLORS, drumVoice, metronomeClick } from '../audio/drum.js';
import { Play, metroOn, setMetroOn, loopOn, setLoopOn, rebuildEvents, fireStep, tickSched, finishSong, togglePlay, stopPlay } from '../audio/engine.js';
import { encodeWav, exportWavRender } from '../audio/render.js';
import { AI, AI_STYLES, SEC_NAME, aiSeedLocked, setAiSeedLocked, planSections, barDyn } from '../ai/styles.js';
import { aiComposeAll, aiRegenTrack, aiExtendTrack, aiStyleTransfer } from '../ai/compose.js';
import { serializeProject, applyProjectData, autosaveNow, loadAutosave, quickSave, quickLoad, saveProjectFile, onFileImport, undoH, pendingPre, setPendingPre, beginEdit, commitEdit, doUndo, doRedo, pushSnap, refreshUndoUI, restoreSnapshot, stopIfPlaying, afterLoad, markDirtyUI } from '../io/project.js';
import { shareLink, loadShareFromHash } from '../io/share.js';
import { exportMidiUI, importMidiUI } from '../io/midi.js';
import { exportWavUI } from '../io/wav.js';
import { structural, paintAll, relabelRows, zoomAround, zoomFitWindow, autoFitZoom, setDrawTool, drawTool, clearRegionUI, copyRegion, pasteRegion, updClipUI, updateRhythmUI, applyQuantize, updateQuantEst, convertRegionRhythm, cellPaintStart, cellPaintMove, cellPaintEnd, previewDrum, regionSel } from './timeline.js';
import { setTab, renderInspector, randomizePatch } from './sidebar.js';
import { updateSeekUI, seekToStep, bindScrubber, followOn, setFollowOn } from './seek.js';
import { renderPiano, sizePianoKeys, alignPianoToTrack, pianoOctMove, onKey, onKeyUp, bindPiano } from './piano.js';

export function refreshMeterUI(){
  const el=document.getElementById('meterSel');
  if(el)el.value=meterLabel();
}
/* ---------- 拍号：按小节重排现有内容后切换 ---------- */
export function applyMeter(n,d){
  n=clamp(Math.round(n),1,16);
  d=([1,2,4,8,16].indexOf(d)>=0)?d:4;
  if(n===meterN()&&d===meterD())return;
  const oldSPB=Math.max(1,SPB()),oldBars=Math.max(1,Math.round(proj.steps/oldSPB));
  beginEdit();
  proj.meterN=n;proj.meterD=d;
  const newSPB=Math.max(1,SPB());
  const newBars=Math.min(MAX_BARS,oldBars);
  const newSteps=newBars*newSPB;
  proj.tracks.forEach(t=>{
    const rows=patRows(t);
    const np=Array.from({length:newSteps},()=>new Array(rows).fill(0));
    for(let s=0;s<Math.min(proj.steps,newSteps);s++){
      const bar=Math.floor(s/oldSPB),inBar=s%oldSPB;
      if(inBar>=newSPB)continue; // 缩短小节时丢弃溢出的格子
      const dst=bar*newSPB+inBar;if(dst>=newSteps)continue;
      const col=t.pat[s];if(!col)continue;
      for(let r=0;r<Math.min(rows,col.length);r++)if(col[r]>0)np[dst][r]=col[r];
    }
    t.pat=np;
    if(t.prec&&t.prec.length){ // 精确时值音符按小节等比重定位
      const out=[],perBarU=newSPB*PREC_U_PER_STEP,oldBarU=oldSPB*PREC_U_PER_STEP,defU=PREC_U_PER_STEP;
      t.prec.forEach(p=>{
        const st=Math.floor(p.u/PREC_U_PER_STEP),bar=Math.floor(st/oldSPB),inU=p.u-bar*oldBarU;
        if(bar>=newBars)return;
        const nu=bar*perBarU+Math.round(inU*newSPB/oldSPB);
        if(nu+(p.durU||defU)<=bar*perBarU+perBarU)out.push({row:p.row,u:nu,durU:p.durU||defU,vel:p.vel});
      });
      t.prec=out;
    }
    /* 升降号按“小节内位置”跟着音符一起重定位（与上面 pat 同一套换算）：
       小节被缩短而丢掉的格子，其记号也一并丢弃；没被丢的记号必须跟到新步号上，
       否则新位置的音会丢掉记号、旧位置的空格会留下幽灵 ♯。 */
    if(t.acc&&Object.keys(t.acc).length){
      const src=t.acc;t.acc={};
      for(const k in src){
        const s=+k,bar=Math.floor(s/oldSPB),inBar=s%oldSPB;
        if(inBar>=newSPB)continue;
        const dst=bar*newSPB+inBar;
        if(dst>=newSteps)continue;
        for(const rr in src[k])setAcc(t,dst,+rr,src[k][rr]);
      }
    }
  });
  proj.steps=newSteps;
  ensurePatSizes();
  commitEdit();
  structural(true);rebuildEvents();syncAllUI();markDirtyUI();
  refreshMeterUI();
  toast('已切换拍号 '+meterLabel()+'：每小节 '+SPB()+' 步 · 每拍 '+beatSteps()+' 步（内容按小节重排，可 Ctrl+Z 撤销）','ok');
}
export function setMeterFromUI(){
  const el=document.getElementById('meterSel');
  if(!el)return;
  const p=String(el.value||'4/4').split('/');
  const n=parseInt(p[0],10),d=parseInt(p[1],10);
  if(!n||!d){refreshMeterUI();return}
  applyMeter(n,d);
}
/* ---------- 顶部控件 ---------- */
/* =========================================================================
   侧栏（批 C 后补）：浮动覆盖层（Figma 式）—— 绝对定位盖在主区上方，主区宽度恒定不变。
   默认收起（首次访问），展开状态记在 localStorage.mpSidebarOpen；只切 .open 类，不改 id/class 命名。
   ========================================================================= */
const SIDE_KEY='mpSidebarOpen';
function readSideOpen(){
  try{ return localStorage.getItem(SIDE_KEY)==='1' }catch(e){ return false }   // 无值 / 读不到 → 收起
}
function setSideOpen(on,persist){
  if(!UI.side)return;
  UI.side.classList.remove('hidden');          // 兼容旧机制留下的 .hidden（display:none 会盖掉覆盖层）
  UI.side.classList.toggle('open',!!on);
  const btn=$('#sideToggle');
  if(btn){
    btn.classList.toggle('on',!!on);
    btn.setAttribute('aria-expanded',on?'true':'false');
    btn.title=on?'收起右侧面板':'展开右侧面板';
  }
  if(persist!==false){ try{ localStorage.setItem(SIDE_KEY,on?'1':'0') }catch(e){} }
}

export function bindTopControls(){
  const syncBpm=v=>{proj.bpm=v;UI.bpm.value=v;UI.bpmNum.value=v;setPosStatus('BPM '+v,1200);if(A&&A.dl)A.dl.delayTime.value=Math.min(1.5,barSeconds()/2)};
  UI.bpm.addEventListener('input',()=>syncBpm(+UI.bpm.value));
  UI.bpmNum.addEventListener('change',()=>syncBpm(clamp(+UI.bpmNum.value||100,40,220)));
  const syncSw=()=>{const v=+UI.swing.value;proj.swing=v;UI.swingV.textContent=v+'%'};
  UI.swing.addEventListener('input',syncSw);
  const setBars=b=>{
    beginEdit();
    proj.steps=clamp(Math.round(b),1,MAX_BARS)*SPB();
    syncBarsUI();
    if(Play.playing){stopPlay();setTimeout(togglePlay,60)}
    if(Math.round(proj.steps/SPB())>=32)autoFitZoom(); // 长曲：先按需缩小视图，再统一重绘一次
    structural(true);renderInspector();rebuildEvents();markDirtyUI();
    commitEdit();
  };
  function syncBarsUI(){
    const b=Math.max(1,Math.round(proj.steps/SPB()));
    if(UI.barsN){UI.barsN.value=b;if(UI.barsV)UI.barsV.textContent=b}
  }
  UI.barsN.addEventListener('change',()=>setBars(+UI.barsN.value||4));
  UI.barsN.addEventListener('input',()=>{const v=clamp(+UI.barsN.value||1,1,MAX_BARS);if(UI.barsV)UI.barsV.textContent=v});
  // 小节 +/-：支持“长按连续增减”；键盘/触屏单击仍只加一次
  const setBarsRel=d=>setBars(clamp(Math.round(proj.steps/SPB())+d,1,MAX_BARS));
  let barHoldT=null,barClickGuard=false;
  const barHoldEnd=()=>{if(barHoldT){clearInterval(barHoldT);barHoldT=null}};
  const barHoldStart=(d,ev)=>{
    ev.preventDefault();barClickGuard=true;setBarsRel(d);
    barHoldEnd();barHoldT=setInterval(()=>setBarsRel(d),280);
  };
  UI.barPlus.addEventListener('click',()=>{if(barClickGuard){barClickGuard=false;return}setBarsRel(1)});
  UI.barMinus.addEventListener('click',()=>{if(barClickGuard){barClickGuard=false;return}setBarsRel(-1)});
  UI.barPlus.addEventListener('pointerdown',e=>barHoldStart(1,e));
  UI.barMinus.addEventListener('pointerdown',e=>barHoldStart(-1,e));
  ['pointerup','pointercancel','pointerleave'].forEach(ev=>{
    UI.barPlus.addEventListener(ev,barHoldEnd);UI.barMinus.addEventListener(ev,barHoldEnd);
  });

  // 回到开头
  const toStart=$('#toStartBtn');
  if(toStart)toStart.addEventListener('click',()=>{seekToStep(0);toast('已回到开头','ok')});
  // 时间线缩放
  $('#zoomIn').addEventListener('click',()=>zoomAround(uiZoom*1.3));
  $('#zoomOut').addEventListener('click',()=>zoomAround(uiZoom/1.3));
  $('#zoomFit').addEventListener('click',()=>zoomFitWindow());
  // 绘制工具切换（画笔 / 橡皮 / 选区）
  const TOOL_OF={toolPaint:'paint',toolErase:'erase',toolSel:'select'};
  const refreshToolUI=()=>{for(const id in TOOL_OF){const el=document.getElementById(id);if(el)el.classList.toggle('on',TOOL_OF[id]===drawTool)}};
  for(const id in TOOL_OF){
    const el=document.getElementById(id);
    if(!el)continue;
    el.addEventListener('click',()=>{
      if(drawTool==='select'&&TOOL_OF[id]!=='select')clearRegionUI(); // 离开选区时清高亮，剪贴板保留
      setDrawTool(TOOL_OF[id]);
      refreshToolUI();
    });
  }
  // 复制 / 粘贴
  $('#copyBtn').addEventListener('click',copyRegion);
  $('#pasteBtn').addEventListener('click',pasteRegion);
  updClipUI();
  UI.masterVol.addEventListener('input',()=>{const v=+UI.masterVol.value/100;proj.masterVol=v;UI.masterV.textContent=Math.round(v*100);setMasterVol(v)});
  UI.playBtn.addEventListener('click',()=>{ togglePlay(); syncPosStatus() });
  UI.metroBtn.addEventListener('click',()=>{setMetroOn(!metroOn);UI.metroBtn.classList.toggle('on',metroOn)});
  UI.loopBtn.addEventListener('click',()=>{setLoopOn(!loopOn);UI.loopBtn.classList.toggle('on',loopOn);toast(loopOn?'整曲循环播放':'单次播放（播完自动停止）')});
  $('#brandBtn').addEventListener('click',()=>{ setSideOpen(true); setTab('ai') });
  UI.aiBtn.addEventListener('click',()=>{ setSideOpen(true); setTab('ai') });
  /* 「▤ 侧栏」= 浮动覆盖层开关（默认收起；展开 280ms/--ease-out、收起 200ms/--ease-in 在 CSS 里） */
  $('#sideToggle').addEventListener('click',()=>setSideOpen(!UI.side.classList.contains('open')));
  setSideOpen(readSideOpen(),false);          // 进页面按上次状态摆好（首次访问 = 收起；不重复写库）
  $$('#sideTabs')?.forEach(()=>{});
  UI.sideTabs.forEach(b=>b.addEventListener('click',()=>setTab(b.dataset.tab)));
  // 菜单
  UI.menuBtn.addEventListener('click',e=>{
    e.stopPropagation();
    const editMenu=$('#editMenu');
    if(editMenu)editMenu.classList.remove('open');       // 批 C：两个顶栏菜单互斥，不会同时挂着
    UI.menu.classList.toggle('open');
  });
  document.addEventListener('click',()=>UI.menu.classList.remove('open'));
  UI.menu.addEventListener('click',e=>{const mi=e.target.closest('.mi');if(!mi)return;UI.menu.classList.remove('open');actMenu(mi.dataset.act)});
  /* 批 C 第三部分：「编辑 ▾」菜单（人性化力度 / 随机音色 / 清空选中轨 / 跟随 从常驻收进来）。
     开关方式与主菜单完全一致（点按钮展开、点别处收起、Esc 收起），4 个按钮的 id 与监听一行没改。 */
  const editBtn=$('#editBtn'),editMenu=$('#editMenu');
  if(editBtn&&editMenu){
    editBtn.addEventListener('click',e=>{
      e.stopPropagation();
      const open=!editMenu.classList.contains('open');
      UI.menu.classList.remove('open');
      editMenu.classList.toggle('open',open);
      editBtn.setAttribute('aria-expanded',open?'true':'false');
      if(open)editMenu.querySelector('.mi').focus();      // 键盘：打开即把焦点送进菜单第一项
    });
    document.addEventListener('click',()=>{
      if(!editMenu.classList.contains('open'))return;
      editMenu.classList.remove('open');
      editBtn.setAttribute('aria-expanded','false');
    });
    document.addEventListener('keydown',e=>{
      if(e.key!=='Escape'||!editMenu.classList.contains('open'))return;
      e.preventDefault();
      editMenu.classList.remove('open');
      editBtn.setAttribute('aria-expanded','false');
      editBtn.focus();                       // 键盘可回：关掉菜单后焦点回到触发按钮
    });
  }
  // 轨道列绘制
  const tl=$('#timeline');
  tl.addEventListener('pointerdown',cellPaintStart);
  tl.addEventListener('pointermove',cellPaintMove);
  tl.addEventListener('pointerup',cellPaintEnd);
  tl.addEventListener('pointerleave',cellPaintEnd);
  tl.addEventListener('contextmenu',e=>{if(e.target.closest('.pc'))e.preventDefault()});
  UI.humanBtn.addEventListener('click',humanizeAll);
  UI.randPatchBtn.addEventListener('click',()=>{
    const t=selTrack();
    if(t&&t.kind==='mel'){
      beginEdit();randomizePatch(t);structural(true);renderInspector();commitEdit();
    }else toast('请先选中一条旋律类音轨');
  });
  $('#undoBtn').addEventListener('click',doUndo);
  $('#redoBtn').addEventListener('click',doRedo);
  $('#quantBtn').addEventListener('click',applyQuantize);
  const qgEl=document.getElementById('quantGrid'),qsEl=document.getElementById('quantStr');
  if(qgEl)qgEl.addEventListener('change',updateQuantEst);
  if(qsEl)qsEl.addEventListener('input',updateQuantEst);
  try{updateQuantEst()}catch(e){}
  // 选区节奏细分：2/3/4/5/6 连音 或 还原为网格
  const rhSel=document.getElementById('rhythmSel'),rhBtn=document.getElementById('rhythmBtn');
  if(rhBtn)rhBtn.addEventListener('click',()=>convertRegionRhythm(rhSel?parseInt(rhSel.value,10):3));
  try{updateRhythmUI()}catch(e){}
  // 拍号
  const meterSel=document.getElementById('meterSel');
  if(meterSel){meterSel.addEventListener('change',setMeterFromUI);refreshMeterUI()}
  // 均衡 / 限制器
  const eqPanel=$('#eqPanel');
  if($('#eqBtn')){
    $('#eqBtn').addEventListener('click',e=>{e.stopPropagation();eqPanel.classList.toggle('open')});
    const bindEq=(id,key)=>{const el=document.getElementById(id);el.addEventListener('input',()=>{const v=+el.value;eqState[key]=v;const lb=document.getElementById(id+'V');if(lb)lb.textContent=v;applyEqUI();});};
    bindEq('eqL','l');bindEq('eqM','m');bindEq('eqH','h');
    const limEl=document.getElementById('eqLim');
    limEl.addEventListener('input',()=>{eqState.lim=+limEl.value>0.5?1:0;const lb=document.getElementById('eqLimV');if(lb)lb.textContent=eqState.lim?'开':'关';applyEqUI();});
    document.addEventListener('click',()=>eqPanel.classList.remove('open'));
  }
  UI.clearSelBtn.addEventListener('click',clearSelTrack);
  const followBtn=$('#followBtn');
  followBtn.addEventListener('click',()=>{
    setFollowOn(!followOn);
    followBtn.classList.toggle('on',followOn);
    toast(followOn?'播放时自动跟随进度':'已关闭自动跟随（可手动拖进度条）');
  });
  // 时间线滚轮：默认横向滚动；Ctrl/⌘+滚轮 = 缩放
  const tlw=$('#timeline');
  tlw.addEventListener('wheel',e=>{
    if(e.ctrlKey||e.metaKey){
      e.preventDefault();
      const z=uiZoom*(e.deltaY<0?1.2:1/1.2);
      zoomAround(clamp(z,ZOOM_MIN,8));
      return;
    }
    if(Math.abs(e.deltaY)>Math.abs(e.deltaX)){
      tlw.scrollLeft+=e.deltaY;
      e.preventDefault();
    }
  },{passive:false});
  // 顶栏快捷键调式
  buildKeyBar();
  // 键盘快捷键
  document.addEventListener('keydown',onKey);
  document.addEventListener('keyup',onKeyUp);
  bindScrubber();
}
export function buildKeyBar(){
  const box=UI.keyInfo;box.innerHTML='';
  box.classList.add('keyBar');
  box.appendChild(el('span','miniLbl','调性'));
  const kSel=el('select','miniSel');
  KEY_NAMES.forEach(n=>{const o=el('option','',n==='C'?n+' (默认)':n);o.value=n;if(n===proj.key)o.selected=true;kSel.appendChild(o)});
  box.appendChild(kSel);
  box.appendChild(el('span','miniLbl','音阶'));
  const mSel=el('select','miniSel');
  for(const k in SCALES){const o=el('option','',SCALE_NAMES[k]);o.value=k;if(k===proj.mode)o.selected=true;mSel.appendChild(o)}
  box.appendChild(mSel);
  box.appendChild(el('span','miniLbl','八度'));
  const oSel=el('select','miniSel');
  for(let o=2;o<=6;o++){const op=el('option','',o);op.value=o;if(o===proj.keyOct)op.selected=true;oSel.appendChild(op)}
  box.appendChild(oSel);
  const apply=()=>{
    proj.key=kSel.value;proj.mode=mSel.value;proj.keyOct=+oSel.value;
    structural(true);renderInspector();markDirtyUI();
  };
  kSel.addEventListener('change',apply);mSel.addEventListener('change',apply);oSel.addEventListener('change',apply);
}
export function actMenu(act){
  switch(act){
    case 'addLead':addTrack('mel','lead');break;
    case 'addArp':addTrack('mel','arp');break;
    case 'addPad':addTrack('mel','pad');break;
    case 'addChord':addTrack('mel','chord');break;
    case 'addBass':addTrack('mel','bass');break;
    case 'addDrum':addTrack('drum','drum');break;
    case 'saveFile':saveProjectFile();break;
    case 'loadFile':UI.fileIn.click();break;
    case 'quickSave':quickSave();break;
    case 'quickLoad':quickLoad();break;
    case 'exportWav':exportWavUI();break;
    case 'exportMidi':exportMidiUI();break;
    case 'importMidi':$('#midiFileIn').click();break;
    case 'shareLink':shareLink();break;
    case 'help':showHelp();break;
    case 'clearAll':clearAll();break;
  }
}
export function addTrack(kind,role){
  beginEdit();
  const t=newTrack(kind,role);
  proj.tracks.push(t);
  ensurePatSizes();
  proj.sel=proj.tracks.length-1;
  structural(true);
  renderInspector();
  commitEdit();
  toast('已添加「'+(kind==='drum'?'鼓组':(ROLES[role]||ROLES.custom).name)+'」音轨','ok');
}
export function delTrack(ti){
  if(!proj.tracks[ti])return;
  if(!confirm('确定删除音轨「'+proj.tracks[ti].name+'」？'))return;
  beginEdit();
  proj.tracks.splice(ti,1);
  if(proj.sel>=proj.tracks.length)proj.sel=proj.tracks.length-1;
  structural(true);renderInspector();markDirtyUI();commitEdit();
}
export function clearSelTrack(){
  const t=selTrack();if(!t)return toast('未选中音轨');
  beginEdit();
  const rows=patRows(t);
  for(let s=0;s<proj.steps;s++)for(let r=0;r<rows;r++)t.pat[s][r]=0;
  if(t.prec)t.prec=[]; // 连节奏细分的精确音符一起清
  if(t.acc)t.acc={};   // 升降号也一起清（否则会在空格上留下幽灵 ♯，且下次画音会“继承”旧记号）
  paintAll();rebuildEvents();markDirtyUI();commitEdit();toast('已清空「'+t.name+'」');
}
export function clearAll(){
  if(!proj.tracks.length)return;
  if(!confirm('确定清空全部音轨？'))return;
  beginEdit();
  proj.tracks=[];proj.sel=-1;
  structural(true);renderInspector();commitEdit();toast('已清空全部音轨');
}
export function humanizeAll(){
  beginEdit();
  let n=0;
  proj.tracks.forEach(t=>{
    const rows=patRows(t);
    for(let s=0;s<proj.steps;s++)for(let r=0;r<rows;r++){
      const v=t.pat[s][r];if(v>0){t.pat[s][r]=clamp(v*(.6+Math.random()*.4),.12,1);n++}
    }
  });
  paintAll();rebuildEvents();commitEdit();toast('人性化处理 '+n+' 个音符','ok');
}
/* 批 C 第三部分：走带区副行改作"操作状态"（原来显示 BPM/拍号，现已在顶栏数值处各有一份）。
   keepMs>0 时到点自动交还给播放状态，避免临时提示把状态顶掉。 */
let posStatusTimer=0;
export function setPosStatus(text,keepMs){
  if(!UI.posSub)return;
  UI.posSub.textContent=text||'就绪';
  if(posStatusTimer){clearTimeout(posStatusTimer);posStatusTimer=0}
  if(keepMs)posStatusTimer=setTimeout(()=>{posStatusTimer=0;setPosStatus(posStatusKey())},keepMs);
}
function posStatusKey(){ return Play.playing?'播放中':(Play.hasStarted?'已暂停':'就绪') }
/** 播放/暂停时空档的"人去楼空感"：状态词跟着走一遍（engine.js 在曲终会写"已结束"） */
function syncPosStatus(){ if(!posStatusTimer)setPosStatus(posStatusKey()) }
export function syncBpmUI(){
  UI.bpm.value=proj.bpm;UI.bpmNum.value=proj.bpm;
  /* 原来这里写 "BPM n · 拍号 · n 小节" 到走带区副行；批 C 起 BPM/拍号只在顶栏数值处出现，
     副行留给操作状态（载入/播放/结束等），所以这里不再写 BPM 文案。 */
}
export function syncAllUI(){
  syncBpmUI();
  refreshMeterUI();
  UI.swing.value=proj.swing;UI.swingV.textContent=proj.swing+'%';
  if(UI.barsN){UI.barsN.value=Math.max(1,Math.round(proj.steps/SPB()));UI.barsV.textContent=Math.max(1,Math.round(proj.steps/SPB()));}
  UI.masterVol.value=Math.round(proj.masterVol*100);UI.masterV.textContent=Math.round(proj.masterVol*100);
  setMasterVol(proj.masterVol);
}
export function showHelp(){
  const content=`
    <div style="font-size:17px;font-weight:800;margin-bottom:2px">${icon('keys')} 智能音乐工坊 PRO — 使用教程</div>
    <div style="font-size:11.5px;color:var(--dim);margin-bottom:12px">Web Audio 在线音乐工作站 · 纯本地合成 · 无需联网</div>

    <div class="h2">① 快速开始</div>
    <div class="small" style="line-height:1.9">
      ・ 点右侧 <b style="color:var(--acc)">${icon('sparkle')} AI 作曲</b> → 选风格、调情绪、点「一键成曲」→ <kbd>空格</kbd> 播放。<br>
      ・ 顶部<b>曲长·小节</b>可 1–${MAX_BARS} 小节自由加减；AI 会按「引子→发展→高潮→尾声」自动编曲。<br>
      ・ <b>${icon('loop')} 循环</b>开=整曲循环；关=单次播放，播完自然淡出收尾。
    </div>

    <div class="h2">② 手动编辑（时间线）</div>
    <div class="small" style="line-height:1.9">
      ・ 旋律轨按音阶度数分行（转调自动跟随），鼓组 8 行合成鼓；点行名可试听。<br>
      ・ <span style="color:var(--acc)">左键拖拽</span>画音符（从亮格拖=擦除）· <b>右键</b>打开音符菜单（♯ 升 / ♭ 降 / ♮ 还原 / ✕ 擦除 / ↩ 撤销）· <b>Shift+单击亮音</b>=切重音/普通。<br>
      ・ <b>加升降号</b>：点中一个音符格，<kbd>Shift+↑</kbd> 升半音、<kbd>Shift+↓</kbd> 降半音；再按反方向=还原成自然音（♮）。<b>先框选一段</b>再按，则整段一起改。<br>
      ・ <b>右键音符</b>=弹出菜单：♯ 升半音 / ♭ 降半音 / ♮ 还原 / ✕ 擦除音符 / ↩ 撤销（擦除已收进菜单；左键从亮格拖、或橡皮工具仍是直接擦除）。<br>
      ・ <b>格子太小点不准？</b>Ctrl+滚轮 或点顶部 <b>−/100%/＋/⤢适配</b> 缩放（Ctrl±、Ctrl+0 复位）。<br>
      ・ <b>拍号</b>：顶部左侧可选 <b>4/4 · 3/4 · 2/4 · 6/8 · 5/4 · 7/8 · 12/8</b>；切换会按小节重排现有音符（Ctrl+Z 可撤销），标尺/节拍器/位置显示/WAV 与 MIDI 导出都会自动跟随。<br>
      ・ <b>${icon('music')} 节奏细分（连音）</b>：先用 ${icon('marquee')}/Shift <b>框选整数拍</b>（起点对齐步 0/4/8/12…），再到顶部量化按钮旁选 <b>2/3/4/5/6 连音</b> 并点「${icon('quaver')} 应用细分」——选区里每拍的起音会变成 N 个<b>等长精确时值</b>（各 1/N 拍，2/3/4/5/6 全部无浮点误差），MIDI 导出按真实比例（3 连音 = 160 tick）；选「还原为网格」可回到普通格子（可 Ctrl+Z）。轨道页侧栏「${icon('quaver')} 节奏细分」是同一功能。<br>
      ・ <b>${icon('marquee')} 框选区域</b>：点 ${icon('marquee')} 选区 后<b>拖动</b>才框选；<b>单击</b>（手抖几像素也算单击）= 只选<b>这一列（1 步）</b>；任意工具下<b>按住 Shift 拖动</b>同样能框选（状态条显示范围与音符数，Esc 取消）。选区覆盖该轨<b>所有行</b>、只按步算，竖带只在你真的框了多步时才出现。<br>
      ・ <b>${icon('copy')} 复制 / ${icon('paste')} 粘贴（Ctrl+C / Ctrl+V）</b>：框选一段 → 复制 → 把<b>播放头</b>移到目标轨起点（或按住 <b>Alt</b> 单击目标格直接定位）→ 粘贴；越界自动加小节，旋律/鼓不能混贴。<br>
      ・ <b>${icon('target')} 量化</b>：选 1/8 / 1/4 网格与强度后点「吸附」。<b>没有选区=整首量化；先用 ${icon('marquee')}/Shift 框选一段=只量化那一段</b>。点吸附前会实时显示“预计移动 ~N 处”；完成后被移动/合并的音符会<b>闪绿</b>，结果条会说明“移动 N 处、去重合并 M 处”，可 Ctrl+Z 撤销。<br>
      ・ 顶部<b>进度条</b>点击/拖动可任意跳转；标尺也可拖动定位。<br>
      ・ <b>${icon('undo')} 撤销 / ${icon('redo')} 重做</b>（Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y）覆盖大部分操作。
    </div>

    <div class="h2">${icon('music')} 半音记号（♯ / ♭）</div>
    <div class="small" style="line-height:1.9">
      ・ 每个音符都可以带一个记号：<b>♯</b>=升半音、<b>♭</b>=降半音，音高按“该行自然音级 ±1 半音”计算。<br>
      ・ 有记号的格子在<b>右上角</b>显示 ♯ / ♭ 并带一圈淡淡的内描边；最近点中的那一格（焦点格）另有一圈主题色外环。<br>
      ・ 左侧行标签始终显示<b>基础音名</b>（如 C）；该行有记号时后面追加灰色小记号 ♯ / ♭ —— 具体是哪个格，看格子右上角。<br>
      ・ 记号<b>跟着音符一起走</b>：量化、复制/粘贴、节奏细分（连音↔网格）、切换拍号、缩小音域都不会丢；<br>
      ・ MIDI 导出/导入<b>保留音高</b>，但记谱可能变（MIDI 只存音高：D♭ 回来可能记作 C♯，听感完全一样）。
    </div>

    <div class="h2">③ 轨道与混音</div>
    <div class="small" style="line-height:1.9">
      ・ 每条轨：音量/声像/混响/延迟发送/静音/独奏；旋律轨可调音色、滤波、包络、音区（时间线上点音轨名即打开）。<br>
      ・ <b>S 独奏</b>只放选中轨；<b>AI 重写此轨</b>只重写当前轨，不碰其它声部。<br>
      ・ 右上 <b>${icon('faders')} EQ</b>：主输出低频/中频/高频 ±12dB，外加<b>砖墙限制器</b>（可开关）防削波。
    </div>

    <div class="h2">④ 演奏</div>
    <div class="small" style="line-height:1.9">
      ・ 底部钢琴<b>按住可左右滑动连奏、松手释放</b>；电脑键盘 <kbd>A~L</kbd> 白键、<kbd>W E T Y U O P</kbd> 黑键，八度 ±。<br>
      ・ <b>${icon('target')} 对准音区</b>把键盘起点对齐到所选旋律轨，方便跟弹；<kbd>X</kbd> 试听旋律轨音符。
    </div>

    <div class="h2">⑤ ${icon('palette')} 音乐可视化（独立页面）</div>
    <div class="small" style="line-height:1.9">
      ・ 入口：菜单「${icon('chart')} 可视化」（会把当前工程复制到独立页面），或直接在那边点「${icon('contrast')} 生成封面」。<br>
      ・ 数据来源与主应用<b>完全相同</b>（同一份工程 / 同一个 localStorage 渠道），两边随时可来回切换，互不影响。
    </div>

    <div class="helpLine"><span style="color:var(--acc)">8 个实时渲染器</span><span>（顶栏下拉切换，参数在底部）</span></div>
    <div class="small" style="line-height:1.8;padding-left:12px">
      ・<b>实时波形</b>：经典时域波形，灵敏度 / 中线 / 线宽可调<br>
      ・<b>频谱瀑布</b>：彩虹热力图，频率随时间流动（历史时长 / 配色 / 锐化）<br>
      ・<b>心电图</b>：跟节拍跳动的 QRS 波，可显示心率<br>
      ・<b>雷达图</b>：频段与质心的多轴对比，带历史轨迹<br>
      ・<b>径向频谱</b>：圆形频谱环，扇形数 / 内半径 / 旋转可调<br>
      ・<b>粒子系统</b>：全屏星点，每拍点亮（密度 / 粒子大小 / 漂浮速度）<br>
      ・<b>跳动波形</b>：基线随节拍弹跳，幅度 / 弹跳力可调<br>
      ・<b>3D 频谱森林</b>：可拖拽旋转的 3D 山脉（频段数 / 历史深度 / 透视强度）
    </div>

    <div class="helpLine"><span style="color:var(--acc)">3 种图片生成器</span><span>（「生成封面」弹窗内切换）</span></div>
    <div class="small" style="line-height:1.8;padding-left:12px">
      ・<b>专辑封面</b>：3 种风格（同心声纹 / 能量砖阵 / 波形缎带），800×800，可换种子 / 曲名<br>
      ・<b>音乐指纹</b>：长条图 1920×400，含缩略频谱 + 能量曲线 + 音高分布<br>
      ・<b>分享卡片</b>：社交图 1200×630，含波形 + 关键数据（BPM / 调式 / 音符数）+ 链接
    </div>

    <div class="helpLine"><span style="color:var(--acc)">使用提示</span><span>（都在同一页内，不需要联网）</span></div>
    <div class="small" style="line-height:1.8;padding-left:12px">
      ・ 首次点「生成封面」会<b>自动分析整曲</b>：7 分钟以内的曲子约 10–30 秒，期间可用顶栏「取消」中止。<br>
      ・ 所有图片支持 <b>2× 高清导出</b>（下载按钮右侧的 ${icon('caret')} 选项菜单里勾选，或直接选「以 2× 分辨率下载」）。<br>
      ・ <b>渲染长度</b>在顶栏齿轮菜单里调（30 / 60 / 90 秒 / 全曲）：预览用 30 秒最快，分析整首前会自动补全曲渲染。<br>
      ・ 参数面板只常驻常用项，其余收在「<b>更多参数 (N)</b>」里（全部参数都保留，展开状态会记住）。<br>
      ・ <kbd>F</kbd> 切换帧率显示；帧率连续偏低时会自动浮现提醒。
    </div>

    <div class="h2">⑥ 保存 / 作品库 / 分享</div>
    <div class="small" style="line-height:1.9">
      ・ 菜单：导出工程(JSON)/导入、导出 <b>WAV / MIDI</b>、快速保存(Ctrl+S)；工程自动存档。<br>
      ・ 侧栏「<b>${icon('books')} 作品库</b>」：把编好的曲子命名保存到浏览器，随时载入/复制/删除。<br>
      ・ 菜单「复制分享链接」：<b>自动压缩</b>，别人打开链接即可还原整首工程。<br>
      ・ <b>${icon('palette')} 可视化页与主应用共享同一份工程数据</b>：主应用里改了曲子，菜单「可视化」再进一次就是最新的（那一步会把工程复制过去）。
    </div>

    <div class="h2">⑦ 快捷键一览</div>
    <div class="helpLine"><kbd>空格</kbd><span>播放 / 停止</span></div>
    <div class="helpLine"><kbd>C</kbd><span>清空当前选中音轨</span></div>
    <div class="helpLine"><kbd>Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y</kbd><span>撤销 / 重做</span></div>
    <div class="helpLine"><kbd>Ctrl+C / Ctrl+V</kbd><span>复制选区 / 粘贴</span></div>
    <div class="helpLine"><kbd>Shift+拖动 / ${icon('marquee')} 选区</kbd><span>框选一段（用于 复制 或 区域量化）</span></div>
    <div class="helpLine"><kbd>Shift+单击亮音</kbd><span>切 重音/普通 力度</span></div>
    <div class="helpLine"><kbd>Alt+单击格子</kbd><span>把该格定为“粘贴起点”</span></div>
    <div class="helpLine"><kbd>Shift+↑</kbd><span>升半音（♯）：点中音符格后按；框选后按=整段一起升</span></div>
    <div class="helpLine"><kbd>Shift+↓</kbd><span>降半音（♭）：反方向再按一次=还原成自然音</span></div>
    <div class="helpLine"><kbd>Ctrl+滚轮 / Ctrl± / Ctrl+0</kbd><span>时间线缩放 / 复位</span></div>
    <div class="helpLine"><kbd>Esc</kbd><span>取消框选 / 关菜单 / 关弹窗</span></div>
    <div class="helpLine"><kbd>Ctrl+S</kbd><span>快速保存</span></div>
    <div class="helpLine"><kbd>F</kbd><span>可视化页：切换帧率显示（帧率偏低时会自动出现）</span></div>
    <div class="helpLine"><kbd>Tab</kbd><span>全站键盘导航（Tab 前进 / Shift+Tab 后退，聚焦处有蓝色外环）</span></div>
    <div style="height:1px;background:var(--line);margin:12px 0"></div>
    <div class="small" style="color:var(--dim)">小贴士：量化后看不懂？被移动的音会闪绿确认；不满意直接 Ctrl+Z。AI 高潮偶发六度/八度跳跃与模进，不满意可「换随机种子」。</div>
    <div style="margin-top:14px;text-align:right"><button class="btn acc" id="helpClose">开始创作 ${icon('music')}</button></div>`;
  /* 弹窗结构（批 C 第二部分：动效需要的两个 class 加在这里，id/class 命名不变）：
     .modal-overlay = 遮罩（420ms 淡入），.modal-card = 卡片（延迟 60ms + scale(.94) 淡入）→ 分层感。
     样式全部在 css/layout.css，JS 里不再写内联样式（否则动效没法用 token 统一管）。 */
  const ov=el('div','',`<div class="modal-overlay">
    <div class="modal-card" role="dialog" aria-modal="true" aria-label="使用教程">${content}</div>
  </div>`);
  document.body.appendChild(ov);
  /* 关闭（批 C 第四部分）：先播 200ms 淡出再移除；用 animationend 收尾而不是定时器。
     降级：reduced-motion 或浏览器不支持动画时 animationName 为 none → 直接移除（行为与以前完全一致）。 */
  let closing=false;
  const close=()=>{
    if(closing)return;
    const scrim=ov.firstElementChild;
    let animated=false;
    try{ animated=!!(scrim&&getComputedStyle(scrim).animationName&&getComputedStyle(scrim).animationName!=='none') }catch(e){}
    if(!animated){ ov.remove(); return }
    closing=true;
    scrim.classList.add('closing');
    scrim.addEventListener('animationend',()=>ov.remove(),{once:true});
    /* 兜底：万一动画被打断（例如标签页切走）也不会留一个关不掉的弹窗 */
    setTimeout(()=>{ if(ov.parentNode)ov.remove() },600);
  };
  ov.querySelector('#helpClose').addEventListener('click',close);
  ov.addEventListener('click',e=>{if(e.target===ov.firstElementChild)close()});
  const esc=e=>{if(e.key==='Escape'){close();document.removeEventListener('keydown',esc)}};
  document.addEventListener('keydown',esc);
}
export function bindExtras(){
  bindPiano(); // 钢琴键盘绑定（原 bindExtras 头部，实现在 ui/piano.js）
  UI.fileIn.addEventListener('change',onFileImport);
  $('#midiFileIn').addEventListener('change',e=>{const f=e.target.files[0];if(f)importMidiUI(f);e.target.value='';});
  $('#demoBtn').addEventListener('click',()=>{
    beginEdit();
    proj=demoProject();proj.steps=32;
    ensurePatSizes();afterLoad();commitEdit();
    toast('已载入示例工程','ok','clapper');
  });
  // 撤销 / 重做 + 复制/粘贴快捷键（在输入框/下拉里时让给文本编辑）
  document.addEventListener('keydown',e=>{
    if(!(e.ctrlKey||e.metaKey))return;
    const k=e.key.toLowerCase();
    if(k==='z'){e.preventDefault();if(e.shiftKey)doRedo();else doUndo()}
    else if(k==='y'){e.preventDefault();doRedo()}
    else if(k==='c'||k==='v'){
      const tag=(e.target&&e.target.tagName||'').toLowerCase();
      if(tag==='input'||tag==='select'||tag==='textarea')return; // 文本编辑优先
      e.preventDefault();
      if(k==='c')copyRegion();else pasteRegion();
    }
    else if(k==='='||k==='+'||k==='-'||k==='0'){
      const tag=(e.target&&e.target.tagName||'').toLowerCase();
      if(tag==='input'||tag==='select'||tag==='textarea')return;
      e.preventDefault();
      if(k==='-')zoomAround(uiZoom/1.25);
      else if(k==='0')zoomAround(1);
      else zoomAround(uiZoom*1.25);
    }
  });
  refreshUndoUI();
  // Ctrl+S
  document.addEventListener('keydown',e=>{
    if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='s'){e.preventDefault();quickSave()}
  });
}

/* 自注册（STEP 6c 收敛）：sidebar 的删除按钮经 hooks.toolbar 反向调用；
   setPosStatus 一并挂上，供 timeline.js（升降号回显）反向调用——toolbar 已 import timeline，不能再反向 import */
hooks.toolbar={delTrack,addTrack,clearAll,humanizeAll,clearSelTrack,setPosStatus};
/* 载入工程后的统一刷新（io/project 经 hooks.afterLoad 反向调用） */
export function afterProjectLoad(){ structural(true);buildKeyBar();syncAllUI();renderInspector();relabelRows(); setPosStatus('就绪'); }
