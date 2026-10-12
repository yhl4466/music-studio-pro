/* [project.js] source: Pro.html 2300-2349, 4723-4808（撤销栈 / 序列化 / 存档 / 导入导出 / 快照） */
import { proj, setProj, newTrack, uid, ensurePatSizes, pruneTrackPrec, meterN, meterD, SPB, MAX_BARS } from '../core/state.js';
import { PREC_U_PER_STEP, ROLES, ENGINE_DEF, setAcc, pruneAcc } from '../core/theory.js';
import { toast, downloadBlob, hooks } from '../core/util.js';
import { LS_KEY, libMeta, archiveRead, archivePush, archiveRemove, archiveClear } from '../core/storage.js';
import { Play, stopPlay, rebuildEvents } from '../audio/engine.js';

/* =========================================================================
   6b. 撤销 / 重做
   ========================================================================= */
export const undoH={stack:[],redo:[]};
export let pendingPre=null;
export function setPendingPre(v){pendingPre=v}
export function beginEdit(){ if(pendingPre===null){try{pendingPre=serializeProject()}catch(e){pendingPre=''}} }
export function commitEdit(){
  if(pendingPre===null||pendingPre==='')return;
  const pre=pendingPre;pendingPre=null;pushSnap(pre);
}
export function pushSnap(pre){
  try{
    const cur=serializeProject();
    if(cur===pre)return;
    undoH.stack.push(pre);
    if(undoH.stack.length>20)undoH.stack.shift();
    undoH.redo=[];
  }catch(e){}
  refreshUndoUI();
}
export function refreshUndoUI(){
  const u=document.getElementById('undoBtn'),r=document.getElementById('redoBtn');
  if(u)u.disabled=!undoH.stack.length;
  if(r)r.disabled=!undoH.redo.length;
}
export function stopIfPlaying(){if(Play.playing)stopPlay()}
export function restoreSnapshot(json){
  try{
    const data=JSON.parse(json);
    applyProjectData(data);
    hooks.afterLoad?.();rebuildEvents();
    refreshUndoUI();
  }catch(e){toast('恢复快照失败','err')}
}
export function doUndo(){
  if(!undoH.stack.length)return;
  stopIfPlaying();
  undoH.redo.push(serializeProject());
  const pre=undoH.stack.pop();
  restoreSnapshot(pre);
  toast('↩ 已撤销','ok');
}
export function doRedo(){
  if(!undoH.redo.length)return;
  stopIfPlaying();
  undoH.stack.push(serializeProject());
  const s=undoH.redo.pop();
  restoreSnapshot(s);
  toast('↪ 已重做','ok');
}
/* =========================================================================
   6a. 自动保存 / 自动存档
   -------------------------------------------------------------------------
   三层存法（各司其职，别混）：
     ① LS_KEY 最新存档 —— 改动后 ~900ms 防抖写一次，刷新/关页时用它恢复；关页前会强制 flush；
     ② 归档历史 ARCHIVE_KEY —— 带时间戳的多份快照，用于改坏/误操作后回退；
        间隔 <2 分钟且变化 <3% 就跳过，避免"每敲一下就存一份"把配额烧光；
     ③ 作品库 LIB_KEY —— 用户主动命名的收藏（见 sidebar 作品库）。
   对外只暴露一个"保存状态"订阅口（onSaveState/saveStatus），UI 据此显示"未保存/已自动保存"。
   为什么要有状态显示：旧实现是纯静默的，用户看不到任何反馈，于是合理地怀疑"根本没有自动保存"。
   ========================================================================= */
