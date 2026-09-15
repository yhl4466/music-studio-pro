/* [main.js] 入口：只做编排——import / 顶层错误监听 / hooks 注入 / boot()；不含业务逻辑定义 */
import { showErr, toast, grabUI, hooks } from './core/util.js';
import { proj, setProj, demoProject } from './core/state.js';
import { bindTheme } from './ui/theme.js';
import { vizLoop } from './ui/viz.js';
import { renderPiano } from './ui/piano.js';
import { visLoop } from './ui/seek.js';
import { bindTopControls, bindExtras, syncAllUI, buildKeyBar, syncBpmUI, afterProjectLoad, showHelp } from './ui/toolbar.js';
import { setTab, renderInspector } from './ui/sidebar.js';
import { structural, paintAll, relabelRows } from './ui/timeline.js';
import { beginEdit, commitEdit, refreshUndoUI, markDirtyUI, loadAutosave } from './io/project.js';
import { loadShareFromHash } from './io/share.js';
import { bindVizLink } from './ui/vizlink.js';

/* 顶层错误上报（原 index.html 顶层） */
window.addEventListener('error',e=>showErr(e.message||'未知错误'));
window.addEventListener('unhandledrejection',e=>{const r=e.reason;showErr('Promise: '+(r&&r.message?r.message:String(r)))});

/* hooks 注入：反向依赖槽（hooks.seek / hooks.toolbar 由对应 ui 模块顶层自注册） */
hooks.inspector={render:renderInspector,selectTab:setTab};        // timeline → sidebar
hooks.ui={structural,paintAll,buildKeyBar,syncBpmUI,markDirtyUI}; // ai / io/midi → timeline
hooks.undo={beginEdit,commitEdit};                               // ai → io/project
hooks.afterLoad=afterProjectLoad;                                // io/project → ui（实现在 ui/toolbar.js）

async function boot(){
  /* a) 读取上次选择的主题（缺省 studio） */
  let th='studio';
  try{th=localStorage.getItem('mpTheme')||'studio'}catch(e){}
  document.documentElement.dataset.theme=th;
  grabUI();
  bindTopControls();
  bindTheme();
  bindExtras();
  bindVizLink();
  renderPiano();
  const demo=(location.hash==='#demo'); // #demo：跳过存档/分享链接，强制载入示例工程
  let had=false,shared=false;
  if(demo){setProj(demoProject());proj.steps=32;had=true}
  else{
    try{shared=await loadShareFromHash()}catch(e){}
    if(shared){had=true}
    else had=loadAutosave();
    if(!had){setProj(demoProject());proj.steps=32}
  }
  syncAllUI();
  structural(true);
  relabelRows(); // 行名刷新：原版漏调用 relabelRows，首次 boot 后左侧音名可能残留旧调式
  renderInspector();
  visLoop();
  vizLoop();
  refreshUndoUI();
  if(demo){toast('🎬 已载入示例工程','ok')}
  else if(shared){toast('🔗 已载入分享链接中的工程','ok')}
  else if(!had){toast('欢迎！点右侧「✨ AI 一键成曲」立刻生成一首歌','ok')}
  else toast('已载入上次的工程','ok');
  // 首次使用：自动弹出图文教程（之后不再打扰，可随时从菜单重看）
  if(!had){
    let shown=false;
    try{shown=!!localStorage.getItem('mpIntroShown')}catch(e){}
    if(!shown){
      try{localStorage.setItem('mpIntroShown','1')}catch(e){}
      setTimeout(()=>{try{showHelp()}catch(e){}},700);
    }
  }
}

boot();
