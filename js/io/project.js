/* [project.js] source: Pro.html 2300-2349, 4723-4808（撤销栈 / 序列化 / 存档 / 导入导出 / 快照） */
import { proj, setProj, newTrack, uid, ensurePatSizes, pruneTrackPrec, meterN, meterD, SPB, MAX_BARS } from '../core/state.js';
import { PREC_U_PER_STEP, ROLES, ENGINE_DEF, setAcc, pruneAcc } from '../core/theory.js';
import { toast, downloadBlob, hooks, clamp } from '../core/util.js';
import { LS_KEY, libMeta, archiveRead, archivePush, archiveRemove, archiveClear } from '../core/storage.js';
import { Play, stopPlay, rebuildEvents } from '../audio/engine.js';

/* =========================================================================
   6b. 撤销 / 重做
   ========================================================================= */
export const undoH={stack:[],redo:[]};
export let pendingPre=null;
export function setPendingPre(v){pendingPre=v}
/* beginEdit：取一份"编辑前快照"，与 commitEdit 配对构成一次可撤销事务。
   ⚠ 失败路径的处理很关键：serializeProject() 在"工程尚未载入"时会抛
   （`proj.tracks.map` 于空 proj 上），此时把 pendingPre 置成 ''。
   而 commitEdit 原来对 '' 直接 return 且**不复位**，于是 '' 会一直留着 ——
   之后每次 beginEdit 都因 `pendingPre===null` 为假而跳过取快照，
   commitEdit 又永远早退 ⇒ **本会话撤销/重做彻底失效且无任何提示**。
   触发窗口真实存在：用 #p= 短链打开 index.html 时，fetchShortLink 最长 15s 超时，
   这期间界面已可交互，用户此时做任何编辑动作（如加一条轨）就会走到这里。
   现在把复位逻辑收在 commitEdit 里（见下），这里保持"失败就标记"的语义。 */
