/* [theme.js] 主题切换：3 项 UI（深色 / 浅色 / 跟随系统）+ 6 套主题 CSS 全保留。
   来源与约定：
   · 只改 <html> 的 data-theme 与 localStorage.mpTheme，不做任何 DOM 重建；
   · mpTheme 取值：'studio'（深色）/ 'cream'（浅色）/ 'system'（跟随系统）；
     旧值 'midnight' / 'cyber' / 'sunrise' / 'forest' **原样生效**（用户没主动切就不动它），
     一旦用户点了 3 项中的任一项就被覆盖；
   · 跟随系统：读 prefers-color-scheme（深色 → studio，浅色 → cream），并监听变化实时切换；
   · 六套主题的 CSS 定义全部保留在 css/theme.css（含未在 UI 露出的四套），方便日后扩展。
   FEAT-V6/T4 配套：切主题时先给 <html> 加 .theme-transitioning（css/theme.css 里定义了
   `transition:none !important`）再改 data-theme，50ms 后移除 —— 避免过渡动画产生中间态重算；
   同时 css 侧已把 color-mix 全部静态化成预混 token（原 1.2 万网格格逐格混色 → 切主题同步重算 515ms）。 */

import { el } from '../core/util.js';

/* =========================================================================
   ↓↓↓ 临时诊断（FEAT-V6/T4-A：量化切主题耗时；验收后整段删除，不影响切换行为）
   读法：syncMs = 改完 data-theme 后立刻强制读计算样式+几何量（把重算/布局逼到同步段，阻塞主体）；
        f1Ms/f2Ms = 到下一帧/再下一帧的累计耗时；longtask = Chromium 阻塞任务（>50ms）。
   Console 手柄：__themeSet('cyber') 直接换主题；__themeMode('system'|'dark'|'light') 换模式并复测。
   ========================================================================= */
let _ltObs=null,_ltFrom=0,_ltOn=false;
function _ltStart(){
  if(_ltOn||typeof PerformanceObserver==='undefined')return;
  try{
    _ltObs=new PerformanceObserver((list)=>{
      if(!_ltOn)return;
      for(const e of list.getEntries())
        console.log('[theme-longtask]',{name:e.name,durMs:+e.duration.toFixed(1),startAgoMs:+(e.startTime-_ltFrom).toFixed(1)});
    });
    _ltObs.observe({entryTypes:['longtask']});
    _ltOn=true;
  }catch(e){}
}
function _ltStop(){ _ltOn=false }
function _now(){ return (typeof performance!=='undefined'&&performance.now)?performance.now():Date.now() }
let _lastTheme=(typeof document!=='undefined'&&document.documentElement.dataset.theme)||'studio';
let _trTimer=0,_pulseTimer=0;
/** 方案 A：切换期间冻结所有过渡（50ms 后自动解除，连点也不会堆积定时器） */
function _freezeTransitions(){
  const root=document.documentElement;
  root.classList.add('theme-transitioning');
  if(_trTimer)clearTimeout(_trTimer);
  _trTimer=setTimeout(()=>{ _trTimer=0; root.classList.remove('theme-transitioning') },50);
}
/** 动效（批 3 第 9 项）：切主题时给 <html> 加 .theme-pulse → body::after 走一次 300ms 亮度脉动。
    只加/减一个 class、只动一个元素的 opacity，不参与切换耗时统计（syncMs 在下一帧前后都已测完）。 */
function _pulse(){
  const root=document.documentElement;
  root.classList.remove('theme-pulse');
  void root.offsetWidth;                    // 强制回流一次：让同一 class 连点也能重启动画
  root.classList.add('theme-pulse');
  if(_pulseTimer)clearTimeout(_pulseTimer);
  _pulseTimer=setTimeout(()=>{ _pulseTimer=0; root.classList.remove('theme-pulse') },320);
}
function _applyTheme(name,where){
  const from=_lastTheme;
  _ltStart(); _ltFrom=_now();
  const t0=_now();
  _freezeTransitions();
  document.documentElement.dataset.theme=name;
  let syncMs=0;
  try{
    getComputedStyle(document.documentElement).getPropertyValue('--bg0');
    void document.documentElement.offsetHeight;
    syncMs=_now()-t0;
  }catch(e){}
  const nodes=(typeof document.getElementsByTagName==='function')?document.getElementsByTagName('*').length:0;
  _lastTheme=name;
  requestAnimationFrame(()=>{
    const f1=_now()-t0;
    requestAnimationFrame(()=>{
      const f2=_now()-t0;
      _ltStop();
      console.log('[theme]',{from:from,to:name,via:where||'menu',nodes:nodes,
        syncMs:+syncMs.toFixed(1),f1Ms:+f1.toFixed(1),f2Ms:+f2.toFixed(1),
        read:'syncMs=重算+布局（阻塞主体）/ f1Ms=下一帧 / f2Ms=再下一帧（含重绘）'});
      if(typeof window!=='undefined')window.__themeLast={from,to:name,nodes,syncMs,f1Ms:f1,f2Ms:f2};
      /* 动效（批 3 第 9 项）：亮度脉动放在两帧测量**之后**再启动 —— 它自己会强制一次回流（重启动画用），
         放在这里就绝不会混进 syncMs/f1Ms/f2Ms，主题切换耗时口径一个字都没变。 */
      _pulse();
    });
  });
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
/** 立即按当前模式应用主题并刷新菜单选中态（where 只用于日志） */
function _syncMenu(panel){
  if(!panel)return;
  for(const b of panel.children)b.classList.toggle('on',b.dataset.mode===mode);
}
function _apply(panel,where){
  const r=_resolve();
  mode=r.mode;
  _applyTheme(r.theme,where);
  _syncMenu(panel);
}
/** 设置模式：'dark' | 'light' | 'system'（写 localStorage 后立即生效） */
function setMode(m,panel,where){
  const hit=MODES.filter(x=>x.key===m)[0];
  if(!hit)return false;
  _store(hit.key==='system'?'system':hit.theme);
  _apply(panel,where||'menu');
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
    setMode(mi.dataset.mode,panel,'menu');
    panel.classList.remove('open');
  });
  document.addEventListener('click',()=>panel.classList.remove('open'));
  /* 跟随系统：系统深浅变化时实时跟随（只在 system 模式下生效） */
  const m=_mq();
  if(m){
    const onChange=()=>{ if(mode==='system')_apply(panel,'system-change') };
    try{ m.addEventListener('change',onChange) }catch(e){ try{ m.addListener(onChange) }catch(e2){} }
  }
  /* 进页面时按 mpTheme 解析一次（main.js 已按原始值设过 data-theme，这里修正 system 与旧值） */
  _apply(panel,'boot');
  if(typeof window!=='undefined'){
    window.__themeSet=(name)=>{ _store(String(name)); _apply(panel,'console'); };
    window.__themeMode=(m)=>{ if(!m)return {mode:mode,stored:_stored(),applied:_lastTheme,systemDark:!!(_mq()&&_mq().matches)}; return setMode(String(m),panel,'console-mode') };
  }
}
