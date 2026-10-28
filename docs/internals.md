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
| GET | `/api/user/self` | 额度、`task_count`、等级 |
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

## 5. 实测：每日任务口径

`daily_tasks/status` 的 `progress`：

- 用普通 `/v1/chat/completions`（不带 Aipy 头）请求：progress 不变。
- 带 `Aipy-Task-ID` + `Aipy-Task-Type: task` 的请求：progress 不变。
- 用 `aipyapp` 的 Python API 跑一个真实 task：progress 不变。
- 结论：trustoken 服务端只统计 **AiPy 客户端完成的任务**，纯 API 无法推进（至少 2026-10-29 是这样）。

插件因此在 `auth.checkin` 里：
1. 领取 `claimable` 的任务奖励（确定有效）；
2. 用 `qwen3.8-flash` 为 `in_progress` 的 gap 发极小请求（best effort）；
3. 把服务端返回的真实 `progress/target` 写进签到消息。

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
