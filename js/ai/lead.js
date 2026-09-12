/* [lead.js] source: Pro.html 4091-4280, 4461-4540（主旋律写作 / 续写取音 / 动机保留） */
import { proj, patRows, newTrack, allocPat, SPB } from '../core/state.js';
import { clamp, pick } from '../core/util.js';
import { ROLES } from '../core/theory.js';
import { planFromSections } from './styles.js';
import { bsOf, fillArp, fillHarmony } from './harmony.js';
import { fillDrums, fillBass } from './rhythm.js';

/* =========================================================================
   动机层（分层生成 · 第二层）：核心动机 + 四种发展变换
   —— 动机用「相对音程 + 节奏时值」表示（intervals[0] 恒为 0，单位=音阶级数/步），
      渲染时再吸附到段落内的和弦音域上，因此可以自由转调/倒影而不越界。
   ========================================================================= */
export const MOTIF_TRANSFORMS=['transpose','invert','rhythmStretch','fragment'];
const MOTIF_LEN_CHOICES=[2,2,3,4];
const nearestDeg=(pool,deg)=>pool.reduce((best,x)=>Math.abs(x-deg)<Math.abs(best-deg)?x:best,pool[0]);
/* 生成 2~4 音的核心动机；scale = 可用音级（一般传本小节的和弦音），seed = 起音参考（续写衔接） */
export function buildMotif(rng,scale,seed){
  const pool=(scale&&scale.length?scale.slice():[0,1,2,3,4]).sort((a,b)=>a-b);
  const root=(seed==null)?pick(pool):nearestDeg(pool,seed);
  const n=2+Math.floor(rng.f()*3);            // 2~4 音
  const intervals=[0],lens=[],onsets=[0];
  let on=0;
  for(let i=1;i<n;i++){
    // 以级进为主（±1、±2 级），偶发小跳（±4）
    let iv=rng.chance(.72)?(rng.chance(.52)?1:-1):(rng.chance(.5)?2:-2);
    if(rng.chance(.12))iv*=2;
    intervals.push(iv);
    const len=pick(MOTIF_LEN_CHOICES);
    lens.push(len);on+=len;onsets.push(on);
  }
  lens.push(pick([2,3,4]));
  return {root,intervals,lens,onsets,span:on+lens[lens.length-1],transform:'core',degree:intervals.length};
}
/* 四种发展变换：transpose（整体转调）/ invert（倒影）/ rhythmStretch（节奏伸缩）/ fragment（取片段，可重复一次） */
export function developMotif(motif,rng,transformType){
  const m=motif||{root:0,intervals:[0,1,0],lens:[2,2,4],onsets:[0,2,4]};
  const type=(transformType&&MOTIF_TRANSFORMS.indexOf(transformType)>=0)?transformType:rng.pick(MOTIF_TRANSFORMS);
  const out={root:m.root,intervals:m.intervals.slice(),lens:m.lens.slice(),onsets:m.onsets.slice(),transform:type,degree:m.intervals.length};
  const rebase=()=>{const on=[];let acc=0;out.lens.forEach(l=>{on.push(acc);acc+=l});out.onsets=on;out.span=acc};
  if(type==='transpose'){
    const mag=rng.chance(.62)?1:2;
    out.root=m.root+(rng.chance(.5)?mag:-mag); // 整体移位（渲染时会吸附回和弦音）
  }else if(type==='invert'){
    out.intervals=m.intervals.map((iv,i)=>i===0?0:-iv); // 以首音为轴镜像
  }else if(type==='rhythmStretch'){
    const k=rng.chance(.5)?2:1.5;
    out.lens=m.lens.map(l=>Math.max(1,Math.round(l*k)));
    rebase();
  }else{ // fragment：取前/后片段，三成概率原样重复一次（形成呼应）
    const keep=Math.max(2,Math.ceil(m.intervals.length/2));
    const from=(m.intervals.length>keep&&rng.chance(.5))?(m.intervals.length-keep):0;
    out.intervals=m.intervals.slice(from,from+keep);
    out.lens=m.lens.slice(from,from+keep);
    const base=m.onsets[from]||0;
    out.onsets=m.onsets.slice(from,from+keep).map(x=>x-base);
    out.degree=out.intervals.length;
    if(rng.chance(.35)){
      const n2=out.intervals.length;
      const rep=out.intervals.map((iv,i)=>i===n2-1?iv+(rng.chance(.5)?1:-1):iv);
      const shift=out.onsets[n2-1]+out.lens[n2-1];
      out.intervals=out.intervals.concat(rep);
      out.lens=out.lens.concat(out.lens.slice());
      out.onsets=out.onsets.concat(out.onsets.map(o=>o+shift));
      out.degree=out.intervals.length;
    }
    rebase();
  }
  out.transform=type;
  return out;
}
/* 段落槽位 → 变换选择：引子/尾声回归主题（转调/片段），发展多变形，高潮用伸缩推动 */
export function motifTransformForSlot(slot,rng){
  if(slot===2)return rng.chance(.6)?'rhythmStretch':'transpose';
  if(slot===1)return rng.pick(['invert','fragment','transpose','rhythmStretch']);
  return rng.chance(.5)?'transpose':'fragment';
}
/* 动机轨迹（模块内导出，供自检/调试观察，不挂全局） */
export const motifTrace={core:null,phrases:[]};