export function beginEdit(){ if(pendingPre===null){try{pendingPre=serializeProject()}catch(e){pendingPre=''}} }
export function commitEdit(){
  /* 注意 pendingPre==='' 这个"毒化"状态的处理顺序（见 beginEdit 的注释）：
     必须先复位再判空，否则一次序列化失败会让本会话所有撤销永久失效。 */
  if(pendingPre===''){pendingPre=null;return}
  if(pendingPre===null)return;
  const pre=pendingPre;pendingPre=null;pushSnap(pre);
}
export function pushSnap(pre){
  try{
    const cur=serializeProject();
    if(cur===pre)return;
    undoH.stack.push(pre);
    if(undoH.stack.length>20)undoH.stack.shift();
    undoH.redo=[];
    /* 【重要】这里置"未保存"标记，而不是在每条编辑路径上各加一次 markDirtyUI()。
       为什么：本函数是全项目**唯一**能准确判断"工程真的变了"的位置（上一行的 cur===pre）。
       而各编辑路径（画笔点音符 setCellVal / 擦除 / 量化 / 混音滑块 / 粘贴 …）并不会
       都记得调 markDirtyUI，实测确认：
         · setCellVal 后      saveStatus().dirty === false
         · 改音量滑块后       saveStatus().dirty === false
         · 量化后            saveStatus().dirty === false
       后果是严重的**静默数据丢失**：flushAutosave() 以 _dirty 为唯一依据
       （`if(!_dirty&&!_timer)return {ok:true,reason:'clean'}`，实测返回 reason:'clean'），
       而它在 pagehide/beforeunload/visibilitychange 三处关页兜底里被调用 ——
       也就是说：编辑过、但 900ms 防抖还没到、又没等到 20 秒兜底轮询就关页，
       改动会被静默丢弃，且"未保存"指示器也不会亮（用户完全无从察觉）。
       挂在这里后，所有编辑路径（含 commitEdit 的事务路径与 restoreSnapshot 的直调路径）
       都会自动被覆盖，且不会误报（cur===pre 时已提前 return）。 */
    markDirtyUI();
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
/* =========================================================================
   载入加固：把"来自不可信载荷"的字段全部夹到安全范围
   -------------------------------------------------------------------------
   为什么需要：applyProjectData 的输入来自分享链接/工程文件，属**不可信数据**，
   而它此前只对 masterVol 的类型、meterN/D、steps 做了检查，其它字段是逐字复制。
   审计实测确认了三条可被单条链接触发的故障：
     ① bpm=1e400（JSON 解析成 Infinity）→ barSeconds()→0 → stepDurNow()→0
        → 音乐调度器 `while(Play.nom<ahead){Play.nom+=0; fireStep(...)}` 永不收敛
        （循环体内无 await、无上限，loopOn 默认开）→ 按一次播放即整页冻结。
        同理 NaN 会让比较恒为 false，行为同样不可预期。
     ② rows 无上限（steps/bpm/cut/vol… 都夹过，唯独漏了它）→
        `Array.from({length:S},()=>new Array(rows))` 按"步数 × rows"分配：
        载荷给 rows:100000000 即内存爆炸。合法值只由 timeline.js 的 octRowsOf 写入（15/22/29）。
     ③ masterVol=Infinity → 建音频图时 `out.gain.value=Infinity`，
        Web Audio 的 float 参数拒绝非有限值并抛 TypeError，
        异常穿出无 try/catch 的 ensureAudio() → 播放再也起不来（本次会话内无法恢复）。
        而且 setMasterVol 里的 clamp(0,1.4) 在建图**之前**是空操作（那时 A/actx 还是 null），
        也不回写 proj.masterVol，所以真正的收口只能在这里。
   ========================================================================= */
const BPM_MIN=20, BPM_MAX=400;        // 与 UI 的取值范围保持一致的量级
const MAX_TRACKS=64;                  // 正常工程 4~8 轨；64 已远超实际
const MAX_TRACK_ROWS=64;              // octRowsOf 产出 15/22/29，64 是宽松上限
const MAX_MASTER_VOL=1.4;             // 与 setMasterVol 的上限一致
const MAX_NOSC=32;                    // 单声部振荡器数上限（UI 上限是 8）

export function applyProjectData(data){
  if(!data||typeof data!=='object')throw new Error('工程数据为空或格式不对');
  // ver<6 的旧档：prec 的 u 单位是 1/3 步（1 步=3u），现在 1 步=PREC_U_PER_STEP u → 整体 ×(PREC_U_PER_STEP/3)
  // ver<7 的旧档：没有 acc 字段（= 全自然音）→ 下面按“无标记”读入；ver≥7 才有稀疏 acc
  const legacy=((+data.ver||1)<6)||data.spb===12;
  const kU=legacy?(PREC_U_PER_STEP/3):1;   // 3u→60u 即 ×20
  setProj(data);
  /* 先夹 bpm / meterN / meterD —— 因为它们参与 SPB()/barSeconds()，
     而下面的 steps 上限、ensurePatSizes 的分配量都依赖它们。顺序不能挪。 */
  const bpm=Number(proj.bpm);
  proj.bpm=(isFinite(bpm)&&bpm>=BPM_MIN&&bpm<=BPM_MAX)?bpm:120;
  if(typeof proj.masterVol!=='number'||!isFinite(proj.masterVol))proj.masterVol=1;
  else proj.masterVol=clamp(proj.masterVol,0,MAX_MASTER_VOL);
  proj.spb=16; // 全局拍切分已取消：统一按“每拍 4 格”的十六分网格，spb 仅为惰性字段
  if(!proj.meterN||proj.meterN<1||proj.meterN>16)proj.meterN=4;
  if(!proj.meterD||[1,2,4,8,16].indexOf(proj.meterD)<0)proj.meterD=4;
  // 超长档（旧版不存在，可能是手改 JSON / 异常分享链接）截断到曲长上限，避免渲染爆炸
  const lim=MAX_BARS*Math.max(1,SPB());
  if(proj.steps>lim)proj.steps=lim;
  const rawTracks=Array.isArray(data.tracks)?data.tracks:[];
  proj.tracks=rawTracks.slice(0,MAX_TRACKS).map(d=>{
    const role=ROLES[d.role]?d.role:'custom';
    const t=newTrack(d.kind||'mel',role,{name:d.name,color:d.color,engine:d.engine,shift:d.shift});
    if(t.kind==='mel'&&!ENGINE_DEF[t.engine])t.engine='pluck';
    t.osc=d.osc;t.cut=d.cut;t.res=d.res;t.env=d.env;t.detune=d.detune;t.nOsc=d.nOsc;
    t.vol=(d.vol!=null&&isFinite(d.vol))?clamp(d.vol,0,MAX_MASTER_VOL):.85;
    t.pan=isFinite(d.pan)?clamp(d.pan,-1,1):0;
    t.reverb=(isFinite(d.reverb)?clamp(d.reverb,0,1):0);
    t.delay=(isFinite(d.delay)?clamp(d.delay,0,1):0);
    t.mute=!!d.mute;t.solo=!!d.solo;t.collapsed=!!d.collapsed;
    t.cut=isFinite(d.cut)?clamp(d.cut,60,18000):undefined;
    t.res=isFinite(d.res)?clamp(d.res,0,24):undefined;
    t.nOsc=isFinite(d.nOsc)?Math.round(clamp(d.nOsc,1,MAX_NOSC)):undefined;
    t.detune=isFinite(d.detune)?clamp(d.detune,-1200,1200):undefined;
    /* env 可能是 null / 非对象（手工编辑或第三方生成的工程），
       而侧栏 renderTrackTab 会直接读 t.env.a —— 那种情况下会抛
       "Cannot read properties of null (reading 'a')" 让检查器整块空白。
       viz/data.js 的 normalizePayload 早已做同样防护（`d.env&&typeof d.env==='object'?d.env:{}`），
       这里补齐，保持两边标准一致。 */
    if(!t.env||typeof t.env!=='object')t.env={};
    if(t.kind==='mel'&&(!t.osc||!ENGINE_DEF[t.engine])){
      const dd=ENGINE_DEF[t.engine];t.osc=dd.osc;t.cut=dd.cut;t.res=dd.res;
      t.env=Object.assign({},dd.env);t.detune=dd.detune;t.nOsc=dd.nOsc;
    }
    t.pat=Array.isArray(d.pat)?d.pat.map(col=>Array.isArray(col)?col.slice():[]):[];
    /* rows：合法值只由 octRowsOf 产出（15/22/29）。此前无上限，
       载荷给个大数就会按"步数 × rows"分配二维数组 → 内存爆炸。 */
    t.rows=(isFinite(d.rows)&&d.rows>=7)?Math.round(Math.min(d.rows,MAX_TRACK_ROWS)):0;
    t.keyOct=(d.keyOct&&d.keyOct>=1)?clamp(Math.round(d.keyOct),1,8):0;
    // 旧档的 prec 时值刻度 ×kU（durU 缺省：旧档 4u=1/3 拍、新档 PREC_U_PER_STEP=1 步）
    t.prec=Array.isArray(d.prec)?d.prec.slice(0,4096).map(p=>({
      row:p.row,
      u:Math.round((+p.u||0)*kU),
      durU:Math.round((+p.durU||(legacy?4:PREC_U_PER_STEP))*kU),
      vel:isFinite(p.vel)?clamp(+p.vel,0,1):.8
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
