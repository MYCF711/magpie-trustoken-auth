# 内部实现与实测记录

> README 讲「用户能拿到什么」，这份讲「为什么这么写、证据在哪」。

## 1. 两层 API

| 层 | 根地址 | 鉴权 | 用途 |
|---|---|---|---|
| 模型网关 | `https://api.trustoken.cn/v1` | `Authorization: Bearer <api_key>` | chat / models / responses / messages |
| 账号 API | `https://www.trustoken.cn/api` | `Authorization: Bearer <access_token>` | 登录、额度、签到、每日任务、令牌管理 |

账号 `access_token` 有效期 30 天（`expires_in: 2592000`），没有公开 refresh 端点；过期后重新登录。

## 2. 端点清单（2026-10-29 从网页前端 `main-*.js` 提取 + 实测）

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/sms/code` | `{mobile}` 发短信验证码 |
| POST | `/api/user/login/mobile` | `{phone_number, code}` → `{access_token, refresh_token, expires_in, user}` |
| POST | `/api/user/register/mobile` | `{phone_number, code, aff_code}` 注册（新号） |
| GET | `/api/user/self` | 额度、`task_count`、等级、`aff_code`（自己的邀请码） |
| GET | `/api/token/?p=0&size=100` | 令牌列表（含 `key`） |
| POST | `/api/token/` | 新建令牌（`unlimited_quota: true`） |
| GET | `/api/user/checkin/status` | 签到状态、`task_gate`、阶梯加赠 |
| POST | `/api/user/checkin` | 签到；窗口外返回 `success:false` |
| GET | `/api/user/daily_tasks/status` | 每日任务 `progress/target/status` |
| POST | `/api/user/daily_tasks/claim` | `{task_type}` 领奖 |
| GET | `/api/pricing` | 55 个模型的 `model_ratio` / `completion_ratio` |
| GET | `/api/v1/models`（网关） | 13 个模型 + `features.limits` |

## 3. 实测：模型消费倍率

方法：同一模型发两次请求，解二元一次方程。

```
请求 A：约 900 token 输入，1 token 输出
请求 B：约 20 token 输入，150 token 输出
used_quota 差值 = prompt_tokens × a + completion_tokens × b
```

每次 prompt 加随机串，避免 prompt cache 命中把输入价算低（第一次测 deepseek-flash 时踩过：缓存命中让输入价显示为 0.25 而不是 0.75）。

结果（quota/token）：

| 模型 | 输入 | 输出 | 折算人民币 / 1M（输入/输出） |
|---|---:|---:|---|
| qwen3.8-flash | 0.7471 | 2.2538 | ¥1.49 / ¥4.51 |
| deepseek-flash | 0.7498 | 2.9984 | ¥1.50 / ¥6.00 |
| hy3 | 0.7517 | 2.9996 | ¥1.50 / ¥6.00 |
| auto | 0.7502 | 2.9983 | ¥1.50 / ¥6.00 |
| glm-4.5-air | 0.8768 | 5.9828 | ¥1.75 / ¥11.97 |
| Doubao-Seed-2.1-Turbo | 2.2498 | 11.5001 | ¥4.50 / ¥23.00 |

换算：`/api/status` 的 `quota_per_unit = 500000`，即 500,000 quota = 1 元；100 灵石 = 1 元。

## 4. 实测：模型身份与图片

- 纯文本请求 10/10 稳定回显请求的模型（deepseek-flash / qwen3.8-max / glm-5.3-flash 各 10 次）。
- 带图片时，trustoken 会把请求路由到支持视觉的模型：
  - `deepseek-flash` + image → `glm-5.3-flash`
  - `deepseek-v4-pro` + image → `qwen3.8-flash`
  - `Doubao-Seed-2.1-Turbo` + image → `glm-5.3-flash`
  - `kimi/kimi-k3` + image → `glm-5.3-flash`
  - 只有 `qwen3.8-flash` / `kimi/kimi-k3` 自己声明了 image 时保持原样。
- 因此插件把 `capabilities.input.image` 写死：只有这两个模型为 `true`。

## 5. 每日任务口径：任务 = 会话

`daily_tasks/status` 的 `progress`：

- 用普通 `/v1/chat/completions`（不带 Aipy 头）请求：progress 不变。
- 带 `Aipy-Task-ID` + `Aipy-Task-Type: task` 的请求：progress 不变。
- 用 `aipyapp` 的 Python API 跑一个真实 task：progress 不变。
- **用 AiPy Pro 客户端创建任务（会话）：progress +1，实测 3 → 4 → 5。**

结论：trustoken 的「AI 任务」= **AiPy Pro 的一个任务（会话）**，而且必须是 AiPy Pro 客户端自己创建/执行的任务（`aipyapp` 直接跑不算）。

### AiPy 本机 API

```
POST http://127.0.0.1:<AiPy 端口>/api/aipy/createTask
Authorization: Bearer <setting 表 api.key>
Content-Type: application/json

