/* [sidebar.js] source: Pro.html 3397-3419, 3429-3612, 4366-4369, 4386-4457, 4624-4703
   （侧栏切换 / AI 面板 / 轨道·混音面板 / 作品库；toolbar 侧函数经 hooks.toolbar 回调） */
import { proj, uiTab, setUiTab, selTrack, SPB, uid, patRows, allocPat, rowMidi, ensurePatSizes } from '../core/state.js';
import { ROLES, ENGINE_NAMES, ENGINE_DEF, ROLE_VOL, KIT, KEY_NAMES, SCALES, SCALE_NAMES, MEL_ROWS, noteNameOf, keyBaseMidi, trackRows } from '../core/theory.js';
import { $, $$, el, clamp, ri, rf, chance, pick, toast, icon, UI, hooks } from '../core/util.js';
import { KIT_COLORS } from '../audio/drum.js';
import { auditionTrack } from '../audio/synth.js';
import { applyTrackVolBus } from '../audio/master.js';
import { Play, stopPlay } from '../audio/engine.js';
import { AI, AI_STYLES, aiSeedLocked, setAiSeedLocked } from '../ai/styles.js';
import { aiComposeAll, aiRegenTrack, aiExtendTrack, aiStyleTransfer } from '../ai/compose.js';
import { LIB_KEY, libRead, libWrite, libMeta } from '../core/storage.js';
import { serializeProject, applyProjectData, loadAutosave, undoH, setPendingPre, beginEdit, commitEdit, afterLoad, refreshUndoUI } from '../io/project.js';
import { structural, paintAll, previewDrum, changeShift, setTrackWidth, setTrackAnchor, convertRegionRhythm } from './timeline.js';

/* 图标名映射（FEAT-V6/T5 批 2 第二步）：风格数据的 icon 字段仍是 emoji（ai/styles.js 未授权），
   故按 key 映射到线性图标名；角色图标已由 theory.js 的 ROLES[].icon 直接给名字，这里不再重复维护。 */
const STYLE_ICON={lofi:'coffee',pop:'mic',edm:'speaker',synth:'city',rock:'guitar',jazz:'sax',film:'clapper',ambient:'galaxy'};

export function randomizePatch(t){
  const pickArr=Object.keys(ENGINE_NAMES);
  t.engine=pick(pickArr);
  const d=ENGINE_DEF[t.engine];
  t.osc=pick(['sine','triangle','sawtooth','square']);
  t.cut=ri(300,9000);t.res=Math.round(rf(0,10)*10)/10;
  t.env={a:Math.round(rf(.001,.6)*1000)/1000,d:Math.round(rf(.01,.6)*1000)/1000,
    s:Math.round(rf(0,.9)*100)/100,r:Math.round(rf(.03,.9)*1000)/1000};
  t.detune=ri(0,30);t.nOsc=chance(.5)?2:3;
  t.color=noteColorPick();
}
export function noteColorPick(){const arr=['#ff7ac8','#22ffd6','#7c6cff','#3aa0ff','#ffc46b','#9fe870','#ff6b81','#5ee0ff'];return pick(arr)}
/* =========================================================================
   批 C 第三部分：低频块折叠（默认收起，状态记在 localStorage.mpSidebarCollapsed）
   做法：把已经建好的 .insBox 就地改造 —— 第一个 .h2 换成可点的 <button class="h2 foldH">，
   其余子节点搬进 .foldBody > .foldInner；折叠靠 grid-template-rows 1fr→0fr（height 不能过渡）。
   按钮是原生 <button>，所以 Tab 可达、回车/空格可切换，aria-expanded 同步。
   ========================================================================= */
