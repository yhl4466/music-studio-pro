/* [styles.js] source: Pro.html 3795-3822, 4708, 3823-3825, 3831-3856（风格表 / 段落曲式 / 段落动态） */
import { clamp } from '../core/util.js';

/* =========================================================================
   8b. 新版 AI 作曲：曲式化编曲（引子 / 发展 / 高潮 / 尾声）
   ========================================================================= */
export const AI_STYLES={
  lofi:{name:'Lo-Fi 氛围',icon:'☕',bpm:[70,88],modes:['minor','dorian'],seventh:.5,
    progs:[[0,5,3,4],[0,1,4,5],[0,5,1,4],[3,4,0,5]],
    drumTpl:'lofi',bassTpl:'off',arpOn:.35,leadOn:true,padOn:true,chordOn:.5,leadBand:[2,11],complexityWt:.5},
  pop:{name:'流行 Pop',icon:'🎤',bpm:[104,122],modes:['major'],seventh:.3,
    progs:[[0,5,3,4],[0,3,4,5],[5,3,0,4],[0,4,5,3]],
    drumTpl:'straight',bassTpl:'pulse',arpOn:.45,leadOn:true,padOn:true,chordOn:.8,leadBand:[4,12],complexityWt:.8},
  edm:{name:'电子舞曲 EDM',icon:'🔊',bpm:[122,132],modes:['minor','dorian','harmonicMinor'],seventh:.4,
    progs:[[0,5,3,6],[0,5,6,3],[5,6,1,0],[0,3,5,6]],
    drumTpl:'fourfloor',bassTpl:'eighths',arpOn:1,leadOn:true,padOn:.6,chordOn:.5,leadBand:[3,13],complexityWt:1.1},
  synth:{name:'合成波 Synthwave',icon:'🌆',bpm:[88,104],modes:['minor','dorian'],seventh:.45,
    progs:[[0,5,3,6],[0,3,5,6],[5,6,0,3]],
    drumTpl:'fourfloor',bassTpl:'eighths',arpOn:.9,leadOn:true,padOn:.8,chordOn:.4,leadBand:[3,12],complexityWt:.9},
  rock:{name:'摇滚 Rock',icon:'🎸',bpm:[118,140],modes:['major','mixolydian'],seventh:.15,
    progs:[[0,4,5,3],[0,4,3,5],[5,3,0,4]],
    drumTpl:'rock',bassTpl:'pulse',arpOn:.2,leadOn:true,padOn:.3,chordOn:.9,leadBand:[2,12],complexityWt:1},
  jazz:{name:'爵士摇摆 Jazz',icon:'🎷',bpm:[96,124],modes:['major','mixolydian'],seventh:1,
    progs:[[1,4,0,6],[1,4,0,3],[5,1,4,0]],
    drumTpl:'swing',bassTpl:'walk',arpOn:.2,leadOn:true,padOn:.4,chordOn:1,leadBand:[2,10],complexityWt:1.2},
  film:{name:'电影配乐',icon:'🎬',bpm:[66,92],modes:['minor','dorian','harmonicMinor'],seventh:.85,
    progs:[[0,5,3,0,5,6,3,4],[0,5,6,3],[0,3,5,6],[5,6,0,0]],
    drumTpl:'cinema',bassTpl:'sparse',arpOn:.3,leadOn:true,padOn:1,chordOn:.6,leadBand:[5,13],complexityWt:.6},
  ambient:{name:'环境 Ambient',icon:'🌌',bpm:[58,74],modes:['dorian','lydian','major'],seventh:.7,
    progs:[[0,3,0,4],[0,5,0,4],[3,0,4,0],[0,2,3,4]],
    drumTpl:'soft',bassTpl:'sparse',arpOn:.25,leadOn:.6,padOn:1,chordOn:.5,leadBand:[5,12],complexityWt:.4},
};
export const AI_DEF={style:'lofi',energy:.5,bright:.6,complex:.5,seed:(Math.random()*1e9)|0};
export let aiSeedLocked=false; // 手动设定/掷骰后锁定；否则每次一键成曲自动换新种子（提升新鲜感）
export function setAiSeedLocked(v){aiSeedLocked=v}
export let AI=Object.assign({autoKey:true,autoMode:true},AI_DEF);
/* 按总小节数分配曲式段落 */
export function planSections(B){
  if(B<=2)return Array.from({length:B},()=>'all');
  if(B===3)return ['intro','climax','outro'];
  if(B===4)return ['intro','build','climax','outro'];
  const intro=Math.max(1,Math.round(B*0.14));
  const outro=B>=10?2:1;
  let core=B-intro-outro;
  let build=Math.max(1,Math.round(core*0.34));
  let climax=Math.max(1,core-build);
  if(build+climax>core){climax=core-build;if(build>1)build--}
  const out=[];
  for(let i=0;i<intro;i++)out.push('intro');
  for(let i=0;i<build;i++)out.push('build');
  for(let i=0;i<climax;i++)out.push('climax');
  for(let i=0;i<outro;i++)out.push('outro');
  return out;
}
export const SEC_NAME={intro:'引子',build:'发展',climax:'高潮',outro:'尾声',all:'整曲'};
export function barDyn(sec,E,C){
  const em={intro:.62,build:.72,climax:1.06,outro:.5,'all':.78};
  const vm={intro:.95,build:1,climax:1.2,outro:.9,'all':1};
  const e=clamp((em[sec]||.7)*(0.62+0.5*E)+(sec==='climax'?.12:0),0.1,1.5);
  const v=clamp((vm[sec]||1)*clamp(0.72+0.45*E,.5,1.3),0.25,1.4);
  return {e,v};
}