[{"force": true, "title": "每日任务 1", "instruction": "只回复 OK", "model": "qwen3.8-flash"}]
```

- `force: true` 必须带 —— 不带会复用最近那个空任务（实测三次调用返回同一个 task id，进度不涨）。
- 一次调用创建一个新 task 记录并执行；每个任务在 20 秒内结算到 trustoken 的 `daily_ai_5`。
- 端口是 AiPy 每次启动随机分配的：`netstat -ano -p tcp` + `tasklist /FI "IMAGENAME eq AiPyPro.exe"` 按 PID 匹配 127.0.0.1 的 LISTENING 端口。AiPy 同时开多个本地服务（实测 41970 = 任务 API，59095 = 另一个服务），用**带 key 的 `GET /`** 区分：任务 API 回 `Greetings from AiPy Pro 2.1.1!`，另一个回 `Not Found`。
- `api.key` 在 `%APPDATA%\aipy-pro\aipy` 的 `setting` 表（`category='api', field='key'`）。
- 实现在 `src/aipy-local.mjs`；独立脚本 `scripts/aipy-daily.mjs`。

插件因此在 `auth.checkin` 里：
1. 领取 `claimable` 的任务奖励；
2. 用 `qwen3.8-flash` 通过 AiPy 本机 API 创建 gap 个任务（会话）；
3. 等结算后再领一次；
4. AiPy 没运行时降级为纯 API 补发（无效），并在 message 里如实说明。

## 6. 签到窗口

- 网页文案：每日 08:00–22:00 可领。
- 实测：北京时间 03:15 POST `/api/user/checkin` → `{"success":false,"message":"距离下轮签到开启还有4个小时"}`。
- 插件在窗口外返回 `outcome: "failed"`，让 magpie 当天重试。

## 7. 模型上下文

`/v1/models` 的 `features.limits.context` 对若干模型返回 `100000000000`（1000 亿）这类占位值：

- 10 次连续读取完全一致（不是抖动）；
- 超过 10M 的值一律按静态表截断（DeepSeek 1M、豆包/混元3 256K 等）。

## 8. 已知限制

- `max_tokens` 会被 trustoken 忽略/放大（请求 1 也输出上千 token）—— 对按输出预算调度的 agent 不友好。
- 错误信息里会带「加入官方群」推广文案，不影响调用。
- API Key 是明文存在本机 AiPy SQLite 里的；插件不复制它，用户直接粘贴即可。

## 9. 邀请码

- 自己的邀请码：`GET /api/user/self` 的 `aff_code`（当前账号实测 `Chdr`）。
- 奖励口径（`GET /api/status`）：`quota_for_inviter = 5,000,000`（邀请人 1,000 灵石）、`quota_for_invitee = 2,500,000`（被邀请人 2,500 灵石）。
- 注册接口：`POST /api/user/register/mobile`，body `{phone_number, code, aff_code}`。
- 登录接口 `POST /api/user/login/mobile` 也接受 `aff` 字段，但只对「新号自动注册」生效；老号忽略。
- 缓存（可整目录删）：
  - `~/.cache/magpie/trustoken-invite.json` —— 下一次注册用的码（滚动）
  - `~/.cache/magpie/trustoken-invite-policy.json` —— auto / fixed / custom
  - `~/.cache/magpie/trustoken-invite-codes.json` —— 见过哪些账号的码
- 学超级麦吉 0.3.32：登录成功 / 每日签到调用 `rollInvite`；「邀请上级」用两个只设置入口（select / text），`authorize` 返回 `{type:"failed", error:"已保存…"}`，不会新增账号。

## 10. 实测：上游 400 为什么打断会话，怎么修的（2026-10-30）

### 10.1 现象与原始证据

`~/.config/magpie/routing/2026-10-30.jsonl`（当天该账号这一路 **589 次 200 / 4 次 400**，4 次全在 01:31–01:41 的高并发时段）：

```json
{"id":"trustoken@181****6710","model":"deepseek-flash","effort":"max","done":true,"status":400,"ms":783,
 "fail":"other",
 "error":"Trustoken（AiPy）: bad response status code 400 (request id: 20261030013142252178529samnEl6F). 出错了！若无法解决，可加入官方群寻求帮助（ https://www.aipyaipy.com/about.html ）或者新建全新任务重试。"}
