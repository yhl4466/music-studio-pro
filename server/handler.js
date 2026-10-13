/* 分享短链后端 · 共享实现（Cloudflare Worker 与 Pages Functions 共用）
   =========================================================================
   同一份逻辑两种部署方式：
     · server/worker.js                —— Workers（需要 workers.dev 或自定义域）
     · server/pages/functions/api/[[path]].js —— Pages Functions（拿 *.pages.dev）
   实测：`workers.dev` 在国内被 DNS 污染（解析到 Akamai/Meta 的 IP，直接连接超时），
   而 `pages.dev` 解析到真正的 Cloudflare IP、TLS 与 HTTP 都能走通 ——
   所以国内可达性上 Pages 明显更好，两者共用这份代码。

   接口：
     POST /api/p         body = '#z=…' 分享载荷 → 201 {id,url,bytes}
     GET  /api/p/:id     → 200 {data} ／ 404 {error:'not_found'}
     GET  /api/health    → 200 {ok,kv}
   ========================================================================= */

export const TTL_SECONDS=180*24*60*60;      // 180 天
export const MAX_BYTES=512*1024;            // 单份上限（正常分享链接 1–20 KB，足够且能挡滥用）
export const ID_LEN=8;
const ID_CHARS='abcdefghijklmnopqrstuvwxyz0123456789';

/* =========================================================================
   限流：优先用 Cloudflare 原生 Rate Limiting 绑定，**不再往 KV 写计数**
   -------------------------------------------------------------------------
   上一版把计数写进 KV，问题是：每次请求都产生一次 KV 写，而免费档只有
   1000 写/天 —— 单个 IP 密集请求就能把当天额度吃光，之后所有人创建短链都会失败
   （不是扣钱，是功能停摆）。所以改成：
     ① 若绑定了 rate limiter（wrangler.toml / Pages 的绑定配置里叫 RATE_LIMIT），
        用它 —— 在边缘判定，不消耗 KV；
     ② 没绑定则**不做服务端限流**，把防滥用交给 Cloudflare 后台的 WAF Rate limiting 规则
        （同样在边缘拦，免费套餐有一定额度）。这是有意的取舍：宁可少一层软限流，
        也不能让限流把 KV 写额度烧光导致功能停摆。
   ========================================================================= */
async function rateLimited(env,req){
  const rl=env&&env.RATE_LIMIT;
  if(!rl||typeof rl.limit!=='function')return false;      // 未绑定 → 不限流（见上）
  try{
    const key=(req.headers.get('CF-Connecting-IP')||'unknown');
    const r=await rl.limit({key});
    return !(r&&r.success);
  }catch(e){
    return false;                                          // 限流器异常不能挡死正常请求
  }
}
function cors(){
  return {
    'Access-Control-Allow-Origin':'*',
    'Access-Control-Allow-Methods':'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers':'Content-Type',
    'Access-Control-Max-Age':'86400',
  };
}
function json(body,status){
  return new Response(JSON.stringify(body),{
    status:status||200,
    headers:Object.assign({
      'Content-Type':'application/json;charset=utf-8',
      'Cache-Control':'no-store',
    },cors()),
  });
}
function newId(){
  const b=new Uint8Array(ID_LEN);
  crypto.getRandomValues(b);
  let s='';
  for(let i=0;i<ID_LEN;i++)s+=ID_CHARS[b[i]%ID_CHARS.length];
  return s;
}

/**
 * 处理一个 API 请求（纯 Web API，Worker 与 Pages 都直接调）。
 * @param {Request} req
 * @param {{MP_KV?:object,RATE_LIMIT?:object}} env 绑定
 * @returns {Promise<Response>}
 */
export async function handleApi(req,env){
  const url=new URL(req.url);
  const path=url.pathname.replace(/\/+$/,'')||'/';

  if(req.method==='OPTIONS')return new Response(null,{status:204,headers:cors()});

  /* 健康检查：前端用它判断"后端配没配好"，好给出准确提示 */
  if(path==='/api/health'&&req.method==='GET'){
    let kv=false;
    try{
      if(env&&env.MP_KV){ await env.MP_KV.get('__health__'); kv=true }
    }catch(e){ kv=false }
    return json({ok:true,kv,rateLimit:!!(env&&env.RATE_LIMIT)});
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
    if(data.length>MAX_BYTES)
      return json({error:'too_large',message:'工程数据过大（上限 '+Math.round(MAX_BYTES/1024)+' KB）',bytes:data.length},413);
    /* 只接受前端约定的三种前缀，避免被当成任意文本存储 */
    if(!/^#[szl]=/.test(data))
      return json({error:'bad_format',message:'数据格式不是分享载荷（需以 #s= / #z= / #l= 开头）'},400);

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
}
