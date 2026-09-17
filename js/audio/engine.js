/* [engine.js] source: Pro.html 1441-1443/1469, 1470-1529, 1531-1533, 1548-1572, 1573-1589, 1604-1620（音序器 + 走带） */
import { proj, actx, A, stepDurNow, SPB, beatSteps, patRows, rowMidi } from '../core/state.js';
import { clamp, UI } from '../core/util.js';
import { KIT, PREC_U_PER_STEP, trackRows, freqOf } from '../core/theory.js';
import { ensureAudio, setGate } from './master.js';
import { synthVoice, reserveVoices } from './synth.js';
import { drumVoice, metronomeClick } from './drum.js';

/* 播放头 UI 晚绑定：ui/seek.js 尚未抽取，暂由 index.html 在 UI 函数下方注入（STEP 6c 迁移） */
export const playheadHooks={};
export function anySolo(){return proj.tracks.some(t=>t.solo)}
/* 重建所有音轨的逐拍事件（用于实时与离线渲染共用）*/
export function rebuildEvents(){
  const S=proj.steps;
  proj._ev=proj.tracks.map(t=>{
    const arr=Array.from({length:S},()=>[]);
    if(t.kind==='drum'){
      for(let s=0;s<S;s++){for(let r=0;r<KIT.length;r++){const v=t.pat[s][r];if(v>0)arr[s].push({kit:r,vel:v})}}
    }else{
      const rows=trackRows(t);
      for(let r=0;r<rows;r++){
        let s=0;
        while(s<S){
          const v=t.pat[s][r];
          if(v>0){
            // 音符最多延续到小节线前：和弦/垫音每小节重新触发，
            // 避免“跨多小节粘连成一根巨音”导致听感糊、导出只剩少数长音符
            let len=1;
            while(s+len<S&&(s+len)%SPB()!==0&&t.pat[s+len][r]>0)len++;
            arr[s].push({row:r,midi:clamp(rowMidi(t,r),12,127),vel:v,len});
            s+=len;
          }else s++;
        }
      }
    }
    return arr;
  });
  if(proj._uiCache)proj._uiCache.evStamps=null;
}
/* 触发一个步进的全部音符（ctx/dest 可为离线）*/
export function fireStep(step,time,ctx,dest,straightTime){
  // straightTime：鼓组按绝对节拍走（无 Swing）；time 为旋律用的 Swing 时间
  const straight=(straightTime==null)?time:straightTime;
  const solo=anySolo();
  const dur=stepDurNow();
  const jit=()=>(Math.random()*2-1)*0.006; // 真人化：±6ms 微提前/滞后
  const jt=b=>Math.max(0,b+jit()); // 时间不允许为负
  const ebOf=t=>(t.env&&t.env.a!=null)?t.env.a:.01;
  const edOf=t=>(t.env&&t.env.d!=null)?t.env.d:.1;
  const esOf=t=>(t.env&&t.env.s!=null)?t.env.s:.7;
  const erOf=t=>(t.env&&t.env.r!=null)?t.env.r:.2;
  // 本步所有旋律轨的并发起音，一次性整组预留声部：
  // 同一时刻的和弦/垫音要么一起出声、要么一起被限流，不会出现“半截和弦”，
  // 也不会出现后一轨的预留把前一轨刚排上的音抢掉。
  let stepNeed=0;
  proj.tracks.forEach((t,ti)=>{
    if(t.mute)return; if(solo&&!t.solo)return; if(t.kind==='drum')return;
    const evs=proj._ev[ti][step];
    if(evs&&evs.length)stepNeed+=evs.length;
    if(t.prec&&t.prec.length){
      const rows=patRows(t);
      for(const p of t.prec)if(p.row!=null&&p.row>=0&&p.row<rows&&Math.floor(p.u/PREC_U_PER_STEP)===step)stepNeed++;
    }
  });
  const stepGrp=(ctx&&ctx._act)?('s'+step+'@'+(Math.round((time||0)*1000))):null;
  if(stepNeed)reserveVoices(ctx,stepNeed,stepGrp);
  proj.tracks.forEach((t,ti)=>{
    if(t.mute)return; if(solo&&!t.solo)return;
    const base={vol:t.vol,pan:t.pan,rev:t.reverb,dly:t.delay,bus:t.id};
    const evs=proj._ev[ti][step];
    if(evs&&evs.length){
      for(const e of evs){
      if(t.kind==='drum'){
        const k=KIT[e.kit];
        const vel=clamp(e.vel*(0.92+Math.random()*.16),.08,1);
        drumVoice(ctx,dest,jt(straight),k.id,vel,base);
      }else{
        const eb=ebOf(t),ed=edOf(t),es=esOf(t),er=erOf(t);
        synthVoice(ctx,dest,jt(time),{
          freq:freqOf(e.midi),vel:clamp(e.vel*(0.95+Math.random()*.1),.08,1),
          durSec:Math.max(.08,e.len*dur),
          engine:t.engine,osc:t.osc,cut:t.cut,res:t.res,
          env:{a:eb*(0.75+Math.random()*.5),d:ed*(0.8+Math.random()*.4),s:es,r:er},
          detune:t.detune,nOsc:t.nOsc,
          grp:stepGrp,
          ...base
        });
      }
    }}
    // 节奏细分（精确时值音符）：在本步对应的时间窗内按 u 精确排时（旋律与鼓都支持）
    if((t.kind==='mel'||t.kind==='drum')&&t.prec&&t.prec.length){
      const eb=ebOf(t),ed=edOf(t),es=esOf(t),er=erOf(t);
      for(const p of t.prec){
        if(p.row==null||p.row<0||p.row>=patRows(t))continue;
        if(Math.floor(p.u/PREC_U_PER_STEP)!==step)continue;
        const when=straight+((p.u-step*PREC_U_PER_STEP)/PREC_U_PER_STEP)*dur;
        if(when<ctx.currentTime-.002)continue;
        const tWhen=jt(Math.max(when,ctx.currentTime));
        if(t.kind==='drum'){
          const k=KIT[p.row];
          drumVoice(ctx,dest,tWhen,k.id,clamp(p.vel*(0.92+Math.random()*.16),.08,1),base);
        }else{
          const m=rowMidi(t,p.row);
          synthVoice(ctx,dest,tWhen,{
            freq:freqOf(m),vel:clamp(p.vel*(0.95+Math.random()*.1),.08,1),
            durSec:Math.max(.08,(p.durU||PREC_U_PER_STEP)*(dur/PREC_U_PER_STEP)), // 精确时值（1/3 拍 = 80u）
            engine:t.engine,osc:t.osc,cut:t.cut,res:t.res,
            env:{a:eb*(0.75+Math.random()*.5),d:ed*(0.8+Math.random()*.4),s:es,r:er},
            detune:t.detune,nOsc:t.nOsc,
            grp:stepGrp,
            ...base
          });
        }
      }
    }
  });
}
/* hasStarted：区分"停止态"与"暂停态"——暂停后按播放要从原位置继续，停止/曲终后按播放要回到 0。
   由 togglePlay / stopPlay / finishSong / seekToStep / startFromStep 共同维护（见各处注释）。 */