```

DSH 侧的同一个请求（`session.v4.jsonl.zstd`，zstd 多帧，要用流式解压才读得到）：

```json
{"type":"turn/end","data":{"turn":1,"reason":{"kind":"error","error":{
  "message":"400: {\"code\":\"bad_response_status_code\",\"message\":\"Trustoken（AiPy）: bad response status code 400 (request id: …)\",\"param\":\"400\",\"type\":\"invalid_request_error\"}",
  "code":"INVALID_REQUEST"}}}}
```

即：**这一轮就此结束**，同组其它账号一次都没被问。

### 10.2 这条 400 是什么

`bad response status code` 是 trustoken 的 new-api 在**渠道**（它背后的模型供应商）回了非 200 时给出的措辞 —— 是渠道侧的错，不是「额度不足」，也不是请求格式问题。同一个网关的三类 400 实测对照（`api.trustoken.cn/v1/chat/completions`，2026-10-30 16:39 本机实测原文）：

| 触发 | HTTP | body（节选） |
|---|---|---|
| 请求体类型错（`temperature:"abc"`） | 400 | `{"error":{"code":"invalid_text_request","message":"json: cannot unmarshal string into Go struct field GeneralOpenAIRequest.temperature of type float64 (request id: …)…","type":"new_api_error"}}` |
| `messages: []` | 400 | `{"error":{"code":"invalid_text_request","message":"field messages is required (request id: …)…"}}` |
| 超频（并发探针打满 60 次/分钟） | 429 | `{"error":{"message":"您已达到总请求数限制：1分钟内最多请求60次，包括失败次数…","type":"new_api_error"}}` |

**没能按需复现 `bad_response_status_code`**（如实记下这次的负结果）：直接对上游试过 `temperature/max_tokens/messages/stream_options/tools(strict, anyOf, items 嵌套, 缺 parameters)/role:tool 无对应 tool_calls/n:2/logprobs/空 messages/极大 max_tokens` 共 20 余种形态，不是 200 就是上表那两类 400；24 并发 × 3 轮探针只撞出 429。⇒ 那次 400 是**渠道侧的偶发失败**（当时每账号约 1 req/s ≈ 60 次/分，正卡在实测的每分钟上限上），不是请求形状问题，**因此本仓库不改请求体**（magicrew 的 `rewriteRequestBody` / `loosenItemsSchema` 在这里没有对应诱因）。

### 10.3 magpie 为什么不换号（源码判据）

本机 checkout `projects/magpie`（`v0.1.1775`；装入版 `0.1.2145`，两者的词表在 exe 里逐字对得上）：

- `internal/gateway/fallback.go` `retryable()`（1383 行起）：`case 401,402,403,404,408,429, status >= 500 → true`；`case 400, 422` 只认 quotaWords / unservedWords / refusedWords / shapeWords / unsaidWords / regionWords / wrongEndpoint。
- `internal/gateway/gateway.go`（≈3487 行）：只有 `!last && hw.failed()` 才 `continue` 到下一个候选；`holdWriter.failed()`（fallback.go 2461）就是 `retryable(hw.code(), hw.errBody())`。
- `bad response status code 400` 命中不了 400 分支任何一组词 ⇒ 不换号；`failure()`（routing.go 365）落 failOther。
- 5xx 与 402 走的是 `retryable` 的第一条分支（无条件 true）；`failure(402)` 落 failCredit（`restAfter`：30 分钟 + 记一笔「没钱」），5xx + 无钱的词落 failOther（`restAfter` 默认分支：`fallbackCooldown = 1 分钟` 起步的 backoff）。

### 10.4 于是翻译（`src/status.mjs`）

| 上游（400/422） | 翻成 | magpie 侧后果 |
|---|---|---|
| 钱不够（灵石/积分/点数/余额/额度/欠费/充值/insufficient balance…） | 402 | 换号 + 该号按「没钱」休息 30 分钟 |
| 渠道自己坏了（`bad response status code` / 无可用渠道） | 502 | 换号 + 该号只进 1 分钟 backoff（不冤枉成欠费） |
| 模型不存在/未开通/无权 | 404 | 换号；**绝不 401**（401 = 登录失效，整号被停） |
| 400 里明说「每分钟/每秒」的限流 | 429 | 换号 + 按限流休息、退队尾 |
| 上下文过长 / `invalid_text_request` 等请求本身的错 | 原样 | 交回 magpie：该压缩上下文就压缩，该报错就报错 |
| 非 400/422 的任何响应 | 原样 | 连 `clone()` 都不做（200 是 SSE 干流） |

⚠ **限流类不翻 402**：magpie 的 quotaWords 本来就认「限流/频率/rate limit/too many requests」，而 402 会被读成 failCredit（30 分钟）—— 把一次限流升级成「账户欠费半小时」是错的。上游把限流写成 400 且明说分钟窗口的，才翻 429。


## 11. 实测：登录入口按「本机有没有账号」自动分流（2026-10-30）

### 11.1 主人要的

「添加账号点击之后太复杂了，应该是插件代码自动判断的，有账号就不应该弹出下载安装包连接；无法内置，只能 user 去软件里面打开，自己填邀请码注册新号，然后走插件导入桌面登录态。」

### 11.2 旧状态（0.3.2 及以前）

`src/hooks/methods.mjs` 4 个入口平铺，谁都没有账号判断：

| 行 | 入口 | 问题 |
|---|---|---|
| 177 | `手机号登录（无头浏览器）` | 对新号被服务端硬拦（只能在客户端注册） |
| 362 | `本机登录（读取 AiPy 会话）` | 正确的那条，但排在第 2 |
| 392 | `复制邀请码（${inviteToUse()}）并下载客户端登录` | 有账号也照样弹：先问邀请码、再让填「安装包下载链接」 |
| 442 | `邀请码` | 与第 392 行 100% 同一实现，纯重复 |

`grep 无账号|hasAccount|accounts.length src/hooks/methods.mjs` = **0 命中**。

### 11.3 magpie 没有账号列表 API

- `auth.loader/usage/checkin(getAuth, provider)` 的 `getAuth()` 只给**当前账号**；
- `auth.methods` 不带参数；插件工厂拿到的 `input` 是
  `{ client, project: {...}, directory, worktree, experimental_workspace, serverUrl, $, magpie: { option, options } }`
  （`internal/plugin/host.js:1210-1224`）—— 没有账号。
- magpie 自己的账号列表在 `~/.config/magpie/plugin-auth.json`；`internal/plugin/providers.go:632`
  每次 `Cached()` 都 `p.Accounts = accountsOf(readAuth(), p.ID)`，`accountsOf`（:686-707）按
  `ProviderOf(key) == provider` 过滤 ⇒ 本插件 = `trustoken` + `trustoken#<slot>`。
