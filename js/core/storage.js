/* [storage.js] source: Pro.html 4707, 4370-4385（localStorage 原语：工程存档 key / 作品库读写）
   + 自动存档历史（archive*）：见文件末尾那段说明 */

export const LS_KEY='musicProducerPro.v1';
export const LIB_KEY='mpStudioLib.v1';
export function libRead(){
  try{const r=localStorage.getItem(LIB_KEY);const a=r?JSON.parse(r):[];return Array.isArray(a)?a:[]}catch(e){return[]}
}
export function libWrite(list){
  try{localStorage.setItem(LIB_KEY,JSON.stringify(list));return true}catch(e){return false}
}
export function libMeta(d){
  const tr=(d.tracks||[]).length;
  const gq=(d.spb===12)?3:4;             // 每四分音符步数
  const den=([1,2,4,8,16].indexOf(d.meterD)>=0)?d.meterD:4;
  const barSteps=(d.meterN||4)*Math.max(1,gq*4/den);
  const bars=Math.round((d.steps||16)/barSteps);
  const mtl=(d.meterN||4)+'/'+den;
  return tr+' 轨 · '+bars+' 小节 · '+mtl+' · '+d.bpm+' BPM · '+(d.key||'C')+(d.mode==='minor'?' 小调':' 大调');
}

/* =========================================================================
   自动存档历史（时间线快照）
   -------------------------------------------------------------------------
   和"快速保存"(LS_KEY) 的区别：
     · LS_KEY      —— 只有**最新一份**状态，刷新时用它恢复，是"当前存档"；
     · 归档历史    —— 多份带时间戳的快照，用来在**改坏/误操作之后回退**。
   为什么需要独立的归档：LS_KEY 被覆盖后旧状态就永久消失了（实测用户反馈"没有自动保存"，
   很大程度上是看不到任何保存反馈、也没有任何回退手段 —— 存没存、存了什么，全都无从判断）。
   存储策略（localStorage 一般只有 5MB，必须小心）：
     · 与上一份内容**逐字节相同**则不存（md5 用字符串哈希代替，足够去重）；
     · 数量上限 ARCHIVE_MAX 份，同时限制总字节 ARCHIVE_BYTES_MAX，超了从最旧的开始丢；
     · 写入抛 QuotaExceededError 时逐级降级：先砍一半归档 → 再全清归档 → 保留当前存档。
   ========================================================================= */
export const ARCHIVE_KEY='mpStudioArchive.v1';
export const ARCHIVE_MAX=24;                  // 最多保留份数
export const ARCHIVE_BYTES_MAX=2.6*1024*1024; // 归档总字节上限（给 LS_KEY/作品库留出空间）
/* =========================================================================
   为什么不用"内容变化幅度"来决定要不要归档（实测结论，别再往这个方向试）
   -------------------------------------------------------------------------
   试过用 JSON 长度差当"变化幅度"的代理。实测完全不成立：
     · 32 小节 → 96 小节（结构大改）：长度只变 0.008%
     · 只切换 1 个音符：                      0.016%
     · 只改 BPM：                             0.000%
     · 增加一整条音轨：                       2.7%
   原因：pat 是稀疏的定长二维数组，加小节只是给每条轨的列数组补零值，
   长度几乎不变；反之加轨会插进一整条完整轨道，长度才明显变化。
   → 结论：长度代理既会把"大改动"漏掉，又会把"加轨"当成特殊事件。
   改用**时间分层**（见 archiveTier）：最近 2 分钟内用"替换"而不是"新增"（合并连续编辑），
   之后按 2 分钟 / 15 分钟 / 2 小时 三档抽稀 —— 24 份就能覆盖约 20 小时的可回退历史，
   而且每一份都对应一个"值得回去看看"的时间点，不是一堆几乎相同的中间态。
   ========================================================================= */
export const ARCHIVE_TIER1_MS=2*60*1000;      // 2 分钟内：替换最新一份（连续编辑合并）
export const ARCHIVE_TIER2_MS=15*60*1000;     // 2–15 分钟：每 3 份留 1
export const ARCHIVE_TIER3_MS=2*60*60*1000;   // 15 分钟–2 小时：每 6 份留 1
const ARCHIVE_TIER2_KEEP=3, ARCHIVE_TIER3_KEEP=6;

/** 归档条目读取（脏数据一律丢弃，绝不让坏档卡住启动） */
export function archiveRead(){
  try{
    const raw=localStorage.getItem(ARCHIVE_KEY);
    if(!raw)return [];
    const a=JSON.parse(raw);
    if(!Array.isArray(a))return [];
    return a.filter(e=>e&&typeof e.data==='string'&&typeof e.ts==='number'&&e.data.length>1);
  }catch(e){ return [] }
}
export function archiveWrite(list){
  try{
    localStorage.setItem(ARCHIVE_KEY,JSON.stringify(list));
    return {ok:true};
  }catch(e){
    return {ok:false,quota:!!(e&&(e.name==='QuotaExceededError'||e.code===22||e.code===1014)),error:e};
  }
}
/** 字节估算：localStorage 按 UTF-16 计，粗估 data.length*2 */
function approxBytes(list){
  let n=0;
  for(const e of list)n+=e.data.length*2;
  return n;
}
/** 按"份数 + 总字节"双重上限裁剪（保留最新的） */
export function archivePrune(list){
  let out=list.slice().sort((a,b)=>b.ts-a.ts);
  if(out.length>ARCHIVE_MAX)out=out.slice(0,ARCHIVE_MAX);
  while(out.length>1&&approxBytes(out)>ARCHIVE_BYTES_MAX)out.pop();
  return out;
}
/**
 * 时间分层抽稀（保留最新那份，其余按"距最新多久"分档抽稀）。
 * 目的：让固定 24 份覆盖尽可能长的时间跨度，同时近期保留细粒度 —— 
 * 用户"改坏了"通常发生在刚刚，所以近期必须密、远期可以稀。
 */
