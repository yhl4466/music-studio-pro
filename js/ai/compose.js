/* [compose.js] source: Pro.html 4295-4365, 4458-4460, 4541-4623（一键成曲 / 单轨重写 / 续写 / 风格迁移） */
import { proj, newTrack, allocPat, patRows, ensurePatSizes, selTrack, SPB, aiMeterOK, meterLabel, MAX_BARS } from '../core/state.js';
import { $, clamp, lerp, pick, makeRng, toast, UI, hooks } from '../core/util.js';
import { KEY_NAMES } from '../core/theory.js';
import { rebuildEvents } from '../audio/engine.js';
import { AI, AI_STYLES, SEC_NAME, planFullForm } from './styles.js';
import { fillDrums, fillBass, aiHumanizeVel } from './rhythm.js';
import { planChords, fillArp, fillHarmony } from './harmony.js';
import { fillLead, extractMelodicOnsets, genRangeTo, emptyBarRuns, preserveSketchOnto } from './lead.js';

/* 风格迁移调试信息（原 window.__stInfo → 模块内私有） */
let styleTransferInfo=null;

/* =========================================================================
   8c-1. 分层生成 · 第三层收尾：去“程式化重复”
   以 on/off 二值网格比较相邻“4 小节块”，完全相同则按角色做最小可闻变奏
   （pad 呼吸留白/加色彩音、chord 补一次短促柱式、鼓加幽灵音、其余音级进移位；
   全部手法都保证二值网格发生变化，兜底再删末音）
   ========================================================================= */
/* 相邻两个 4 小节块的 on/off 网格是否完全相同（逐格早退，避免拼字符串的开销） */
function sameBlock(t,rows,k1,k2){
  for(let s=0;s<64;s++){
    const c1=t.pat[k1*64+s],c2=t.pat[k2*64+s];
    if(!c1||!c2){if(!!c1!==!!c2)return false;continue}
    for(let r=0;r<rows;r++){
      if((c1[r]>0?1:0)!==(c2[r]>0?1:0))return false;
    }
  }
  return true;
}
function varyBlock(t,rows,k,rng){
  const s0=k*64,s1=s0+64;
  const active=[];
  for(let s=s0;s<s1;s++){
    const col=t.pat[s];if(!col)continue;
    for(let r=0;r<rows;r++)if(col[r]>0)active.push({s,r,v:col[r]});
  }
  if(!active.length)return false; // 空块（该轨本段静默）不算重复，也不硬塞音符
  const role=t.role||t.kind;
  const bs=s1-16; // 块内最后一小节
  if(role==='pad'){
    // 呼吸：末小节后半留白（若已留白，则叠一个色彩音 +2 级）
    let cut=false;
    for(let s=bs+8;s<bs+16;s++)for(let r=0;r<rows;r++)if(t.pat[s][r]>0){t.pat[s][r]=0;cut=true}
    if(!cut){
      for(const c of active){
        const r2=c.r+2;
        if(r2<rows&&!(t.pat[c.s][r2]>0)){t.pat[c.s][r2]=c.v*.82;break}
      }
    }
  }else if(role==='chord'){
    // 柱式：末小节第三拍再补一次短促和弦（听感上是加厚，不破坏和声）
    const set=[];
    for(let s=bs;s<bs+16;s++)for(let r=0;r<rows;r++)if(t.pat[s][r]>0&&set.indexOf(r)<0)set.push(r);
    if(set.length){for(let s=bs+10;s<bs+12&&s<bs+16;s++)set.forEach(r=>{t.pat[s][r]=Math.max(t.pat[s][r]||0,.42)})}
  }else if(role==='drum'){
    // 幽灵音：末小节反拍加一记轻踩镲（占用则换另一处，再不行换军鼓）
    const cand=[3,4];
    let placed=false;
    for(const st of [3,7,11,15]){
      for(const r of cand){
        if(r>=rows)continue;
        if(!(t.pat[bs+st][r]>0)){t.pat[bs+st][r]=.2;placed=true;break}
      }
      if(placed)break;
    }
    if(!placed&&rows>1)for(const st of [5,13]){if(!(t.pat[bs+st][1]>0)){t.pat[bs+st][1]=.26;placed=true;break}}
  }else if(role==='bass'){
    // 末小节补一个十六分经过音（落在空位）
    for(const st of [7,15,11,3]){
      if(!(t.pat[bs+st]&&t.pat[bs+st][active[0].r]>0)){t.pat[bs+st][active[0].r]=.42;break}
    }
  }else{
    // 旋律/琶音等：末小节取一个音做 ±1 级进移位
    for(let i=active.length-1;i>=0;i--){
      const c=active[i];if(c.s<bs)continue;
      const r2=c.r+(rng.chance(.5)?1:-1);
      if(r2>=0&&r2<rows&&!(t.pat[c.s][r2]>0)){t.pat[c.s][r2]=c.v;t.pat[c.s][c.r]=0;break}
    }
  }
  if(!sameBlock(t,rows,k,k-1))return true;
  const last=active[active.length-1]; // 兜底：删掉块内最后一个音（必然与上一块不同）
  t.pat[last.s][last.r]=0;
  return !sameBlock(t,rows,k,k-1);
}
export function deRepeatPass(tracks,rng){
  const B=Math.round(proj.steps/16),blocks=Math.floor(B/4);
  if(blocks<2)return 0;
  let fixed=0;
  tracks.forEach(t=>{
    const rows=patRows(t);if(!rows)return;
    for(let k=1;k<blocks;k++){
      if(!sameBlock(t,rows,k,k-1))continue;
      if(varyBlock(t,rows,k,rng))fixed++;
    }
  });
  return fixed;
}

