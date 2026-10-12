/* [theme.js] 主题切换：3 项 UI（深色 / 浅色 / 跟随系统）+ 6 套主题 CSS 全保留。
   来源与约定：
   · 只改 <html> 的 data-theme 与 localStorage.mpTheme，不做任何 DOM 重建；
   · mpTheme 取值：'studio'（深色）/ 'cream'（浅色）/ 'system'（跟随系统）；
     旧值 'midnight' / 'cyber' / 'sunrise' / 'forest' **原样生效**（用户没主动切就不动它），
     一旦用户点了 3 项中的任一项就被覆盖；
   · 跟随系统：读 prefers-color-scheme（深色 → studio，浅色 → cream），并监听变化实时切换；
   · 六套主题的 CSS 定义全部保留在 css/theme.css（含未在 UI 露出的四套），方便日后扩展。
   性能约定：切主题只做「改 <html> 的 data-theme + 一个 300ms 的 opacity 脉动」，
   不再往整棵 DOM 上写 `transition:none !important`、也不再强制一次全页回流（原因见下方 _applyTheme 注释）。 */

import { el } from '../core/util.js';

/* =========================================================================
   Console 手柄（保留）：__themeSet('cyber') 直接换主题；__themeMode('system'|'dark'|'light') 换模式。
   FEAT-V6/T4-A 那套“切主题耗时量化”临时诊断（同步/两帧计时、长任务观察器、每次切换的耗时才打印、
   以及挂在 window 上的耗时快照）已在验收后整段删除，本文件不再向 Console 输出任何东西。
   ========================================================================= */
let _lastTheme=(typeof document!=='undefined'&&document.documentElement.dataset.theme)||'studio';
let _pulseTimer=0;
/* =========================================================================
   主题切换的两项耗时（实测，主页面 2.5 万元素 / 32 小节）：
   · 旧实现每次切换都加 `.theme-transitioning`（通配符 `transition:none!important`）再撤销 ——
     两趟整棵 DOM 的同步样式重算，330–450ms，纯观感收益，已整段删除（见 css/theme.css 注释）。
   · 旧实现 `_pulse()` 里有一句 `void root.offsetWidth` 用来"强制回流重启动画" ——
     在 2.5 万元素的页面上这一次强制布局本身就是 200–270ms。
     现在改成"先摘类、下一帧再加类"：同样能重启动画，但一次布局都不强制。
   ========================================================================= */
function _pulse(){
  const root=document.documentElement;
  root.classList.remove('theme-pulse');
  if(_pulseTimer){clearTimeout(_pulseTimer);_pulseTimer=0}
  requestAnimationFrame(()=>{
    root.classList.add('theme-pulse');
    _pulseTimer=setTimeout(()=>{_pulseTimer=0;root.classList.remove('theme-pulse')},320);
  });
}
function _applyTheme(name){
  document.documentElement.dataset.theme=name;
  _lastTheme=name;
  _pulse();
}

/* =========================================================================
   主题模式：dark(studio) / light(cream) / system(跟随系统) / legacy(旧值原样生效)
   ========================================================================= */
const MODES=[
  {key:'dark',   theme:'studio', icon:'🌙', label:'深色',     dot:'studio'},
  {key:'light',  theme:'cream',  icon:'☀️', label:'浅色',     dot:'cream'},
  {key:'system', theme:'system', icon:'⚙',  label:'跟随系统', dot:''}
];
const LEGACY=['midnight','cyber','sunrise','forest'];   // 旧值：CSS 保留、原样生效、不在 UI 露出
let mode='dark';

function _stored(){ try{ return String(localStorage.getItem('mpTheme')||'') }catch(e){ return '' } }
function _mq(){ try{ return (typeof window!=='undefined'&&window.matchMedia)?window.matchMedia('(prefers-color-scheme: dark)'):null }catch(e){ return null } }
/** 跟随系统：系统深色 → studio，系统浅色 → cream */
function _systemTheme(){ const m=_mq(); return (m&&m.matches)?'studio':'cream' }
/** 把 localStorage 的原始值解析成 {mode, theme} */
function _resolve(){
  const s=_stored();
  if(s==='system')return {mode:'system',theme:_systemTheme()};
  if(s==='studio')return {mode:'dark',theme:'studio'};
  if(s==='cream') return {mode:'light',theme:'cream'};
  if(s)return {mode:'legacy',theme:s};        // 旧值（midnight/cyber/…）原样生效
  return {mode:'dark',theme:'studio'};        // 默认深色
}
function _store(v){ try{ localStorage.setItem('mpTheme',v) }catch(e){} }
/** 立即按当前模式应用主题并刷新菜单选中态 */
function _syncMenu(panel){
  if(!panel)return;
  for(const b of panel.children)b.classList.toggle('on',b.dataset.mode===mode);
}
function _apply(panel){
  const r=_resolve();
  mode=r.mode;
  _applyTheme(r.theme);
  _syncMenu(panel);
}
/** 设置模式：'dark' | 'light' | 'system'（写 localStorage 后立即生效） */
function setMode(m,panel){
  const hit=MODES.filter(x=>x.key===m)[0];
  if(!hit)return false;
  _store(hit.key==='system'?'system':hit.theme);
  _apply(panel);
  return true;
}

export function bindTheme(){
  const wrap=document.getElementById('themeWrap'),btn=document.getElementById('themeBtn');
  if(!wrap||!btn)return;
  const panel=el('div','menu themePanel','');
  MODES.forEach((m)=>{
    const b=el('button','mi themeMi','<i class="tdot" data-k="'+m.dot+'"></i><i class="ic">'+m.icon+'</i><span>'+m.label+'</span>');
    b.dataset.mode=m.key;
    b.dataset.theme=m.theme;
    b.title=(m.key==='system')?'跟随系统的深色/浅色设置（系统切换时网页自动跟随）'
           :('固定使用'+(m.key==='dark'?'深色':'浅色')+'主题'+(LEGACY.length?('（原『午夜/赛博/日出/森林』四套仍保留在 CSS 里，可用 __themeSet 直接切换）'):''));
    if(m.key==='system'){                      // 系统项：色点用两套主题色拼一个渐变（不新增 CSS）
      const dot=b.querySelector('.tdot');
      if(dot)dot.style.background='linear-gradient(90deg,#18d1ff,#6a3fd0)';
    }
    panel.appendChild(b);
  });
  wrap.appendChild(panel);
  btn.addEventListener('click',e=>{e.stopPropagation();_syncMenu(panel);panel.classList.toggle('open')});
  panel.addEventListener('click',e=>{
    const mi=e.target.closest('.mi');if(!mi)return;e.stopPropagation();
    setMode(mi.dataset.mode,panel);
    panel.classList.remove('open');
  });
  document.addEventListener('click',()=>panel.classList.remove('open'));
  /* 跟随系统：系统深浅变化时实时跟随（只在 system 模式下生效） */
  const m=_mq();
  if(m){
    const onChange=()=>{ if(mode==='system')_apply(panel) };
    try{ m.addEventListener('change',onChange) }catch(e){ try{ m.addListener(onChange) }catch(e2){} }
  }
  /* 进页面时按 mpTheme 解析一次（main.js 已按原始值设过 data-theme，这里修正 system 与旧值） */
  _apply(panel);
  if(typeof window!=='undefined'){
    window.__themeSet=(name)=>{ _store(String(name)); _apply(panel); };
    window.__themeMode=(m)=>{ if(!m)return {mode:mode,stored:_stored(),applied:_lastTheme,systemDark:!!(_mq()&&_mq().matches)}; return setMode(String(m),panel) };
  }
}
