/* [viz/data.js] 可视化页数据层：URL hash / localStorage.vizProject → 统一 v6 载荷 → 归一化为可渲染的 proj。
   设计要点（VISUALIZER-V1 决策 2/3）：
   - hash 通道复用 io/share.js 的“纯解码原语”，但**不调用** loadShareFromHash（它内部 applyProjectData 会改全局 proj）；
   - 页面里唯一被调用的归一化入口是本文件的 normalizePayload()，绝不调用 io/project.js 的 applyProjectData；
   - 空状态文案与卡片渲染收敛在本文件，main.js 只负责编排。
   依赖方向：viz → core + io/share.js（纯函数），不 import 任何 ui 模块。 */
import { $, clamp } from '../core/util.js';
import { proj, setProj, newTrack, allocPat, ensurePatSizes, pruneTrackPrec, SPB, MAX_BARS } from '../core/state.js';
import { PREC_U_PER_STEP, ROLES, ENGINE_DEF, MEL_ROWS, KIT, trackRows, degSemi } from '../core/theory.js';
import { b64ToBytes, inflateB64, lzDecode } from '../io/share.js';
import { fetchShortLink, shortIdFromHash } from '../io/shortlink.js';   // #p= 短链（扫码导入谱子必需）
import { LS_KEY } from '../core/storage.js';                            // 返回主应用时把工程移交给它

/* 归一化结果就是 core/state.js 的全局 proj；这里按同一实例再导出一次，
   让页面/测试统一从本模块取工程，避免出现“两份 proj”的隐患。 */
export { proj };

export const VIZ_KEY='vizProject';          // 新 key：只由主应用写入、可视化页只读，不触碰 musicProducerPro.v1
export const EMPTY_TITLE='音乐可视化';
/* 空状态主文案：规格给定句式；因 Windows 下该 emoji 会渲染成蓝方块，把 emoji 图标改为菜单项名称（见汇报的偏差说明） */
export const EMPTY_MSG='请先在主应用生成音乐，再点菜单里的「可视化」';
export const BACK_TEXT='返回主应用';

/* 最近一次加载结果的诊断信息（供页面提示与排查） */
export const info={source:'none',slot:'',reason:'',steps:0,tracks:0};

/* ---------- 数值安全 ---------- */
const num=(v,f)=>{const n=Number(v);return Number.isFinite(n)?n:f};
const intIn=(v,f,a,b)=>{const n=Math.round(num(v,f));return clamp(n,a,b)};
const oneOf=(v,list,f)=>(list.indexOf(v)>=0?v:f);

/* =========================================================================
   1. hash 通道：#s=（裸 Base64）/ #z=（deflate-raw）/ #l=（纯 JS LZSS）/ #p=（短链 ID）
   -------------------------------------------------------------------------
   ⚠ #p= 必须在这里解析，不能只靠 io/share.js 的 loadShareFromHash ——
     可视化页走的是本模块的 loadProject()，而它的 hash 判断原来只认 #s=/#z=/#l=。
     结果是：分享卡片的二维码扫出来只打开网站、**不会导入谱子**（用户实测反馈的 bug）。
     现在 #p= 先向后端取回载荷，再交给下面同一套解码，#s=/#z=/#l= 的路径一行没改。
   ========================================================================= */
export async function readHashJson(hash){
  const h=hash||'';
  try{
    /* 短链：向后端换回 '#z=…' 之类的载荷，再重入本函数解码 */
    const sid=shortIdFromHash(h);
    if(sid){
      const r=await fetchShortLink(sid);
      if(!r.ok){
        info.reason='短链打开失败：'+(r.message||'未知原因');
        return null;
      }
      return await readHashJson(r.data);
    }
    if(h.startsWith('#s=')){
      const s1=decodeURIComponent(escape(atob(h.slice(3))));
      lastPayloadJson=s1;                       // 记下来，供"返回主应用"时移交（见 handoffPayload）
      return s1;
    }
    if(h.startsWith('#z=')){
      const s2=await inflateB64(h.slice(3));
      lastPayloadJson=s2;
      return s2;
    }
    if(h.startsWith('#l=')){
      const s3=lzDecode(b64ToBytes(h.slice(3)));
      lastPayloadJson=s3;
      return s3;
    }
  }catch(e){ return null }
  return null;
}
/* =========================================================================
   返回主应用时的工程移交
   -------------------------------------------------------------------------
   问题（用户反馈）：扫码/打开短链进入可视化页 → 点「返回主应用」→ 主界面只有示例工程。
   原因：「返回主应用」只是跳到 ./index.html，不带任何数据；而可视化页的工程来自 URL hash，
   主应用读的是自己的存档键（musicProducerPro.v1），两者不通 —— 所以回到主界面就丢了谱面。

   修法：把**已经取回并解码好的那份载荷 JSON**（与主应用 serializeProject() 输出的格式相同，
   主应用的 applyProjectData 能直接吃）在跳转前写进主应用的存档键。
   这样主应用启动时原有的 loadAutosave() 路径就会自然把它读进来，
   **不需要给主应用加任何特殊分支**，也不会误覆盖（写的就是当前这份工程）。
   ========================================================================= */
