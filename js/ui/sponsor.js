/* [ui/sponsor.js] 「支持开发」入口（爱发电赞助）。
   设计要点（照 ui/vizlink.js 的既有模式，保持本模块自包含）：
   - 不改 toolbar.js、不加 actMenu 的 switch 分支：本模块自己在 #menu 里插一个 .mi 按钮并绑 click。
     插在「快捷键 & 说明」下方、用 .divider 与「清空全部音轨」隔开（那是危险操作，不该挨着赞助）。
   - **地址来自 <meta name="afdian-url">，留空则整个入口不出现** ——
     这样 fork 的人不会莫名其妙带上别人的赞助页（与 mp-api-base 那次教训一致：
     配置项要有明确的"未配置"语义，而不是硬编码一个别人的地址）。
   - 只用既有图标 --ic-coffee（"请我喝杯咖啡"），不新增图标资源、不写 emoji。
   - 外链一律 rel="noopener noreferrer" 且 target=_blank：
     避免目标页通过 window.opener 反向操作本页（赞助页是第三方，按不可信处理）。 */

import { toast, el, icon } from '../core/util.js';

let bound=false;

/* index.html 里留的占位符用户名。识别它并当作"未配置"，
   这样作者还没注册/还没换名字时，菜单里不会冒出一个点了打不开的按钮。 */
const PLACEHOLDER_NAME='your-name';

/** 读取爱发电主页地址；未配置（含仍是占位符）返回 '' */
export function readSponsorUrl(){
  try{
    const m=document.querySelector('meta[name="afdian-url"]');
    const c=String((m&&m.getAttribute('content'))||'').trim();
    if(!c)return '';
    /* 只接受 https 的 afdian.com 地址：防止误填本地路径/别的站点，
       也顺手挡掉 javascript: 这类协议（虽然只是给 window.open 用）。 */
    let u=null;
    try{ u=new URL(c) }catch(e){ return '' }          // 不是合法 URL 就当未配置
    if(u.protocol!=='https:')return '';
    if(!/(^|\.)afdian\.com$/i.test(u.hostname))return '';
    if(u.pathname==='/a/'+PLACEHOLDER_NAME)return '';  // 仍是占位符
    return c;
  }catch(e){ return '' }
}

/** 已配置赞助地址时为 true（供自检/其它 UI 判断用） */
export function hasSponsor(){ return !!readSponsorUrl() }

function openSponsor(){
  const url=readSponsorUrl();
  if(!url)return false;                       // 未配置：入口本就不该存在，静默失败
  try{
    /* noopener：新窗口拿不到 window.opener，防止第三方页面反向控制本页；
       noreferrer：不把本站地址带给对方（顺手减少 referrer 泄漏）。 */
    const w=window.open(url,'_blank','noopener,noreferrer');
    if(w)w.opener=null;                       // 双保险：某些浏览器忽略特性串里的 noopener
    return true;
  }catch(e){
    /* 弹窗被拦截等情况：退化为当前页跳转由用户自行决定，给出可复制的地址更稳妥 */
    return false;
  }
}

/** 在 #menu 里挂上「支持开发」入口；重复调用安全。未配置地址时什么都不做。 */
export function bindSponsor(){
  if(bound)return false;
  const menu=document.getElementById('menu');
  if(!menu){ console.warn('[sponsor] 未找到 #menu，跳过支持开发入口挂载'); return false }
  const url=readSponsorUrl();
  if(!url){
    /* 未配置：不插入任何 DOM。这是刻意的 —— 宁可没有入口，
       也不放一个点了没反应的按钮，或者指向别人赞助页的链接。 */
    return false;
  }
  /* 用项目标准的 icon() 生成 <span class="ico ico-coffee">，而不是手写 class ——
     .mi 里的图标有两套规则（.mi .ic 用 mask 简写带默认 --ic-dot；.ico 是基类），
     混用 class 会让优先级难以预测。icon() 是既有 API，走它就与其它图标一致。 */
  const btn=el('button','mi',icon('coffee')+'支持开发<small>请我喝杯咖啡</small>');
  btn.id='sponsorBtn';
  btn.type='button';
  btn.title='喜欢这个项目？可以请作者喝杯咖啡（在新标签页打开爱发电）';
  btn.addEventListener('click',e=>{
    e.preventDefault();
    e.stopPropagation();                      // 不要冒泡给 #menu，避免被 actMenu 当成未知 data-act
    if(!openSponsor())toast('没能打开赞助页，可能是浏览器拦截了新标签页','warn');
  });
  /* 插在「快捷键 & 说明」之后，并加分隔线与「清空全部音轨」隔开。
     用 help 按钮定位而不是写死索引 —— 菜单中间以后可能再加条目。 */
  const help=menu.querySelector('[data-act="help"]');
  const div=el('div','divider');
  div.style.margin='4px 0';
  if(help&&help.nextSibling){
    menu.insertBefore(div,help.nextSibling);
    menu.insertBefore(btn,div.nextSibling);
  }else{
    /* 兜底：菜单结构变了就追加到末尾（宁可位置不理想，也不要静默不出现） */
    menu.appendChild(div);
    menu.appendChild(btn);
  }
  bound=true;
  return true;
}