/* ---------- 主旋律（按段落写作：引子动机→发展推进→高潮高音区→尾声收束） ---------- */
export function fillLead(t,rng,chords,secs,style,E,C,band,seed){
  const S=proj.steps,B=secs.length;
  for(let s=0;s<S;s++)for(let r=0;r<patRows(t);r++)t.pat[s][r]=0;
  const F=planFromSections(secs,E,C); // 分层生成：每小节密度/力度/动机槽位
  const lo=band[0],hi=band[1];
  if(seed!=null)seed=clamp(Math.round(seed),lo,hi);
  // 留白式节奏骨架（每 16 步一拍栏，总时值约 9~13 步，其余休止）
  const RHYTHMS=[
    [[0,2],[3,3],[8,2],[12,3]],                 // 平静
    [[0,2],[2,2],[6,2],[8,3],[12,2]],           // 中速八分
    [[0,2],[4,2],[8,3],[12,2],[14,2]],          // 切分
    [[0,3],[3,2],[8,2],[12,4]],                 // 三连装饰
    [[0,2],[2,2],[4,2],[8,2],[10,2],[12,3]]     // 推进
  ];
  const rIdx=E>.68?4:(E>.45?2:(E>.22?1:0));
  const pickR=k=>RHYTHMS[clamp((k==null?rIdx:k)+rng.i(-1,1),0,RHYTHMS.length-1)];
  const toneIn=(b,minR,maxR)=>{const c=chords[b].rows.filter(r=>r>=minR&&r<=maxR);return c.length?c:chords[b].rows};
  const place=(bs,step,row,len,vel)=>{
    const end=Math.min(S,bs+step+len);
    for(let s=bs+step;s<end;s++)t.pat[s][row]=Math.max(t.pat[s][row]||0,s===bs+step?vel:vel*.72);
  };
  const midR=Math.floor((lo+hi)/2);
  let cur=clamp(pick(toneIn(0,lo,midR)),lo,hi);
  let prevEnd=null;
  let phrase=null;
  let motifCells=null;
  let coreMotif=null; // 整曲唯一的“核心动机 DNA”，由第一个乐句陈述、后续乐句发展
  motifTrace.core=null;motifTrace.phrases=[];
  for(let b=0;b<B;b++){
    const raw=secs[b],sec=raw==='all'?'build':raw;
    const M=F.bars[b]||{},D={e:M.density==null?.62:M.density,v:M.vel==null?.7:M.vel};
    const densIdx=clamp(rIdx+(D.e>=.9?1:(D.e<=.4?-1:0)),0,RHYTHMS.length-1); // 段落密度 → 节奏骨架疏密
    const bs=bsOf(b);
    if(sec==='outro'){
      if(b===B-1){
        // 最后小节：第 3 拍起主音长音收束（先留一点余白，更从容）
        const p=toneIn(b,lo,hi);
        const tonic=clamp(p.length?p[Math.floor(p.length/2)]:Math.round((lo+hi)/2),lo,hi);
        if(rng.chance(.85)){ // 属音/邻音"导入"后落主音
          const leadIn=clamp(tonic-1>=lo?tonic-1:tonic+1,lo,hi);
          place(bs,6,leadIn,2,.55);
        }
        place(bs,8,tonic,8,.9);
      }else{
        // 多小节尾声：倒数第二节必给安静的下行收束小句，为长音蓄势
        const pool=toneIn(b,lo,hi);
        let note=clamp(pool.length?pick(pool):Math.round((lo+hi)/2),lo,hi);
        const steps=[4,12];
        if(rng.chance(.55))steps.push(8);
        steps.sort((a,b)=>a-b).forEach(st=>{
          note=clamp(note-(rng.chance(.6)?1:2),lo,hi);
          place(bs,st,note,2,.42);
        });
      }
      continue;
    }
    // 引子动机：整个引子都保持可闻的稀疏动机（引子已封顶 2~6 小节），开头不再长时间只剩垫音
    // 每 2 小节建乐句：动机句 → 应答句，起始音承接上一句
    if(b%2===0){
      const pStart=toneIn(b,lo,midR);
      const pPeak=toneIn(Math.min(B-1,b+1),sec==='climax'?midR-1:midR,hi-1);
      const pEnd=toneIn(Math.min(B-1,b+1),lo,midR+1);
      let startD;
      if(b===0&&seed!=null){
        // 续写衔接：新乐句从“上一段最后一个音”附近自然接续，而不是随机起音
        const drift=rng.chance(.62)?0:(rng.chance(.5)?1:-1);
        startD=clamp(seed+drift,lo,hi);
        if(rng.chance(.5)){
          const cc=toneIn(b,lo,midR);
          if(cc.length){const best=cc.reduce((x,y)=>Math.abs(y-startD)<Math.abs(x-startD)?y:x,cc[0]);if(Math.abs(best-startD)<=2)startD=best;}
        }
      }else startD=(b===0)?clamp(pick(pStart),lo,hi)
        : clamp((prevEnd!=null?prevEnd:cur)+(rng.chance(.5)?-1:1),lo,hi);
      phrase={
        startD,
        peakD:clamp(pick(pPeak),lo,hi),
        endD:clamp(pick(pEnd),lo,hi),
        dir:rng.chance(.5)?1:-1,
        variant:rng.pick(['same','arch','answer','motif'])
      };
      cur=clamp(startD,lo,hi); // 乐句起点承接上一句结尾（±1 级内）
    }
    const anchors=[{p:0,d:phrase.startD},{p:16,d:phrase.peakD},{p:31,d:phrase.endD}];
    const targetD=pos=>{let a=anchors[0],z=anchors[1];if(pos>16){a=anchors[1];z=anchors[2];}const tt=(pos-a.p)/((z.p-a.p)||1);return a.d+(z.d-a.d)*tt;};
    // —— 动机陈述（乐句首小节）：第一句立核心动机，之后全部由 developMotif 变换而来 ——
    let ledMotif=null;
    if(b%2===0){
      const pool=toneIn(b,lo,hi);
      if(!coreMotif){
        // 核心动机的音高素材取“音域内圈”，避免根音贴边导致动机被压平
        const inner=pool.filter(d=>d>=lo+2&&d<=hi-2);
        coreMotif=buildMotif(rng,inner.length?inner:pool,seed!=null?seed:null); // 续写时接住上一段末音
        motifTrace.core={root:coreMotif.root,intervals:coreMotif.intervals.slice(),lens:coreMotif.lens.slice(),transform:'core'};
        ledMotif=coreMotif;
      }else{
        ledMotif=developMotif(coreMotif,rng,motifTransformForSlot(M.slot,rng));
      }
      // 动机落地：整体平移（而不是逐音 clamp），保证音程轮廓完整保留在音域内
      const iv=ledMotif.intervals;
      const ivMin=Math.min.apply(null,iv),ivMax=Math.max.apply(null,iv);
      const want=nearestDeg(pool,clamp(phrase.startD,lo,hi))+clamp(ledMotif.root-coreMotif.root,-3,3);
      const bLo=lo-ivMin,bHi=hi-ivMax;
      const baseRow=(bLo<=bHi)?clamp(want,bLo,bHi):clamp(want,lo,hi);
      for(let i=0;i<iv.length;i++){
        const st=ledMotif.onsets[i];
        if(st>=16)break;
        const row=clamp(baseRow+iv[i],lo,hi);
        const arch=clamp(.62+.38*Math.max(0,1-Math.abs(st-15.5)/15.5),.55,1);
        const mv=clamp((st%4===0?.95:(st%2===0?.72:.58))*D.v*arch,.08,1);
        place(bs,st,row,Math.min(ledMotif.lens[i],16-st),mv);
      }
      cur=clamp(baseRow+iv[iv.length-1],lo,hi);
      motifTrace.phrases.push({bar:b,sec,transform:ledMotif.transform,notes:iv.length,root:baseRow,intervals:iv.slice(),lens:ledMotif.lens.slice(),onsets:ledMotif.onsets.slice()});
    }
    // 动机句不再走“随机节奏骨架”；应答句（奇数小节）仍用骨架生成 → 陈述—应答
    let barR=ledMotif?[]:pickR(densIdx);
    if(b%2===1&&phrase.variant==='same')barR=RHYTHMS[densIdx]; // 动机重复：节奏一致
    if(sec==='intro')barR=barR.filter(h=>h[0]%4===0); // 引子动机可闻但不密集
    // 偶尔整体跳过个别音，制造呼吸感（密度高的段落更少跳）
    if(D.e<.9&&rng.chance(clamp(.42-.24*D.e,.1,.4)))barR=barR.filter((h,i)=>i!==barR.length-1||rng.chance(.6));
    let leapUsed=0;
    const leapProb=clamp(clamp(D.e-.3,0,1)*.45*(0.7+0.4*E)*(phrase.variant==='motif'?.5:1),0,.4);
    for(let hiIdx=0;hiIdx<barR.length;hiIdx++){
      const hit=barR[hiIdx];
      let s0=hit[0],len=hit[1];
      const pos=(b%2)*16+s0;
      let target=clamp(Math.round(targetD(pos)),lo,hi);
      // 应答句做轻微音程平移（多为 ±1 级）
      if(b%2===1&&phrase.variant==='answer')target=clamp(target+phrase.dir*(rng.chance(.7)?1:2),lo,hi);
      // 级进走向目标：以 ±1 级为主，偶尔跳 2 级，避免大跳
      let step=clamp(target-cur,-2,2);
      if(Math.abs(step)>=2&&rng.chance(.65))step=Math.sign(step)*1;
      let row=cur+step;
      // 强拍若和弦音离得近，可吸附
      if(s0%4===0){
        const c=toneIn(b,lo,hi);
        const cand=c.length?c.reduce((best,x)=>Math.abs(x-row)<Math.abs(best-row)?x:best,c[0]):null;
        if(cand!=null&&Math.abs(cand-row)<=2)row=cand;
      }
      // —— 记忆点大跳（六度/八度或和弦音跨跳），每小节至多一次 ——
      if(s0%8===0&&leapUsed===0&&leapProb>0&&rng.chance(leapProb)){
        const cands=[];
        toneIn(b,lo,hi).forEach(ct=>{const d=Math.abs(ct-cur);if(d>=4&&d<=7)cands.push(ct)});
        [cur-7,cur+7].forEach(o=>{if(o>=lo&&o<=hi&&o!==cur)cands.push(o)});
        if(cands.length){
          const up=cands.filter(c=>c>cur),dn=cands.filter(c=>c<cur);
          const set=up.length&&(dn.length===0||rng.chance(.62))?up:dn;
          if(set.length){row=clamp(pick(set),lo,hi);leapUsed=1;}
        }
      }
      row=clamp(Math.round(row),lo,hi);
      cur=row;
      // 乐句拱形力度（弱 → 强 → 弱，每 2 小节一个呼吸）
      const lpos=(b%2)*16+s0;
      const arch=clamp(.62+.38*Math.max(0,1-Math.abs(lpos-15.5)/15.5),.55,1);
      const vel=clamp((s0%4===0?.95:(s0%2===0?.72:.58))*D.v*arch,.08,1);
      place(bs,s0,row,len,vel);
    }
    // —— 装饰音：经过音（Passing Tone）+ 前倚音（Appoggiatura）——
    if(sec!=='outro'&&rng.chance(sec==='intro'?.35:(sec==='climax'?.9:.65))){
      const ons=[];
      for(let cs=bs;cs<bs+16;cs++)for(let r=lo;r<=hi;r++){
        const vv=t.pat[cs]&&t.pat[cs][r];
        if(vv>0&&(cs===bs||t.pat[cs-1][r]===0))ons.push({s:cs,r});
      }
      if(ons.length>1){
        for(let i=1;i<ons.length;i++){
          const a=ons[i-1],b2=ons[i];
          if(b2.s-a.s<6)continue;
          const dir=Math.sign(b2.r-a.r);if(!dir)continue;
          const dist=Math.abs(b2.r-a.r);if(dist<2||dist>4)continue;
          const pS=b2.s-2,pR=a.r+dir;
          if(pS<=a.s||pS<bs+1||pS>=bs+16||pR<lo||pR>hi)continue;
          let free=true;for(let r2=lo;r2<=hi;r2++)if(t.pat[pS][r2]>0){free=false;break}
          if(!free)continue;
          t.pat[pS][pR]=clamp(.5*D.v,.08,1);
        }
      }
      [0,4,8,12].forEach(off=>{
        const s2=bs+off;
        if(s2-1<bs)return;
        let main=-1;
        for(let r=lo;r<=hi;r++)if(t.pat[s2][r]>0&&(s2===bs||t.pat[s2-1][r]===0)){main=r;break}
        if(main<0)return;
        const app=main+(rng.chance(.5)?1:-1);
        if(app<lo||app>hi)return;
        let free=true;for(let r2=lo;r2<=hi;r2++)if(t.pat[s2-1][r2]>0){free=false;break}
        if(!free)return;
        t.pat[s2-1][app]=clamp(.62*D.v,.08,1);
      });
    }
    // —— 模进（Motif Sequence）：乐句第 2 小节整段复制并转调，形成“记忆点” ——
    if(phrase.variant==='motif'){
      if(b%2===0){
        motifCells=[];
        for(let cs=bs;cs<bs+16;cs++)for(let rr=lo;rr<=hi;rr++){
          const vv=t.pat[cs]&&t.pat[cs][rr];
          if(vv>0)motifCells.push({d:cs-bs,r:rr,v:vv});
        }
      }else if(motifCells&&motifCells.length){
        // 清掉本小节自动生成的音，换成动机的转调复制
        for(let cs=bs;cs<bs+16;cs++)for(let rr=lo;rr<=hi;rr++)t.pat[cs][rr]=0;
        const fit=sh=>{let ok=0;motifCells.forEach(m=>{const rr2=m.r+sh;if(rr2>=lo&&rr2<=hi)ok++});return ok};
        const shift=(fit(2)>=fit(-2)?2:-2);
        motifCells.forEach(m=>{
          const rr2=m.r+shift;
          if(rr2>=lo&&rr2<=hi)t.pat[bs+m.d][rr2]=Math.max(t.pat[bs+m.d][rr2]||0,clamp(m.v*.98,.08,1));
        });
        motifCells=null;
      }
    }else if(b%2===1){motifCells=null}
    // 应答句末音落在和弦音（解决）
    if(b%2===1){
      const lastRow=clamp(phrase.endD,lo,hi);
      cur=lastRow;
      prevEnd=lastRow;
    }
  }
}
export function extractMelodicOnsets(t){
  const S=proj.steps,out=[];
  for(let r=0;r<patRows(t);r++){
    let s=0;
    while(s<S){
      const v=t.pat[s][r];
      if(v>0){
        let len=1;
        while(s+len<S&&(s+len)%SPB()!==0&&t.pat[s+len][r]>0)len++;
        out.push({s,r,v,len});
        s+=len;
      }else s++;
    }
  }
  out.sort((a,b)=>a.s-b.s||a.r-b.r);
  return out;
}
/* 按角色在指定小节区间补写（每种音轨用各自生成逻辑：鼓→段落节奏、贝斯→根音/律动、
   垫/柱式→和声、琶音→分解、主旋律→乐句） */
