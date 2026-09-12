/* [storage.js] source: Pro.html 4707, 4370-4385（localStorage 原语：工程存档 key / 作品库读写） */

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