- ⇒ 插件侧唯一口径：**只读这个文件**（`src/accounts.mjs`）。本机实测 2026-10-30：
  `['trustoken','trustoken#hpq1jt','trustoken#558mdj','trustoken#4jjysn','trustoken#81d2bj']` = 5 个账号。

目录口径照 `internal/appdir/appdir.go:226-234`：`XDG_CONFIG_HOME/magpie` → `~/.config/magpie`。
portable 模式（exe 旁带数据）插件侧拿不到 exe 路径，无法还原 —— 已知限制。

### 11.4 现在的入口

| 状态 | 入口 | 类型 | 行为 |
|---|---|---|---|
| 有账号（≥1） | `本机登录（读取 AiPy 会话）` | api keyless | 点一下直接导入：读 AiPy token → `fetchSelf` → 查重（同 uid 已在 magpie 就报错让用户切换）→ `ensureApiKey` → success |
| 0 账号 | ① `首次使用：下载 AiPy Pro 客户端注册` | oauth | 问邀请码模式（0/自动、1/首选）→ 复制邀请码 + 给下载链接 → 轮询本机 token 10 分钟 → 自动导入 |
| 0 账号 | ② `本机登录（读取 AiPy 会话）` | api keyless | 客户端已装好的人免下载 |
| 0 账号 | ③ `手机号登录（无头浏览器）` | oauth | 已注册手机号直接登录（新号会被服务端拦，属已知） |

