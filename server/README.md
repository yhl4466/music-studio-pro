# 分享短链后端

把整份工程数据存起来，换回一个 8 位短 ID。于是分享卡片的二维码只需装约 60 字节
（`.../visualizer.html#p=<id>`），**一张普通二维码就能扫出整份谱子** ——
不需要 PDF417 之类的大码制，也不用多张二维码拼接。

## 两种部署方式，选一个

| | Workers | **Pages Functions（推荐国内用）** |
| --- | --- | --- |
| 地址 | `xxx.workers.dev` | `xxx.pages.dev` |
| 国内可达性 | ❌ **被 DNS 污染**（实测解析到 Akamai/Meta 的 IP，连接超时） | ✅ 解析到真 Cloudflare IP，链路正常 |
| 代码 | `server/worker.js` | `server/pages/functions/api/[[path]].js` |

两者共用同一份实现 [`server/handler.js`](handler.js)，行为完全一致。

### 为什么推荐 Pages

实测（同一台机器、同一时刻）：

```
workers.dev                 → 199.96.62.21       连接超时
pages.dev                   → 104.18.20.135     正常
cloudflare-pages.pages.dev  → 172.66.46.232     HTTP 522
```

那个 **522 是关键证据**：它是 Cloudflare 边缘返回的（"源站无响应"，因为那是个不存在的站点名）。
**能收到 Cloudflare 的 522，说明 TLS 与 HTTP 请求完整走到了边缘、没有被劫持。**
反观 `workers.dev` 是直接连接超时。

> 说明：DNS 污染策略会变，不能保证永久可用。但当前 `pages.dev` 明显优于 `workers.dev`。

## 部署 Pages（三条命令）

```bash
cd server/pages

# 1) 建项目（首次）
npx wrangler pages project create mp-share

# 2) 部署 Functions
npx wrangler pages deploy . --project-name mp-share
```

### 绑定 KV（短链的数据存这里）

1. 打开 Cloudflare 控制台 → **Workers & Pages** → 选 `mp-share` → **Settings** → **Functions** → **KV namespace bindings**
2. Add binding：**Variable name 必须填 `MP_KV`**，KV namespace 选你之前建的那个
3. 保存后**重新部署一次**（`npx wrangler pages deploy . --project-name mp-share`）

### 验证

```bash
curl https://mp-share.pages.dev/api/health
```

期望：`{"ok":true,"kv":true,...}`
- `kv:true` → 全部就绪 ✅
- `kv:false` → 绑定没生效，回到上面第 1 步检查变量名是否**正好是 `MP_KV`**

## 把地址告诉前端

前端按这个优先级找后端：

1. `localStorage.mpApiBase`（可视化页「设置 → 短链后端」填一次即可）
2. `<meta name="mp-api-base" content="...">`（写进 HTML，别人打开也自动生效 —— 推荐）
3. 都没有 → **短链功能自动禁用**并给出提示，其余功能完全不受影响

## 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/api/p` | body = 分享载荷（`#s=` / `#z=` / `#l=` 那串）→ `201 {id,url,bytes}` |
| `GET` | `/api/p/:id` | → `200 {data}`；不存在/过期 → `404 {error:'not_found'}` |
| `GET` | `/api/health` | → `200 {ok,kv,rateLimit}` |

## 设计取舍（改之前先读）

- **后端不解析工程数据**，只当不可变字符串存。将来前端换编码方式（`#z=`/`#c=`…）后端一行都不用改。
- **数据不可变**：同一 id 永不覆盖，所以不需要账号与鉴权；8 位随机 id 本身就是权限（base36 ≈ 2.8e12）。
- **TTL 180 天**：分享链接不该永久占存储；过期后前端明确报"链接已过期"。
- **单份上限 512 KB**（正常分享链接 1–20 KB）。
- **CORS 允许任意 Origin**：公开分享服务、不带 cookie/凭据；收窄 Origin 会让 fork 出去的自建前端用不了。

### 关于限流（改过一版，说明原因）

第一版把限流计数**写进 KV**，问题是每次请求都产生一次 KV 写，而免费档只有 **1000 写/天** ——
单个 IP 密集请求就能把当天额度吃光，之后所有人创建短链都会失败（不是扣钱，是功能停摆）。

现在改成：
1. 若绑定了 Cloudflare 原生 **Rate Limiting** 绑定（变量名 `RATE_LIMIT`），用它 —— 边缘判定，不消耗 KV；
2. 没绑定则**不做服务端限流**，把防滥用交给控制台里的 **WAF → Rate limiting rules**（同样在边缘拦，免费套餐有额度）。

这是有意的取舍：宁可少一层软限流，也不能让限流把 KV 写额度烧光导致功能停摆。

**建议在控制台加一条速率限制规则**（Security → WAF → Rate limiting rules）：
对 `/api/p` 的 POST，按 IP 限制「每分钟 10 次」，动作选 Block。

## 成本

免费套餐下**超额是请求被拒，不会自动计费**。KV 免费档：读 10 万/天、写 1000/天、存储 1 GB。
按每份 20 KB 算，1 GB 约存 5 万份。想更保险可在 Workers & Pages 与 KV 的产品侧边栏设置
budget alert（[官方说明](https://developers.cloudflare.com/changelog/post/2026-06-04-billable-usage-product-sidebar/)）。

## 关于账号安全

- **不要把账号密码或 API Token 提交进仓库。** 本目录只需要你的 KV namespace **id**（`wrangler.toml` 里那行），
  它是资源标识符、不是凭据，可以公开提交。
- 本地用 `wrangler login`（OAuth）即可，无需管理 token；CI 里才需要 token，且**只放进仓库 Secrets**。
