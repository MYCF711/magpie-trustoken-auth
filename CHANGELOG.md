# 更新记录

> 每个版本一节，**一条一行**，说用户能感知的变化。

## 0.1.0 — 2026-10-29

**Trustoken（AiPy）接入 magpie —— 登录、模型、额度、签到、每日任务一次到位**

- **登录**：手机号 + 短信验证码（`POST /api/sms/code` → `POST /api/user/login/mobile`），也支持直接粘贴 API Key（只调模型，不签到）。
- **模型目录**：登录后按账号实时拉 `GET /v1/models`；未登录用 13 个静态模型兜底。图片输入按 trustoken 自己的声明写死（只有 `qwen3.8-flash` / `kimi/kimi-k3` 标了 image）。
- **额度**：`GET /api/user/self` → 灵石余额（quota / 5000），卡片以钱包型窗口展示。
- **签到**：`POST /api/user/checkin`，北京时间 08:00–22:00 窗口；窗口外返回 `failed` 让 magpie 当天重试。
- **每日任务**：`GET /api/user/daily_tasks/status` → 自动领取 `claimable` 的奖励（`POST /api/user/daily_tasks/claim`）。
- **最低消费模型**：`src/rates.mjs` 是 2026-10-29 的实测倍率表；`qwen3.8-flash` 最低（输入 0.7471 / 输出 2.2538 quota/token），插件用它补每日任务。
- **模型错误**：模型级错误统一翻译成 404，不误伤整个账号。