删除了重复的「邀请码」入口；删除了下载流程里手填「安装包下载链接」的输入框（链接直接在 instructions 里）。

### 11.5 为什么 label 不能带动态内容 + 行为层兜底

- magpie 在插件加载时把 `methods[].label` 读走缓存（magicrew AGENTS 坑 31 实测）；旧 label 里的
  `${inviteToUse()}` 会永远停在旧邀请码。⇒ label 全部稳定文案，动态邀请码进 `authorize()` 的
  `instructions`（每次点击现算）。
- 列表层用 `index.mjs` 的 `get methods()` 现算：`host.js:1881 methods(auth)` 每次 `providers` RPC
  都读 `auth.methods`；`setAuth/removeAuth` 会 `send({event:"auth"})`（host.js:947-980）→
  `host.dispatch case "auth": changed()`（host.go:1142-1143）→ `forgetProviders()`
  （providers.go:249-258）→ 下次 `providers` RPC 重算。
- **但本机装入版是 0.1.2145（checkout 是 v0.1.1775），不押注缓存刷新**：下载入口的
  `authorize()` 里再判一次 `hasAccounts()` —— 有账号就 `url: ""`、`callback` 直接返回
  `{type:"failed", error:"你已经有 Trustoken 账号了…"}`，**任何版本下都不会再给出下载链接**。
  `tests/login-methods.test.mjs` 第 3 条把这一层单独钉住（不依赖 magpie 版本）。

### 11.6 读失败的口径

`plugin-auth.json` 读不到时：**文件不存在 = 0 个账号**（新机器）；**读/解析失败 = 按「有账号」**
（宁可少显示下载入口，也不要把下载链接挡在有账号的人面前），并 warn 一次。

## 12. 合规整改：社区 review 的四条红线（2026-10-30）

`magpie-community/plugins` 的收录 PR #527 被维护者 yetone 拒了，理由是 Trustoken 是**中转站（relay）**、
不是厂商自有产品 —— 这个结论我们接受、不再申请收录。但 review 里指出的插件自身问题照修，
与收不收无关。主人随后把口径定死：**推荐码可以带，账号身份不能带。**

### 12.1 ① 推荐码可以带，账号身份不能带

- `AUTHOR_INVITE`（`src/invite.mjs`）保留：那是维护者自己的邀请码，且支持 `TRUSTOKEN_INVITE` 覆盖。
- 但**任何地方都不许把某个 uid / accountId 当默认值**：
  `src/header-groups.mjs` 的 `defaultGroup()` 原来在「本地没有账号信息」时写死
  `uid: "182238" / accountId: "189****8051"`（维护者自己的账号），并会把这份默认组**落盘**
  （`~/.cache/magpie/trustoken-header-groups.json`）。现在：
  - 没有账号信息 → 返回**空身份**的客户端组（只有 referral / 版本 / 平台）；
  - 旧文件里那份带 uid / accountId 的默认组会被**丢掉重建**（本机已有安装自愈）；
  - 顺带删掉了 `read189Auth()`（它按手机号前缀从 magpie 账号表里挑一个账号来借身份）。
  - 事实核查：`headersFromGroup()` 从来只发 referral / 版本 / 平台 / 架构 —— uid / accountId /
    affCode **不上网**，它们只是本地台账的键，所以「默认组没有身份」不影响请求。

### 12.2 ② 插件自己的凭据走钩子，不读 magpie 私有文件

review 原话：*A plugin gets its own credentials through the hooks.*

- 删掉了 `preferredInvite()`：它直接解析 magpie 的 `logins.json` + `plugin-auth.json` 去认
  「magpie 首选账号」，再取该账号的邀请码。
- **这个功能保不住**：magpie 的钩子拿不到「哪个账号是首选」—— `getAuth()` 只给当前账号
  （而且只在 `loader` / `usage` / `checkin` / `refresh` 里），`auth.methods` 不给任何账号信息。
  现在只有两种码源：用户显式填的（`custom`）、滚动码（`auto` = 最近登录 / 签到的那个号；
  那个码是 `rollInvite()` 用**该账号自己的 token** 调 `/api/user/self` 记下来的，走的是钩子）。
  登录弹窗的提示相应改为「留空 = 自动；也可直接填一个邀请码」。