const FOLD_KEY='mpSidebarCollapsed';
const FOLD_DEFAULT=['rhythm','aiRewrite','aiExtend','styleTransfer'];   // 这四个默认折叠
let foldSet=null;
function foldState(){
  if(foldSet)return foldSet;
  foldSet=new Set(FOLD_DEFAULT);
  try{
    const raw=localStorage.getItem(FOLD_KEY);
    if(raw){const a=JSON.parse(raw);if(Array.isArray(a))foldSet=new Set(a.filter(x=>typeof x==='string'))}
  }catch(e){}
  return foldSet;
}
function foldSave(){
  try{ localStorage.setItem(FOLD_KEY,JSON.stringify([...foldState()])) }catch(e){}
}
/** 把 insBox（或任意容器，其内第一个 .h2 是标题）变成可折叠块；返回同一个容器 */
function makeFoldable(box,key,titleText){
  const head=box.querySelector('.h2');
  if(!head)return box;
  const collapsed=foldState().has(key);
  const btn=document.createElement('button');
  btn.type='button';
  btn.className='h2 foldH';
  btn.setAttribute('aria-expanded',collapsed?'false':'true');
  btn.title='展开 / 收起「'+(titleText||head.textContent.trim())+'」';
  const car=document.createElement('span');
  car.className='ico ico-caret';car.setAttribute('aria-hidden','true');
  btn.appendChild(car);
  while(head.firstChild)btn.appendChild(head.firstChild);   // 原标题里的图标 + 文字搬进按钮
  head.replaceWith(btn);
  const body=document.createElement('div');body.className='foldBody';
  const inner=document.createElement('div');inner.className='foldInner';
  while(btn.nextSibling)inner.appendChild(btn.nextSibling);  // 其余内容整体搬进折叠体
  body.appendChild(inner);
  box.appendChild(body);
  box.classList.add('fold');
  if(collapsed)box.classList.add('collapsed');
  btn.addEventListener('click',()=>{
    const nowCollapsed=!box.classList.contains('collapsed');
    box.classList.toggle('collapsed',nowCollapsed);
    btn.setAttribute('aria-expanded',nowCollapsed?'false':'true');
    if(nowCollapsed)foldState().add(key);else foldState().delete(key);
    foldSave();
  });
  return box;
}
/* ---------- 侧栏 ---------- */
/* =========================================================================
   批 C 第四部分：面板"旧内容淡出"（只有切 tab 时才做，编辑引起的重渲染不做）
   做法：把 sideBody 现有的子节点**整体搬进一个影子层**（.panelGhost），渲染完新内容后再把影子层叠上去，
   200ms 内 opacity 1→0 + translateX(0→-8px)（--ease-in），到点移除。
   · 搬节点而不是 cloneNode(true)：clone 出来的重复 id 会让 document.getElementById 拿到副本
     （面板里有 #extLen / #extAdd 这类会被别处查询的 id），搬节点则天然没有重复。
   · 影子层在新内容渲染**之后**才挂上：各 tab 渲染器开头会 box.innerHTML=''，早挂会被清掉。
   ========================================================================= */