let _dirty=false;
let _timer=null;
let _lastSaveTs=0;
let _lastArchiveTs=0;
let _status='idle';                 // idle | pending | saved | error
let _statusMsg='';
const _saveListeners=[];
/** 订阅保存状态：fn({status,ts,msg,archiveCount})。立即回调一次当前状态。 */
export function onSaveState(fn){
  if(typeof fn!=='function')return ()=>{};
  _saveListeners.push(fn);
  try{fn(saveStatus())}catch(e){}
  return ()=>{const i=_saveListeners.indexOf(fn);if(i>=0)_saveListeners.splice(i,1)};
}
export function saveStatus(){
  let archiveCount=0;
  try{archiveCount=archiveRead().length}catch(e){}
  return {status:_status,ts:_lastSaveTs,msg:_statusMsg,archiveCount,dirty:_dirty,pending:!!_timer};
}
function emitSaveState(){
  const st=saveStatus();
  for(const fn of _saveListeners){try{fn(st)}catch(e){}}
}
/** 标记"有改动"：900ms 防抖后自动保存（期间继续改动只重置计时，不叠加保存） */
export function markDirtyUI(){
  _dirty=true;
  _status='pending';_statusMsg='';
  emitSaveState();
  if(_timer)clearTimeout(_timer);
  _timer=setTimeout(()=>{ _timer=null; autosaveNow() },900);
}
/** 立即保存（含归档判断）。返回 {ok,archived,reason} */
export function autosaveNow(opts){
  if(_timer){clearTimeout(_timer);_timer=null}
  let json=null;
  try{ json=serializeProject() }catch(e){ /* 序列化失败也要给出可见反馈，不能静默 */ }
  if(json==null){
    _status='error';_statusMsg='序列化失败';_dirty=false;emitSaveState();
    return {ok:false,reason:'serialize'};
  }
  let ok=false,quota=false;
  try{ localStorage.setItem(LS_KEY,json); ok=true }
  catch(e){
    quota=!!(e&&(e.name==='QuotaExceededError'||e.code===22||e.code===1014));
    /* 空间不足：先清掉归档历史再试一次（归档是可再生的，当前存档更重要） */
    if(quota){
      archiveClear();
      try{ localStorage.setItem(LS_KEY,json); ok=true; quota=false }catch(e2){}
    }
  }
  _dirty=false;
  if(!ok){
    _status='error';
    _statusMsg=quota?'浏览器存储空间不足':'写入失败';
    emitSaveState();
    return {ok:false,reason:quota?'quota':'write'};
  }
  _lastSaveTs=Date.now();
  _status='saved';_statusMsg='';
  /* 归档：与最新一份不同、且满足时间/变化阈值时才新增一份 */
  let arch={added:false,reason:'skip'};
  try{
    const meta={name:proj.name||'',meter:'',tracks:(proj.tracks||[]).length,bpm:proj.bpm,steps:proj.steps};
    try{ meta.meter=libMeta({tracks:proj.tracks,steps:proj.steps,spb:proj.spb,meterN:meterN(),meterD:meterD(),bpm:proj.bpm,key:proj.key,mode:proj.mode}) }catch(e){}
    arch=archivePush(json,meta,{force:!!(opts&&opts.forceArchive),keep:!!(opts&&opts.keep)});
    if(arch.added)_lastArchiveTs=_lastSaveTs;
  }catch(e){ arch={added:false,reason:'error'} }
  emitSaveState();
  return {ok:true,archived:!!arch.added,reason:arch.reason};
}
/** 关页/切后台时强制落盘：此时防抖计时器可能还没到，不 flush 就会丢掉最后一次改动 */
export function flushAutosave(){
  if(!_dirty&&!_timer)return {ok:true,reason:'clean'};
  return autosaveNow();
}
/** 窗口级兜底：pagehide/visibilitychange 都要 flush（移动端 pagehide 有时不触发） */
export function installAutosaveGuards(){
  const flush=()=>{ try{flushAutosave()}catch(e){} };
  window.addEventListener('pagehide',flush);
  window.addEventListener('beforeunload',flush);
  document.addEventListener('visibilitychange',()=>{ if(document.visibilityState==='hidden')flush() });
  /* 兜底轮询：万一某个改动路径忘了调 markDirtyUI（历史遗留路径不少），
     这里每 20s 比对一次序列化结果，发现不同就补一次保存 —— 自动保存不该依赖"每条路径都记得调用"。 */
  setInterval(()=>{
    try{
      if(_timer)return;                                  // 已有待保存，不抢
      const cur=serializeProject();
      const prev=localStorage.getItem(LS_KEY);
      if(cur!==prev){ _dirty=true; autosaveNow() }
    }catch(e){}
  },20000);
}
export function loadAutosave(){
  try{const raw=localStorage.getItem(LS_KEY);if(raw){applyProjectData(JSON.parse(raw));return true}}catch(e){}
  return false;
}
/** 载入一份归档快照（可撤销：载入前把当前状态压进撤销栈；并清空"已改回原样"的误判） */
export function restoreArchive(id){
  const list=archiveRead();
  const en=list.find(x=>x.id===id);
  if(!en)return {ok:false,reason:'missing'};
  try{
    /* 先把当前状态保存下来，避免"恢复历史"这个动作本身造成丢失 */
    try{ autosaveNow() }catch(e){}
    const pre=serializeProject();
    applyProjectData(JSON.parse(en.data));
    afterLoad();rebuildEvents();
    pushSnap(pre);
    refreshUndoUI();
    _lastSaveTs=Date.now();_status='saved';
    emitSaveState();
    return {ok:true,entry:en};
  }catch(e){
    return {ok:false,reason:'bad',error:e};
  }
}
/** 删除一份归档 */
export function deleteArchive(id){
  const list=archiveRemove(id);
  emitSaveState();
  return !!list;
}
export function clearArchives(){
  const ok=archiveClear();
  emitSaveState();
  return ok;
}
export function quickSave(){ const r=autosaveNow({forceArchive:true}); toast(r.ok?'已保存到浏览器':'保存失败：'+(_statusMsg||'未知原因'),r.ok?'ok':'err') }
export function quickLoad(){
  beginEdit();
  if(loadAutosave()){
    afterLoad();
    /* 必须重建事件表：applyProjectData 之后 proj._ev 还是**上一首**的（长度/内容都对不上），
       播放时 fireStep 会按新 tracks 的索引去取旧 _ev，直接越界崩掉（实测复现）。 */
    rebuildEvents();
    commitEdit();
    toast('已载入浏览器存档','ok');
  }
  else{pendingPre=null;toast('没有找到存档','err');}
}
/* ---------- 序列化 ---------- */
export function serializeProject(){
  // 双保险：导出/存档/分享链接/撤销快照之前再清一次孤儿升降号键（rebuildEvents 里已收口，这里几乎零成本）
  try{proj.tracks.forEach(t=>pruneAcc(t,proj.steps))}catch(e){}
  return JSON.stringify({
    ver:7,name:proj.name,bpm:proj.bpm,swing:proj.swing,steps:proj.steps,spb:proj.spb||16,
    meterN:meterN(),meterD:meterD(),masterVol:proj.masterVol,
    key:proj.key,mode:proj.mode,keyOct:proj.keyOct,tracks:proj.tracks.map(t=>({
      id:t.id,kind:t.kind,role:t.role,name:t.name,color:t.color,engine:t.engine,osc:t.osc,cut:t.cut,res:t.res,
      env:t.env,detune:t.detune,nOsc:t.nOsc,vol:t.vol,pan:t.pan,reverb:t.reverb,delay:t.delay,
      mute:t.mute,solo:t.solo,shift:t.shift,collapsed:t.collapsed,rows:t.rows||0,keyOct:t.keyOct||0,pat:t.pat,prec:t.prec||[],
      ...((t.acc&&Object.keys(t.acc).length)?{acc:t.acc}:{}) // 升降号（稀疏）：真有标记才写这个字段，没标记的轨与旧档形态完全一致
    }))
  });
}
export function applyProjectData(data){
  // ver<6 的旧档：prec 的 u 单位是 1/3 步（1 步=3u），现在 1 步=PREC_U_PER_STEP u → 整体 ×(PREC_U_PER_STEP/3)
  // ver<7 的旧档：没有 acc 字段（= 全自然音）→ 下面按“无标记”读入；ver≥7 才有稀疏 acc
  const legacy=((+data.ver||1)<6)||data.spb===12;
  const kU=legacy?(PREC_U_PER_STEP/3):1;   // 3u→60u 即 ×20
  setProj(data);
  if(typeof proj.masterVol!=='number')proj.masterVol=1;
  proj.spb=16; // 全局拍切分已取消：统一按“每拍 4 格”的十六分网格，spb 仅为惰性字段
  if(!proj.meterN||proj.meterN<1||proj.meterN>16)proj.meterN=4;
  if(!proj.meterD||[1,2,4,8,16].indexOf(proj.meterD)<0)proj.meterD=4;
  // 超长档（旧版不存在，可能是手改 JSON / 异常分享链接）截断到曲长上限，避免渲染爆炸
  const lim=MAX_BARS*Math.max(1,SPB());
  if(proj.steps>lim)proj.steps=lim;
  proj.tracks=(data.tracks||[]).map(d=>{
    const role=ROLES[d.role]?d.role:'custom';
    const t=newTrack(d.kind||'mel',role,{name:d.name,color:d.color,engine:d.engine,shift:d.shift});
    if(t.kind==='mel'&&!ENGINE_DEF[t.engine])t.engine='pluck';
    Object.assign(t,{osc:d.osc,cut:d.cut,res:d.res,env:d.env,detune:d.detune,nOsc:d.nOsc,
      vol:d.vol!=null?d.vol:.85,pan:d.pan||0,reverb:d.reverb||0,delay:d.delay||0,mute:!!d.mute,solo:!!d.solo,collapsed:!!d.collapsed});
    if(t.kind==='mel'&&(!t.osc||!ENGINE_DEF[t.engine])){
      const dd=ENGINE_DEF[t.engine];t.osc=dd.osc;t.cut=dd.cut;t.res=dd.res;
      t.env=Object.assign({},dd.env);t.detune=dd.detune;t.nOsc=dd.nOsc;
    }
    t.pat=Array.isArray(d.pat)?d.pat.map(col=>Array.isArray(col)?col.slice():[]):[];
    t.rows=(d.rows&&d.rows>=7)?d.rows:0;
    t.keyOct=(d.keyOct&&d.keyOct>=1)?d.keyOct:0;
    // 旧档的 prec 时值刻度 ×kU（durU 缺省：旧档 4u=1/3 拍、新档 PREC_U_PER_STEP=1 步）
    t.prec=Array.isArray(d.prec)?d.prec.map(p=>({
      row:p.row,
      u:Math.round((+p.u||0)*kU),
      durU:Math.round((+p.durU||(legacy?4:PREC_U_PER_STEP))*kU),
      vel:+p.vel||.8
    })):[];
    t.id=d.id||uid();
    // 升降号（acc）：稀疏读入并顺手消毒——只收 ±1，0/垃圾值直接丢弃；旧档没有 d.acc = 全自然音
    t.acc={};
    if(d.acc&&typeof d.acc==='object'){
      for(const k in d.acc){
        const col=d.acc[k];if(!col||typeof col!=='object')continue;
        for(const rr in col){const v=col[rr];if(v===1||v===-1)setAcc(t,Math.round(+k),Math.round(+rr),v)}
      }
    }
    return t;
  });
  if(proj.sel==null)proj.sel=proj.tracks.length?0:-1;
  ensurePatSizes();
  proj.tracks.forEach(pruneTrackPrec);
}
export function saveProjectFile(){
  const blob=new Blob([serializeProject()],{type:'application/json'});
  downloadBlob(blob,(proj.name||'song').replace(/[\\/:*?"<>|]/g,'_')+'.mpjson');
  toast('工程已导出','ok');
}
export function afterLoad(){
  if(Play.playing)stopPlay();
  hooks.afterLoad?.();
}
export function onFileImport(e){
  const f=e.target.files[0];if(!f)return;
  beginEdit();
  const rd=new FileReader();
  rd.onload=()=>{
    try{const d=JSON.parse(rd.result);if(!d.tracks||!d.steps)throw new Error('bad');
      applyProjectData(d);afterLoad();commitEdit();toast('已导入工程「'+d.name+'」','ok');
    }catch(err){pendingPre=null;toast('导入失败：文件格式不正确','err')}
  };
  rd.readAsText(f);
  e.target.value='';
}
