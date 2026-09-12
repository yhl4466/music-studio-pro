/* [master.js] source: Pro.html 1094-1195, 1595-1603（母带链 / 信号图 / 音频上下文 / 门限） */
import { proj, actx, A, setActx, setA, barSeconds } from '../core/state.js';
import { clamp, toast } from '../core/util.js';

export const eqState={l:0,m:0,h:0,lim:1}; // 主输出 EQ / 限制器状态（dB / 开关）
export function applyEqUI(){
  if(!A||!actx)return;
  const now=actx.currentTime;
  const db2lin=db=>Math.pow(10,db/20);
  try{
    A.eq[0].gain.setTargetAtTime(db2lin(eqState.l),now,.02);
    A.eq[1].gain.setTargetAtTime(db2lin(eqState.m),now,.02);
    A.eq[2].gain.setTargetAtTime(db2lin(eqState.h),now,.02);
    A.lim.limDry.gain.setTargetAtTime(eqState.lim?0:1,now,.02);
    A.lim.limWet.gain.setTargetAtTime(eqState.lim?1:0,now,.02);
  }catch(e){}
}
const ctxNoise=new WeakMap(); // 每个 context 的白噪声缓冲（WeakMap：离线导出用的 OfflineAudioContext 被回收时自动释放，避免每次导出都残留一份缓冲+上下文）
export function noiseBuf(ctx){
  if(ctxNoise.has(ctx))return ctxNoise.get(ctx);
  const n=ctx.sampleRate; const b=ctx.createBuffer(1,n,ctx.sampleRate); const d=b.getChannelData(0);
  for(let i=0;i<n;i++)d[i]=Math.random()*2-1;
  ctxNoise.set(ctx,b); return b;
}
export function makeIR(ctx,sec,decay){
  const rate=ctx.sampleRate,len=Math.floor(rate*sec);const b=ctx.createBuffer(2,len,rate);
  for(let c=0;c<2;c++){const d=b.getChannelData(c);for(let i=0;i<len;i++){d[i]=(Math.random()*2-1)*Math.pow(1-i/len,decay)}}
  return b;
}
/* 创建某 context 的完整信号图，返回控制句柄 */
export function buildGraph(ctx){
  const db2lin=db=>Math.pow(10,db/20);
  const out=ctx.createGain(); out.gain.value=proj.masterVol;
  // 3 段均衡（Low/Mid/High，±12dB）
  const eqL=ctx.createBiquadFilter();eqL.type='lowshelf';eqL.frequency.value=160;eqL.Q.value=.7;
  eqL.gain.value=db2lin(eqState.l);
  const eqM=ctx.createBiquadFilter();eqM.type='peaking';eqM.frequency.value=850;eqM.Q.value=.9;
  eqM.gain.value=db2lin(eqState.m);
  const eqH=ctx.createBiquadFilter();eqH.type='highshelf';eqH.frequency.value=3400;eqH.Q.value=.7;
  eqH.gain.value=db2lin(eqState.h);
  const comp=ctx.createDynamicsCompressor();
  comp.threshold.value=-14; comp.knee.value=22; comp.ratio.value=4; comp.attack.value=.004; comp.release.value=.22;
  const post=ctx.createGain(); post.gain.value=1.25;
  // 停止/急停门限：主音量与所有混响/延迟都经过它，暂停时能立刻收声不拖长音
  const gate=ctx.createGain(); gate.gain.value=1;
  post.connect(gate); gate.connect(comp);
  out.connect(eqL); eqL.connect(eqM); eqM.connect(eqH); eqH.connect(post);
  // 砖墙限制器（可旁通）
  const lim=ctx.createDynamicsCompressor();
  lim.threshold.value=-1.5; lim.knee.value=0; lim.ratio.value=20; lim.attack.value=.0015; lim.release.value=.06;
  const limDry=ctx.createGain(); limDry.gain.value=eqState.lim?0:1;
  const limWet=ctx.createGain(); limWet.gain.value=eqState.lim?1:0;
  comp.connect(limDry); limDry.connect(ctx.destination);
  comp.connect(lim); lim.connect(limWet); limWet.connect(ctx.destination);
  let an=null;
  if(ctx===actx){an=ctx.createAnalyser();an.fftSize=256;an.smoothingTimeConstant=.82;post.connect(an)}
  // 混响（湿声并入 out，使主音量可控制混响尾巴）
  const revBus=ctx.createGain(), conv=ctx.createConvolver(); conv.buffer=makeIR(ctx,2.4,2.8);
  const revWet=ctx.createGain(); revWet.gain.value=.55;
  revBus.connect(conv); conv.connect(revWet); revWet.connect(out);
  // 延迟
  const dl=ctx.createDelay(2); dl.delayTime.value=Math.min(1.5,barSeconds()/2); // 延迟时间跟随节拍（半小节），1.5s 上限 < createDelay(2)
  const dfb=ctx.createGain(); dfb.gain.value=.34;
  const dflt=ctx.createBiquadFilter(); dflt.type='lowpass'; dflt.frequency.value=3400;
  const dwet=ctx.createGain(); dwet.gain.value=.4;
  dl.connect(dflt); dflt.connect(dfb); dfb.connect(dl);
  dflt.connect(dwet); dwet.connect(out);
  // 每轨共享音量总线（实时推子可作用于正在发声的音符）
  ctx._tb={};
  ctx._act=[]; // 活跃音源（复音限制用）
  const h={master:out,revBus,dl,post,comp,an,gate,eq:[eqL,eqM,eqH],lim:{lim,limDry,limWet}};
  ctx._g=h; return h;
}
export function getTrackBus(ctx,busId,vol){
  if(busId==null)return null;
  if(!ctx._tb)ctx._tb={};
  let b=ctx._tb[busId];
  if(!b){
    b=ctx.createGain(); b.gain.value=clamp(numSafe(vol,.85),0,1.4);
    const G=ctx._g; if(G&&G.master)b.connect(G.master);
    ctx._tb[busId]=b;
  }
  return b;
}
export function numSafe(x,f){const n=Number(x);return isFinite(n)?n:f}
export function applyTrackVolBus(t){
  if(!actx||!actx._tb||!actx._tb[t.id])return;
  actx._tb[t.id].gain.setTargetAtTime(clamp(numSafe(t.vol,.85),0,1.4),actx.currentTime,.02);
}
export function ensureAudio(){
  if(!actx){
    const AC=window.AudioContext||window.webkitAudioContext;
    if(!AC){toast('当前浏览器不支持 Web Audio','err');return false}
    setActx(new AC());
  }
  if(actx.state==='suspended')actx.resume();
  if(!A)setA(buildGraph(actx));
  return true;
}
export function setMasterVol(v){
  v=clamp(numSafe(v,1),0,1.4);
  if(A&&actx){
    A.master.gain.cancelScheduledValues(actx.currentTime);
    A.master.gain.setTargetAtTime(v,actx.currentTime,.02);
  }
}
export function setGate(open,fast){
  if(!A||!actx)return;
  const g=A.gate.gain, now=actx.currentTime;
  try{
    g.cancelScheduledValues(now);
    g.setValueAtTime(Math.max(g.value,0.0001),now);
    g.linearRampToValueAtTime(open?1:0.0001,now+(fast?.04:.12));
  }catch(e){}
}