let lastPayloadJson=null;
/** 把当前从分享链接载入的工程移交给主应用（写主应用存档键）。返回是否成功 */
export function handoffPayload(){
  if(!lastPayloadJson)return false;
  try{
    /* 必须先自检能不能解析：宁可不移交，也不能把坏数据写进主应用的存档 */
    const o=JSON.parse(lastPayloadJson);
    if(!o||!Array.isArray(o.tracks)||!o.steps)return false;
    localStorage.setItem(LS_KEY,lastPayloadJson);
    return true;
  }catch(e){ return false }
}
/* 供“复制可视化直链”使用：可解码出 JSON 的 hash 一律原样保留，其余清空 */
export function hashForViz(hash){
  const h=hash||'';
  return (h.startsWith('#s=')||h.startsWith('#z=')||h.startsWith('#l=')||shortIdFromHash(h))?h:'';
}

/* =========================================================================
   2. localStorage 通道
   ========================================================================= */
export function readStoredJson(){
  try{
    const raw=localStorage.getItem(VIZ_KEY);
    return (raw&&raw.length>2)?raw:null;
  }catch(e){ return null }
}

/* =========================================================================
   3. v6 载荷归一化（纯函数，只返回新对象，不改全局）
   ========================================================================= */
function legacyOf(d){
  return ((+d.ver||1)<6)||d.spb===12;   // 与 io/project.js 的判定一致
}
/* 行号 ↔ 半音 反解（老档没有 prec.row 时用，语义 = state.js rowMidi 的逆） */
function semiToRow(t,semi,rows){
  if(!Number.isFinite(semi))return null;
  let best=null,bd=1e9;
  for(let r=0;r<rows;r++){
    const d=Math.abs(degSemi(proj.mode,r)-semi);
    if(d<bd){bd=d;best=r;if(d===0)break}
  }
  return bd<=0.75?best:null;
}
function normalizePat(src,S,rows){
  const out=Array.from({length:S},()=>new Array(rows).fill(0));
  if(!Array.isArray(src))return out;
  for(let s=0;s<Math.min(S,src.length);s++){
    const col=src[s];
    if(!Array.isArray(col))continue;
    for(let r=0;r<Math.min(rows,col.length);r++){
      const v=num(col[r],0);
      if(v>0)out[s][r]=clamp(v,0,.001+1);
    }
  }
  return out;
}
/* 升降号（♯/♭）：主应用 serializeProject() 写的稀疏表 {[step]:{[row]:-1|0|1}}。
   只收 ±1（0 = 无标记，不落键，保持稀疏），且 step 必须落在 [0,steps)、row 落在 [0,该轨行数)：
   越界、非数字、非法列（非对象）一律丢弃。旧工程没有这个字段 → 返回 {}（= 全自然音）。 */