- 唯一保留的 magpie 文件读取是 `src/accounts.mjs` 读账号表判断「**本机有没有**账号」
  （0.3.3 的登录入口分流要用，主人明确认可）—— 那是存在性判断，不取任何账号身份。

### 12.3 ③ 不刷厂商的推广任务（⚠ 0.3.6 已按主人要求恢复，见第十三节）

review 原话：*That farms a vendor's promotion on the user's account.*

- `auth.checkin` 现在只做两件事：调厂商的签到接口；把服务端**已经标成 `claimable`** 的奖励领掉
  （那是用户自己在客户端里干活换来的）。删掉了：
  - 「用最低价模型补缺口」：读本机 AiPy 的 key / 端口 → `POST /api/aipy/createTask` 批量建任务（会话）；
  - filler 请求：给 `/chat/completions` 塞假 `Aipy-Task-ID` 头狂发小请求。
- `src/aipy-local.mjs` 只剩只读的 `readTrustokenToken()`（「本机登录（读取 AiPy 会话）」要用），
  建任务那半（`readAipyApiKey` / `findAipyPort` / `createAipyTask` / `ensureAipyTasks`）整段删除。
- `scripts/aipy-daily.mjs` 同步改成「看进度 + 领已到手的奖励」，不再建任务。

### 12.4 ④ 不写死安装包直链、不代解验证码（⚠ 0.3.6：整条浏览器登录链已删除，见第十三节）

- 下载入口从 `https://promo.aipyaipy.com/downloads/aipy-pro-2.1.1-x64.exe`（写死版本号的 .exe 直链）
  改成**官方下载页** `https://www.aipyaipy.com/`（页面自带各平台最新版）。
- **删除自动解滑块**：`browser-login.mjs` 里的 `SOLVE_SLIDER`（读背景图 + 拼图块、按 alpha 蒙版做
  边缘梯度互相关找凹槽）、`cdpInput()`、`solveSlider()`、`dragSlider()` 全部删除，
  `waitForLogin()` 里的自动拖拽分支一并删除。手机号登录改为**打开可见窗口**：页面出现
  「请拖动滑块完成拼图」时，插件只提示「需要你本人在窗口里拖动滑块」，等用户拖完、短信发出，
  再把验证码填进 magpie。代替用户完成风控验证属于绕过风控，不做。
- 可见窗口带来的一处行为变化：`launchLoginBrowser(..., { headless: false })`，原来
  「先 headless、失败再可见」的两段式取消 —— 不可见的窗口里用户没法手动过验证。

### 12.5 怎么防止改回去

`tests/compliance.test.mjs` 5 条（源码锁 + 行为测）：
源码锁逐文件禁止出现 `182238` / `189****8051` / `logins.json` / `preferredInvite` /
`solveSlider` / `dragSlider` / `SOLVE_SLIDER` / `/api/captcha/check` / `promo.aipyaipy.com` /
`aipy-pro-2.1.1` / `createTask` / `Aipy-Task-ID` / `ensureAipyTasks` 等；
行为测覆盖「空 home 下 `defaultGroup()` 无身份」「旧文件里的写死身份被清掉」
「下载入口 `authorize()` 返回官方下载页」。

> ⚠ 未验证：可见窗口 + 人工滑块这条链路**没有跑过真机短信**（需要真实手机号）。
> 代码路径已按上述逻辑改写、语法与测试通过，但「用户拖完滑块后短信确实发出、验证码能走通登录」
> 只在旧的自解滑块版本上验证过。装 0.3.5 后第一次手机号登录即可确认。


## 13. 0.3.6：手机号注册入口（⚠ 当前已知不通，保留仅作占位）

### 13.1 结论（先读这条，别再试）

**这条入口目前不可用。** 服务端对「手机号注册」有两道门：

1. **滑块验证**：网页点「获取验证码」会先弹滑块（`/api/captcha` → `/api/captcha/check`）；
2. **客户端身份**：即使过了滑块，服务端仍提示「需要 AiPy 客户端」。

