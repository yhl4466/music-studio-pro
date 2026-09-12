/* [drum.js] source: Pro.html 1324-1423, 1660（鼓组合成 / 节拍器 / 鼓件配色） */
import { clamp } from '../core/util.js';
import { actx, proj } from '../core/state.js';
import { getTrackBus, noiseBuf } from './master.js';

/* ---------- 鼓组合成 ---------- */
export function drumVoice(ctx,dest,time,id,vel,o){
  o=o||{}; const V=clamp(vel,.04,1); const vol=o.vol!=null?o.vol:1; const P=V*vol;
  const route=(n)=>{ // 挂载混响/延迟发送
    const G=ctx._g;
    if(G&&dest===G.master){if(o.rev>0.002){const sg=ctx.createGain();sg.gain.value=o.rev;n.connect(sg);sg.connect(G.revBus)}
    if(o.dly>0.002){const sg=ctx.createGain();sg.gain.value=o.dly;n.connect(sg);sg.connect(G.dl)}}
    return n;
  };
  const panN=(typeof ctx.createStereoPanner==='function')?ctx.createStereoPanner():null;
  if(panN){panN.pan.value=clamp(o.pan||0,-1,1)}
  const bus=getTrackBus(ctx,o.bus,o.vol);
  const toOut=(n)=>{route(n);if(panN){n.connect(panN);(panN).connect(bus||dest)}else{(n).connect(bus||dest)} };
  const g=ctx.createGain();
  const tail=id==='crash'||id==='hho'?1.1:.35;
  switch(id){
    case 'kick':{
      const osc=ctx.createOscillator();osc.type='sine';
      osc.frequency.setValueAtTime(165,time);
      osc.frequency.exponentialRampToValueAtTime(44,time+.11);
      g.gain.setValueAtTime(P,time);
      g.gain.exponentialRampToValueAtTime(.0004,time+.30);
      osc.connect(g);toOut(g);osc.start(time);osc.stop(time+.4);
      break}
    case 'snare':{
      const osc=ctx.createOscillator();osc.type='triangle';
      osc.frequency.setValueAtTime(210,time);osc.frequency.exponentialRampToValueAtTime(140,time+.08);
      const og=ctx.createGain();og.gain.value=P*.7;
      og.gain.setValueAtTime(P*.7,time);og.gain.exponentialRampToValueAtTime(.001,time+.18);
      osc.connect(og);og.connect(g);
      const src=ctx.createBufferSource();src.buffer=noiseBuf(ctx);src.playbackRate.value=.8;
      const hp=ctx.createBiquadFilter();hp.type='highpass';hp.frequency.value=1200;
      const ng=ctx.createGain();ng.gain.value=P*1.05;
      ng.gain.setValueAtTime(P*1.05,time);ng.gain.exponentialRampToValueAtTime(.0004,time+.19);
      src.connect(hp);hp.connect(ng);ng.connect(g);
      g.gain.setValueAtTime(1,time);
      toOut(g);
      osc.start(time);osc.stop(time+.25);src.start(time);src.stop(time+.25);
      break}
    case 'clap':{
      const src=ctx.createBufferSource();src.buffer=noiseBuf(ctx);
      const bp=ctx.createBiquadFilter();bp.type='bandpass';bp.frequency.value=1500;bp.Q.value=1.1;
      const ng=ctx.createGain();ng.gain.value=0;
      const t=[0,.012,.03,.11]; const vs=[0,P,P*.4,0]; const ts=[.002,.003,.002,.06];
      for(let i=0;i<t.length;i++){ng.gain.setValueAtTime(vs[i],time+t[i]);if(i<t.length-1)ng.gain.linearRampToValueAtTime(vs[i+1],time+t[i]+ts[i])}
      src.connect(bp);bp.connect(ng);ng.connect(g);toOut(g);
      src.start(time);src.stop(time+.3);
      break}
    case 'hhc':{
      const src=ctx.createBufferSource();src.buffer=noiseBuf(ctx);
      const hp=ctx.createBiquadFilter();hp.type='highpass';hp.frequency.value=7600;
      const ng=ctx.createGain();
      ng.gain.setValueAtTime(P*.55,time);ng.gain.exponentialRampToValueAtTime(.0004,time+.04);
      src.connect(hp);hp.connect(ng);ng.connect(g);toOut(g);
      src.start(time);src.stop(time+.08);
      break}
    case 'hho':{
      const src=ctx.createBufferSource();src.buffer=noiseBuf(ctx);
      const hp=ctx.createBiquadFilter();hp.type='highpass';hp.frequency.value=7400;
      const ng=ctx.createGain();
      ng.gain.setValueAtTime(P*.6,time);ng.gain.exponentialRampToValueAtTime(.0004,time+.42);
      src.connect(hp);hp.connect(ng);ng.connect(g);toOut(g);
      src.start(time);src.stop(time+.5);
      break}
    case 'tom':{
      const osc=ctx.createOscillator();osc.type='sine';
      osc.frequency.setValueAtTime(240,time);osc.frequency.exponentialRampToValueAtTime(95,time+.2);
      g.gain.setValueAtTime(P,time);g.gain.exponentialRampToValueAtTime(.0004,time+.4);
      osc.connect(g);toOut(g);osc.start(time);osc.stop(time+.5);
      break}
    case 'rim':{
      const osc=ctx.createOscillator();osc.type='square';
      osc.frequency.setValueAtTime(1750,time);
      const og=ctx.createGain();og.gain.value=P*.5;
      og.gain.setValueAtTime(P*.5,time);og.gain.exponentialRampToValueAtTime(.0004,time+.05);
      osc.connect(og);og.connect(g);
      g.gain.setValueAtTime(1,time);
      toOut(g);osc.start(time);osc.stop(time+.1);
      break}
    case 'crash':{
      const src=ctx.createBufferSource();src.buffer=noiseBuf(ctx);
      const hp=ctx.createBiquadFilter();hp.type='highpass';hp.frequency.value=5200;
      const ng=ctx.createGain();
      ng.gain.setValueAtTime(P*.5,time);ng.gain.exponentialRampToValueAtTime(.0002,time+1.05);
      src.connect(hp);hp.connect(ng);ng.connect(g);toOut(g);
      src.start(time);src.stop(time+1.2);
      break}
  }
}
/* 节拍器 */
export function metronomeClick(time,bar){
  if(!actx)return;
  const osc=actx.createOscillator();
  osc.type='square';
  osc.frequency.value=bar?1650:1100;
  const g=actx.createGain();
  g.gain.setValueAtTime(Math.min(.3,.16*(proj.masterVol!=null?proj.masterVol:1)),time);g.gain.exponentialRampToValueAtTime(.0002,time+.03);
  osc.connect(g);g.connect(actx.destination);
  osc.start(time);osc.stop(time+.05);
}
/* 鼓件行配色（KIT 8 行） */
export const KIT_COLORS=['#ffb36b','#ffd166','#f6f1d5','#7fe3ff','#4ec8ff','#c9a1ff','#ff9fb2','#ff8ad8'];
