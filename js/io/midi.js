/* [midi.js] source: Pro.html 2496-2787（SMF 格式 1 导出 / 导入） */
import { proj, newTrack, allocPat, meterN, meterD, SPB, rowMidi, rowMidiAt, MAX_BARS } from '../core/state.js';
import { KIT, MEL_ROWS, SCALES, ROLES, PREC_U_PER_STEP, trackRows } from '../core/theory.js';
import { toast, downloadBlob, UI, hooks } from '../core/util.js';
import { beginEdit, commitEdit, markDirtyUI, setPendingPre } from './project.js';
import { rebuildEvents } from '../audio/engine.js';

/* 最近一次导出的 MIDI 字节（原 window.__lastMidi → 模块内私有） */
let lastMidiBlob=null;
/* =========================================================================
   6d. MIDI 导出 / 导入（标准 SMF 格式 1）
   ========================================================================= */
export const GM_DRUMS={36:0,35:0,38:1,40:1,39:2,42:3,44:3,54:3,46:4,26:4,37:6,41:5,43:5,45:5,47:5,48:5,50:5,49:7,57:7,51:7,55:7};
export const KIT_MIDI={0:36,1:38,2:39,3:42,4:46,5:45,6:37,7:49};
/* 收集一轨的 MIDI 事件：[tick,note,status,vel]；含节奏细分的精确时值音符。
   PPQ=480 → stepT=120/16分，uTick=stepT/PREC_U_PER_STEP=2；3 连音 durU=80 → 80*2=160 tick = 1/3 拍 */