export function aiComposeAll(){
  if(!aiMeterOK()){toast('AI 自动编曲目前仅支持 4/4（当前 '+meterLabel()+'）：请手动编辑，或把拍号切回 4/4','err');return}
  hooks.undo?.beginEdit?.();
  const rng=makeRng(AI.seed);
  const style=AI_STYLES[AI.style];
  if(!style){hooks.undo?.commitEdit?.();toast('未知风格','err');return}
  const E=AI.energy,B=AI.bright,C=AI.complex;
  const Bbars=Math.max(1,Math.round(proj.steps/SPB()));
  const secs=planFullForm(Bbars,E,C).secs;
  proj.bpm=clamp(Math.round(lerp(style.bpm[0],style.bpm[1],E)+rng.i(-4,4)),40,220);
  hooks.ui?.syncBpmUI?.();
  if(AI.autoKey){proj.key=KEY_NAMES[rng.i(0,11)]}
  if(AI.autoMode)proj.mode=pick(style.modes);
  if(AI.autoMode&&B>.6&&style.modes.indexOf('major')<0)proj.mode='major';
  const chords=planChords(rng,secs,style,E,clamp(C+.15,0,1.3));
  const want=[];
  const hasDrum=(style.drumTpl!=='soft'||E>.5);
  if(hasDrum)want.push('drum');
  want.push('bass');
  want.push('pad');
  if(style.chordOn>0&&(style.chordOn>=1||rng.chance(style.chordOn)))want.push('chord');
  if(style.arpOn>0&&(style.arpOn>=1||rng.chance(style.arpOn)))want.push('arp');
  if(style.leadOn&&(style.leadOn===true||rng.chance(style.leadOn)))want.push('lead');
  proj.tracks=[];
  const fresh=role=>{const tr=newTrack(role==='drum'?'drum':'mel',role);allocPat(tr,proj.steps,patRows(tr));proj.tracks.push(tr);return tr};
  want.forEach(r=>fresh(r));
  proj.tracks.forEach(t=>{
    if(t.kind==='drum')fillDrums(t,rng,style,chords,secs,E,C);
    else if(t.role==='bass')fillBass(t,rng,chords,secs,style,E,C);
    else if(t.role==='arp')fillArp(t,rng,chords,secs,style,E,C);
    else if(t.role==='pad'||t.role==='chord')fillHarmony(t,rng,chords,secs,t.role==='pad',C,E);
    else if(t.role==='lead')fillLead(t,rng,chords,secs,style,E,C,style.leadBand||[2,12]);
  });
  deRepeatPass(proj.tracks,rng); // 分层生成第三层收尾：消除相邻 4 小节的完全重复
  aiHumanizeVel(proj.tracks,rng,.13); // AI 输出自带人性化力度
  proj.sel=0;
  hooks.ui?.structural?.(true);
  hooks.ui?.buildKeyBar?.();
  hooks.inspector?.render?.();
  const cnt={};
  secs.forEach(s=>cnt[s]=(cnt[s]||0)+1);
  const desc=Bbars+' 小节 · '+Object.keys(cnt).map(k=>SEC_NAME[k]+(cnt[k]||0)).join(' · ');
  hooks.undo?.commitEdit?.();
  toast('🎼 '+style.name+' 完成：'+proj.key+(proj.mode==='minor'?' 小调':' 大调')+' · '+proj.bpm+' BPM · '+desc,'ok');
}
export function aiRegenTrack(role){
  if(!aiMeterOK()){toast('AI 重写目前仅支持 4/4（当前 '+meterLabel()+'）：请手动编辑或切回 4/4','err');return}
  const ti=proj.sel,t=proj.tracks[ti];
  if(!t)return toast('未选中音轨');
  hooks.undo?.beginEdit?.();
  const rng=makeRng(AI.seed);
  const style=AI_STYLES[AI.style]||AI_STYLES.lofi;
  const E=AI.energy,B=AI.bright,C=AI.complex;
  const Bbars=Math.max(1,Math.round(proj.steps/SPB()));
  const secs=planFullForm(Bbars,E,C).secs;
  const chords=planChords(rng,secs,style,E,clamp(C+.15,0,1.3));
  if(t.kind==='drum'){fillDrums(t,rng,style,chords,secs,E,C)}
  else{
    const rows=patRows(t);
    for(let s=0;s<proj.steps;s++)for(let r=0;r<rows;r++)t.pat[s][r]=0;
    switch(role){
      case 'bass':fillBass(t,rng,chords,secs,style,E,C);break;
      case 'arp':fillArp(t,rng,chords,secs,style,E,C);break;
      case 'pad':case 'chord':fillHarmony(t,rng,chords,secs,role==='pad',C,E);break;
      case 'lead':default:fillLead(t,rng,chords,secs,style,E,C,style.leadBand||[2,12]);break;
    }
  }
  deRepeatPass([t],rng); // 去程式化重复（单轨重写同样适用）
  aiHumanizeVel([t],rng,.13);
  hooks.ui?.paintAll?.();rebuildEvents();hooks.ui?.markDirtyUI?.();
  hooks.undo?.commitEdit?.();
  toast('✨ 已用 AI 重写「'+t.name+'」','ok');
}
/* =========================================================================
   8d. AI 延伸 / 风格迁移（保留动机 DNA）
   ========================================================================= */
