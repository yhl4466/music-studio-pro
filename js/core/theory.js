/* [theory.js] source: Pro.html 851-853, 937-973, 979-982, 984-1016（rowMidi 因读 proj 移入 state.js） */
/* 精确时值刻度：1 步 = PREC_U_PER_STEP u，1 拍 = 4 步 = 240u。
   2/3/4/5/6 等分依次为 120/80/60/48/40 u，全部是整数 → 无浮点误差 */
export const PREC_U_PER_STEP = 60;
/* =========================================================================
   1. 音乐理论常量：音阶 / 调号 / 频率
   ========================================================================= */
export const NOTE_SEMI={C:0,'C#':1,Db:1,D:2,'D#':3,Eb:3,E:4,F:5,'F#':6,Gb:6,G:7,'G#':8,Ab:8,A:9,'A#':10,Bb:10,B:11};
export const NOTE_NAMES=['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
export const KEY_NAMES=['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
export function noteNameOf(midi){const n=Math.round(midi);return NOTE_NAMES[((n%12)+12)%12]+(Math.floor(n/12)-1)}
/* 音阶：7 个全音阶音程 */
export const SCALES={
  major:[0,2,4,5,7,9,11],
  minor:[0,2,3,5,7,8,10],
  dorian:[0,2,3,5,7,9,10],
  mixolydian:[0,2,4,5,7,9,10],
  lydian:[0,2,4,6,7,9,11],
  phrygian:[0,1,3,5,7,8,10],
  harmonicMinor:[0,2,3,5,7,8,11],
  melodicMinor:[0,2,3,5,7,9,11]
};
export const SCALE_NAMES={major:'大调 Major',minor:'自然小调 Minor',dorian:'多利亚 Dorian',mixolydian:'混合利底亚 Mixo',
  lydian:'利底亚 Lydian',phrygian:'弗里几亚 Phrygian',harmonicMinor:'和声小调',melodicMinor:'旋律小调'};
/* 半音偏移数组（用于行号映射）*/
export const DEG_CUM={};
for(const k in SCALES){DEG_CUM[k]=SCALES[k].slice()} // 各音级到主音的半音偏移（切勿再累加）
/* 度数行 -> 半音（0..23+，行 0..14，7 与 14 为八度根音）*/
export function degSemi(scaleKey,d){const cum=DEG_CUM[scaleKey];const oct=Math.floor(d/7);const i=d%7;return oct*12+cum[i]}
/* 最接近的行（给定半音 0..24）*/
export function semiToDeg(scaleKey,sem){
  let best=0,bd=99;
  for(let d=0;d<=14;d++){const dd=Math.abs(degSemi(scaleKey,d)-sem);if(dd<bd){bd=dd;best=d}}
  return best;
}
export const MEL_ROWS=15; // 默认：两个八度的音阶级数行（老工程/通用）
/* 每轨独立音域：
   t.rows   — 该轨显示的音阶行数（oct*7+1：2→15、3→22、4→29）；缺省=MEL_ROWS(2 八度)
   t.keyOct — 该轨“基音八度”锚点（行 0 = 该八度的主音）；缺省跟随工程 keyOct */
export function trackRows(t){return t&&t.kind==='drum'?KIT.length:(t&&t.rows&&t.rows>=7?t.rows:MEL_ROWS)}
export function octRowsOf(oct){return oct*7+1}
export const ROW_MIDI=[]; // 预缓存纯函数
export function keyBaseMidi(keyName,octave){return (octave+1)*12+NOTE_SEMI[keyName]}
export function midiOfRow(scaleKey,keyName,keyOct,shift,d){return keyBaseMidi(keyName,keyOct)+shift+degSemi(scaleKey,d)}
export function freqOf(midi){return 440*Math.pow(2,(midi-69)/12)}
/* =========================================================================
   2. 工程与音轨模型
   ========================================================================= */
export const KIT=[ // 鼓组音色行（固定 8 行）；icon = 线性图标名（css/layout.css 的 .ico-<name>），不再是 emoji 字形
  {id:'kick',  name:'底鼓',   icon:'kick'},
  {id:'snare', name:'军鼓',   icon:'snare'},
  {id:'clap',  name:'拍手',   icon:'clap'},
  {id:'hhc',   name:'闭镲',   icon:'hhc'},
  {id:'hho',   name:'开镲',   icon:'hho'},
  {id:'tom',   name:'通鼓',   icon:'tom'},
  {id:'rim',   name:'边击',   icon:'rim'},
  {id:'crash', name:'吊镲',   icon:'crash'}
];
export const ROLES={ // icon = 线性图标名（供 ui/timeline.js 的 .tgIcon 与 ui/sidebar.js 的 .roleTag 使用）
  lead :{name:'主旋律',icon:'mic',  defEngine:'lead', color:'#ff7ac8', shift:12},
  bass :{name:'贝斯',  icon:'low',  defEngine:'bass', color:'#ffc46b', shift:-12},
  pad  :{name:'和弦垫',icon:'mist', defEngine:'pad',  color:'#7c6cff', shift:0},
  chord:{name:'柱式和弦',icon:'keys',defEngine:'organ',color:'#3aa0ff', shift:-12},
  arp  :{name:'琶音', icon:'waves',defEngine:'pluck', color:'#22ffd6', shift:12},
  custom:{name:'自定义',icon:'gear',defEngine:'pluck',color:'#9fe870',shift:0},
  drum :{name:'鼓组', icon:'drum', color:'#ff6b81', shift:0}
};
export const ENGINE_NAMES={lead:'主音 Lead',pluck:'拨弦 Pluck',pad:'垫 Pad',bass:'贝斯 Bass',bell:'铃音 Bell',organ:'风琴 Organ'};
/* 引擎默认参数 */
export const ENGINE_DEF={
  lead :{osc:'sawtooth',cut:4200,res:2.5,a:.012,d:.09,s:.62,r:.2, detune:14, nOsc:2, glide:0},
  pluck:{osc:'triangle',cut:3000,res:1,a:.004,d:.22,s:.0, r:.16, detune:6,  nOsc:1, glide:0},
  pad  :{osc:'triangle',cut:950, res:1.4,a:.4,d:.5,s:.32,r:.85, detune:5,  nOsc:1, glide:0},
  bass :{osc:'sawtooth',cut:390, res:3.5,a:.004,d:.12,s:.55,r:.14, detune:5,  nOsc:1, glide:0},
  bell :{osc:'sine',    cut:9000,res:.5,a:.002,d:.8, s:.0, r:1.1, detune:0,  nOsc:1, glide:0},
  organ:{osc:'sine',    cut:2000,res:.4, a:.03, d:.07,s:.42,r:.18, detune:0,  nOsc:1, glide:0}
};
export const ROLE_VOL={lead:.92,bass:.85,pad:.45,chord:.26,arp:.7,custom:.85,drum:.8};
/* =========================================================================
   3. 升降号（acc）层：t.acc = {[step]:{[row]:-1|0|1}} —— 稀疏对象，0 不落键
   accOf / setAcc 是本层唯一读写入口；两者只依赖 t，不依赖 proj → 归本文件。
   注意：音高入口 rowMidi 在 core/state.js（state.js import 本文件，本文件不可反向 import）。
   ========================================================================= */
/* 读：无 t.acc / 无该 step / 无该 row / 非法值 → 一律 0（= 无变化） */
export function accOf(t,step,row){
  if(!t||!t.acc||step==null||row==null)return 0;
  const s=t.acc[step];
  if(!s)return 0;
  const v=s[row];
  return (v===1||v===-1)?v:0;
}
/* 写：只认 ±1 落键；其余值（0/undefined/NaN…）一律删键；空 step 键一并删除（进一步稀疏化） */
export function setAcc(t,step,row,v){
  if(!t||step==null||row==null)return;
  const a=t.acc||(t.acc={});
  const s=a[step]||(a[step]={});
  if(v===1||v===-1)s[row]=v;else delete s[row];
  if(!Object.keys(s).length)delete a[step];
}
/* 兜底清洗：删掉“没有音”的升降号键（孤儿标记）。
   判据 = 该 (step,row) 上既没有网格音符（t.pat[step][row]>0），也没有落在该步的精确时值音符（prec）；
   另外 step 越界（<0 或 ≥ steps）、row 越界（≥ 该轨行数）的键同样算孤儿。
   —— 所有会改 pat 的路径（绘制/擦除、量化、粘贴、细分、拍号、清空、曲长、AI 重写）最后都会走
      audio/engine.js 的 rebuildEvents()，那里调用本函数即可全局收口；serializeProject 之前再调一次做双保险。
   steps 省略时取该轨 pat 的列数。返回删掉的键数。 */
export function pruneAcc(t,steps){
  if(!t||!t.acc)return 0;
  const S=(steps!=null&&steps>=0)?steps:(t.pat?t.pat.length:0);
  const rows=trackRows(t);
  // “有精确时值音符”的格做成集合（只有真的存在 prec 音符时才建；绝大多数轨是空数组 → 零开销）
  let precHas=null;
  if(t.prec&&t.prec.length){
    precHas=new Set();
    for(let i=0;i<t.prec.length;i++){
      const p=t.prec[i];
      if(p.row!=null&&p.row>=0&&p.row<rows)precHas.add(Math.floor((p.u||0)/PREC_U_PER_STEP)+':'+p.row);
    }
  }
  const drop=[];
  for(const k in t.acc){
    const step=+k;
    const col=t.acc[k];
    if(!(step>=0&&step<S)){for(const rr in col)drop.push([step,+rr]);continue}
    const patCol=t.pat?t.pat[step]:null;
    for(const rr in col){
      const row=+rr;
      // 常见情形：记号就在有音符的格上 → 一次查表即通过（不做集合查询、不拼字符串）
      if(row>=0&&row<rows&&patCol&&patCol[row]>0)continue;
      if(!precHas||!precHas.has(step+':'+row))drop.push([step,row]);
    }
  }
  for(let i=0;i<drop.length;i++)setAcc(t,drop[i][0],drop[i][1],0);
  return drop.length;
}