function normalizeAcc(src,t,S){
  const out={};
  if(!src||typeof src!=='object'||Array.isArray(src))return out;
  const rows=trackRows(t);
  for(const k in src){
    const step=Math.round(num(k,NaN));
    if(!Number.isFinite(step)||step<0||step>=S)continue;
    const col=src[k];
    if(!col||typeof col!=='object'||Array.isArray(col))continue;
    for(const rk in col){
      const row=Math.round(num(rk,NaN));
      if(!Number.isFinite(row)||row<0||row>=rows)continue;
      const v=num(col[rk],0);
      if(v!==1&&v!==-1)continue;
      (out[step]||(out[step]={}))[row]=v;
    }
  }
  return out;
}
function normalizePrec(src,t,kU){
  const out=[];
  if(!Array.isArray(src))return out;
  const rows=trackRows(t);
  for(const p of src){
    if(!p||typeof p!=='object')continue;
    let row=Math.round(num(p.row,NaN));
    if(!Number.isFinite(row)||row<0||row>=rows){        // 老档可能只有 midi/u
      const viaSemi=semiToRow(t,num(p.midi,NaN),rows);
      if(viaSemi==null)continue;
      row=viaSemi;
    }
    const u=Math.round(num(p.u,NaN)*kU);
    if(!Number.isFinite(u)||u<0)continue;
    const durU=clamp(Math.round(num(p.durU,PREC_U_PER_STEP)*kU)||PREC_U_PER_STEP,1,PREC_U_PER_STEP*MAX_BARS*SPB());
    out.push({row,u,durU,vel:clamp(num(p.vel,.8),.02,1)});
  }
  return out;
}
function buildTrack(d,i,used,S){
  if(!d||typeof d!=='object')return null;
  if(d.kind!=='mel'&&d.kind!=='drum')return null;        // 只认识两类轨，其余视为损坏数据
  const kind=d.kind;
  const role=ROLES[d.role]?d.role:'custom';
  // 引擎必须先校验：core/state.js 的 newTrack() 遇到 ENGINE_DEF 里没有的 engine 会直接抛错
  const engOk=(typeof d.engine==='string'&&ENGINE_DEF[d.engine])?d.engine:null;
  const engine=(kind==='mel')?(engOk||'pluck'):null;
  const t=newTrack(kind,role,{name:d.name,color:d.color,engine,shift:d.shift});
  t.engine=engine;
  const def=engine?ENGINE_DEF[engine]:{};
  t.osc=num(d.osc,def.osc);
  t.cut=clamp(num(d.cut,num(def.cut,8000)),20,18000);
  t.res=clamp(num(d.res,num(def.res,.6)),0,20);
  const de=d.env&&typeof d.env==='object'?d.env:{};
  t.env={a:clamp(num(de.a,num(def.a,.01)),.001,4),d:clamp(num(de.d,num(def.d,.1)),.001,6),
         s:clamp(num(de.s,num(def.s,.7)),0,1),r:clamp(num(de.r,num(def.r,.2)),.01,8)};
  t.detune=clamp(num(d.detune,num(def.detune,0)),-50,50);
  t.nOsc=clamp(Math.round(num(d.nOsc,num(def.nOsc,1))),1,7);
  t.vol=clamp(num(d.vol,.85),0,1.4);
  t.pan=clamp(num(d.pan,0),-1,1);
  t.reverb=clamp(num(d.reverb,0),0,1);
  t.delay=clamp(num(d.delay,0),0,1);
  t.mute=!!d.mute; t.solo=!!d.solo; t.collapsed=!!d.collapsed;
  t.shift=clamp(Math.round(num(d.shift,t.shift||0)),-48,48);
  t.rows=(num(d.rows,0)>=7)?Math.round(num(d.rows,MEL_ROWS)):0;
  t.keyOct=(num(d.keyOct,0)>=1)?clamp(Math.round(num(d.keyOct,0)),1,8):0;
  t.prec=normalizePrec(d.prec,t,1);                       // 恒为数组：缺字段/损坏数据都回落成 []
  // 音符矩阵必须显式重建：ensurePatSizes() 只在尺寸不符时新建零矩阵，
  // 若这里留空数组，音符会被静默清空（离线渲染将得到一段无声的缓冲）。
  t.pat=normalizePat(d.pat,S,trackRows(t));
  t.acc=normalizeAcc(d.acc,t,S);                          // 升降号：稀疏表，只认 ±1 且不越界（旧档无此字段 → {}）
  t.steps=S;
  t.id=(typeof d.id==='string'&&d.id&&!used.has(d.id))?d.id:('viz'+i+Math.random().toString(36).slice(2,7));
  used.add(t.id);
  return t;
}
/**
 * 把主应用 serializeProject() 产出的 v6 JSON 对象归一化成可视化页可直接使用的工程。
 * 只读入参、只写全局 proj（经 core/state.js 的 setProj / ensurePatSizes / pruneTrackPrec）。
 * @returns {{ok:boolean, reason?:string, steps?:number, tracks?:number}}
 */
