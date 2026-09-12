/* [render.js] source: Pro.html 4814-4831, 4837-4879（WAV 编码与离线渲染；重入锁入口在 js/io/wav.js） */
import { proj, stepDurNow, SPB } from '../core/state.js';
import { buildGraph } from './master.js';
import { rebuildEvents, fireStep } from './engine.js';
import { toast, downloadBlob, exportProgressStart, exportProgressSet, exportProgressStop } from '../core/util.js';

/* ---------- WAV 导出 ---------- */
export function encodeWav(buffer){
  const numCh=Math.min(2,buffer.numberOfChannels);
  const sr=buffer.sampleRate,len=buffer.length,block=numCh*2,dataSize=len*block;
  const buf=new ArrayBuffer(44+dataSize),v=new DataView(buf);
  const ws=(o,s)=>{for(let i=0;i<s.length;i++)v.setUint8(o+i,s.charCodeAt(i))};
  ws(0,'RIFF');v.setUint32(4,36+dataSize,true);ws(8,'WAVE');ws(12,'fmt ');
  v.setUint32(16,16,true);v.setUint16(20,1,true);v.setUint16(22,numCh,true);
  v.setUint32(24,sr,true);v.setUint32(28,sr*block,true);v.setUint16(32,block,true);v.setUint16(34,16,true);
  ws(36,'data');v.setUint32(40,dataSize,true);
  const chs=[];for(let c=0;c<numCh;c++)chs.push(buffer.getChannelData(c));
  let off=44;
  for(let i=0;i<len;i++)for(let c=0;c<numCh;c++){
    let s=chs[c][i];s=Math.max(-1,Math.min(1,s));
    v.setInt16(off,s<0?s*0x8000:s*0x7fff,true);off+=2;
  }
  return new Blob([buf],{type:'audio/wav'});
}
export async function exportWavRender(){ // 原 exportWavUI 函数体（仅新增 bpm0 快照）
  const bpm0=proj.bpm; // 文件名用快照：导出期间改 BPM 不会与已渲染音频不一致
  if(!proj.tracks.length)return toast('没有可导出的音符','err');
  rebuildEvents();
  const S=proj.steps,dur=stepDurNow();
  // 时长按需：1 遍完整播放 + 依据“最长音符实际时值”动态计算的尾音缓冲，
  // 不再为了保尾音固定重复多遍（避免文件无谓过长）
  let maxLenStep=1;
  proj._ev.forEach(tk=>tk.forEach(es=>es.forEach(e=>{if(e.len)maxLenStep=Math.max(maxLenStep,e.len)})));
  const loops=1;
  const tailNeed=Math.min(8,Math.max(2.6,maxLenStep*dur+0.9)); // 释音+混响余韵
  const total=S*dur+tailNeed;
  const sr=44100;
  const oc=new (window.OfflineAudioContext||window.webkitOfflineAudioContext)(2,Math.ceil(total*sr),sr);
  const G=buildGraph(oc);
  const sw=proj.swing/100;
  exportProgressStart('🎧 调度音符中…');
  const tick=()=>new Promise(r=>setTimeout(r,0));
  let doneSteps=0;
  const totalSteps=loops*S;
  for(let l=0;l<loops;l++){
    for(let s=0;s<S;s++){
      const nom=l*S*dur+s*dur;
      const t=nom+((s%2===1&&sw>0)?dur*sw*.5:0);
      fireStep(s,t,oc,G.master,nom);
      doneSteps++;
      if(doneSteps%48===0){ // 分块让出主线程并更新“已调度步数”进度
        exportProgressSet(doneSteps/totalSteps*84);
        await tick();
      }
    }
  }
  exportProgressSet(84);
  exportProgressStart('🎧 正在离线渲染（渲染完成后自动收尾）…');
  try{
    const buf=await oc.startRendering();
    // 离线上下文用完即释放：close() 停止并回收 OfflineAudioContext 及其内部缓冲（AudioBuffer 结果仍然可用）
    const cl=oc.close; try{ if(typeof cl==='function') await cl.call(oc); }catch(e){}
    const blob=encodeWav(buf);
    const secs=(buf.length/sr).toFixed(1);
    downloadBlob(blob,(proj.name||'song').replace(/[\\/:*?"<>|]/g,'_')+'_'+bpm0+'bpm.wav');
    exportProgressStop(true);
    toast('已导出 WAV · '+secs+' 秒 · '+proj.steps/SPB()*loops+' 小节','ok');
  }catch(e){exportProgressStop(false);toast('渲染失败：'+e.message,'err')}
}
