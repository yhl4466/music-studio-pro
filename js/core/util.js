/* [util.js] source: Pro.html 815-850, 923-935, 1073-1088, 2789-2825, 4809-4813 (+ hooks 注册表) */
/* =========================================================================
   0a. 线性图标（FEAT-V6/T5 批 2 第二步：JS 侧不再拼 emoji，统一走 icon()）
   —— 图形本体在 css/layout.css：--ic-* 内联 SVG + .ico-* 的 mask-image；
      这里只产出结构，颜色由 currentColor 决定（跟随主题/状态色）。
      用法：el('button','btn',icon('save')+' 保存')、toast('已保存','ok','save')
   ========================================================================= */
export function icon(name){
  const n=String(name==null?'':name).replace(/[^a-zA-Z0-9-]/g,'');
  return '<span class="ico'+(n?' ico-'+n:'')+'" aria-hidden="true"></span>';
}
/* emoji → 图标名：只服务于"还没改用 icon() 的旧调用点"（toast 文案首字符）。
   本轮授权的 4 个文件已全部改为显式 icon()；这张表让 ai/audio/io 等未授权文件里的
   旧 toast 文案也不再出现 emoji —— toast() 是唯一收口点，转换集中在这一处。 */
const EMOJI_ICON={
  '🎼':'music','🎵':'music','🎶':'music','🎨':'palette','✨':'sparkle','💾':'save','📂':'folder',
  '🔗':'link','✅':'check','✓':'check','✗':'cross','⚠':'warn','🎬':'clapper','↩':'undo','↪':'redo',
  '📋':'copy','📌':'paste','🎯':'target','📍':'pin','🎧':'headphones','🔲':'marquee','♫':'quaver',
  '🥁':'drum','🎤':'mic','🎸':'guitar','🎹':'keys','🌈':'shuffle','🧹':'broom','🎲':'dice','🔥':'flame',
  '☀':'sun-dim','🧬':'dna','☕':'coffee','🔊':'speaker','🌆':'city','🎷':'sax','🌌':'galaxy','⚙':'gear',
  '🌙':'moon','🔁':'loop','◉':'metro','☰':'menu','▤':'panel','✕':'close','✎':'pencil','🗑':'trash'
};
/* 取出文案开头的 emoji（最多 2 个）→ 图标名数组；返回剩余文案 */
function _leadIcons(text){
  const GL=/^([\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{2190}-\u{21FF}])\u{FE0F}?[\s\u00A0]*/u;
  const names=[];let t=String(text);
  for(let i=0;i<2;i++){
    const m=GL.exec(t);if(!m)break;
    const nm=EMOJI_ICON[m[1]];if(!nm)break;          // 认不出来就原样保留，不猜
    names.push(nm);t=t.slice(m[0].length);
  }
  return {names,rest:t};
}
/* =========================================================================
   0b. 全局错误上报（便于定位问题，不干扰运行）
   ========================================================================= */
export function showErr(m){
  try{
    console.error('ERR',m);
    document.title='错误：'+m;
    let b=document.getElementById('errbar');
    if(!b){b=document.createElement('div');b.id='errbar';
      b.style.cssText='position:fixed;left:8px;bottom:8px;z-index:99999;background:#ff3355;color:#fff;font:600 12px ui-monospace,monospace;padding:8px 14px;border-radius:10px;max-width:72vw;box-shadow:0 6px 24px rgba(0,0,0,.5)';
      document.body.appendChild(b);}
    b.innerHTML=icon('warn');b.appendChild(document.createTextNode(String(m)));
  }catch(e){}
}
/* =========================================================================
   0. 通用工具
   ========================================================================= */
export const $  = s => document.querySelector(s);
export const $$ = s => Array.from(document.querySelectorAll(s));
export const clamp = (v,a,b)=>Math.max(a,Math.min(b,v));
export const ri = (a,b)=>Math.floor(Math.random()*(b-a+1))+a;
export const rf = (a,b)=>Math.random()*(b-a)+a;
export const pick = arr => arr[Math.floor(Math.random()*arr.length)];
export const chance = p => Math.random()<p;
export const lerp=(a,b,t)=>a+(b-a)*t;
export const debounce=(fn,ms)=>{let t;return(...a)=>{clearTimeout(t);t=setTimeout(()=>fn(...a),ms)}};

/* el(tag,cls,x)：x 为 string → innerHTML；x 为对象 → {style,text} */
export function el(tag,cls,html){const e=document.createElement(tag);if(cls)e.className=cls;
  if(html!=null){if(typeof html==='object'&&html!==null&&!html.nodeType){
    if(html.style)e.style.cssText+=(e.style.cssText?';':'')+html.style;
    if(html.text!=null)e.textContent=html.text;
  }else e.innerHTML=html}
  return e}
export function pad2(n){return n<10?'0'+n:''+n}

/* 确定性随机（种子）*/
export function mulberry32(a){return function(){a|=0;a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296}}
export function makeRng(seed){const r=mulberry32(seed>>>0);return{next:r,f:()=>r(),i:(a,b)=>Math.floor(r()*(b-a+1))+a,pick(arr){return arr[Math.floor(r()*arr.length)]},chance(p){return r()<p}}}

