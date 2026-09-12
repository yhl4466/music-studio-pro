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
export const KIT=[ // 鼓组音色行（固定 8 行）
  {id:'kick',  name:'底鼓',   icon:'◍'},
  {id:'snare', name:'军鼓',   icon:'◈'},
  {id:'clap',  name:'拍手',   icon:'☩'},
  {id:'hhc',   name:'闭镲',   icon:'✦'},
  {id:'hho',   name:'开镲',   icon:'✧'},
  {id:'tom',   name:'通鼓',   icon:'◉'},
  {id:'rim',   name:'边击',   icon:'◇'},
  {id:'crash', name:'吊镲',   icon:'✺'}
];
export const ROLES={
  lead :{name:'主旋律',icon:'🎤',defEngine:'lead', color:'#ff7ac8', shift:12},
  bass :{name:'贝斯',  icon:'🎸',defEngine:'bass', color:'#ffc46b', shift:-12},
  pad  :{name:'和弦垫',icon:'🌫️',defEngine:'pad',  color:'#7c6cff', shift:0},
  chord:{name:'柱式和弦',icon:'🎹',defEngine:'organ',color:'#3aa0ff', shift:-12},
  arp  :{name:'琶音', icon:'🌊',defEngine:'pluck', color:'#22ffd6', shift:12},
  custom:{name:'自定义',icon:'🔧',defEngine:'pluck',color:'#9fe870',shift:0},
  drum :{name:'鼓组', icon:'🥁',color:'#ff6b81', shift:0}
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
