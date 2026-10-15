/* [io/siteUrl.js] 对外可访问的站点地址解析
   =========================================================================
   为什么需要它：分享卡片上的二维码/链接必须是**别人点得开**的地址。
   而在本地起服务时 location.origin 是 http://localhost:8123 —— 印出来只有本机能打开，
   别的设备扫了必然打不开（实测用户反馈的致命问题）。
   解析优先级（从「明确知道」到「合理猜测」）：
     ① localStorage 里用户手填的地址（mpSiteUrl）—— 自建部署的人用这个纠正；
     ② <meta name="mp-share-base"> —— 部署方可写在 HTML 里；
     ③ <link rel="canonical"> —— 标准做法，顺带兼容；
     ④ 当前 location（**仅当它不是 localhost/127.0.0.1/::1 时**）；
     ⑤ 兜底 = 本仓库的正式部署地址（README 里公示的那个）。
   ④⑤ 的顺序是关键：在 localhost 上开发时直接跳到 ⑤，
   这样"本地打开 → 生成分享卡片"也会印出可用的公网地址，而不是自欺欺人的 localhost。
   ========================================================================= */

export const LS_SITE_KEY='mpSiteUrl';
export const FALLBACK_SITE='https://yhl4466.github.io/music-studio-pro/';

/** 本机地址（这些 origin 上的链接发给别人一定打不开） */
export function isLocalHost(host){
  const h=String(host||'').toLowerCase().replace(/^\[|\]$/g,'');
  return h==='localhost'||h==='::1'||h==='0.0.0.0'||
    /^127\./.test(h)||/^10\./.test(h)||/^192\.168\./.test(h)||/^172\.(1[6-9]|2\d|3[01])\./.test(h);
}
function normalize(u){
  const s=String(u==null?'':u).trim();
  if(!s)return '';
  /* 已带协议头的一律先验协议，只有 http/https 放行 —— 否则 "ftp://x/" 会被当成
     没有协议的裸域名，拼成 "https://ftp//x/" 悄悄接受（实测踩过）。 */
  if(/^[a-z][a-z0-9+.-]*:/i.test(s)){
    let x=null;
    try{ x=new URL(s) }catch(e){ return '' }
    if(x.protocol!=='http:'&&x.protocol!=='https:')return '';
    return x.href;
  }
  // 没写协议的当裸域名处理，补 https
  try{
    const x=new URL('https://'+s.replace(/^\/+/,''));
    if(x.protocol!=='http:'&&x.protocol!=='https:')return '';
    if(!x.hostname)return '';
    return x.href;
  }catch(e){ return '' }
}
function metaContent(name){
  try{
    const m=document.querySelector('meta[name="'+name+'"]')||document.querySelector('link[rel="'+name+'"]');
    return m?(m.getAttribute('content')||m.getAttribute('href')||''):'';
  }catch(e){ return '' }
}
export function readSiteOverride(){
  try{ return localStorage.getItem(LS_SITE_KEY)||'' }catch(e){ return '' }
}
export function writeSiteOverride(u){
  try{
    if(u==null||u==='')localStorage.removeItem(LS_SITE_KEY);
    else localStorage.setItem(LS_SITE_KEY,String(u));
    return true;
  }catch(e){ return false }
}
/**
 * 解析「对外站点基址」（以 / 结尾），用于拼分享链接与二维码。
 * @returns {{url:string,from:string,local:boolean}}
 *   from：'override'|'meta'|'canonical'|'location'|'fallback'
 *   local：解析结果是否仍是本机地址（true = 别人打不开，UI 应给出警告）
 */
export function resolveSiteBase(){
  const ov=normalize(readSiteOverride());
  if(ov)return {url:ensureDir(ov),from:'override',local:false};
  const mt=normalize(metaContent('mp-share-base'));
  if(mt)return {url:ensureDir(mt),from:'meta',local:false};
  const cn=normalize((()=>{try{return (document.querySelector('link[rel="canonical"]')||{}).href||''}catch(e){return ''}})());
  if(cn)return {url:ensureDir(cn),from:'canonical',local:false};
  try{
    if(typeof location!=='undefined'&&location.origin&&!isLocalHost(location.hostname)){
      return {url:ensureDir(location.origin+location.pathname),from:'location',local:false};
    }
  }catch(e){}
  return {url:FALLBACK_SITE,from:'fallback',local:false};
}
function ensureDir(u){
  const s=String(u||'');
  return s.endsWith('/')?s:(s+'/');
}
/** 可视化页的对外地址 —— ⚠ 当前**没有任何调用者**（保留仅为可能的"直接分享可视化页"需求）。
    分享链接一律走 buildShareUrl()，它指向 SHARE_PAGE（主界面 index.html）。 */
export function publicVisualizerUrl(){
  const b=resolveSiteBase();
  return b.url+'visualizer.html';
}
/**
 * 生成分享链接（基址 = 对外可访问地址，**不是** location.href）。
 * 这是关键修复：原来 shareLink 用 location.href 拼，在 localhost 上分享出去的链接别人打不开。
 *
 * 指向哪个页面（用户要求）：**index.html（主界面）**，而不是之前的 visualizer.html。
 * 理由：拿到链接/扫码的人先看到完整编辑器，可以改谱子、继续创作；
 *       可视化只是主界面菜单里的一个功能（`goVisualizer()` 会把工程移交过去）。
 * 改动带来的连锁影响（已一并处理，改回去时注意）：
 *   ① 二维码容量：visualizer.html(15 字符) → index.html(10 字符)，链接反而更短，更容易塞进一张码；
 *   ② 主界面必须能处理 #p= 短链 —— `loadShareFromHash()` 已支持（会把数据取回并应用）；
 *   ③ 可视化页自己生成的分享卡片现在也指向主界面，卡片与二维码语义一致。
 * @param {string} hash 形如 '#z=xxxx'（含前缀 #）；为空则返回不带 hash 的基址
 */
export const SHARE_PAGE='index.html';   // 分享链接指向的页面（集中一处，便于以后调整）
export function buildShareUrl(hash){
  const b=resolveSiteBase();
  const h=String(hash||'');
  return b.url+SHARE_PAGE+(h?(h.charAt(0)==='#'?h:('#'+h)):'');
}
/** 面向用户的来源说明（设置面板里显示"当前用的是哪个地址"） */
export function siteSourceLabel(from){
  switch(from){
    case 'override':return '你手动设置';
    case 'meta':return '页面 meta 声明';
    case 'canonical':return '页面 canonical 声明';
    case 'location':return '当前访问地址';
    default:return '默认线上地址';
  }
}