export function normalizePayload(data){
  if(!data||typeof data!=='object'||Array.isArray(data))return {ok:false,reason:'载荷不是对象'};
  const legacy=((+data.ver||1)<6)||data.spb===12;
  const kU=legacy?(PREC_U_PER_STEP/3):1;
  const S=intIn(data.steps,0,1,Math.max(1,MAX_BARS*64));  // 先硬夹一次，防异常 JSON 造成内存爆炸

  setProj({
    name:(typeof data.name==='string'&&data.name)?data.name:'未命名工程',
    bpm:clamp(num(data.bpm,120),40,220),
    swing:clamp(num(data.swing,0),0,80),
    steps:S,
    spb:16,                                               // 全局拍切分已取消：统一十六分网格（与 applyProjectData 一致）
    meterN:0, meterD:0,                                   // 下面按合法值补齐
    masterVol:clamp(num(data.masterVol,1),0,1.4),
    key:(typeof data.key==='string'&&data.key)?data.key:'C',
    mode:typeof data.mode==='string'?data.mode:'major',
    keyOct:clamp(Math.round(num(data.keyOct,4)),0,8),
    tracks:[], sel:0
  });
  proj.meterN=intIn(data.meterN,4,1,16);
  proj.meterD=oneOf(Math.round(num(data.meterD,4)),[1,2,4,8,16],4);

  const perBar=Math.max(1,SPB());
  const lim=MAX_BARS*perBar;
  proj.steps=clamp(Math.round(num(data.steps,perBar)||perBar),1,lim);

  const used=new Set();
  const list=Array.isArray(data.tracks)?data.tracks:[];
  proj.tracks=[];
  for(let i=0;i<list.length;i++){
    const t=buildTrack(list[i],i,used,proj.steps);
    if(t){ if(legacy)t.prec=normalizePrec(list[i].prec,t,kU); proj.tracks.push(t) }
  }
  if(!proj.tracks.length)return {ok:false,reason:'工程里没有任何音轨'};

  ensurePatSizes();      // 重建 pat 尺寸 / 逐轨清理越界的精确时值音符
  pruneTrackPrec&&proj.tracks.forEach(pruneTrackPrec);
  proj.sel=0;
  return {ok:true,steps:proj.steps,tracks:proj.tracks.length,bars:proj.steps/perBar};
}

/* =========================================================================
   4. 统一装载入口
   ========================================================================= */
function jsonToProject(json,source,slot){
  if(typeof json!=='string'||!json.trim())return null;
  let data=null;
  try{ data=JSON.parse(json) }catch(e){ info.reason='JSON 解析失败'; return null }
  if(!data||typeof data!=='object'){ info.reason='载荷不是对象'; return null }
  if(!Array.isArray(data.tracks)&&!data.steps){ info.reason='不是工程数据（缺少 tracks/steps）'; return null }
  try{
    const r=normalizePayload(data);
    if(!r.ok){ info.reason=r.reason||'归一化失败'; return null }
    info.source=source; info.slot=slot||''; info.steps=r.steps; info.tracks=r.tracks; info.reason='';
    return proj;
  }catch(e){ info.reason='归一化异常：'+(e&&e.message?e.message:e); return null }
}
/** 读取工程：URL hash 优先，其次 localStorage.vizProject。返回 Promise<proj|null>（null = 走空状态） */
export async function loadProject(){
  info.source='none'; info.slot=''; info.reason=''; info.steps=0; info.tracks=0;
  const hash=hashForViz(location.hash);
  if(hash){
    const json=await readHashJson(hash);
    const p=jsonToProject(json,'hash',hash.slice(1,3));
    if(p)return p;
    if(!info.reason)info.reason='分享链接无法解析';
    tryReloadForStaleModules();          // 见下：短链打不开时自动强刷一次
    return null;
  }else if(location.hash){
    info.reason='URL hash 不是工程链接（需 #s= / #z= / #l=）';
  }
  const stored=readStoredJson();
  if(stored){
    const p=jsonToProject(stored,'storage',VIZ_KEY);
    if(p)return p;
  }else if(!info.reason){
    info.reason='浏览器里没有找到工程数据';
  }
  return null;
}
/* =========================================================================
   陈旧模块自愈：短链打不开时自动强刷一次
   -------------------------------------------------------------------------
   为什么需要它：GitHub Pages 给所有静态资源发 `Cache-Control: max-age=600`，
   于是**推送后 10 分钟内**再打开页面，浏览器仍然执行旧版模块 ——
   表现就是"短链明明有数据，页面却提示分享链接无法解析 / 短链打开失败"。
   这个坑实测误导过三次排查（我这边用全新 profile 测一直是好的）。

   做法（刻意保持极简，因为本函数可能正运行在**旧版模块**里）：
     · 只在"URL 带 hash 参数（本该有工程）且解析失败"时触发；
     · sessionStorage 标记，**一次会话只刷一次** —— 万一后端真的宕机，
       也只是刷一次就停，不会变成无限刷新；
     · 只用 location.reload() 与 sessionStorage 这两个必然存在的 API，
       不依赖任何新引入的东西。
   ========================================================================= */
