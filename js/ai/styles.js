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
