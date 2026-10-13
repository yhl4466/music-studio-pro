/* 分享短链后端 · Cloudflare Pages Functions 入口（拿 *.pages.dev 地址）
   =========================================================================
   为什么用 Pages 而不是 Workers：实测 `workers.dev` 在国内被 DNS 污染
   （解析到 Akamai/Meta 的 IP，连接直接超时），而 `pages.dev` 解析到真正的
   Cloudflare IP，TLS 与 HTTP 都能走通（用不存在的站点名测得 HTTP 522 ——
   能收到 Cloudflare 边缘的 522 就说明链路完整、没有被劫持）。

   路由：本文件是 catch-all（[[path]]），`/api/p`、`/api/p/:id`、`/api/health`
   全部落到这里；若把前端也放在同一个 Pages 项目里，`/api/*` 由本函数处理、
   其余路径由静态资源处理。逻辑复用 ../../../handler.js，与 Worker 完全一致。
   ========================================================================= */
import { handleApi } from '../../../handler.js';

export async function onRequest(context){
  const { request, env } = context;
  const url = new URL(request.url);
  /* 只接管 /api/*，其余交回静态资源（同项目部署前端时要保留这条判断） */
  if(!url.pathname.startsWith('/api/'))return context.next();
  return handleApi(request, env || {});
}