export function archiveTier(list,nowMs){
  const now=(typeof nowMs==='number')?nowMs:Date.now();
  const out=[];
  let n2=0,n3=0;
  list.forEach((e,i)=>{
    if(i===0){ out.push(e); return }                    // 最新一份永远保留
    const age=Math.max(0,now-e.ts);
    if(age<ARCHIVE_TIER2_MS){ out.push(e); return }      // 2 分钟内全留
    if(age<ARCHIVE_TIER3_MS){ if(n2++%ARCHIVE_TIER2_KEEP===0)out.push(e); return }
    if(n3++%ARCHIVE_TIER3_KEEP===0)out.push(e);
  });
  return out;
}
/**
 * 写入一份归档。返回 {ok, added, replaced, reason, list}
 *   reason：'same'（与最新一份逐字节相同，跳过）| 'replaced'（2 分钟内的连续编辑，合并进最新那份）
 *           | 'added' | 'quota'（空间不足，已尽力裁剪）
 * opts.force —— 忽略"2 分钟合并"直接新增一份（用户手动"立即保存"时用）。
 */
export function archivePush(data,meta,opts){
  const o=opts||{};
  const list=archiveRead();
  const newest=list[0]||null;
  if(newest&&newest.data===data)return {ok:true,added:false,reason:'same',list};
  const now=Date.now();
  const entry={id:'a'+now.toString(36)+Math.floor(Math.random()*1e6).toString(36),ts:now,
    name:(meta&&meta.name)||'',meter:(meta&&meta.meter)||'',auto:o.auto!==false,
    keep:!!o.keep,data};
  /* 2 分钟内视为"同一次连续编辑"：替换最新那份，而不是再堆一份几乎相同的。
     这样既不会把配额烧光、也不会让时间线被中间态淹没，而"改坏了要回退"的需求仍然满足
     —— 回退点就是"这次编辑开始前"的状态。
     ⚠ 但**会话基线（keep:true）绝不被替换**：否则在新会话开头两分钟内把工程改坏，
       唯一的快照会被一次次覆盖成"坏掉的状态"，等于没有可回退点（实测发现的设计漏洞）。
       遇到基线就往下找最新的可合并项；若整段 2 分钟窗口全是基线，就老老实实新增一份。 */
  if(!o.force){
    let ri=-1;
    for(let i=0;i<list.length;i++){
      if(list[i].keep)continue;
      if((now-list[i].ts)<ARCHIVE_TIER1_MS)ri=i;
      break;
    }
    if(ri>=0){
      const next=[entry].concat(list.slice(0,ri)).concat(list.slice(ri+1));
      const pruned=archivePrune(archiveTier(next,now));
      const w=archiveWrite(pruned);
      if(w.ok)return {ok:true,added:true,replaced:true,reason:'replaced',list:pruned};
      /* 写不进去就走下面的配额降级 */
    }
  }
  let next=archivePrune(archiveTier([entry].concat(list),now));
  let w=archiveWrite(next);
  if(!w.ok){
    /* 配额不足：逐级降级 —— 砍一半 → 只留几份 → 放弃归档（当前存档仍要保住） */
    for(const keep of [Math.floor(ARCHIVE_MAX/2),8,3,1]){
      const base=list.slice(0,keep);
      if(!base.length)break;
      next=archivePrune([entry].concat(base));
      w=archiveWrite(next);
      if(w.ok)return {ok:true,added:true,reason:'quota',pruned:true,list:next};
    }
    return {ok:false,added:false,reason:'quota',list};
  }
  return {ok:true,added:true,reason:'added',list:next};
}
export function archiveRemove(id){
  const list=archiveRead().filter(e=>e.id!==id);
  return archiveWrite(list).ok?list:null;
}
export function archiveClear(){
  try{localStorage.removeItem(ARCHIVE_KEY);return true}catch(e){return false}
}
export function archiveStats(){
  const list=archiveRead();
  return {count:list.length,bytes:approxBytes(list),
    newest:list.length?list[0].ts:0,oldest:list.length?list[list.length-1].ts:0};
}
/** 相对时间文案（归档列表用）：刚刚 / N 分钟前 / N 小时前 / 日期 */
export function relTime(ts,nowMs){
  const now=(typeof nowMs==='number')?nowMs:Date.now();
  const d=Math.max(0,now-ts);
  const m=Math.floor(d/60000);
  if(d<45000)return '刚刚';
  if(m<60)return m+' 分钟前';
  const h=Math.floor(m/60);
  if(h<24)return h+' 小时前';
  const dt=new Date(ts);
  return (dt.getMonth()+1)+'/'+dt.getDate()+' '+String(dt.getHours()).padStart(2,'0')+':'+String(dt.getMinutes()).padStart(2,'0');
}
/** 时钟文案 HH:MM:SS（保存状态用） */
export function clockText(ts){
  const dt=new Date(ts);
  return String(dt.getHours()).padStart(2,'0')+':'+String(dt.getMinutes()).padStart(2,'0')+':'+String(dt.getSeconds()).padStart(2,'0');
}
