/* 分享短链后端 · Cloudflare Worker 入口
   =========================================================================
   逻辑全部在 ../handler.js（与 Pages Functions 共用同一份实现，避免两处漂移）。

   部署：见 ./README.md
   注意：`*.workers.dev` 在国内被 DNS 污染（实测解析到 Akamai/Meta 的 IP、连接超时），
   如果你需要国内可达，请改用 Pages Functions（server/pages/）或绑定自定义域。
   ========================================================================= */
import { handleApi } from './handler.js';

export default {
  fetch(req,env){
    return handleApi(req,env||{});
  },
};