export const Play={playing:false,step:0,nom:0,timer:null,q:[],uiStep:-1,started:0,hasStarted:false};
export let metroOn=false;
export function setMetroOn(v){metroOn=v}
export let loopOn=true; // 整曲循环（默认开）；关闭 = 单次播放，播完自动停
export function setLoopOn(v){loopOn=v}
export function tickSched(){
  if(!Play.playing||!actx)return;
  const dur=stepDurNow();
  const ahead=actx.currentTime+0.18;
  while(Play.nom<ahead){
    Play.nom+=dur;
    const sw=proj.swing/100;
    const off=(beatSteps()===4&&Play.step%2===1&&sw>0)?dur*sw*.5:0; // Swing 用于“每拍 4 步”的体系
    const when=Play.nom+off;
    if(when>=actx.currentTime-.01){
      fireStep(Play.step,when,actx,A.master,Play.nom); // 鼓=nom(直拍)，旋律=when(Swing)
      if(metroOn&&Play.step%beatSteps()===0)metronomeClick(when,Play.step%SPB()===0);
      Play.q.push({step:Play.step,time:when});
    }
    Play.step=(Play.step+1);
    if(Play.step>=proj.steps){
      if(!loopOn){ // 单次播放：曲尾柔收——不再硬切，让尾音自然淡出
        Play.step=proj.steps-1;
        finishSong();
        return;
      }
      Play.step=0;
    }
  }
}
/* 曲尾优雅淡出（约 1 秒），保留最后和弦/混响的自然衰减 */
export function finishSong(){
  if(Play.timer){clearInterval(Play.timer);Play.timer=null}
  Play.playing=false;Play.q=[];Play.uiStep=-1;
  Play.hasStarted=false;      // 曲终＝停止态：下次按播放从 0 开始（否则会停在最后一格反复收尾）
  playheadHooks.setPlayUI?.(false);
  if(A&&actx){
    const g=A.gate.gain, now=actx.currentTime;
    try{
      g.cancelScheduledValues(now);
      g.setValueAtTime(Math.max(g.value,0.0001),now);
      g.linearRampToValueAtTime(0.0001,now+1.0);
    }catch(e){}
  }
  playheadHooks.clearStepGlow?.();
  playheadHooks.updatePos?.(proj.steps-1);
  UI.posSub.textContent='🎵 已结束';
}
/** 暂停：保留 Play.step 与 hasStarted —— 下次按播放从原位置继续。
    与 stopPlay()（明确停止 / 回到停止态，下次从头）区分开：
    播放按钮与空格键共用 togglePlay，如果暂停也走 stopPlay，"暂停后继续"就必然归零（Bug 1 的另一半）。 */
