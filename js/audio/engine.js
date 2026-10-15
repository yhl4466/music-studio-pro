/* [engine.js] source: Pro.html 1441-1443/1469, 1470-1529, 1531-1533, 1548-1572, 1573-1589, 1604-1620（音序器 + 走带） */
import { proj, actx, A, stepDurNow, SPB, beatSteps, patRows, rowMidiAt } from '../core/state.js';
import { clamp, icon, UI, toast } from '../core/util.js';
import { KIT, PREC_U_PER_STEP, trackRows, freqOf, pruneAcc } from '../core/theory.js';
import { ensureAudio, setGate, setAudioBusy, scheduleAudioSleep } from './master.js';
import { synthVoice, reserveVoices } from './synth.js';
import { drumVoice, metronomeClick } from './drum.js';

/* 播放头 UI 晚绑定：ui/seek.js 尚未抽取，暂由 index.html 在 UI 函数下方注入（STEP 6c 迁移） */
export const playheadHooks={};
export function anySolo(){return proj.tracks.some(t=>t.solo)}
/* 重建所有音轨的逐拍事件（用于实时与离线渲染共用）*/
export function rebuildEvents(){
  const S=proj.steps;
  proj._ev=proj.tracks.map(t=>{
    pruneAcc(t,S); // 兜底收口：清掉没有音的升降号键（所有改 pat 的路径最后都会走到这里）
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
            // midi 按“该步 + 该行”现算：升降号（t.acc）在这一处生效，缓存进 proj._ev
            arr[s].push({row:r,midi:clamp(rowMidiAt(t,r,s),12,127),vel:v,len});
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
  /* proj._ev 与 proj.tracks 必须等长，但**不能假设它一定等长**：
     只要有一条载入/导入路径漏调 rebuildEvents（或 tracks 在 _ev 之后被加长），
     proj._ev[ti] 就是 undefined，而下面还要取 [step] —— 直接抛
     "Cannot read properties of undefined (reading '1')" 让整个播放挂掉（实测复现过）。
     这里用 ?? 兜底：一步取不到事件就当这一步没有事件，最多这一拍不发声，绝不整机崩。 */
  const evRow=(ti)=>{ const r=(proj._ev&&proj._ev[ti])||null; return r?r[step]:null };
  let stepNeed=0;
  proj.tracks.forEach((t,ti)=>{
    if(t.mute)return; if(solo&&!t.solo)return; if(t.kind==='drum')return;
    const evs=evRow(ti);
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
    const evs=evRow(ti);
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
          const m=rowMidiAt(t,p.row,step); // 精确时值音符：音高同样计入该步的升降号
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

/* =========================================================================
   调度前瞻（LOOKAHEAD_S）—— 修"声音断续/爆音"的关键参数
   -------------------------------------------------------------------------
   原值 0.18 秒。音频调度是"主线程提前把音符排进 Web Audio 时间轴"，因此
   **只要主线程被阻塞超过前瞻窗口，音频就饿死 → 断续/爆音**。
   实测（headless，播放 10 秒）主线程长任务最大 154ms；用户机器在有 GC、
   布局重算、合成压力时更长，0.18s 直接被吃穿。
   这也解释了"一直都有、只是现在更明显"：它不是某次提交引入的 bug，
   而是这个窗口一直太窄。我上一轮把 UI 侧热点（getComputedStyle 680ms/8s）
   清掉后，剩下真正影响听感的就是这一项。

   取值权衡：
     · 太小 → 主线程一卡就掉音（原状况）
     · 太大 → 排队音符变多、内存与"改参数立刻生效"的手感变差
   0.7 秒能吸收 700ms 的主线程停顿，而排程提前量用户听不出来
   （首音仍按 Play.nom 精确排程，这不等于"起播延迟"）。
   ========================================================================= */
export const LOOKAHEAD_S=0.7;
/* 首个音符相对"上下文开始跑"的提前量：音频线程要先跑热图（卷积混响尤其贵），
   留一点余量比让第一声爆掉更好。 */
export const START_LEAD=0.1;

/* =========================================================================
   统一排程入口 beginScheduling() —— 修"按播放要等一会儿才有声音"
   -------------------------------------------------------------------------
   症状：按播放后画面先动了，声音过一会儿才出来（用户实测反馈）。
   根因：ensureAudio() 里 `if(actx.state==='suspended')actx.resume()` 是**即发即忘**。
   resume() 返回 Promise，而上下文真正转到 running 需要时间（机器繁忙、或刚被
   scheduleAudioSleep 挂起过时更久）。原实现不等它，紧接着就 tickSched() 排音符，
   这些音符落在"仍挂起"的窗口里会被浏览器丢弃 —— 听感就是起播延迟。
   修法：await resume（带超时兜底，因为个别环境该 Promise 不 resolve），
   确认 running 后才设 nom 并排第一批音符；tickSched 内部也有 running 守卫。
   令牌 _schedToken 保证 await 期间用户再按停止/播放时，这次排程作废。
   ========================================================================= */
let _schedToken=0;
export function beginScheduling(){
  const token=++_schedToken;
  if(!actx){setAudioBusy(false);return}
  const begin=()=>{
    if(token!==_schedToken||!Play.playing)return;      // 期间被停止/重开 → 放弃
    if(!actx||actx.state!=='running'){
      setAudioBusy(false);                              // 不静默：否则表现为"播放头在动但没声音"
      try{ toast('音频没能启动，请再点一次播放','err') }catch(e){}
      return;
    }
    Play.nom=actx.currentTime+START_LEAD;Play.q=[];Play.uiStep=-1;
    tickSched();
    Play.timer=setInterval(tickSched,30);
  };
  if(actx.state==='running'){ begin(); return }
  const p=(()=>{ try{ return actx.resume() }catch(e){ return null } })();
  let done=false;
  const fin=()=>{ if(done)return; done=true; begin() };
  if(p&&typeof p.then==='function'){
    p.then(fin,()=>fin());
    setTimeout(fin,600);        // 兜底：resume 的 Promise 在某些环境不 resolve
  }else{
    setTimeout(fin,120);        // 老浏览器 resume() 返回 undefined：给点时间再查状态
  }
}
/* 供 stopPlay/pausePlay 作废尚未落地的 async 起播 */
export function cancelScheduling(){ _schedToken++ }

export function tickSched(){
  if(!Play.playing||!actx)return;
  /* 上下文还没真正 running：此刻排的音会被浏览器当作"挂起期间"处理掉，
     听感就是"按了播放没声音，过一会儿才响"。直接返回，等它 running 再排
     （startFromStep 会 await resume 并主动再调一次 tickSched）。 */
  if(actx.state!=='running')return;
  const dur=stepDurNow();
  const ahead=actx.currentTime+LOOKAHEAD_S;
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
  setAudioBusy(false);
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
  UI.posSub.innerHTML=icon('music')+'已结束';
  scheduleAudioSleep(3500);   // 等收尾淡出+混响尾巴走完，再把音频线程挂起（见 master.js 注释）
}
/** 暂停：保留 Play.step 与 hasStarted —— 下次按播放从原位置继续。
    与 stopPlay()（明确停止 / 回到停止态，下次从头）区分开：
    播放按钮与空格键共用 togglePlay，如果暂停也走 stopPlay，"暂停后继续"就必然归零（Bug 1 的另一半）。 */
export function pausePlay(){
  if(!Play.playing)return false;
  cancelScheduling();                 // 作废可能还在 await resume 的起播
  Play.playing=false;Play.q=[];Play.uiStep=-1;
  if(Play.timer){clearInterval(Play.timer);Play.timer=null}
  setGate(false,true);
  setAudioBusy(false);
  playheadHooks.setPlayUI?.(false);
  /* 注意：不调 updatePos(0)（那是 stopPlay 的"回到开头"语义），暂停时位置显示必须停在原处 */
  scheduleAudioSleep(3500);   // 暂停后音频线程也该睡（尾巴衰减完再挂起）
  return true;
}
export function togglePlay(){
  if(Play.playing){pausePlay();return}
  /* 顺序要紧：先把"正在播"的标记立起来，再 ensureAudio（它会 resume + 取消待执行的挂起）。
     反过来写会有一个真实的竞态：一个已经排队等着的挂起回调可能刚好在 resume 之后执行，
     把正在播放的上下文又挂起 —— 表现就是"按了播放、播放头在动但没有声音"。 */
  setAudioBusy(true);
  if(!ensureAudio()){setAudioBusy(false);return}
  /* 修复 Bug 1：原来这里无条件 Play.step=0，导致"暂停后按播放"从头开始。
     现在只有"没播放过"（初始态 / stopPlay 后 / 曲终后）才归零；暂停态保持 Play.step 继续。
     seek 过的位置由 seekToStep 直接写 Play.step 并把 hasStarted 置 true，因此不受本分支影响。 */
  if(!Play.hasStarted){
    Play.step=0;
  }
  Play.hasStarted=true;
  Play.playing=true;
  playheadHooks.setPlayUI?.(true);
  /* 起播统一走 beginScheduling：它 await resume 确认 running 后才 setGate + 设 nom + 排音符。
     原实现在这里同步 setGate(true) 并立刻按 actx.currentTime+.06 排程 —— 若上下文还在
     resume 途中，这些音符会被丢弃，听感就是"按了播放要等一会儿才有声音"。 */
  beginScheduling();
}
export function stopPlay(){
  cancelScheduling();                 // 作废可能还在 await resume 的起播
  Play.playing=false;Play.q=[];Play.uiStep=-1;
  Play.hasStarted=false;      // 停止＝回到停止态：下次按播放从 0 开始（暂停不经过这里，见 togglePlay）
  if(Play.timer){clearInterval(Play.timer);Play.timer=null}
  setGate(false,true); // 快速收声：不再拖长音
  setAudioBusy(false);
  playheadHooks.setPlayUI?.(false);
  playheadHooks.clearStepGlow?.();
  playheadHooks.updatePos?.(0);
  scheduleAudioSleep(3500);   // 停止后音频线程挂起（尾巴衰减完再关，避免把混响尾巴切掉）
}
