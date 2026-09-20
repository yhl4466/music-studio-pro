/* [project.js] source: Pro.html 2300-2349, 4723-4808（撤销栈 / 序列化 / 存档 / 导入导出 / 快照） */
import { proj, setProj, newTrack, uid, ensurePatSizes, pruneTrackPrec, meterN, meterD, SPB, MAX_BARS } from '../core/state.js';
import { PREC_U_PER_STEP, ROLES, ENGINE_DEF, setAcc, pruneAcc } from '../core/theory.js';
import { toast, downloadBlob, hooks } from '../core/util.js';
import { LS_KEY } from '../core/storage.js';
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
let _dirty=false;
export function markDirtyUI(){
  if(_dirty)return;
  _dirty=true;
  setTimeout(()=>{_dirty=false;autosaveNow()},900);
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
export function autosaveNow(){try{localStorage.setItem(LS_KEY,serializeProject())}catch(e){}}
export function loadAutosave(){
  try{const raw=localStorage.getItem(LS_KEY);if(raw){applyProjectData(JSON.parse(raw));return true}}catch(e){}
  return false;
}
export function quickSave(){autosaveNow();toast('已快速保存到浏览器','ok')}
export function quickLoad(){
  beginEdit();
  if(loadAutosave()){afterLoad();commitEdit();toast('已载入浏览器存档','ok')}
  else{pendingPre=null;toast('没有找到存档','err');}
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
