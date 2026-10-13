/* 智能音乐工坊 PRO · 分享短链后端（Cloudflare Worker + KV）
   =========================================================================
   作用：把整份工程数据存进 KV，换回一个 8 位短 ID。
   于是二维码里只需要放 .../visualizer.html#p=<id>（约 60 字节），
   **一张普通二维码就装得下** —— 不再需要 PDF417 之类的大码制，也不用多张拼接。

   接口（全部 JSON）：
     POST /api/p         body = 工程分享载荷（就是 #z=/#l=/#s= 后面那串）
                         → 201 {id, url, bytes}
     GET  /api/p/:id     → 200 {data} ／ 404 {error:'not_found'}
     GET  /api/health    → 200 {ok:true, kv:true|false}

   设计取舍（都是有意的，改之前先读）：
     · **只存压缩后的那串字符**，不解析、不重建工程 —— 后端不需要懂音乐格式，
       将来前端换编码方式（#z=/#l=/#c=…）后端一行都不用改。
     · 数据是**不可变**的：同一个 id 不会被覆盖，所以不需要鉴权/账号体系。
       随机 id 就是唯一的"权限"，猜到别人 id 的概率极低（8 位 base36 ≈ 2.8e12）。
     · TTL 180 天：分享链接不该永久占用存储；过期后前端会明确报"链接已过期"。
     · 限流按 IP 计数（KV 计数窗口 1 小时），防止被当成免费图床刷。
     · 允许任意 Origin（CORS `*`）—— 这是公开分享服务，没有凭据、没有 cookie，
       收窄 Origin 反而会让 fork 出去的自建前端用不了。
   ========================================================================= */

const TTL_SECONDS=180*24*60*60;      // 180 天
const MAX_BYTES=512*1024;            // 单份上限：正常分享链接 1–20 KB，512KB 足够且能挡滥用
const ID_LEN=8;
const RATE_LIMIT_PER_HOUR=60;        // 每 IP 每小时最多创建多少个短链
const ID_CHARS='abcdefghijklmnopqrstuvwxyz0123456789';

function cors(){
  return {
    'Access-Control-Allow-Origin':'*',
    'Access-Control-Allow-Methods':'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers':'Content-Type',
    'Access-Control-Max-Age':'86400',
  };
}
function json(body,status,extra){
  return new Response(JSON.stringify(body),{
    status:status||200,
    headers:Object.assign({'Content-Type':'application/json;charset=utf-8','Cache-Control':'no-store'},cors(),extra||{}),
  });
}
function newId(){
  const b=new Uint8Array(ID_LEN);
  crypto.getRandomValues(b);
  let s='';
  for(let i=0;i<ID_LEN;i++)s+=ID_CHARS[b[i]%ID_CHARS.length];
  return s;
}
function clientIp(req){
  return req.headers.get('CF-Connecting-IP')||req.headers.get('X-Forwarded-For')||'unknown';
}
/** 按 IP 限流：窗口内计数超限就拒绝 */
async function rateLimited(env,req){
  if(!env||!env.MP_KV)return false;                 // KV 没绑定时不做限流（宁可放行，也别把功能挡死）
  const key='rl:'+clientIp(req)+':'+Math.floor(Date.now()/3600000);
  let n=0;
  try{ n=parseInt(await env.MP_KV.get(key)||'0',10)||0 }catch(e){ return false }
  if(n>=RATE_LIMIT_PER_HOUR)return true;
  try{ await env.MP_KV.put(key,String(n+1),{expirationTtl:3600}) }catch(e){}
  return false;
}
const CORS_HEADERS=cors;

export default {
  async fetch(req,env){
    const url=new URL(req.url);
    const path=url.pathname.replace(/\/+$/,'')||'/';

    if(req.method==='OPTIONS')return new Response(null,{status:204,headers:cors()});

    /* 健康检查：前端用它判断"后端到底配没配好"，好给出准确提示 */
    if(path==='/api/health'&&req.method==='GET'){
      let kv=false;
      try{
        if(env&&env.MP_KV){ await env.MP_KV.get('__health__'); kv=true }
      }catch(e){ kv=false }
      return json({ok:true,kv});
    }

    /* 创建短链 */
    if(path==='/api/p'&&req.method==='POST'){
      if(!env||!env.MP_KV)return json({error:'kv_not_bound',message:'服务端未绑定 KV 命名空间 MP_KV'},503);
      if(await rateLimited(env,req))
        return json({error:'rate_limited',message:'请求过于频繁，请稍后再试'},429);
      let body='';
      try{ body=await req.text() }catch(e){ return json({error:'bad_body'},400) }
      const data=String(body||'').trim();
      if(!data)return json({error:'empty'},400);
      if(data.length>MAX_BYTES)return json({error:'too_large',message:'工程数据过大（上限 '+Math.round(MAX_BYTES/1024)+' KB）',bytes:data.length},413);
      /* 只接受前端约定的三种前缀，避免被当成任意文本存储 */
      if(!/^#[szl]=/.test(data))return json({error:'bad_format',message:'数据格式不是分享载荷（需以 #s= / #z= / #l= 开头）'},400);

      /* 碰撞概率极低，但仍重试几次 */
      let id=null;
      for(let i=0;i<5;i++){
        const cand=newId();
        const exist=await env.MP_KV.get('p:'+cand);
        if(!exist){ id=cand; break }
      }
      if(!id)return json({error:'id_collision'},500);
      await env.MP_KV.put('p:'+id,data,{expirationTtl:TTL_SECONDS});
      return json({id,url:'#p='+id,bytes:data.length,ttlDays:Math.round(TTL_SECONDS/86400)},201);
    }

    /* 取回短链 */
    const m=path.match(/^\/api\/p\/([a-z0-9]{4,32})$/i);
    if(m&&req.method==='GET'){
      if(!env||!env.MP_KV)return json({error:'kv_not_bound'},503);
      const id=m[1].toLowerCase();
      let data=null;
      try{ data=await env.MP_KV.get('p:'+id) }catch(e){ return json({error:'kv_error'},500) }
      if(!data)return json({error:'not_found',message:'链接不存在或已过期'},404);
      return json({data});
    }

    return json({error:'not_found',message:'未知接口。可用：POST /api/p、GET /api/p/:id、GET /api/health'},404);
  },
};
