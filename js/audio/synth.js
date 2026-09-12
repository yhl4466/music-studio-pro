/* [synth.js] source: Pro.html 1197-1323, 1424-1437（合成器音色 / 敲击类 / 试听） */
import { clamp } from '../core/util.js';
import { ENGINE_DEF, freqOf } from '../core/theory.js';
import { actx, A } from '../core/state.js';
import { getTrackBus, noiseBuf, ensureAudio, setGate } from './master.js';

/* ---------- 合成器音色 ---------- */
export const VOICE_LIMIT=32; // 最大复音数（超出时抢占最弱/最老音源）
export const PARTIALS={default:[1],bell:[1,2.01,2.99,4.03,5.51],organ:[1,2,4.01]};
export const ORG_GAIN=[.8,.42,.16];
export function synthVoice(ctx,dest,time,o){
  // o:{freq,vel,durSec,engine,osc,cut,res,env:{a,d,s,r},detune,nOsc,pan,rev,dly,vol}
  const num=(x,f)=>{const n=Number(x);return isFinite(n)?n:f};
  const V=clamp(num(o.vel,.8),.04,1);
  const g=ctx.createGain(); g.gain.value=1;
  const filt=ctx.createBiquadFilter(); filt.type='lowpass';
  const cut=clamp(num(o.cut,1200),60,14000);
  const tNow=num(time,0);
  const ta=num(o.env&&o.env.a,.01), td=num(o.env&&o.env.d,.1), ts=num(o.env&&o.env.s,.7), tr=num(o.env&&o.env.r,.2);
  const tEnd=Math.max(ta+.04,.1);
  const f1=Math.min(18000,cut*(1+1.2*V));
  const f2=Math.max(55,cut*(.35+.65*V));
  if(!isFinite(f1)||!isFinite(f2)){console.error('AUTOTEST-NANFILT '+JSON.stringify({vel:o.vel,cut:o.cut,env:o.env,freq:o.freq,time}));}
  filt.frequency.setValueAtTime(isFinite(f1)?f1:400,tNow);
  filt.frequency.exponentialRampToValueAtTime(isFinite(f2)?f2:300,tNow+tEnd);
  filt.Q.value=clamp(num(o.res,2),0,20);
  const panN=(typeof ctx.createStereoPanner==='function')?ctx.createStereoPanner():null;
  if(panN){panN.pan.value=clamp(num(o.pan,0),-1,1)}
  const dry=ctx.createGain();
  const bus=getTrackBus(ctx,o.bus,o.vol);
  dry.gain.value=bus?1:num(o.vol,1);
  g.connect(filt);filt.connect(dry);
  // 每轨共享总线：音量推子可实时作用于正在发声的音符
  if(panN){dry.connect(panN); if(bus){panN.connect(bus)}else{panN.connect(dest)} }
  else if(bus){dry.connect(bus)}
  else {dry.connect(dest)}
  const G=ctx._g;
  if(G&&dest===G.master){
    if(o.rev>0.003){const sg=ctx.createGain();sg.gain.value=o.rev*.9;dry.connect(sg);sg.connect(G.revBus)}
    if(o.dly>0.003){const sg=ctx.createGain();sg.gain.value=o.dly*.9;dry.connect(sg);sg.connect(G.dl)}
  }
  const Aenv=ta,Denv=td,Senv=clamp(ts,0,1),Renv=tr;
  const manual=(o.releaseOn==='manual');
  const durSec=manual?20:Math.max(.06,num(o.durSec,.12));
  const end=tNow+durSec;
  const relStart=end, relEnd=relStart+Renv+.06;
  const peak=V*num(o.power,1);
  const holdVal=peak*Senv;
  const gp=g.gain;
  gp.setValueAtTime(0,tNow);
  gp.linearRampToValueAtTime(peak,tNow+Aenv);
  gp.setTargetAtTime(holdVal,tNow+Aenv,Math.max(.008,Denv*.35));
  // 释放阶段：从 0 起步不能用 exponentialRamp（WebAudio 会抛 RangeError），需走线性
  gp.setValueAtTime(holdVal,relStart);
  if(holdVal>0.0006)gp.exponentialRampToValueAtTime(.0004,relEnd);
  else gp.linearRampToValueAtTime(0.0001,relEnd);

  const f0=num(o.freq,440);
  const srcs=[];
  const freqs=[f0];
  const nd=clamp(num(o.detune,0),0,60);
  if(nd>0&&(num(o.nOsc,1)>1)){
    const r=Math.pow(2,nd/1200);
    if(num(o.nOsc,2)>=3){freqs.push(f0*r,f0/r)}
    else freqs.push(f0*(1+r)/2*(1+0.0009), f0*(1+r)/2*(1-0.0009));
  }
  const parts=PARTIALS[o.engine]||PARTIALS.default;
  const hasSub=(o.engine==='bass'||o.engine==='organ');
  freqs.forEach(f=>{
    parts.forEach((m,pi)=>{
      const osc=ctx.createOscillator();
      osc.type=o.osc||'sawtooth';
      const maxF=(ctx.sampleRate||44100)/2*.9;
      const fm=f*m;
      if(!isFinite(fm)){console.error('AUTOTEST-NANFREQ '+JSON.stringify({freq:o.freq,engine:o.engine}))}
      osc.frequency.value=isFinite(fm)?Math.min(fm,maxF):440;
      const og=ctx.createGain();
      if(o.engine==='organ'){og.gain.value=ORG_GAIN[pi]||.1}
      else og.gain.value=o.engine==='bell'?Math.pow(.7,pi):(pi===0?1:.5);
      // bell 音色用正弦叠加非谐波泛音
      osc.type=(o.engine==='bell'||o.engine==='organ')?'sine':(o.osc||'sawtooth');
      osc.connect(og);og.connect(g);
      srcs.push(osc);
      osc.start(tNow);
      osc.stop(manual?tNow+22:relEnd+.1);
    });
  });
  if(hasSub&&o.engine!=='organ'){
    const so=ctx.createOscillator();so.type='sine';so.frequency.value=isFinite(f0/2)?f0/2:220;
    const sg2=ctx.createGain();sg2.gain.value=(o.engine==='bass'?.55:.2);
    so.connect(sg2);sg2.connect(g);
    srcs.push(so);
    so.start(tNow);so.stop(manual?tNow+22:relEnd+.1);
  }
  const kill=()=>{
    try{
      const now=ctx.currentTime||0;
      gp.cancelScheduledValues(now);
      gp.setValueAtTime(Math.max(gp.value,0.0001),now);
      gp.linearRampToValueAtTime(0.0001,now+.08);
    }catch(e){}
    srcs.forEach(osc=>{try{osc.stop((ctx.currentTime||0)+.09)}catch(e){}});
  };
  if(!manual&&ctx._act&&typeof ctx.startRendering!=='function'){
    // 复音限制（仅实时播放）：超过上限时抢掉“最弱/最老”的音源。
    // 离线(OfflineAudioContext)调度阶段 currentTime 固定为 0，
    // 若同样限流会把后续旋律全抢光——导出时禁用。
    ctx._act=ctx._act.filter(v=>v.until>((ctx.currentTime||0)+.02));
    if(ctx._act.length>=VOICE_LIMIT){
      let idx=0;
      for(let i=1;i<ctx._act.length;i++){
        const a=ctx._act[i],b=ctx._act[idx];
        if(a.vel<b.vel-1e-6||(Math.abs(a.vel-b.vel)<1e-6&&a.until<b.until))idx=i;
      }
      try{ctx._act[idx].kill()}catch(e){}
      ctx._act.splice(idx,1);
    }
    ctx._act.push({vel:V,until:relEnd+.1,kill});
  }
  return manual?{kill}:null;
}
/* 敲击类：无固定音高时用 click */
export function clickVoice(ctx,dest,time,o){
  // 简易打击辅助（rim）
  const dur=o.durSec||.05;
  const src=ctx.createBufferSource();src.buffer=noiseBuf(ctx);
  const hp=ctx.createBiquadFilter();hp.type='bandpass';hp.frequency.value=o.freq||1800;hp.Q.value=1.4;
  const g=ctx.createGain();
  g.gain.setValueAtTime(clamp(o.vel,.04,1)*(o.vol||1),time);
  g.gain.exponentialRampToValueAtTime(.0001,time+dur);
  src.connect(hp);hp.connect(g);g.connect(dest);
  src.start(time);src.stop(time+dur+.05);
}
/* 实时播放单音试听 */
export function auditionTrack(track,midi,vel){
  if(!ensureAudio())return;
  setGate(true,true);
  midi=clamp(midi,12,127);
  const eng=track&&track.kind==='mel'&&track.engine?track.engine:'pluck';
  const def=ENGINE_DEF[eng];
  synthVoice(actx,A.master,actx.currentTime+0.02,{
    freq:freqOf(midi),vel:vel||.9,durSec:.32,
    engine:eng,osc:(track&&track.osc)||def.osc,cut:(track&&track.cut)||def.cut,res:(track&&track.res)||def.res,
    env:(track&&track.env)||def.env,detune:(track&&track.detune)||def.detune,nOsc:(track&&track.nOsc)||def.nOsc,
    pan:track?track.pan:0,rev:track?(track.reverb||0):.12,dly:track?(track.delay||0):0,vol:1
  });
}
