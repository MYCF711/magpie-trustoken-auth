#!/usr/bin/env node
// 发布到 npm 时把 package.json 的 name 临时换成 npm 包名（小写 ASCII）。
//
// git 源/卡片标题用 `爱派AiPy`（无空格，bun 依赖键合法；npm 不接受中文名），
// 发布那一刻换成 `magpie-trustoken-auth`，发布后还原。一律用 `npm run publish:npm`。
//
// `PUBLISH_AS` 这个名字是 scripts/check.mjs 约定的。

import fs from "node:fs"
import { execSync } from "node:child_process"

const PUBLISH_AS = "magpie-trustoken-auth" // npm 上的包名：小写、不变
const file = "package.json"
const orig = fs.readFileSync(file, "utf8")
const pkg = JSON.parse(orig)

pkg.name = PUBLISH_AS
fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + "\n")
try {
  execSync("npm publish", { stdio: "inherit" })
} finally {
  fs.writeFileSync(file, orig) // 无论成败都改回来
}