export function notesOfTrack(t,ti,stepT){
  const out=[];const arr=proj._ev[ti];
  const velOf=v=>Math.max(1,Math.min(127,Math.round((v==null?.8:v)*127)));
  if(arr)arr.forEach((es,s)=>{es.forEach(e=>{
    if(t.kind==='drum'){
      const note=(KIT_MIDI[e.kit]!==undefined)?KIT_MIDI[e.kit]:36;
      out.push([s*stepT,note,90,velOf(e.vel)]);
      out.push([s*stepT+Math.max(1,Math.round(stepT*0.5)),note,80,0]);
    }else{
      out.push([s*stepT,e.midi,90,velOf(e.vel)]);
      out.push([(s+e.len)*stepT,e.midi,80,0]);
    }
  })});
  if(t.prec&&t.prec.length){
    const uTick=stepT/PREC_U_PER_STEP;
    for(const p of t.prec){
      if(p.row==null)continue;
      const st=p.u*uTick;
      if(t.kind==='drum'){
        if(p.row>=KIT.length)continue;
        const note=(KIT_MIDI[p.row]!==undefined)?KIT_MIDI[p.row]:36;
        out.push([st,note,90,velOf(p.vel)]);
        out.push([st+Math.round((p.durU||PREC_U_PER_STEP)*uTick),note,80,0]); // 真实精确时值（原为硬编码半步，会丢失连音时值导致导入端无法还原）
      }else{
        const midi=rowMidiAt(t,p.row,Math.floor(p.u/PREC_U_PER_STEP)); // 精确时值音符同样计入该步的升降号
        out.push([st,midi,90,velOf(p.vel)]);
        out.push([st+(p.durU||PREC_U_PER_STEP)*uTick,midi,80,0]); // 真实精确时值
      }
    }
  }
  return out;
}
export function exportMidiUI(){
  try{
    if(!proj.tracks.length){toast('没有可导出的音符','err');return}
    rebuildEvents();
    const PPQ=480,stepT=PPQ/4;
    const tb=tempoBytes();
    // 指挥轨：tempo + 4/4 拍号
    const cond=[];
    pushME(cond,0,0xff,0x51,3,tb[0],tb[1],tb[2]);
    // 拍号：nn dd（2 的幂）cc（每拍 MIDI 时钟）bb（每四分音符的 32 分音符数=8）
    const denExp=Math.round(Math.log2(meterD()));
    const clocks=Math.round(24*(4/meterD()));
    pushME(cond,0,0xff,0x58,4,meterN(),denExp,clocks,8);
    cond.push(0,0xff,0x2f,0);
    const tracks=[cond];
    // 各轨：鼓合并到通道9，旋律按轨分通道
    const merged={};
    proj.tracks.forEach((t,ti)=>{
      const ch=(t.kind==='drum')?9:(ti%9);
      const key=(t.kind==='drum')?'d9':'m'+ch;
      merged[key]=merged[key]||{ch,events:[],role:(t.kind==='drum'?'drumkit':(t.role||'lead'))};
      const ev=merged[key].events;
      notesOfTrack(t,ti,stepT).forEach(n=>ev.push(n));
    });
    for(const key in merged){
      const m=merged[key];
      m.events.sort((a,b)=>a[0]-b[0]||((a[2]&0xf0)-(b[2]&0xf0)));
      const data=[];
      // 轨道名元数据：role:bass / role:pad / role:drumkit … 便于导入还原与宿主显示
      const nm=strBytes('role:'+(m.role||'custom')+';key:'+proj.key+';mode:'+proj.mode+';oct:'+proj.keyOct);
      pushME(data,0,0xff,0x03,nm.length,...nm);
      let last=0;
      m.events.forEach(ev=>{
        const dt=Math.max(0,ev[0]-last);last=ev[0];
        pushVLQ(data,dt);
        data.push((ev[2]===90?0x90:0x80)|m.ch,ev[1],ev[3]);
      });
      data.push(0,0xff,0x2f,0);
      tracks.push(data);
    }
    const blob=new Blob([buildMidi(tracks)],{type:'audio/midi'});
    lastMidiBlob=buildMidi(tracks);
    downloadBlob(blob,(proj.name||'song').replace(/[\\/:*?"<>|]/g,'_')+'.mid');
    toast('已导出 MIDI（'+(Object.keys(merged).length)+' 轨）','ok');
  }catch(e){toast('MIDI 导出失败：'+e.message,'err')}
}
export function tempoBytes(){
  // MIDI 速度以“每分钟四分音符”计：四分 = (分母拍时长) × (分母/4)
  const us=Math.round(60000000/(proj.bpm||120)*(meterD()/4));
  return[(us>>>16)&255,(us>>>8)&255,us&255];
}
export function strBytes(s){return Array.from(s).map(c=>c.charCodeAt(0)&0xff)}
export function pushME(d,dt,...msg){
  pushVLQ(d,dt);msg.forEach(b=>d.push(b));
}
export function pushVLQ(d,v){
  let arr=[v&0x7f];v>>>=7;
  while(v>0){arr.unshift((v&0x7f)|0x80);v>>>=7}
  arr.forEach(b=>d.push(b));
}
export function buildMidi(tracks){
  const ntr=tracks.length;
  const parts=[];
  let trackData=[];
  trackData.push(0x4d,0x54,0x68,0x64,0x00,0x00,0x00,0x06,0x00,0x01,0x00,ntr,0x01,0xe0);
  parts.push(...trackData);
  tracks.forEach(t=>{
    parts.push(0x4d,0x54,0x72,0x6b);
    const len=t.length;
    parts.push((len>>>24)&0xff,(len>>>16)&0xff,(len>>>8)&0xff,len&0xff);
    parts.push(...t);
  });
  return new Uint8Array(parts);
}
export function importMidiUI(file){
  const rd=new FileReader();
  rd.onload=()=>{
    try{
      const m=parseMidi(new Uint8Array(rd.result));
      if(!m||!m.events.length)throw new Error('无音符');
      importMidiData(m);
      toast('已导入 MIDI：'+m.events.length+' 个音符','ok');
    }catch(e){toast('MIDI 导入失败：'+(e.message||e),'err')}
  };
  rd.readAsArrayBuffer(file);
}
export function parseMidi(bytes){
  const res={events:[],bpm:120,names:[]};
  let p=0;
  const rd8=()=>bytes[p++];
  const rd32=()=>(((rd8()<<24)|(rd8()<<16)|(rd8()<<8)|rd8())>>>0);
  if(rd8()!==0x4d||rd8()!==0x54||rd8()!==0x68||rd8()!==0x64)throw new Error('非 MIDI 文件');
  rd32(); // header len
  rd16(); // format
  const ntr=rd16();
  const tickDiv=rd16()||480;
  res.noteTicks=Math.max(1,Math.round(tickDiv/4));
  for(let ti=0;ti<ntr;ti++){
    // MTrk
    if(rd8()!==0x4d||rd8()!==0x54||rd8()!==0x72||rd8()!==0x6b)throw new Error('轨道头损坏');
    const len=rd32();
    const end=p+len;
    let cur=0,ch=0,lastStatus=0,name='';
    while(p<end){
      cur+=readVLQ();
      let st=rd8();
      if(st===0xff){
        const type=rd8();
        const l=readVLQ();
        if(type===0x51&&l===3){
          res.bpm=Math.round(60000000/((rd8()<<16)|(rd8()<<8)|rd8()));
        }else if(type===0x03){ // 轨道名
          let s='';
          for(let i=0;i<l;i++)s+=String.fromCharCode(rd8());
          name=s;
        }else if(type===0x2f){p+=l}
        else p+=l;
      }else if(st===0xf0||st===0xf7){
        const l=readVLQ();p+=l;
      }else{
        if(st&0x80){lastStatus=st;ch=st&0x0f;st&=0xf0}
        else{st=lastStatus&0xf0}
        if(st===0x90||st===0x80){
          const note=rd8();const vel=rd8();
          const on=(st===0x90&&vel>0);
          res.events.push({tick:cur,type:on?'on':'off',note,vel,ch,trk:ti});
        }else{
          // 控制类事件按数据字节数正确消费，避免干扰音符解析
          if(st===0xc0||st===0xd0){rd8();}            // Program / Channel Pressure：1 字节
          else if(st===0xa0||st===0xb0||st===0xe0){rd8();rd8();} // Poly / CC / Pitch Bend：2 字节
          else rd8(); // 其它未知通道事件：保守消费 1 字节
        }
      }
    }
    res.names[ti]=name;
  }
  return res;
  function rd16(){return (rd8()<<8)|rd8()}
  function readVLQ(){let v=0;for(;;){const b=rd8();v=(v<<7)|(b&0x7f);if(!(b&0x80))return v}}
}
export const ROLE_FALLBACK=['lead','bass','pad','chord','arp','lead','bass','pad','chord'];
export function metaFromName(n){
  const o={};
  String(n||'').split(';').forEach(p=>{
    const i=p.indexOf(':');
    if(i>0)o[p.slice(0,i).trim()]=p.slice(i+1).trim();
  });
  return o;
}
export function roleFromName(n){
  const r=metaFromName(n).role;
  return r||null;
}
/* 把 on/off 配对成音符，还原真实持续时间（长音不再变成 16 分短音） */
export function noteRuns(evs){
  const sorted=evs.slice().sort((a,b)=>a.tick-b.tick||(a.type==='on'?1:-1));
  const open={},runs=[];
  sorted.forEach(e=>{
    const key=e.trk+'|'+e.ch+'|'+e.note;
    if(e.type==='on'){if(!open[key])open[key]={trk:e.trk,ch:e.ch,note:e.note,on:e.tick,vel:e.vel}}
    else if(open[key]){
      const o=open[key];
      runs.push({trk:o.trk,ch:o.ch,note:o.note,on:o.on,off:e.tick,vel:o.vel});
      delete open[key];
    }
  });
  for(const key in open){const o=open[key];runs.push({trk:o.trk,ch:o.ch,note:o.note,on:o.on,off:o.on+1,vel:o.vel});}
  return runs;
}
export function importMidiData(m){
  beginEdit();
  const noteTicks=(m.noteTicks)||120;
  const names=(m.names)||[];
  // 2) 速度：parseMidi 已从 tempo meta 解析出 m.bpm，这里写回工程（原先从未写回 → 导入后 BPM 保持旧值）
  if(m.bpm)proj.bpm=m.bpm;
  // 1) 读取导出时写入的调性元数据 → 导入不再走调
  for(let i=0;i<names.length;i++){
    const mt=metaFromName(names[i]);
    if(mt.key&&SCALES[mt.mode]){
      proj.key=mt.key;proj.mode=mt.mode;proj.keyOct=parseInt(mt.oct)||4;
      break;
    }
  }
  const roleFor=e=>{
    if(e.ch===9)return null; // 鼓单独处理
    const r=roleFromName(names[e.trk]);
    if(r&&ROLES[r]&&r!=='drum')return r;
    return ROLE_FALLBACK[e.ch%ROLE_FALLBACK.length]||'lead';
  };
  let maxStep=0;
  m.events.forEach(e=>{maxStep=Math.max(maxStep,Math.round(e.tick/noteTicks))});
  // MIDI 导入按 16 分网格/4/4 还原（避免与当前拍号混用导致小节错位）
  if (meterN() !== 4 || meterD() !== 4) {
    if (!confirm('MIDI 导入会重置为 4/4 十六分网格，当前拍号将被覆盖。继续？')) {
      setPendingPre(null); return;
    }
  }
  proj.spb=16;proj.meterN=4;proj.meterD=4;
  proj.steps=Math.max(16,Math.min(MAX_BARS*16,Math.ceil((maxStep+1)/16)*16));
  proj.tracks=[];
  const drumsOn=m.events.filter(e=>e.type==='on'&&e.ch===9);
  let drumT=null;
  if(drumsOn.length){drumT=newTrack('drum','drum');allocPat(drumT,proj.steps,KIT.length);proj.tracks.push(drumT);}
  // 旋律：按 on/off 时长成段还原（每段连续填满步进格）
  const melRuns=noteRuns(m.events).filter(r=>r.ch!==9);
  const groups={};
  melRuns.forEach(r=>{
    const role=roleFor(r);
    (groups[role]=groups[role]||[]).push(r);
  });
  const tracksByRole={};
  for(const role in groups){
    const tr=newTrack('mel',(role in ROLES)?role:'custom');
    tr.name=(role in ROLES)?ROLES[role].name:('导入·'+role);
    allocPat(tr,proj.steps,MEL_ROWS);
    tracksByRole[role]=tr;
    proj.tracks.push(tr);
  }
  if(!proj.tracks.length){
    const lt=newTrack('mel','lead');allocPat(lt,proj.steps,MEL_ROWS);proj.tracks.push(lt);
  }
  const placeRun=(tr,r)=>{
    const st=r.on/noteTicks;                        // 精确位置（可能落在 16 分网格之间）
    const s0=Math.round(st);
    const durF=(r.off-r.on)/noteTicks;              // 时值（步）
    // 导入反解：只用 rowMidi（自然音级）—— MIDI 音高无法区分“谱面 ♯”与“调内音”，
    // 因此导入端刻意不猜 acc：升号会落在最近的自然音级上，音高听感保持、记号不还原（诚实限制，见汇报）
    // 精确时值判定：起点偏离网格 ±0.02 步（≈1.2u），或（非鼓组）时值不是整数步——后者用于 3 连音中
    // 正好落在网格上的首音（u=0/240…），它同样是 prec（时值 80u≈1.33 步）；鼓组导出恒用半步时值，故排除
    const offGrid=Math.abs(st-Math.floor(st))>0.02||(r.ch!==9&&Math.abs(durF-Math.round(durF))>0.02);
    if(s0>=proj.steps)return;
    let best=0,bd=99;
    for(let rr=0;rr<trackRows(tr);rr++){
      const mm=rowMidi(tr,rr);
      const d0=Math.abs(mm-r.note);
      if(d0<bd){bd=d0;best=rr}
    }
    if(bd>3)return;
    const v0=Math.min(1,Math.max(.3,r.vel/127));
    if(offGrid){
      // —— 精确时值分支：写入 trk.prec，不写 pat（同一音绝不既进 pat 又进 prec，避免 fireStep 双触发）——
      const step=Math.floor(st);
      const u=Math.round((st-step)*PREC_U_PER_STEP);
      const uAbs=step*PREC_U_PER_STEP+u;
      const durU=Math.max(1,Math.round((r.off-r.on)/noteTicks*PREC_U_PER_STEP));
      if(step>=proj.steps)return;
      if(tr.pat[step]&&tr.pat[step][best]>0){ // 同格冲突：网格音更接近整格 → 保留它，丢弃精确音
        console.warn('MIDI 导入：第 '+(step+1)+' 格第 '+best+' 行已有网格音（更接近整格），丢弃 u='+uAbs+' 的精确音');
        return;
      }
      const dup=tr.prec.find(p=>p.row===best&&Math.abs(p.u-uAbs)<=1);
      if(dup){ console.warn('MIDI 导入：已存在同格同行同 u 的精确音（u='+dup.u+'），丢弃重复项'); return; }
      tr.prec.push({row:best,u:uAbs,durU,vel:v0});
      return;
    }
    // —— 普通网格分支（原逻辑不变）——
    const durC=Math.max(1,Math.round((r.off-r.on)/noteTicks));
    const hadPrec=tr.prec.filter(p=>p.row===best&&Math.floor(p.u/PREC_U_PER_STEP)===s0);
    if(hadPrec.length){ // 同格冲突：网格音更接近整格 → 留下的网格音，移除该格精确音（与 trimPrecAt 行为一致）
      console.warn('MIDI 导入：第 '+(s0+1)+' 格第 '+best+' 行被网格音取代，移除 '+hadPrec.length+' 个精确音');
      tr.prec=tr.prec.filter(p=>!(p.row===best&&Math.floor(p.u/PREC_U_PER_STEP)===s0));
    }
    for(let d=0;d<durC&&s0+d<proj.steps;d++){
      const v=d===0?v0:v0*.9;
      tr.pat[s0+d][best]=Math.max(tr.pat[s0+d][best]||0,v);
    }
  };
  for(const role in groups){
    const tr=tracksByRole[role];
    groups[role].forEach(r=>placeRun(tr,r));
  }
  if(drumT){
    // 鼓组同样支持精确时值：用 on/off 配对后的 run（而非原始 note-on）判定，起点偏离网格 → 写 prec
    noteRuns(m.events).filter(r=>r.ch===9).forEach(r=>{
      const k=GM_DRUMS[r.note];
      if(k===undefined)return;
      const stD=r.on/noteTicks, vD=Math.min(1,Math.max(.3,r.vel/127));
      const durD=(r.off-r.on)/noteTicks, drumHit=Math.abs(durD-0.5)<=0.02; // 普通鼓点导出恒为半步短音（stepT*0.5）
      if(Math.abs(stD-Math.floor(stD))>0.02||!drumHit){ // 起点偏离网格，或时值不是“半步短音”→ 精确时值
        const step=Math.floor(stD), u=Math.round(stD*PREC_U_PER_STEP);
        if(step>=proj.steps)return;
        if(drumT.pat[step]&&drumT.pat[step][k]>0){ console.warn('MIDI 导入：鼓组第 '+(step+1)+' 格已有网格音（更接近整格），丢弃 u='+u+' 的精确音'); return; }
        if(drumT.prec.find(p=>p.row===k&&Math.abs(p.u-u)<=1)){ console.warn('MIDI 导入：鼓组已存在同格同行同 u 的精确音（u='+u+'），丢弃重复项'); return; }
        drumT.prec.push({row:k,u,durU:Math.max(1,Math.round((r.off-r.on)/noteTicks*PREC_U_PER_STEP)),vel:vD});
        return;
      }
      const step=Math.round(stD);
      const had=drumT.prec.filter(p=>p.row===k&&Math.floor(p.u/PREC_U_PER_STEP)===step);
      if(had.length){
        console.warn('MIDI 导入：鼓组第 '+(step+1)+' 格被网格音取代，移除 '+had.length+' 个精确音');
        drumT.prec=drumT.prec.filter(p=>!(p.row===k&&Math.floor(p.u/PREC_U_PER_STEP)===step));
      }
      if(step<proj.steps)drumT.pat[step][k]=Math.max(drumT.pat[step][k]||0,vD);
    });
  }
  proj.sel=0;
  commitEdit();
  hooks.ui?.structural?.(true);rebuildEvents();markDirtyUI();hooks.inspector?.render?.();
  if(UI.barsN){const bb=Math.max(1,Math.round(proj.steps/SPB()));UI.barsN.value=bb;if(UI.barsV)UI.barsV.textContent=bb}
  hooks.ui?.syncBpmUI?.(); // 同步 BPM 到顶栏（io/* 不得 import ui/*，故经 hooks.ui 回调；不新增 import）
}
