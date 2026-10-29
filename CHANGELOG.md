## 0.1.8

- feat: 注册/登录请求注入 AiPy 客户端同款 `X-AIPY-*` 请求头；`X-AIPY-REFERRAL-CODE` 读取 `%APPDATA%/aipy-pro/referral`（本机为 `BJ5OOSP-7xpn8zonzw`）。

## 0.1.7

- feat: 增加「本机登录（读取 AiPy 会话）」，在 AiPy Pro 客户端登录任意手机号后，插件可直接读 token 添加到 magpie。

## 0.1.6

- fix: 显式设置 `sessionStorage.layout="false"`，确保 OAuth 登录页走 `/api/user/register/mobile`，不被 `/api/user/login/mobile` 的“新号需下载客户端”策略拦截。

## 0.1.5

- fix: OAuth 授权页 302 到 /login 有渲染延迟，改为轮询等待手机号输入框（最多 15 秒），不再固定 800ms 后报「没找到手机号输入框」。

## 0.1.4

- fix: OAuth 登录点击后处理「登录或者注册需要同意《用户协议》和《隐私协议》」二次确认；
  实测同意后走 `/api/user/register/mobile`，不再被“新增账号需下载 AiPy Pro 客户端”拦截。

## 0.1.3

- feat: 改用 AiPy 客户端同款 OAuth 授权页（`client_id=aipy-pro` + `redirect_uri=aipy-pro://oauth` + PKCE）；
  登录页注入 `window.aipy`，登录成功后捕获 `aipy-pro://oauth?code=...` 并换 token。

## 0.1.2

- fix: 回调检测「新增账号需下载 AiPy Pro 客户端」等业务错误，立即返回原因，不再转圈 180 秒。

## 0.1.1

- fix: 无头登录返回 `opened: true`，避免 magpie 再开系统默认浏览器（用户看到网页登录页）。

# 更新记录

> 每个版本一节，**一条一行**，说用户能感知的变化。

## 0.1.0 — 2026-10-29

**Trustoken（AiPy）接入 magpie —— 登录、模型、额度、签到、每日任务一次到位**

- **登录**：无头 Chromium 内置登录——自动填手机号、勾协议、填邀请码、获取验证码、解滑块；用户在 magpie 里填短信验证码后自动提交并捕获登录响应。滑块用边缘梯度互相关，连续 10 次实测一次通过 10/10。
- **模型目录**：登录后按账号实时拉 `GET /v1/models`；未登录用 13 个静态模型兜底。图片输入按 trustoken 自己的声明写死（只有 `qwen3.8-flash` / `kimi/kimi-k3` 标了 image）。
- **额度**：`GET /api/user/self` → 灵石余额（quota / 5000），卡片以钱包型窗口展示。
- **签到**：`POST /api/user/checkin`，北京时间 08:00–22:00 窗口；窗口外返回 `failed` 让 magpie 当天重试。
- **每日任务**：`GET /api/user/daily_tasks/status` → 自动领取 `claimable` 的奖励（`POST /api/user/daily_tasks/claim`）。
- **任务 = 会话**：实测 trustoken 的「AI 任务」= AiPy Pro 的一个任务（会话）。插件通过 AiPy 本机 API `POST /api/aipy/createTask`（`force: true`）自动创建缺口任务，模型用最低价 `qwen3.8-flash`；实测 progress 3 → 4 → 5，并成功领取 150 灵石。独立脚本 `scripts/aipy-daily.mjs`。
- **邀请码（学超级麦吉 0.3.32）**：注册新号自动带 `aff_code`；默认作者码 `Chdr`；「邀请上级」支持自动 / 固定 / 自定义三种策略；每次登录与每日签到自动滚动当前账号自己的码。缓存文件 `~/.cache/magpie/trustoken-invite*.json`。
- **最低消费模型**：`src/rates.mjs` 是 2026-10-29 的实测倍率表；`qwen3.8-flash` 最低（输入 0.7471 / 输出 2.2538 quota/token），插件用它补每日任务。
- **模型错误**：模型级错误统一翻译成 404，不误伤整个账号。