/* =========================================================================
   8c. 分层生成 · 第一层：整曲曲式规划（段落结构 + 密度/力度/动机标记）
   段落基准：density 0-1 = 乐器密度，vel 0.3-1.0 = 力度系数
   slot：动机槽位（引子/尾声 0 = 主题，发展 1 = 变形，高潮 2 = 高八度变奏），供动机发展使用
   ========================================================================= */
export const SEC_BASE={
  intro:{d:.34,v:.46,newMotif:true,slot:0},
  build:{d:.62,v:.70,newMotif:false,slot:1},
  climax:{d:.98,v:.95,newMotif:true,slot:2},
  outro:{d:.28,v:.40,newMotif:false,slot:0},
  all:{d:.62,v:.70,newMotif:true,slot:0},
};
/* 段落基准经 energy / complexity 轻微调制；保证高潮的密度与力度明显高于发展 */
export function secMeta(sec,E,C){
  const b=SEC_BASE[sec]||SEC_BASE.all;
  const d=clamp(b.d*(0.78+0.42*E)*(0.92+0.16*C),.05,1);
  const v=clamp(b.v*(0.8+0.3*E),.3,1);
  return {density:+d.toFixed(3),vel:+v.toFixed(3),newMotif:b.newMotif,slot:b.slot};
}
/* 把段落标签数组展开为「每小节元数据 + 段落汇总」（fill* 统一从这里取密度/力度） */
export function buildForm(secs,E,C){
  E=(E==null?AI.energy:E);C=(C==null?AI.complex:C);
  const bars=[],sections=[],B=secs.length;
  let i=0;
  while(i<B){
    const sec=secs[i];let j=i;while(j<B&&secs[j]===sec)j++;
    const m=secMeta(sec,E,C);
    sections.push({sec,from:i,to:j,bars:j-i,density:m.density,vel:m.vel,newMotif:m.newMotif,slot:m.slot});
    for(let b=i;b<j;b++)bars.push({
      sec,density:m.density,vel:m.vel,slot:m.slot,
      blockIdx:Math.floor(b/4),barInSec:b-i,sectionBars:j-i,sectionFrom:i,sectionTo:j,
      isSectionStart:b===i,isSectionEnd:b===j-1,isBlockStart:b%4===0,
      newMotif:m.newMotif&&b===i,
    });
    i=j;
  }
  return {secs:secs.slice(),bars,sections,B};
}
/* 用已有段落标签数组直接取元数据（fill* 内部调用，无需改函数签名）
   —— 同一次生成里 5 条轨会各自调用，这里做一次记忆化，避免重复展开 */
let _formCache={key:'',val:null};
export function planFromSections(secs,E,C){
  E=(E==null?AI.energy:E);C=(C==null?AI.complex:C);
  const key=secs.join(',')+'|'+E+'|'+C;
  if(_formCache.key===key)return _formCache.val;
  const val=buildForm(secs,E,C);
  _formCache={key,val};
  return val;
}
/* 分层生成第一层：按总小节数规划整曲曲式
   —— 引子固定 2~6 小节封顶（不再按总长百分比无限放大，长曲开头不再长时间空白）
   —— 尾声 2~8 小节；其余核心部分按 45/55 分给「发展 / 高潮」 */
export function planFullForm(totalBars,E,C){
  const B=Math.max(1,Math.round(totalBars||1));
  const mk=(i,b,c,o)=>{
    const a=[];
    for(let k=0;k<i;k++)a.push('intro');
    for(let k=0;k<b;k++)a.push('build');
    for(let k=0;k<c;k++)a.push('climax');
    for(let k=0;k<o;k++)a.push('outro');
    while(a.length<B)a.push('build');
    return a.slice(0,B);
  };
  if(B<=2)return buildForm(Array.from({length:B},()=>'all'),E,C);
  if(B===3)return buildForm(mk(1,0,1,1),E,C);
  if(B===4)return buildForm(mk(1,1,1,1),E,C);
  let intro=clamp(Math.round(B*.13),2,6);
  let outro=clamp(Math.round(B*.18),2,8);
  if(B-intro-outro<2){ // 极小曲长（5~8 小节）：引子/尾声各让一步，保住发展+高潮
    intro=Math.max(1,Math.min(intro,Math.floor((B-2)/2)));
    outro=Math.max(1,Math.min(outro,B-intro-1));
  }
  const core=Math.max(1,B-intro-outro);
  const build=Math.max(1,Math.round(core*.45));
  const climax=Math.max(1,core-build);
  return buildForm(mk(intro,build,climax,outro),E,C);
}