let ghostTimer=0;
export function setTab(tab){
  const changed=(tab!==uiTab);
  const box=(changed&&UI.sideBody)?UI.sideBody:null;
  let ghost=null,ghostTop=0,ghostH=0;
  if(box&&box.firstChild){
    ghost=document.createElement('div');
    ghost.className='panelGhost';
    ghost.setAttribute('aria-hidden','true');
    ghostTop=box.scrollTop||0;                 // 绝对定位在滚动容器里要自己补上滚动偏移
    ghostH=box.clientHeight||0;
    while(box.firstChild)ghost.appendChild(box.firstChild);   // 旧节点整体搬走（监听随之保留，不影响后续渲染）
  }
  setUiTab(tab);
  UI.sideTabs.forEach(b=>b.classList.toggle('on',b.dataset.tab===tab));
  renderInspector();
  if(ghost&&box){
    ghost.style.top=ghostTop+'px';
    if(ghostH)ghost.style.height=ghostH+'px';
    box.appendChild(ghost);
    /* 到点移除（这个 setTimeout 是搬动画必需的一次，已批准） */
    if(ghostTimer)clearTimeout(ghostTimer);
    ghostTimer=setTimeout(()=>{ ghostTimer=0; ghost.remove() },220);
  }
}
export function renderInspector(){
  if(uiTab==='ai'){renderAiTab();return}
  if(uiTab==='lib'){renderLibTab();return}
  renderTrackTab();
}
export function sliderRow(parent,label,min,max,step,val,onIn,fmt,extra){
  const row=el('div','sliderLine');
  row.appendChild(el('label','',label));
  const r=document.createElement('input');r.type='range';r.min=min;r.max=max;r.step=step;r.value=val;
  const v=el('span','v',fmt?fmt(val):Math.round(val));
  r.addEventListener('input',()=>{const x=parseFloat(r.value);v.textContent=fmt?fmt(x):Math.round(x);onIn(x)});
  row.appendChild(r);row.appendChild(v);
  parent.appendChild(row);
  return r;
}
export function sliderRowPct(parent,label,val,onIn){ // 0..1
  return sliderRow(parent,label,0,100,1,Math.round(val*100),x=>onIn(x/100),x=>Math.round(x)+'%');
}
export function renderTrackTab(){
  const box=UI.sideBody;box.innerHTML='';
  const t=selTrack();
  if(!proj.tracks.length){box.innerHTML='<div class="modeNote">还没有音轨。点击 <b>'+icon('menu')+' 菜单</b> 添加，或到 <b>'+icon('sparkle')+' AI 作曲</b> 一键成曲。</div>';return}
  if(!t){box.innerHTML='<div class="modeNote">点击时间线上的任意一条音轨进行编辑。</div>';return}
  const b=el('div','');
  const ins=el('div','insBox');
  // 头部
  const hd=el('div','insHead');
  const R=ROLES[t.role]||ROLES.custom;
  const dot=el('button','',{style:'width:22px;height:22px;border-radius:8px;border:1px solid #fff3;cursor:pointer;flex:none;background:'+t.color});dot.title='随机颜色';
  dot.addEventListener('click',()=>{t.color=noteColorPick();dot.style.background=t.color;structural(true)});
  hd.appendChild(dot);
  const nm=document.createElement('input');nm.className='tname';nm.style.flex='1';nm.value=t.name;
  nm.addEventListener('change',()=>{t.name=nm.value||t.name;structural(true)});
  hd.appendChild(nm);
  const kind=el('span','roleTag',icon(t.kind==='drum'?ROLES.drum.icon:R.icon)+' '+(t.kind==='drum'?'鼓组':R.name));kind.style.color=t.color;kind.style.borderColor=t.color+'55';
  hd.appendChild(kind);
  const del=el('button','btn sm danger',icon('close'));del.title='删除此轨';del.addEventListener('click',()=>hooks.toolbar?.delTrack?.(proj.sel));
  hd.appendChild(del);
  ins.appendChild(hd);
  // 混音
  const M=el('button','hchip'+(t.mute?' on':''),'M静音');M.style.height='26px';
  M.addEventListener('click',()=>{t.mute=!t.mute;M.classList.toggle('on',t.mute);structural(false)});
  const So=el('button','hchip solo'+(t.solo?' solo on':''),'S独奏');So.style.height='26px';
  So.addEventListener('click',()=>{t.solo=!t.solo;So.classList.toggle('on',t.solo);structural(false)});
  const ms=el('div','');ms.style.display='flex';ms.style.gap='6px';ms.style.margin='8px 0';
  ms.appendChild(M);ms.appendChild(So);ins.appendChild(ms);

  sliderRowPct(ins,'音量',t.vol,v=>{t.vol=v;applyTrackVolBus(t)});
  sliderRow(ins,'声像',-100,100,1,Math.round((t.pan||0)*100),x=>t.pan=x/100,x=>{const p=x;return p===0?'C':(p<0?'L'+(-p):'R'+p)});
  sliderRowPct(ins,'混响发送',t.reverb||0,v=>{t.reverb=v});
  sliderRowPct(ins,'延迟发送',t.delay||0,v=>{t.delay=v});

  if(t.kind==='mel'){
    const dv=el('div','divider');ins.appendChild(dv);
    const engRow=el('div','field');
    engRow.appendChild(el('label','','合成器'));
    const eng=el('select','sel');
    for(const k in ENGINE_NAMES){const o=el('option','',ENGINE_NAMES[k]);o.value=k;if(k===t.engine)o.selected=true;eng.appendChild(o)}
    eng.addEventListener('change',()=>{applyEngineDefaults(t,eng.value);renderTrackTab()});
    engRow.appendChild(eng);ins.appendChild(engRow);
    const oscRow=el('div','field');
    oscRow.appendChild(el('label','','波形'));
    const osc=el('select','sel');
    ['sine','triangle','sawtooth','square'].forEach(w=>{const o=el('option','',{sine:'正弦 sine',triangle:'三角 tri',sawtooth:'锯齿 saw',square:'方波 sqr'}[w]);o.value=w;if(w===t.osc)o.selected=true;osc.appendChild(o)});
    osc.addEventListener('change',()=>{t.osc=osc.value});
    oscRow.appendChild(osc);ins.appendChild(oscRow);
    const dRow=el('div','dblRow');
    const d1=el('div',''),d2=el('div','');
    sliderRow(d1,'泛音数',1,4,1,t.nOsc||1,x=>t.nOsc=Math.round(x));
    sliderRow(d2,'失谐 ct',0,40,1,t.detune||0,x=>t.detune=Math.round(x));
    dRow.appendChild(d1);dRow.appendChild(d2);ins.appendChild(dRow);
    sliderRow(ins,'滤波 Hz',120,15000,10,t.cut||2000,x=>t.cut=Math.round(x),x=>x>=1000?(x/1000).toFixed(1)+'k':Math.round(x));
    sliderRow(ins,'共鸣 Q',0.1,18,.1,t.res||1,x=>t.res=Math.round(x*10)/10);
    const aRow=el('div','dblRow');const a1=el('div',''),a2=el('div','');
    sliderRow(a1,'起音 ms',1,1200,1,Math.round((t.env.a||.01)*1000),x=>t.env.a=x/1000);
    sliderRow(a2,'衰减 ms',10,1200,1,Math.round((t.env.d||.1)*1000),x=>t.env.d=x/1000);
    aRow.appendChild(a1);aRow.appendChild(a2);ins.appendChild(aRow);
    const rRow=el('div','dblRow');const r1=el('div',''),r2=el('div','');
    sliderRowPct(r1,'延音',t.env.s||0,x=>t.env.s=x);
    sliderRow(r2,'释音 ms',20,1500,1,Math.round((t.env.r||.2)*1000),x=>t.env.r=x/1000);
    rRow.appendChild(r1);rRow.appendChild(r2);ins.appendChild(rRow);
    // 音区
    const sf=el('div','field');
    sf.appendChild(el('label','','音区'));
    const sfd=el('div','seedRow');sfd.style.flex='1';
    const dm=el('button','btn sm','−12');const octv=el('span','',{style:'flex:1;text-align:center;font:600 12px var(--mono);color:var(--acc)'});
    const refresh=()=>{octv.textContent=(t.shift>=0?'+':'')+t.shift+' 半音'};
    refresh();
    const dp=el('button','btn sm','+12');
    dm.addEventListener('click',()=>{t.shift=clamp((t.shift||0)-12,-48,48);refresh();structural(true)});
    dp.addEventListener('click',()=>{t.shift=clamp((t.shift||0)+12,-48,48);refresh();structural(true)});
    sfd.appendChild(dm);sfd.appendChild(octv);sfd.appendChild(dp);
    sf.appendChild(sfd);ins.appendChild(sf);
    // 独立音域：宽度（可写多宽）与基音八度（该轨锚定在哪一组八度）
    const wf=el('div','field');
    wf.appendChild(el('label','','音域宽'));
    const wsel=el('select','sel');
    [[2,'2 八度（默认）'],[3,'3 八度'],[4,'4 八度']].forEach(o=>{const op=el('option','',o[1]);op.value=o[0];wsel.appendChild(op)});
    wsel.value=String(Math.round((trackRows(t)-1)/7));
    wsel.addEventListener('change',()=>setTrackWidth(+wsel.value));
    wf.appendChild(wsel);ins.appendChild(wf);
    const af=el('div','field');
    af.appendChild(el('label','','基音八度'));
    const asel=el('select','sel');
    for(let o=1;o<=7;o++){const op=el('option','',noteNameOf(keyBaseMidi(proj.key,o)));op.value=o;asel.appendChild(op)}
    asel.value=String(t.keyOct||proj.keyOct);
    asel.addEventListener('change',()=>setTrackAnchor(+asel.value));
    af.appendChild(asel);ins.appendChild(af);
    ins.appendChild(el('div','small','「音域宽」=这一轨能写多少八度（3/4 八度 = 更多行，音高标签每行都有）；「基音八度」=第 0 行主音所在八度，各轨可各自错开，互不影响。'));
    const btns=el('div','rowBtns');
    const test=el('button','btn',icon('play')+' 试听音色');
    test.addEventListener('click',()=>{const m=rowMidi(t,Math.floor(trackRows(t)/2));auditionTrack(t,m,.95)});
    const rnd=el('button','btn',icon('dice')+' 随机音色');rnd.addEventListener('click',()=>{beginEdit();randomizePatch(t);structural(true);renderTrackTab();commitEdit()});
    btns.appendChild(test);btns.appendChild(rnd);ins.appendChild(btns);
  }else{
    const dv=el('div','divider');ins.appendChild(dv);
    ins.appendChild(el('div','h2','鼓组音色（点击试听）'));
    const kl=el('div','kitList');
    KIT.forEach((k,i)=>{
      const kr=el('div','kitRow');
      const sw=el('div','sw');sw.style.background=KIT_COLORS[i];
      kr.appendChild(sw);
      kr.appendChild(el('span','',k.name));
      const pb=el('button','btn sm',icon('play'));
      pb.addEventListener('click',()=>previewDrum(i));
      kr.appendChild(pb);
      kl.appendChild(kr);
    });
    ins.appendChild(kl);
  }
  b.appendChild(ins);
  // 选区节奏细分（旋律轨 + 鼓组轨）：把选中拍的音符/鼓点改成 N 个等长精确时值
  {
    const tr=el('div','insBox');
    tr.appendChild(el('div','h2',icon('quaver')+' 节奏细分'));
    const copy=t.kind==='drum'
      ?'把某拍的鼓点改成 N 连音：先用 '+icon('marquee')+' 选区（或按住 Shift 拖）框选<b>整数拍</b>（如 1 拍=4 格），再到顶部选好连音数并点「'+icon('quaver')+' 应用细分」。<br>・ 每行<b>恰好 N 个鼓点</b> → 改成 N 个等长音（各 1/N 拍）；<br>・ 「还原为网格」可把该拍变回普通格子；<br>・ 其它行/其它拍不受影响。'
      :'把选区内“每拍的起音”改成 N 个等长精确时值（N=2/3/4/5/6），其它轨道不受影响：先用 '+icon('marquee')+' 选区（或按住 Shift 拖）框选<b>整数拍</b>（起点对齐拍的步 0/4/8/12…，如 1 拍=4 格），再到顶部选好连音数并点「'+icon('quaver')+' 应用细分」。<br>・ 每拍正好 N 个起音 → 改为 N 个等长音（各 1/N 拍）；<br>・ 某拍只有 1 个完整长音 → 变为同音 N 等分；<br>・ 选「还原为网格」→ 精确音符落回最近的格子；<br>・ 转换后显示绿色细条标记（按格内实际时值比例）。';
    tr.appendChild(el('div','small',copy));
    const trb=el('button','bigBtn ghost',icon('quaver')+' 对选区应用细分（按顶部选择）');
    trb.addEventListener('click',()=>{const s=document.getElementById('rhythmSel');convertRegionRhythm(s?parseInt(s.value,10):3)});
    tr.appendChild(trb);
    b.appendChild(makeFoldable(tr,'rhythm','节奏细分'));
  }
  // AI 重写
  const ai=el('div','insBox');
  ai.appendChild(el('div','h2',icon('sparkle')+' AI 重写此轨'));
  const fr=el('div','field');
  fr.appendChild(el('label','','重写为'));
  const roleSel=el('select','sel');
  const opts= t.kind==='drum'?[{v:'drum',n:'鼓组节奏'}] :
    [{v:'lead',n:'主旋律'},{v:'arp',n:'琶音'},{v:'pad',n:'和弦垫'},{v:'chord',n:'柱式和弦'},{v:'bass',n:'贝斯'}];
  opts.forEach(o=>{const op=el('option','',o.n);op.value=o.v;if(o.v===t.role)op.selected=true;roleSel.appendChild(op)});
  fr.appendChild(roleSel);
  ai.appendChild(fr);
  const ab=el('button','bigBtn ghost',icon('sparkle')+' 用 AI 重写（不碰其它音轨）');
  ab.addEventListener('click',()=>{aiRegenTrack(roleSel.value)});
  ai.appendChild(ab);
  b.appendChild(makeFoldable(ai,'aiRewrite','AI 重写此轨'));
  // AI 延伸（仅旋律轨）：画出灵感后按动机 DNA 续写
  if(t.kind==='mel'){
    const ex=el('div','insBox');
    ex.appendChild(el('div','h2',icon('music')+' AI 续写（保留动机 DNA）'));
    ex.appendChild(el('div','small','先随意画几个音符/和弦 → 系统分析音程·节奏·轮廓，接着把动机续写下去。'));
    const fr2=el('div','field');
    fr2.appendChild(el('label','','续写长度'));
    const lenSel=el('select','sel');
    lenSel.id='extLen';
    [1,2,4,8].forEach(n=>{const o=el('option','','+'+(n===1?'1 小节':n+' 小节'));o.value=n;if(n===4)o.selected=true;lenSel.appendChild(o)});
    fr2.appendChild(lenSel);
    ex.appendChild(fr2);
    const ck=el('label','',{style:'display:flex;gap:6px;align-items:center;font-size:11.5px;color:var(--mut)'});
    const chk=document.createElement('input');chk.type='checkbox';chk.checked=true;chk.id='extAdd';
    ck.appendChild(chk);
    ck.appendChild(el('span','','添加小节（勾选=扩展曲长后续写；不勾=填满当前剩余空白小节，不扩长）'));
    ex.appendChild(ck);
    const eb=el('button','bigBtn ghost',icon('sparkle')+' 续写并扩展');
    eb.addEventListener('click',()=>aiExtendTrack());
    ex.appendChild(eb);
    b.appendChild(makeFoldable(ex,'aiExtend','AI 续写'));
  }
  box.appendChild(b);
}
export function applyEngineDefaults(t,engine){
  t.engine=engine;
  const d=ENGINE_DEF[engine];
  t.osc=d.osc;t.cut=d.cut;t.res=d.res;t.env={a:d.a,d:d.d,s:d.s,r:d.r};
  t.detune=d.detune;t.nOsc=d.nOsc;
}
/* ---------- AI 面板 ---------- */
/* =========================================================================
   8c. 作品库（浏览器本地存储编过的曲子）
   ========================================================================= */