/* 简易 toast（kind: 'ok'|'err'；ic: 可选图标名，见 css/layout.css 的 --ic-*） */
export function toast(msg,kind,ic){
  const lead=_leadIcons(msg);
  const name=ic||lead.names[0]||'';
  const body=lead.rest.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const t=el('div','toast'+(kind?' '+kind:''),(name?icon(name):'')+body);
  $('#toasts').appendChild(t);
  setTimeout(()=>{t.style.transition='all .3s';t.style.opacity='0';t.style.transform='translateY(6px)';setTimeout(()=>t.remove(),320)},2600);
}

/* =========================================================================
   3. 全局引用
   ========================================================================= */
export const UI={};
export function grabUI(){
  UI.ruler=$('#ruler');UI.trackList=$('#trackList');UI.side=$('#side');UI.sideBody=$('#sideBody');
  UI.playBtn=$('#playBtn');UI.posMain=$('#posMain');UI.posSub=$('#posSub');
  UI.bpm=$('#bpm');UI.bpmNum=$('#bpmNum');UI.swing=$('#swing');UI.swingV=$('#swingV');
  UI.barsN=$('#barsN');UI.barsV=$('#barsV');UI.barPlus=$('#barPlus');UI.barMinus=$('#barMinus');UI.loopBtn=$('#loopBtn');
  UI.masterVol=$('#masterVol');UI.masterV=$('#masterV');
  UI.metroBtn=$('#metroBtn');UI.keyInfo=$('#keyInfo');UI.emptyTip=$('#emptyTip');
  UI.aiBtn=$('#aiBtn');UI.sideTabs=$$('.stab');UI.viz=$('#viz');
  UI.pKeys=$('#pKeys');UI.pianoOctV=$('#pianoOctV');
  UI.humanBtn=$('#humanBtn');UI.randPatchBtn=$('#randPatchBtn');UI.clearSelBtn=$('#clearSelBtn');
  UI.menuBtn=$('#menuBtn');UI.menu=$('#menu');UI.fileIn=$('#fileIn');UI.brandBtn=$('#brandBtn');
}

/* ---------- 导出进度提示（调度分块推进 + 渲染等待） ---------- */
let exportProgressEl=null;
export function exportProgressElEnsure(){
  if(exportProgressEl)return exportProgressEl;
  exportProgressEl=document.createElement('div');
  exportProgressEl.style.cssText='position:fixed;right:14px;bottom:14px;z-index:120;background:var(--card);border:1px solid var(--acc);border-radius:var(--r-sm);padding:10px 14px;width:210px;color:var(--txt);font:12px sans-serif;box-shadow:var(--shadow-2)';
  exportProgressEl.innerHTML='<div id="epTxt" style="margin-bottom:6px"></div><div style="height:6px;background:var(--ctl-bg2);border-radius:4px;overflow:hidden"><div id="epBar" style="height:100%;width:0%;border-radius:4px;background:var(--grad)"></div></div><div id="epPct" style="text-align:right;font:600 10px var(--mono);color:var(--acc);margin-top:4px"></div>';
  document.body.appendChild(exportProgressEl);
  return exportProgressEl;
}
export function exportProgressStart(text){
  try{
    const el=exportProgressElEnsure();
    const txt=el.querySelector('#epTxt');
    if(txt){
      const lead=_leadIcons(text);
      txt.innerHTML=lead.names.map(icon).join('')+
        lead.rest.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    }
    exportProgressSet(0);
  }catch(e){}
}
export function exportProgressSet(pct){
  try{
    const el=exportProgressElEnsure();
    const bar=el.querySelector('#epBar');
    if(bar)bar.style.width=clamp(pct,0,100)+'%';
    const pctEl=el.querySelector('#epPct');
    if(pctEl)pctEl.textContent=Math.round(clamp(pct,0,100))+'%';
  }catch(e){}
}
export function exportProgressStop(ok){
  try{
    if(exportProgressEl){
      exportProgressSet(100);
      const pctEl=exportProgressEl.querySelector('#epPct');
      if(pctEl)pctEl.innerHTML=icon(ok?'check':'cross')+(ok?'完成':'失败');
      const pe=exportProgressEl; // 捕获本次的进度条元素：后续导出可能已把 exportProgressEl 置空，回调里不能再解引用模块变量
      setTimeout(()=>{ if(!pe)return; pe.style.transition='opacity .3s'; pe.style.opacity='0'; setTimeout(()=>{ pe.remove(); if(exportProgressEl===pe)exportProgressEl=null; },320)},ok?400:900);
    }
  }catch(e){}
}

export function downloadBlob(blob,name){
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a');a.href=url;a.download=name;document.body.appendChild(a);a.click();
  setTimeout(()=>{URL.revokeObjectURL(url);a.remove()},400);
}

/* 跨模块晚绑定注册表：由 main.js 在 boot 前注入，用于打断 ui ↔ audio/io 的循环依赖 */
export const hooks={inspector:null,afterLoad:null,ui:null,undo:null,seek:null,toolbar:null};
export function setHooks(map){Object.assign(hooks,map||{})}
