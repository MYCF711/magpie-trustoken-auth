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