export function genRangeTo(realT,role,barFrom,barTo,fullSecs,chordsFull,style,E,C,rng){
  if(barTo<=barFrom)return;
  const regionSteps=(barTo-barFrom)*16;
  const subSecs=fullSecs.slice(barFrom,barTo);
  const subChords=chordsFull.slice(barFrom,barTo);
  const tmp=newTrack(role==='drum'?'drum':'mel', role==='drum'?'drum':(role in ROLES?role:'lead'));
  allocPat(tmp,regionSteps,patRows(tmp));
  // 主旋律续写：取 realT 里 barFrom 之前最近的 1~2 小节中的收束音作为新乐句起音
  let seed=null;
  if(role==='lead'&&barFrom>0){
    const scMin=Math.max(0,(barFrom-2)*16);
    outer:for(let s=barFrom*16-1;s>=scMin;s--){
      const col=realT.pat[s];if(!col)continue;
      for(let r=col.length-1;r>=0;r--)if(col[r]>0){seed=r;break outer;}
    }
  }
  const prevS=proj.steps;proj.steps=regionSteps;
  try{
    if(role==='drum')fillDrums(tmp,rng,style,subChords,subSecs,E,C);
    else if(role==='bass')fillBass(tmp,rng,subChords,subSecs,style,E,C);
    else if(role==='arp')fillArp(tmp,rng,subChords,subSecs,style,E,C);
    else if(role==='pad'||role==='chord')fillHarmony(tmp,rng,subChords,subSecs,role==='pad',C,E);
    else fillLead(tmp,rng,subChords,subSecs,style,E,C,style.leadBand||[2,12],seed);
  }finally{proj.steps=prevS;}
  const off=barFrom*16;
  for(let s=0;s<regionSteps&&off+s<realT.pat.length;s++){
    const src=tmp.pat[s],dst=realT.pat[off+s];
    for(let r=0;r<Math.min(src.length,dst.length);r++)if(src[r]>0)dst[r]=Math.max(dst[r]||0,src[r]);
  }
}
/* 找到某条轨上 完全空白的小节段（返回 [from,to) 列表） */
export function emptyBarRuns(t,B){
  const runs=[];
  const rows=patRows(t);
  let cur=-1;
  for(let b=0;b<B;b++){
    let any=false;
    for(let s=b*16;s<b*16+16;s++)for(let r=0;r<rows;r++)if(t.pat[s]&&t.pat[s][r]>0){any=true;break}
    if(!any){if(cur<0)cur=b;}
    else if(cur>=0){runs.push([cur,b]);cur=-1;}
  }
  if(cur>=0)runs.push([cur,B]);
  return runs;
}
/* 把“用户原轨内容”写回 AI 重组后的同角色新轨（首 S 步内覆盖为 DNA，防止丢失） */
export function preserveSketchOnto(srcTracks,S){
  srcTracks.forEach(tr=>{
    if(tr.kind!=='mel'&&tr.kind!=='drum')return;
    let dst=proj.tracks.find(x=>x.kind===tr.kind&&x.role===tr.role);
    if(!dst)dst=proj.tracks.find(x=>x.kind==='mel'&&x.role==='lead');
    if(!dst)dst=proj.tracks.find(x=>x.kind===tr.kind);
    if(!dst){ // 新编曲里没有该角色 → 直接追加一条原轨的延续
      dst=newTrack(tr.kind,tr.role);proj.tracks.push(dst);
    }
    const rows=patRows(dst);
    if(dst.pat.length<proj.steps)allocPat(dst,proj.steps,rows);
    const lim=Math.min(S,tr.pat.length,proj.steps);
    for(let s=0;s<lim;s++)for(let r=0;r<Math.min(rows,tr.pat[s]?tr.pat[s].length:0);r++)
      if(tr.pat[s][r]>0)dst.pat[s][r]=Math.max(dst.pat[s][r]||0,tr.pat[s][r]);
  });
}