export function renderLibTab(){
  const box=UI.sideBody;box.innerHTML='';
  const list=libRead();
  const b=el('div','');
  b.appendChild(el('div','h2',icon('home')+' 存入作品库'));
  const sr=el('div','seedRow');
  const nm=document.createElement('input');nm.className='numInp';nm.style.flex='1';nm.value=proj.name||'未命名工程';
  sr.appendChild(nm);
  const add=el('button','btn acc',icon('save')+' 保存当前工程');
  add.addEventListener('click',()=>{libSaveEntry(nm.value||proj.name||'未命名工程')});
  sr.appendChild(add);b.appendChild(sr);
  b.appendChild(el('div','small','保存在本机浏览器（localStorage）。同一作品可存多个副本，支持载入 / 重命名 / 另存 / 删除。'));
  b.appendChild(el('div','h2','我的作品（'+list.length+'）'));
  if(!list.length){
    b.appendChild(el('div','modeNote','还没有存档。用 '+icon('sparkle')+' AI 成曲或手动编好后，点上面的「保存当前工程」。'));
  }else{
    list.forEach(en=>{
      const card=el('div','insBox');
      card.style.padding='8px';
      const head=el('div','insHead');
      const dot=el('div','tgIcon',icon('note'));dot.style.background='rgba(0,217,255,.12)';dot.style.color='var(--acc)';
      head.appendChild(dot);
      const info=el('div','',{style:'flex:1;min-width:0'});
      info.appendChild(el('div','',{style:'font-weight:700;font-size:12.5px',text:en.name}));
      info.appendChild(el('div','',{style:'font-size:10px;color:var(--dim);margin-top:2px',text:libMeta(en.data)}));
      head.appendChild(info);
      const dt=new Date(en.created).toLocaleDateString();
      head.appendChild(el('span','tag-mini',dt));
      card.appendChild(head);
      const row=el('div','rowBtns');
      const open=el('button','btn',icon('folder')+' 载入');
      open.addEventListener('click',()=>libOpenEntry(en.id));
      const dup=el('button','btn sm',icon('copy')+' 另存');
      dup.addEventListener('click',()=>{libSaveEntry(en.name+' (副本)')});
      const ren=el('button','btn sm',icon('pencil'));
      ren.addEventListener('click',()=>{const n=prompt('重命名：',en.name);if(n){en.name=n;if(libWrite(list))renderLibTab()}});
      const del=el('button','btn sm danger',icon('trash'));
      del.addEventListener('click',()=>{if(confirm('删除「'+en.name+'」？')){libWrite(list.filter(x=>x.id!==en.id));renderLibTab()}});
      row.appendChild(open);row.appendChild(dup);row.appendChild(ren);row.appendChild(del);
      card.appendChild(row);
      b.appendChild(card);
    });
  }
  box.appendChild(b);
}
export function libSaveEntry(name){
  try{
    const data=serializeProject();
    const list=libRead();
    list.unshift({id:uid(),name:name||proj.name||'未命名工程',data,created:Date.now()});
    if(list.length>60)list.length=60;
    if(libWrite(list)){
      toast('已存入作品库：'+(name||proj.name),'ok','save');
      renderLibTab();
    }else toast('保存失败：浏览器存储空间不足','err');
  }catch(e){toast('保存失败：'+e.message,'err')}
}
export function libOpenEntry(id){
  const list=libRead();
  const en=list.find(x=>x.id===id);
  if(!en)return toast('未找到该作品');
  try{
    if(Play.playing)stopPlay();
    applyProjectData(JSON.parse(en.data));
    afterLoad();
    // 载入作品是全新上下文：清空撤销/重做历史，避免误回到上一首
    undoH.stack=[];undoH.redo=[];setPendingPre(null);
    refreshUndoUI();
    toast('已载入作品：「'+en.name+'」','ok');
    renderLibTab();
  }catch(e){toast('载入失败：'+e.message,'err')}
}
export function renderAiTab(){
  const box=UI.sideBody;box.innerHTML='';
  const b=el('div','');
  b.appendChild(el('div','h2','选择音乐风格'));
  const chips=el('div','chips');
  for(const k in AI_STYLES){
    const s=AI_STYLES[k];
    const c=el('button','chip'+(AI.style===k?' on':''),'<span class="e">'+icon(STYLE_ICON[k]||'music')+'</span>'+s.name);
    c.addEventListener('click',()=>{AI.style=k;renderAiTab()});
    chips.appendChild(c);
  }
  b.appendChild(chips);
  b.appendChild(el('div','h2','音乐情绪（能量 / 亮度 / 复杂度）'));
  const m=el('div','mood');
  const mk=(label,key,ico)=>{ // 0..1
    const row=el('div','moodRow');
    row.appendChild(el('label','',icon(ico)+' '+label));
    const r=document.createElement('input');r.type='range';r.min=0;r.max=100;r.step=1;r.value=Math.round(AI[key]*100);
    const v=el('span','mv',Math.round(AI[key]*100)+'%');
    r.addEventListener('input',()=>{const x=+r.value/100;AI[key]=x;v.textContent=Math.round(x*100)+'%'});
    row.appendChild(r);row.appendChild(v);
    return row;
  };
  m.appendChild(mk('能量','energy','flame'));
  m.appendChild(mk('亮度','bright','sun-dim'));
  m.appendChild(mk('复杂度','complex','dna'));
  b.appendChild(m);
  b.appendChild(el('div','h2','调性设置'));
  const autoK=AI.autoKey===undefined?true:AI.autoKey;
  const autoM=AI.autoMode===undefined?true:AI.autoMode;
  const kf=el('div','field');kf.appendChild(el('label','','调性'));
  const kSel=el('select','sel');
  const ko=el('option','','随机（每次不同）');ko.value='auto';if(autoK)ko.selected=true;kSel.appendChild(ko);
  KEY_NAMES.forEach(n=>{const o=el('option','',n+' ('+noteNameOf(keyBaseMidi(n,4))+')');o.value=n;if(!autoK&&n===proj.key)o.selected=true;kSel.appendChild(o)});
  kSel.addEventListener('change',()=>{AI.autoKey=kSel.value==='auto';if(!AI.autoKey){proj.key=kSel.value}});
  kf.appendChild(kSel);b.appendChild(kf);
  const mf=el('div','field');mf.appendChild(el('label','','音阶'));
  const mSel=el('select','sel');
  const mo=el('option','','跟随所选风格');mo.value='auto';if(autoM)mo.selected=true;mSel.appendChild(mo);
  for(const k in SCALES){const o=el('option','',SCALE_NAMES[k]);o.value=k;if(!autoM&&k===proj.mode)o.selected=true;mSel.appendChild(o)}
  mSel.addEventListener('change',()=>{AI.autoMode=mSel.value==='auto';if(!AI.autoMode)proj.mode=mSel.value});
  mf.appendChild(mSel);b.appendChild(mf);
  b.appendChild(el('div','h2','随机种子'));
  const sr=el('div','seedRow');
  const si=el('input','numInp');si.style.flex='1';si.value=AI.seed;
  si.addEventListener('change',()=>{AI.seed=clamp(Math.round(+si.value||0),0,1e9);aiSeedLocked=true});
  const dice=el('button','btn',icon('dice'));dice.title='随机种子';
  dice.addEventListener('click',()=>{AI.seed=(Math.random()*1e9)|0;si.value=AI.seed;aiSeedLocked=true});
  sr.appendChild(si);sr.appendChild(dice);b.appendChild(sr);
  const aiMain=el('div','aiMain');
  const big=el('button','bigBtn',icon('sparkle')+' 一键 AI 成曲');
  big.addEventListener('click',()=>{
    // 默认每次自动换新种子，保证作品不重样；手动设过种子则保留（可复现）
    if(!aiSeedLocked)AI.seed=(Math.random()*1e9)|0;
    aiComposeAll();
    if(!aiSeedLocked){si.value=AI.seed}
  });
  aiMain.appendChild(big);
  const rndBtn=el('button','bigBtn ghost',icon('dice')+' 换随机种子再创作');
  rndBtn.addEventListener('click',()=>{AI.seed=(Math.random()*1e9)|0;aiComposeAll()});
  aiMain.appendChild(rndBtn);
  b.appendChild(aiMain);
  // —— 风格迁移（批 C：收进可折叠块，默认收起） ——
  {
    const fw=el('div','insBox');
    fw.appendChild(el('div','h2',icon('palette')+' 风格迁移（保留旋律）'));
    fw.appendChild(el('div','small','把当前主旋律搬到目标风格：保留你写下的旋律 DNA，AI 按该风格重新配器与和声化。'));
    const st2=el('div','chips');
    let style2='jazz';
    for(const k in AI_STYLES){
      const s2=AI_STYLES[k];
      const c=el('button','chip'+(k===style2?' on':''),'<span class="e">'+icon(STYLE_ICON[k]||'music')+'</span>'+s2.name);
      c.addEventListener('click',()=>{style2=k;Array.from(st2.children).forEach(x=>x.classList.remove('on'));c.classList.add('on')});
      st2.appendChild(c);
    }
    fw.appendChild(st2);
    const mBtn=el('button','bigBtn ghost',icon('palette')+' 迁移当前旋律到所选风格');
    mBtn.addEventListener('click',()=>aiStyleTransfer(style2));
    fw.appendChild(mBtn);
    b.appendChild(makeFoldable(fw,'styleTransfer','风格迁移'));
  }
  /* AI 面板底部提示（批 C 后补）：压到 3 行 bullet —— 信息与原来等价（自动配器 / 空格试听 / 两个出口），
     只是不再写成一段长句；id/class 与结构都没动。 */
  b.appendChild(el('div','modeNote',
    '・AI 自动创建鼓组、贝斯、和声与旋律音轨<br>'+
    '・生成后按 <b style="color:var(--acc)">空格</b> 试听<br>'+
    '・不满意 → 点「换种子再创作」，或切到 <b>'+icon('faders')+' 轨道/混音</b> 单轨重写'));
  box.appendChild(b);
}