function tryReloadForStaleModules(){
  try{
    if(typeof location==='undefined'||!location.hash||location.hash.length<3)return;
    const KEY='vizStaleReload';
    if(sessionStorage.getItem(KEY)==='1')return;    // 本次会话已刷过一次 → 不再刷
    sessionStorage.setItem(KEY,'1');
    location.reload();
  }catch(e){ /* 无 sessionStorage（隐私模式等）→ 不刷，照常显示错误原因 */ }
}

/* =========================================================================
   6. 内存内演示工程（不写 localStorage）
   用途：无工程数据时也能验证“离线预渲染 + 可视化”链路是否真的产出了音符。
   4 小节、2 轨、共 8 个音符：鼓 4 个 kick（步 0/4/8/12）+ 旋律 4 个（C/E/G/C 八度）。
   音高→行号：大调音阶度数 0/2/4/7 → 行 0/2/4/7（= C/E/G/C）。
   注意 lead 角色的 shift=+12（主应用既有语义）：实际发声音高为 C5/E5/G5/C6，
   行号 0 在 UI 上仍显示为该轨的锚点音（2 八度音阶行）。
   ========================================================================= */
export function makeDemoProject(){
  const S=64;
  const drum=newTrack('drum','drum',{name:'鼓组'});
  allocPat(drum,S,KIT.length);                        // 8 行固定鼓组行，KIT[0]=kick
  for(const s of [0,4,8,12])drum.pat[s][0]=.9;

  const lead=newTrack('mel','lead',{name:'主旋律'});
  allocPat(lead,S,MEL_ROWS);                          // 15 行音阶行
  const MEL=[[0,0],[2,4],[4,8],[7,12]];               // [行号, 步号] → 度数 0/2/4/7（C/E/G/C）
  for(const [row,step] of MEL)lead.pat[step][row]=.85;

  const raw={ ver:6, name:'演示工程 · 4 小节', bpm:120, swing:0, steps:S, spb:16,
    meterN:4, meterD:4, masterVol:1, key:'C', mode:'major', keyOct:4, tracks:[drum,lead] };
  const r=normalizePayload(raw);                      // 复用同一套归一化，保证与真实工程同构
  return r.ok?proj:null;
}

/* =========================================================================
   5. 空状态视图（居中卡片 + 返回主应用链接）
   ========================================================================= */
function backLink(){
  const a=document.createElement('a');
  a.className='vz-cardLink'; a.href='./index.html';
  a.textContent=BACK_TEXT;
  return a;
}
function fillCard(title,body,bars){
  const host=$('#vzCardBody'), tEl=document.querySelector('.vz-cardT');
  const overlay=$('#vzOverlay');
  if(tEl)tEl.textContent='◆ '+title;
  if(host){
    host.textContent='';
    const p=document.createElement('p');
    p.className='vz-cardP'; p.textContent=body;
    host.appendChild(p);
    if(bars){
      const m=document.createElement('p');
      m.className='vz-cardMeta'; m.textContent=bars;
      host.appendChild(m);
    }
    const lk=backLink();
    host.appendChild(lk);
  }
  if(overlay)overlay.classList.remove('off');
}
/** 空状态：无数据 / 数据损坏 / 非法链接 */
export function showEmpty(reason){
  const why=reason||info.reason||'没有可用数据';
  fillCard(EMPTY_TITLE,EMPTY_MSG,why);
}
/** 加载成功：隐藏遮罩，标题栏与提示行回填工程摘要 */
export function hideEmpty(){
  const overlay=$('#vzOverlay');
  if(overlay)overlay.classList.add('off');
}
export function describe(){
  const bars=Math.max(1,Math.round(proj.steps/Math.max(1,SPB())));
  const from=info.source==='hash'?'分享链接':'浏览器临时数据';
  return proj.name+' · '+proj.bpm+' BPM · '+bars+' 小节 · '+proj.tracks.length+' 轨（来自'+from+'）';
}