export function pausePlay(){
  if(!Play.playing)return false;
  Play.playing=false;Play.q=[];Play.uiStep=-1;
  if(Play.timer){clearInterval(Play.timer);Play.timer=null}
  setGate(false,true);
  playheadHooks.setPlayUI?.(false);
  /* 注意：不调 updatePos(0)（那是 stopPlay 的"回到开头"语义），暂停时位置显示必须停在原处 */
  return true;
}
export function togglePlay(){
  if(Play.playing){pausePlay();return}
  if(!ensureAudio())return;
  setGate(true,true);
  /* 修复 Bug 1：原来这里无条件 Play.step=0，导致"暂停后按播放"从头开始。
     现在只有"没播放过"（初始态 / stopPlay 后 / 曲终后）才归零；暂停态保持 Play.step 继续。
     注意 nom（排期游标）始终重置为当前时间 +0.06，这是"从当前位置接着往前走"所必需的；
     seek 过的位置由 seekToStep 直接写 Play.step，并把 hasStarted 置 true，因此不受本分支影响。 */
  if(!Play.hasStarted){
    Play.step=0;
  }
  Play.hasStarted=true;
  Play.playing=true;Play.uiStep=-1;Play.nom=actx.currentTime+.06;Play.q=[];
  playheadHooks.setPlayUI?.(true);
  tickSched();
  Play.timer=setInterval(tickSched,30);
}
export function stopPlay(){
  Play.playing=false;Play.q=[];Play.uiStep=-1;
  Play.hasStarted=false;      // 停止＝回到停止态：下次按播放从 0 开始（暂停不经过这里，见 togglePlay）
  if(Play.timer){clearInterval(Play.timer);Play.timer=null}
  setGate(false,true); // 快速收声：不再拖长音
  playheadHooks.setPlayUI?.(false);
  playheadHooks.clearStepGlow?.();
  playheadHooks.updatePos?.(0);
}
