/* [harmony.js] source: Pro.html 3826-3830, 3857-3922, 4039-4090（和弦声部 / 琶音 / 和声垫） */
import { proj, patRows } from '../core/state.js';
import { clamp, pick } from '../core/util.js';
import { degSemi } from '../core/theory.js';
import { planFromSections } from './styles.js';

export function chordRowsOf(mode,rootDeg,with7){
  const t=[rootDeg,rootDeg+2,rootDeg+4];
  if(with7)t.push(rootDeg+6);
  return t;
}
/* 和弦进行（按段落选择两个走向，段末回主/属准备） */
export function chordVoicings(rows){
  const cands=[];
  for(let k=0;k<rows.length;k++){
    const r=rows.slice();
    for(let i=0;i<k;i++){if(r[i]<=7)r[i]+=7;else break}
    r.sort((a,b)=>a-b);
    const f=r.filter(x=>x<=14);
    if(f.length)cands.push(f);
  }
  if(!cands.length)cands.push(rows.slice().sort((a,b)=>a-b));
  return cands;
}
export function voiceCost(prev,cur){
  if(!prev||!prev.length||!cur.length)return 99;
  const sem=r=>degSemi(proj.mode,r);
  let c=0;
  cur.forEach(a=>{
    let m=99;
    prev.forEach(b=>{const d=Math.abs(sem(a)-sem(b));if(d<m)m=d});
    c+=m;
  });
  return c;
}
export function planChords(rng,secs,style,E,C){
  const B=secs.length;
  const p1=pick(style.progs)||[0,5,3,4];
  const p2=style.progs.length>1?pick(style.progs.filter(p=>p!==p1)):p1;
  const clim0=secs.indexOf('climax');
  const out=[];
  let prevVoic=null;
  for(let b=0;b<B;b++){
    const sec=secs[b];
    let root;
    if(sec==='climax'&&clim0>=0)root=p2[(b-clim0)%p2.length];
    else root=p1[b%p1.length];
    if(b===B-1)root=0; // 结束回主
    else if(sec==='outro'&&b===B-2&&rng.chance(.75))root=4; // 属和弦预备
    else if(b===0)root=0;
    let seventh=style.seventh*(0.3+0.8*C);
    if(sec==='intro')seventh*=.4;
    if(sec==='climax')seventh=Math.min(1,seventh*1.35);
    const with7=rng.chance(seventh);
    let rows=chordRowsOf(proj.mode,root,with7).filter(x=>x<=14);
    rows.sort((a,b)=>a-b);
    rows=rows.filter((v,i,a)=>a.indexOf(v)===i);
    const cands=chordVoicings(rows);
    // 声部进行：选与上一和弦“最近”的转位（保持共同音、避免声部大跳/越过旋律）
    let chosen;
    if(prevVoic&&cands.length>1){
      let best=Infinity,ties=[];
      cands.forEach(c=>{
        const cost=voiceCost(prevVoic,c);
        if(cost<best-1e-6){best=cost;ties=[c]}
        else if(Math.abs(cost-best)<1e-6){ties.push(c)}
      });
      chosen=pick(ties.length?ties:cands);
    }else{
      chosen=cands[0];
      if(rng.chance(.3)&&cands.length>1)chosen=pick(cands.slice(0,Math.min(3,cands.length)));
    }
    prevVoic=chosen;
    out.push({root,rows:chosen,with7,sec});
  }
  return out;
}
/* ---------- 琶音（引子/尾声静默，高潮最密） ---------- */
export function fillArp(t,rng,chords,secs,style,E,C){
  const S=proj.steps,B=secs.length;
  for(let s=0;s<S;s++)for(let r=0;r<patRows(t);r++)t.pat[s][r]=0;
  const F=planFromSections(secs,E,C);
  for(let b=0;b<B;b++){
    const raw=secs[b],sec=raw==='all'?'build':raw;
    if(sec==='intro'||sec==='outro')continue;
    const M=F.bars[b]||{},D={e:M.density==null?.62:M.density,v:M.vel==null?.7:M.vel};
    const ch=chords[b];
    let rows=ch.rows.map(x=>x>=7?x:x+7).filter(x=>x<=14);
    if(!rows.length)rows=ch.rows;
    const seq=rows.length?rows:ch.rows;
    const dir=rng.chance(.5)?1:-1;
    // 基础走八分音符；高潮（密度 ≥.9）偶尔 16 分点缀（跳过部分反拍留白），避免与旋律打架
    const gap=(D.e>=.9&&E>.5)?1:2;
    let idx=dir>0?0:seq.length-1;
    for(let s=bsOf(b);s<bsOf(b)+16;s+=gap){
      if(s%2===1&&rng.chance(D.e>=.9?.4:.55))continue; // 反拍留白
      t.pat[s][seq[idx]]=clamp((s%8===0?.88:(s%4===0?.7:.55))*D.v*.85,.06,1);
      idx+=dir;
      if(idx<0)idx=seq.length-1;
      if(idx>=seq.length)idx=0;
    }
  }
}
export function bsOf(b){return b*16}
/* ---------- 和声垫 / 柱式和弦（Pad 全曲延音；Chord 仅在发展/高潮出现、断奏化） ---------- */
export function fillHarmony(t,rng,chords,secs,padMode,C,E){
  const S=proj.steps,B=secs.length;
  for(let s=0;s<S;s++)for(let r=0;r<patRows(t);r++)t.pat[s][r]=0;
  const F=planFromSections(secs,E,C);
  for(let b=0;b<B;b++){
    const raw=secs[b],sec=raw==='all'?'build':raw;
    const M=F.bars[b]||{},D={e:M.density==null?.62:M.density,v:M.vel==null?.7:M.vel};
    const ch=chords[b];
    let rows=ch.rows.slice();
    if(padMode)rows=ch.rows.map(x=>x>=7?x:x+7).filter(x=>x<=14);
    if(!rows.length)rows=ch.rows;
    if(padMode){
      // 整小节长音（播放端自动合并），音量随段落起伏且整体压得很低（柔和垫底）
      // 高潮才铺满（含七度色彩），引子/发展收成三音和弦 → 高潮在和声厚度上也明显更"放"
      if(sec!=='climax'&&rows.length>3)rows=rows.slice(0,3);
      // 统一 Math.max 叠加写入：即使与同轨其它生成内容重叠也不互相覆盖
      const vel=clamp((sec==='intro'?.5:sec==='climax'?.6:sec==='outro'?.42:.5)*D.v*.8,.06,.85);
      for(let s=0;s<16;s++)rows.forEach(rw=>{const cell=bsOf(b)+s;t.pat[cell][rw]=Math.max(t.pat[cell][rw]||0,vel)});
    }else{
      if(sec==='intro'||sec==='outro')continue; // 柱式只在发展/高潮响
      // 断奏柱式：发展每小节两次；高潮三次（密度/力度更高）
      const vel=clamp((sec==='climax'?.56:.36)*D.v,.05,.8);
      const hits=sec==='climax'?[0,8,12]:[0,8];
      hits.forEach(hit=>{
        for(let d=0;d<2&&hit+d<16;d++)rows.forEach(rw=>{const cell=bsOf(b)+hit+d;t.pat[cell][rw]=Math.max(t.pat[cell][rw]||0,vel)});
      });
    }
  }
}
