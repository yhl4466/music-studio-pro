/* [ui/vizlink.js] 主应用 → 可视化页 的入口（V1 子任务 7）。
   设计要点：
   - 不改 toolbar.js、不改 actMenu 的 switch：本模块直接在 #menu 末尾 append 一个 .mi 按钮，
     并自行绑定 click（事件冒泡到 #menu 后 actMenu 不认识 data-act="visualize"，是 no-op，互不干扰）。
   - 移交方式：serializeProject() → 自校验 → localStorage['vizProject'] → 跳转 ./visualizer.html。
     只写 viz 专用 key，不触碰主应用存档 key 'musicProducerPro.v1'。
   - 自校验只读一份 JSON 副本，不调用 applyProjectData（那会改动主应用全局 proj）。 */
import { serializeProject } from '../io/project.js';
import { toast, el } from '../core/util.js';

export const VIZ_KEY='vizProject';
const MAX_BYTES=4*1024*1024;                 // localStorage 单键通常 5MB 上限，留出余量

let bound=false;

/** 只读校验：确认是主应用导出的 v6 工程载荷（不改任何全局状态） */
export function validateVizPayload(json){
  if(typeof json!=='string'||!json.trim())return {ok:false,reason:'工程序列化为空'};
  let data=null;
  try{ data=JSON.parse(json) }catch(e){ return {ok:false,reason:'工程 JSON 解析失败：'+(e&&e.message||e)} }
  if(!data||typeof data!=='object'||Array.isArray(data))return {ok:false,reason:'工程载荷不是对象'};
  if(data.ver==null)return {ok:false,reason:'工程缺少 ver 字段'};
  if(!Number.isFinite(Number(data.steps))||Number(data.steps)<=0)return {ok:false,reason:'工程缺少有效的 steps'};
  if(!Array.isArray(data.tracks))return {ok:false,reason:'工程缺少 tracks 数组'};
  if(!data.tracks.length)return {ok:false,reason:'工程里还没有音轨，先添加或让 AI 生成'};
  return {ok:true,steps:Number(data.steps),tracks:data.tracks.length,ver:data.ver};
}

/* 跨页面过渡（FEAT-V6/T5 批 C 第一部分）：
   · Chromium 126+ 对同源跨文档导航会自动做过渡（css/theme.css 里的 @view-transition{navigation:auto}）；
   · 这里再包一层 startViewTransition，是为了同文档跳转/较旧实现也能受益，且**必须优雅降级**：
     没有这个 API 时直接 location.href —— 功能一样，只是没有过渡动画。 */
export function navigateWithTransition(url){
  try{
    if(typeof document!=='undefined'&&typeof document.startViewTransition==='function'){
      document.startViewTransition(()=>{ location.href=url });
      return true;
    }
  }catch(e){}
  location.href=url;
  return false;
}

function goVisualizer(){
  const json=serializeProject();
  const v=validateVizPayload(json);
  if(!v.ok){ toast('无法打开可视化：'+v.reason,'err'); return false }
  if(json.length>MAX_BYTES){ toast('工程过大（约 '+Math.round(json.length/1048576)+'MB），无法移交到可视化页','err'); return false }
  try{
    localStorage.setItem(VIZ_KEY,json);
  }catch(e){
    toast('浏览器存储写入失败：'+((e&&e.message)||'空间不足'),'err');
    return false;
  }
  toast('已移交工程（'+v.steps+' 步 · '+v.tracks+' 轨）→ 正在打开可视化页','ok');
  navigateWithTransition('./visualizer.html');
  return true;
}

/** 在 #menu 里挂上「📊 可视化」入口；重复调用安全 */
export function bindVizLink(){
  if(bound)return true;
  let menu=null;
  try{ menu=document.getElementById('menu') }catch(e){}
  if(!menu){ console.warn('[vizlink] 未找到 #menu，跳过可视化入口挂载'); return false }

  const btn=el('button','mi','<span class="ic">📊</span>可视化<small>新页面</small>');
  btn.dataset.act='visualize';
  btn.title='在独立页面里播放并观察波形 / 频谱（会把当前工程复制到可视化页）';
  btn.addEventListener('click',e=>{ e.preventDefault(); goVisualizer() });
  menu.appendChild(btn);
  bound=true;
  return true;
}