/* “AI 续写”：曲式化 + 按角色补写；纯灵感自动配成完整编曲 */
export function aiExtendTrack(){
  if(!aiMeterOK()){toast('AI 续写目前仅支持 4/4（当前 '+meterLabel()+'）：请手动编辑或切回 4/4','err');return}
  const t=selTrack();
  if(!t)return toast('请先在「轨道/混音」选中一条音轨','err');
  const style=AI_STYLES[AI.style]||AI_STYLES.lofi;
  const addMode=!($('#extAdd')&&$('#extAdd').checked===false);
  const addBars=clamp(parseInt((($('#extLen')||{}).value)||'4',10)||4,1,8);
  const S=proj.steps;
  const end=addMode?Math.min(MAX_BARS*16,S+addBars*16):S;
  if(addMode&&end===S)return toast('已达 '+MAX_BARS+' 小节上限','err');
  const E=AI.energy,C=AI.complex;
  const secs=planFullForm(Math.ceil(end/16),E,C).secs;
  const rng=makeRng((AI.seed||7)^0x5f5);
  const chords=planChords(rng,secs,style,E,clamp(C+.15,0,1.3));
  const hasSong=proj.tracks.filter(x=>['drum','bass','pad','chord','arp'].indexOf(x.role)>=0).length>=2;
  const isMel=(t.kind==='mel');
  if(isMel){const ons=extractMelodicOnsets(t);if(ons.length<2)return toast('旋律轨请先画几个音符（或和弦），再续写','err');}
  hooks.undo?.beginEdit?.();
  if(addMode){proj.steps=end;ensurePatSizes();}
  if(!hasSong){
    // —— 纯灵感：自动配成完整编曲（曲式化），再把用户手绘内容按角色覆盖回原区间 ——
    const prevAutoKey=AI.autoKey,prevAutoMode=AI.autoMode;
    const srcTracks=proj.tracks.map(tr=>({kind:tr.kind,role:tr.role,pat:tr.pat.map(c=>c.slice())}));
    const srcSteps=S;
    AI.autoKey=false;AI.autoMode=false;
    try{
      aiComposeAll(); // 按当前风格完整配器（含引子/发展/高潮/尾声）
    }finally{AI.autoKey=prevAutoKey;AI.autoMode=prevAutoMode;}
    preserveSketchOnto(srcTracks,srcSteps);
    hooks.undo?.commitEdit?.();hooks.ui?.structural?.(true);rebuildEvents();
    if(UI.barsN){const bb=Math.max(1,Math.round(proj.steps/SPB()));UI.barsN.value=bb;if(UI.barsV)UI.barsV.textContent=bb}
    toast('🎶 已把灵感续成完整编曲（'+(proj.steps/SPB())+' 小节 · 按曲式与风格配器），保留你的动机','ok');
    return;
  }
  // —— 已有完整编曲：按“每种音轨各自的逻辑”补写新小节/空白小节 ——
  const B=Math.ceil(proj.steps/SPB());
  const from=addMode?(S/16):0,to=B;
  let touched=0;
  proj.tracks.forEach(track=>{
    if(track.kind!=='mel'&&track.kind!=='drum')return;
    const runs=addMode?[[from,to]]:emptyBarRuns(track,B);
    runs.forEach(rg=>{
      const bf=Math.max(0,rg[0]),bt=Math.min(B,rg[1]);
      if(bt<=bf)return;
      genRangeTo(track,track.role,bf,bt,secs,chords,style,E,C,makeRng((AI.seed||7)^0xAA^(bf+bt)));
      touched++;
    });
  });
  hooks.undo?.commitEdit?.();hooks.ui?.structural?.(true);rebuildEvents();
  if(UI.barsN){const bb=Math.max(1,Math.round(proj.steps/SPB()));UI.barsN.value=bb;if(UI.barsV)UI.barsV.textContent=bb}
  toast('🎶 AI 续写完成：已按曲式把 '+(addMode?'新小节':'空白小节')+' 的鼓组/贝斯/和声/琶音/旋律逐轨补出（'+(addMode?'+'+(B-S/16)+' 小节':'共补 '+touched+' 轨段')+'）','ok');
}
/* “风格迁移”：把当前主旋律保留，按目标风格重新配器/和声化 */
export function aiStyleTransfer(styleKey){
  if(!aiMeterOK()){toast('风格迁移目前仅支持 4/4（当前 '+meterLabel()+'）：请手动编辑或切回 4/4','err');return}
  const style=AI_STYLES[styleKey];
  if(!style)return toast('未知风格','err');
  const srcTrack=(selTrack()&&selTrack().kind==='mel')
    ?selTrack()
    :(proj.tracks.find(x=>x.kind==='mel'&&x.role==='lead')||proj.tracks.find(x=>x.kind==='mel'));
  if(!srcTrack)return toast('需要先有一条旋律（手画或先 AI 生成）再迁移','err');
  const src=srcTrack.pat.map(col=>col.slice());
  hooks.undo?.beginEdit?.();
  const prevAutoKey=AI.autoKey,prevAutoMode=AI.autoMode;
  AI.autoKey=false;AI.autoMode=false; // 保留调性与调式，只换“配器与和声”
  try{
    AI.style=styleKey;
    aiComposeAll();
  }finally{
    AI.autoKey=prevAutoKey;AI.autoMode=prevAutoMode;
  }
  // 把源旋律写回新工程的主旋律轨（DNA 不变）
  const lead=proj.tracks.find(x=>x.kind==='mel'&&x.role==='lead')||proj.tracks.find(x=>x.kind==='mel');
  if(lead&&src){
    const rows=patRows(lead);
    for(let s=0;s<proj.steps;s++)for(let r=0;r<rows;r++)lead.pat[s][r]=(src[s]&&src[s][r])?src[s][r]:0;
  }
  styleTransferInfo={found:!!lead,hasSrc:!!src,first:(lead&&lead.pat[0][0])||null,roles:proj.tracks.map(t=>t.role).join(',')};
  hooks.undo?.commitEdit?.();
  hooks.ui?.structural?.(true);rebuildEvents();hooks.inspector?.render?.();
  toast('🎨 已按「'+style.name+'」重新编曲，主旋律 DNA 保留','ok');
}
