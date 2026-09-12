/* [state.js] source: Pro.html 854-869, 922, 974-978, 1017-1071, 1093, 1547, 1661-1678, 2143-2147 */
import { PREC_U_PER_STEP, KIT, MEL_ROWS, ROLES, ENGINE_DEF, ROLE_VOL, degSemi, keyBaseMidi, trackRows } from './theory.js';
/* 每小节步数：一律“每拍 4 格”的十六分网格（spb 已惰性化，不再影响逻辑） */
/* 拍号 / 网格换算 */
export function stepsPerQuarter(){return 4}
export function meterN(){return (proj&&proj.meterN)||4}
export function meterD(){return (proj&&proj.meterD)||4}
export function meterLabel(){return meterN()+'/'+meterD()}
/* 每拍步数：步=16分音符时，4/4→4、3/4→4、6/8→2、2/2→8 …（必须为整数，否则回退） */
export function stepsPerBeat(){
  const v=stepsPerQuarter()*4/meterD();
  return (Number.isInteger(v)&&v>=1)?v:stepsPerQuarter();
}
export function SPB(){return meterN()*stepsPerBeat()} // 每小节步数
export function beatSteps(){return stepsPerBeat()}
export function barSeconds(){return meterN()*(60/(proj.bpm||120))} // BPM 按“拍号分母拍”计（标准节拍器约定）
export function isStraightFourFour(){return meterN()===4&&meterD()===4}
export function aiMeterOK(){return isStraightFourFour()}
export function fmtPos(step){const spb=SPB(),bs=beatSteps();const bar=Math.floor(step/spb)+1,beat=Math.floor((step%spb)/bs)+1,cell=step%bs+1;return bar+'.'+beat+'.'+cell}
/* 某一轨某行的绝对 MIDI（独立锚点 + 轨内 shift + 音阶度数） */
export function rowMidi(t,r){
  const kb=keyBaseMidi(proj.key,(t&&t.keyOct)?t.keyOct:proj.keyOct);
  return kb+(t&&t.shift||0)+degSemi(proj.mode,r);
}
export function newTrack(kind,role,opts={}){
  const r=ROLES[role]||ROLES.custom;
  const eng=(kind==='mel')?(opts.engine||r.defEngine):null;
  const def=eng?ENGINE_DEF[eng]:{};
  return {
    id:uid(), kind, role,
    name:opts.name||(kind==='drum'?'鼓组':'音轨'+(role?('·'+r.name):'')),
    color:opts.color||r.color,
    engine:eng, osc:def.osc, cut:def.cut, res:def.res,
    env:{a:def.a,d:def.d,s:def.s,r:def.r},
    detune:def.detune, nOsc:def.nOsc,
    vol:(ROLE_VOL[role]!=null?ROLE_VOL[role]:0.85), pan:0, reverb:0, delay:0, mute:false, solo:false,
    shift:opts.shift!=null?opts.shift:(r.shift||0),
    rows:opts.rows||0, keyOct:opts.keyOct||0, // 0=默认：2八度、跟随工程 keyOct
    collapsed:false,
    // pattern: pattern[step][row] = velocity(0=关)
    pat:[],
    // prec：选区节奏细分产生的精确时值音符——{row,u,durU,vel}
    // u 单位：1 步 = PREC_U_PER_STEP(60)u、1 拍 = 240u；各轨道独立，只影响本轨
    prec:[],
    steps:0
  };
}
export function uid(){return 't'+Math.random().toString(36).slice(2,8)+Date.now().toString(36).slice(-3)}
export function allocPat(track,S,rows){track.pat=Array.from({length:S},()=>new Array(rows).fill(0));track.steps=S}
export function patRows(track){return trackRows(track)}

export let proj={};
export function setProj(v){proj=v}
export function blankProject(){
  return {
    name:'未命名工程', bpm:100, swing:0, steps:32, spb:16, meterN:4, meterD:4, masterVol:1,
    key:'C', mode:'major', keyOct:4, tracks:[], sel:-1
  };
}
export function applyTrackPatSize(t){const rows=patRows(t);if(t.pat.length!==t.steps||!t.pat[0]||t.pat[0].length!==rows){allocPat(t,t.steps,rows)}}

/* 在 C 大调下生成一套带基本和弦的默认示例 —— 供空工程演示，之后由 AI 接管 */
export function demoProject(){
  const p=blankProject();
  p.name='示例工程'; p.bpm=100; p.key='C'; p.mode='major';
  const mk=(role,shift,name)=>{const t=newTrack('mel',role,{shift});t.name=name;p.tracks.push(t);allocPat(t,p.steps,MEL_ROWS);return t};
  p.tracks.push(newTrack('drum','drum',{name:'鼓组'}));allocPat(p.tracks[0],p.steps,KIT.length);
  mk('bass',-12,'贝斯');
  mk('pad',-12,'和声垫');
  const lead=mk('lead',12,'主旋律');
  // 极简填充（主要靠 AI 升级后会重建）
  const S=p.steps;
  for(let s=0;s<S;s+=4){p.tracks[0].pat[s][0]=.9}              // kick 每拍
  for(let s=2;s<S;s+=8)p.tracks[0].pat[s][3]=.55                // 后置闭镲
  for(let s=4;s<S;s+=8){p.tracks[0].pat[s][1]=.8}              // snare 2/4
  for(let s=0;s<S;s+=2)p.tracks[1].pat[s][0]=.85;               // bass root
  for(let s=0;s<S;s+=16){for(const d of[0,2,4])p.tracks[2].pat[s][d]=.6}
  for(let s=0;s<S;s+=4)p.tracks[3].pat[s][(s/4)%2?4:7]=.75;
  return p;
}

export let actx=null, A=null; // A = 实时图
export function setActx(v){actx=v}
export function setA(v){A=v}
export function stepDurNow(){return barSeconds()/SPB()}
export let uiTab='ai'; // 当前侧栏标签（默认与界面高亮一致：AI 作曲面板）
export function setUiTab(v){uiTab=v}
export function selTrack(){return proj.sel>=0&&proj.sel<proj.tracks.length?proj.tracks[proj.sel]:null}
export function ensurePatSizes(){
  const S=proj.steps;
  proj.tracks.forEach(t=>{
    const rows=patRows(t);
    if(t.pat.length!==S||(t.pat[0]&&t.pat[0].length!==rows)){
      const np=Array.from({length:S},()=>new Array(rows).fill(0));
      if(t.pat&&t.pat.length){for(let s=0;s<Math.min(S,t.pat.length);s++){const src=t.pat[s];for(let r=0;r<Math.min(rows,src.length);r++)np[s][r]=src[r]}}
      t.pat=np;
    }
    pruneTrackPrec(t); // 曲长变化后清理越界的精确时值音符
  });
}
export function stepWidth(){const S=proj.steps;return S<=16?32:S<=32?26:S<=64?20:S<=128?14:S<=256?9:7}
/* 视图级缩放：只改变格子的显示宽度，不改变曲长与音符 */
export let uiZoom=1;
export function setUiZoom(v){uiZoom=v}
export function effStepWidth(){return Math.max(4,Math.round(stepWidth()*uiZoom))}
export function pruneTrackPrec(t){
  if(!t.prec)return;
  const lim=proj.steps*PREC_U_PER_STEP;
  t.prec=t.prec.filter(p=>Number.isFinite(p.u)&&p.u>=0&&p.u+(p.durU||PREC_U_PER_STEP)<=lim);
}