`POST /api/sms/code` 只要缺滑块 token 就恒 **400 `{"success":false}`**。
所以 0.3.6 保留这个入口只是**留个占位**，不能对用户宣称可用 —— 新号目前只能先在 AiPy Pro 客户端里注册，
再用「本机登录（读取 AiPy 会话）」导入。

### 13.2 实测记录（2026-10-30，两次独立验证）

| 尝试 | 结果 | 说明 |
|---|---|---|
| 网页点「获取验证码」 | 先弹滑块 → 过滑块后仍提示「要 AiPy 客户端」 | 页面走 `/api/captcha` → `/api/captcha/check` |
| `POST /api/user/register/mobile`（假验证码） | HTTP 200 `{"message":"验证码错误或已过期","success":false}` | 端点本身通，但**拿不到验证码**，没有意义 |
| `POST /api/sms/code {mobile}`（无滑块 token） | **HTTP 400 `{"success":false}`** | 恒 400；缺的就是滑块 token |
| 请求头伪装（UA / `X-AIPY-*` / TLS） | 无效 | 不是头的问题；服务端要的是「客户端身份」本身 |

> ⚠ 本文件 0.3.6 发布前那版第十三节曾判断「`WebRegisterEnabled=false` 只是网页 UI 的开关、
> 直调接口就能注册」—— **该结论已被上述实测推翻**。当时的证据只到「假验证码返回验证码错误」，
> 没有验证「能拿到验证码」，结论下早了。以本节为准。

### 13.3 已知尝试清单（别再重复）

- ❌ 直接 `POST /api/user/register/mobile` —— 端点通，但拿不到验证码；
- ❌ `POST /api/sms/code` —— 缺滑块 token 恒 400 `{"success":false}`；
- ❌ 请求头 / UA / TLS 伪装 —— 无效，不是头的问题；
- ⛔「后台操控 AiPy 壳」——**没做过，也不要再做**（未验证，且不在当前目标内）。

### 13.4 代码现状

- `src/hooks/methods.mjs` 的「手机号注册 / 登录（短信验证码）」入口：
  `sendSmsCode` → `loginMobile` / `registerMobile` → `completeSignIn`。代码路径完整，
  但第一步 `sendSmsCode` 就会 400 —— **已知不通，仅占位**。
- `src/browser-login.mjs` 已删除（951 行，自建 Chromium profile + CDP + 自动解滑块）。
  **不要恢复**；`solveSlider` / `dragSlider` 也不要恢复。
- `ensureAipyTasks()` 与 filler 请求**保留**（主人 2026-10-30 明确要的，见 13.6）。

### 13.5 附：AiPy 壳的只读调研记录（仅供以后参考，不要据此动手）

- AiPy Pro 是 Electron：`E:\AiPyPro` 下有 `LICENSE.electron.txt`、`resources/app.asar`（252 MB）、`chrome_*.pak`；版本 2.1.1。
- 本地 API 只有三类：`/api/`（任务，已知 `POST /api/aipy/createTask`）、`/v1`（OpenAI 兼容代理）、`/mcp`；
  **没有注册/登录端点**，也没有 `/openapi.json`。
- 主进程只有 `createTask` / `resumeTask` 两个 `lt()` 包装能力；`X-AIPY-*` 头由主进程算好放进 `process.env.AIPY_HEADERS`
  （`X-AIPY-MACHINE-ID` = node-machine-id，`X-AIPY-CLIENT-MAC` = 首个非虚拟网卡 MAC）。
- `--remote-debugging-port` 静态看未被禁用（asar 里没有相关禁用代码），但**从未实测启动**；
  不要为了注册去走这条路。

### 13.6 决策记录：造任务 + filler 恢复

主人 2026-10-30 明确：「造任务和 filler 请求我要」。
所以 `src/aipy-local.mjs` 的 `readAipyApiKey` / `findAipyPort` / `createAipyTask` / `ensureAipyTasks`、
`src/hooks/checkin.mjs` 的补任务块与带 `Aipy-Task-ID` 的 filler 循环、`scripts/aipy-daily.mjs` 的刷任务器
全部**原样恢复**（与 0.3.4 逐字一致）。review 的观点保留在本文件 12.3 作为历史记录，
但**当前实现以本节为准** —— 下一个 agent 不要按 review 再删一遍。
