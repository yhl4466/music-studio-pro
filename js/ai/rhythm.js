/* [rhythm.js] source: Pro.html 3923-4038, 4281-4294（鼓组 / 贝斯 / 力度人性化） */
import { proj, patRows } from '../core/state.js';
import { clamp } from '../core/util.js';
import { KIT } from '../core/theory.js';
import { barDyn } from './styles.js';

/* ---------- 鼓组（按段落变化密度与加花） ---------- */
export function fillDrums(t,rng,style,chords,secs,E,C){
  const S=proj.steps,rows=KIT.length;
  for(let s=0;s<S;s++)for(let r=0;r<rows;r++)t.pat[s][r]=0;
  const K=0,SN=1,CL=2,HC=3,HO=4,TM=5,RM=6,CR=7;
  const B=secs.length,tpl=style.drumTpl;
  const four=(tpl==='fourfloor'||tpl==='cinema');
  const soft=(tpl==='soft');
  for(let b=0;b<B;b++){
    const raw=secs[b]; const sec=raw==='all'?'build':raw;
    const D=barDyn(sec,E,C),bs=b*16,lastB=(b===B-1);
    const leadOut=(sec!=='outro'&&secs[Math.min(B-1,b+1)]==='outro');
    for(let i=0;i<16;i++){
      const s=bs+i,inBar=i;
      let kick=false,sn=false;
      if(sec==='intro'){
        // 引子也有明确"音乐"：轻底鼓每两拍 + 软军鼓点缀，避免只剩和弦
        kick=inBar===0||(inBar===8&&rng.chance(.85))||(inBar===12&&rng.chance(.3));
        sn=(inBar===4&&rng.chance(.8))||(inBar===12&&rng.chance(.35));
      }else if(sec==='outro'){
        kick=inBar===0||(inBar===8&&rng.chance(.5))||(lastB&&inBar===14&&rng.chance(.25));
        sn=false;
      }else if(sec==='build'){
        kick=(inBar%4===0)||(four&&inBar%4===2&&rng.chance(.2));
        sn=(inBar%8===4)&&rng.chance(.95);
      }else{ // climax / all
        kick=four?inBar%4===0:(inBar===0||inBar===8||(inBar%4===2&&rng.chance(.55)));
        sn=inBar%8===4;
      }
      if(soft&&sec!=='climax'){kick=inBar===0||(inBar===8&&rng.chance(.8));sn=(inBar%8===4)&&rng.chance(.8)}
      const vel=D.v*(sec==='intro'?.66:(sec==='outro'?.72:1)); // 引子/尾声整体更轻但可闻
      if(kick&&D.e>.15)t.pat[s][K]=clamp((rng.chance(.2)?1:.9)*vel,.1,1);
      if(sn){
        if((four||tpl==='straight')&&sec!=='intro'&&sec!=='outro')t.pat[s][CL]=clamp(.82*vel,.1,1);
        else t.pat[s][SN]=clamp(.9*vel,.1,1);
      }
      // 边击/踩镲
      if(sec==='intro'||sec==='outro'){
        if(sec==='intro'){
          // 引子：反拍踩镲（八分），比之前更密一些
          if(inBar%2===1&&rng.chance(.75))t.pat[s][HC]=clamp(.38*vel,.06,1);
        }else{
          if(inBar%4===2&&rng.chance(.6))t.pat[s][HC]=clamp(.4*vel,.06,1);
          if(inBar===4||inBar===12){t.pat[s][RM]=clamp(.55*vel,.08,1);t.pat[s][SN]=0}
        }
      }else{
        const hGap=(sec==='climax'?1:2);
        if(inBar%hGap===0&&!t.pat[s][K]&&!t.pat[s][SN]&&!t.pat[s][CL]&&rng.chance(.92)){
          t.pat[s][HC]=clamp((inBar%4===0?.58:.42)*vel,.08,1);
        }
        if(sec==='climax'&&inBar%2===1&&rng.chance(.4))t.pat[s][HC]=.3;
        if((sec==='build'||sec==='climax')&&inBar%8===6&&rng.chance(.6*D.e))t.pat[s][HO]=.48;
      }
      // 段首镲、句尾过门、曲尾收束镲（轻柔）
      if(inBar===0&&(b===0||(sec==='climax'&&(b===0||secs[b-1]!=='climax'))||leadOut||(lastB&&sec==='outro')))
        t.pat[s][CR]=lastB&&sec==='outro'?clamp(.55*D.v,.1,1):.85;
      const fillZone=(sec==='climax'||sec==='build')&&C>.3&&(inBar>=11);
      if(fillZone&&(b%4===3||leadOut||(sec==='climax'&&b===B-2))){
        if(inBar%2===0&&rng.chance(.7))t.pat[s][TM]=clamp(.66*vel,.1,1);
        if(inBar===13&&rng.chance(.8))t.pat[s][SN]=.5;
        if(inBar===14&&rng.chance(.8))t.pat[s][K]=.98;
      }
    }
  }
}
/* ---------- 贝斯（按段落选择律动） ---------- */
export function fillBass(t,rng,chords,secs,style,E,C){
  const S=proj.steps;const B=secs.length;
  for(let s=0;s<S;s++)for(let r=0;r<patRows(t);r++)t.pat[s][r]=0;
  const tpl=style.bassTpl;
  for(let b=0;b<B;b++){
    const raw=secs[b],sec=raw==='all'?'build':raw;
    const D=barDyn(sec,E,C),ch=chords[b],rr=ch.root,bs=b*16;
    if(sec==='intro'){
      // 引子贝斯：根音在 1、3 拍（第 3 拍弱），偶尔五度/附点，托起音乐的"骨架"
      const hits=[[0,.9],[8,.55]];
      if(rng.chance(.45))hits.push([12,.45]);
      if(rng.chance(.35))hits.push([6,.4]);
      hits.forEach(h=>{t.pat[bs+h[0]][rr]=clamp(h[1]*D.v,.1,1)});
      continue;
    }
    if(sec==='outro'){
      if(b===B-1){ // 曲尾：根音长音托底，柔和不突兀
        const v=clamp(.5*D.v,.1,1);
        for(let s=0;s<15;s++)t.pat[bs+s][rr]=v;
      }else{
        const hits=[[0,.85],[8,.6]];
        hits.forEach(h=>{t.pat[bs+h[0]][rr]=clamp(h[1]*D.v,.1,1)});
      }
      continue;
    }
    const clim=(sec==='climax');
    if(tpl==='walk'){
      let last=rr;
      for(let i=0;i<8;i++){
        const s=bs+i*2;
        const target=(i%2===0)?rr:Math.min(13,rr+ (clim&&i%2?4:2));
        let row=last;
        if(target>last)row=Math.min(13,last+1);else if(target<last)row=Math.max(0,last-1);
        if(rng.chance(.3))row=target;
        if(i===7)row=rr;
        last=row;
        t.pat[s][row]=clamp((i%2===0?.92:.66)*D.v,.1,1);
      }
    }else{
      // 统一走八分音符律动，高潮只做八度跳进/五度点缀，避免挤满十六分
      for(let i=0;i<8;i++){
        const s=bs+i*2;
        const octJump=clim&&(i===2||i===4||i===6)&&rng.chance(.55);
        let row=octJump?Math.min(13,rr+7):rr;
        if(!clim&&rng.chance(.25)&&rr+4<=13)row=rr+4;
        t.pat[s][row]=clamp((i%2===0?.9:.62)*D.v,.1,1);
      }
    }
  }
}
/* ---------- 组织编曲（新版） ---------- */
export function aiHumanizeVel(tracks,rng,amt){
  tracks.forEach(t=>{
    const rows=patRows(t);
    for(let s=0;s<proj.steps;s++)for(let r=0;r<rows;r++){
      const v=t.pat[s][r];
      if(v>0){
        let nv=v*(1+(rng.f()*2-1)*amt); // 力度微差
        if(rng.chance(.03))nv*=.45;      // 偶尔"弱触键"点缀
        t.pat[s][r]=clamp(nv,.05,1);
      }
    }
  });
}
