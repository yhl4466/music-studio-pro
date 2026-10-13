/* [io/shortlink.js] 分享短链后端客户端（Cloudflare Worker + KV，见 server/）
   =========================================================================
   为什么需要：分享卡片那个二维码容量只有 213 字节（QR v10-M），而压缩后的工程
   数据最小 259 字节、真实作品 1.5–6 KB —— 单张二维码在原理上装不下。
   把数据存到后端换一个 8 位短 ID 后，链接只有约 60 字节，**一张普通二维码就够**，
   不需要任何大码制、也不用多张拼接。

   后端地址解析优先级：
     ① localStorage.mpApiBase（用户在可视化页设置里手填，最方便）
     ② <meta name="mp-api-base">（自建部署写死在 HTML 里）
     ③ 都没有 → 功能**自动禁用**，UI 给出明确提示，其余功能完全不受影响
   这条"没配后端就优雅降级"是刻意的：本轮之前本项目是纯前端，
   fork 出去没有后端的人不应该因此看到一堆报错。

   协议（与 server/worker.js 一一对应，改一边要改另一边）：
     POST {base}/api/p        body = '#z=…' → 201 {id,url,bytes}
     GET  {base}/api/p/{id}                → 200 {data} ／ 404 {error:'not_found'}
     GET  {base}/api/health                → 200 {ok,kv}
   ========================================================================= */

export const LS_API_KEY='mpApiBase';
export const SHORT_ID_RE=/^[a-z0-9]{4,32}$/i;
const TIMEOUT_MS=15000;

export function readApiBase(){
  try{
    const v=localStorage.getItem(LS_API_KEY);
    if(v&&String(v).trim())return normalizeBase(v);
  }catch(e){}
  try{
    const m=document.querySelector('meta[name="mp-api-base"]');
    const c=m&&(m.getAttribute('content')||'');
    if(c&&String(c).trim())return normalizeBase(c);
  }catch(e){}
  return '';
}
export function writeApiBase(u){
  try{
    const v=String(u==null?'':u).trim();
    if(!v)localStorage.removeItem(LS_API_KEY);
    else localStorage.setItem(LS_API_KEY,v);
    return true;
  }catch(e){ return false }
}
function normalizeBase(u){
  let s=String(u||'').trim();
  if(!s)return '';
  if(!/^https?:\/\//i.test(s))s='https://'+s.replace(/^\/+/,'');
  try{
    const x=new URL(s);
    if(x.protocol!=='http:'&&x.protocol!=='https:')return '';
    return x.origin+x.pathname.replace(/\/+$/,'');
  }catch(e){ return '' }
}
/** 后端是否已配置（没配就禁用短链功能，而不是让用户点了报错） */
export function hasApi(){ return !!readApiBase() }

function withTimeout(ms){
  const ctl=(typeof AbortController!=='undefined')?new AbortController():null;
  const t=setTimeout(()=>{ try{ ctl&&ctl.abort() }catch(e){} },ms);
  return {signal:ctl?ctl.signal:undefined,done:()=>clearTimeout(t)};
}
/** 把可读的失败原因翻成用户能看懂的一句话 */
export function friendlyError(e){
  const m=String((e&&e.message)||e||'');
  if(/Failed to fetch|NetworkError|aborted|timeout/i.test(m))return '连不上后端（检查网络或后端地址）';
  return m||'未知错误';
}

/**
 * 上传工程数据，换回短 ID。
 * @param {string} payload 形如 '#z=xxxx' 的分享载荷
 * @returns {Promise<{ok:true,id:string,url:string,bytes:number}|{ok:false,reason:string,message:string}>}
 */
export async function createShortLink(payload){
  const base=readApiBase();
  if(!base)return {ok:false,reason:'no-api',message:'未配置后端地址，短链不可用（可在可视化页「设置 → 分享地址」下方填写）'};
  const data=String(payload||'').trim();
  if(!data)return {ok:false,reason:'empty',message:'没有可上传的工程数据'};
  if(!/^#[szl]=/.test(data))return {ok:false,reason:'bad-format',message:'工程数据格式不对（应为 #s= / #z= / #l= 开头）'};
  const {signal,done}=withTimeout(TIMEOUT_MS);
  try{
    const r=await fetch(base+'/api/p',{
      method:'POST',
      headers:{'Content-Type':'text/plain;charset=utf-8'},   // 纯文本，后端不解析 JSON，省一层
      body:data,
      signal,
    });
    const j=await r.json().catch(()=>({}));
    if(!r.ok)return {ok:false,reason:j.error||('http-'+r.status),message:j.message||('后端返回 '+r.status)};
    if(!j.id||!SHORT_ID_RE.test(j.id))return {ok:false,reason:'bad-response',message:'后端返回的短 ID 不合法'};
    return {ok:true,id:j.id,url:'#p='+j.id,bytes:j.bytes||data.length};
  }catch(e){
    return {ok:false,reason:'network',message:friendlyError(e)};
  }finally{ done() }
}

/**
 * 按短 ID 取回工程数据。
 * @returns {Promise<{ok:true,data:string}|{ok:false,reason:string,message:string}>}
 */
export async function fetchShortLink(id){
  const base=readApiBase();
  if(!base)return {ok:false,reason:'no-api',message:'未配置后端地址，无法打开短链'};
  const key=String(id||'').trim().toLowerCase();
  if(!SHORT_ID_RE.test(key))return {ok:false,reason:'bad-id',message:'短链 ID 格式不对'};
  const {signal,done}=withTimeout(TIMEOUT_MS);
  try{
    const r=await fetch(base+'/api/p/'+encodeURIComponent(key),{signal});
    const j=await r.json().catch(()=>({}));
    if(r.status===404)return {ok:false,reason:'not_found',message:'链接不存在或已过期'};
    if(!r.ok)return {ok:false,reason:j.error||('http-'+r.status),message:j.message||('后端返回 '+r.status)};
    if(typeof j.data!=='string'||!j.data)return {ok:false,reason:'bad-response',message:'后端没有返回数据'};
    return {ok:true,data:j.data};
  }catch(e){
    return {ok:false,reason:'network',message:friendlyError(e)};
  }finally{ done() }
}
/** 健康检查：设置页用它告诉用户"后端到底通没通" */
export async function checkApi(){
  const base=readApiBase();
  if(!base)return {ok:false,reason:'no-api',message:'未配置后端地址'};
  const {signal,done}=withTimeout(8000);
  try{
    const r=await fetch(base+'/api/health',{signal});
    const j=await r.json().catch(()=>({}));
    if(!r.ok)return {ok:false,reason:'http-'+r.status,message:'后端返回 '+r.status};
    if(!j.kv)return {ok:false,reason:'kv',message:'后端已部署但未绑定 KV（服务端配置不全）'};
    return {ok:true,message:'后端正常'};
  }catch(e){
    return {ok:false,reason:'network',message:friendlyError(e)};
  }finally{ done() }
}
/** 从 URL hash 里取出短链 ID（#p=xxxxxxxx）；不是短链返回 '' */
export function shortIdFromHash(hash){
  const h=String(hash||'');
  const m=h.match(/^#p=([a-z0-9]{4,32})$/i);
  return m?m[1].toLowerCase():'';
}
