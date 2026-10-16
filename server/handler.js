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
   限流：内存滑动窗口（不碰 KV）+ 可选的 Cloudflare 原生限流绑定
   -------------------------------------------------------------------------
   演进过程（改之前先读，别再走回头路）：
     第 1 版：把计数写进 KV —— 每次请求一次 KV 写，而免费档只有 1000 写/天，
             单个 IP 密集请求就能吃光当天额度，之后**所有人**创建短链都失败。
     第 2 版：干脆去掉服务端限流，全靠控制台 WAF —— 安全但少了一层，且要人工配。
     第 3 版（现在）：**内存滑动窗口**。它不产生任何 KV 写，所以没有第 1 版的额度问题，
             又能挡住最常见的"同一个 IP 猛刷"。
   ⚠ 实测结论（2026-10，部署在 Cloudflare Pages 上）：**在 Pages 上它基本拦不住**。
     连续发 60 次 + 并行 20 次，共 120 次创建请求**全部返回 201**，一次 429 都没有。
     原因是 Cloudflare 把请求分散到多个 isolate，每个 isolate 只看到几个请求，
     各自的计数都远达不到阈值 —— 内存状态不跨 isolate 共享。
     所以：**它只在"单 isolate 持续处理"的场景（本地 dev、小流量 Worker）才有意义**，
     线上真实防刷必须靠 Cloudflare 边缘规则（见下）。
     保留这段代码是因为它在本地/单实例下确实有效，且成本为零、不碰 KV；
     但**不要**把它当成线上保护。
   ★ 真正的线上防刷：控制台 Security → WAF → Rate limiting rules，
     对 `http.request.method eq "POST" and http.request.uri.path eq "/api/p"`
     按 IP 限制（例如 60 秒 10 次），动作 Block。这是边缘判定，不消耗 KV，跨 isolate 生效。
   ========================================================================= */
const RL_WINDOW_MS=60*60*1000;      // 1 小时窗口
const RL_MAX_POSTS=30;             // 每 IP 每窗口最多创建 30 条短链
const _hits=new Map();             // ip -> number[]（时间戳）；只在 isolate 内存里
function memoryRateLimited(ip,now){
  const t=now||Date.now();
  let arr=_hits.get(ip);
  if(!arr){ arr=[]; _hits.set(ip,arr) }
  /* 丢掉窗口外的；顺带在表太长时做一次整体清理，避免 isolate 长跑后内存膨胀 */
  while(arr.length&&t-arr[0]>RL_WINDOW_MS)arr.shift();
  if(_hits.size>2000){
    for(const [k,v] of _hits){
      while(v.length&&t-v[0]>RL_WINDOW_MS)v.shift();
      if(!v.length)_hits.delete(k);
    }
  }
  if(arr.length>=RL_MAX_POSTS)return true;
  arr.push(t);
  return false;
}
async function rateLimited(env,req){
  const ip=req.headers.get('CF-Connecting-IP')||req.headers.get('X-Forwarded-For')||'unknown';
  /* ① 绑定了原生限流就用它（更准、跨 isolate） */
  const rl=env&&env.RATE_LIMIT;
  if(rl&&typeof rl.limit==='function'){
    try{
      const r=await rl.limit({key:ip});
      if(r&&r.success===false)return true;
    }catch(e){
      /* 限流器异常不能挡死正常请求 → 落到内存限流继续保护 */
    }
  }
  /* ② 内存兜底（始终生效，不碰 KV） */
  return memoryRateLimited(ip);
}
/* 说明：这里原有 rateLimitConfig() 与 _resetRateLimit() 两个"供自检/测试"的导出，
   但仓库里没有任何测试文件引用它们（当时的验证是在仓库外临时跑的），属死接口，已删除。
   阈值本身就是上面的 RL_WINDOW_MS / RL_MAX_POSTS 两个常量，需要时直接读即可。 */
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
