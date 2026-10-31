#!/usr/bin/env node
// 发布到 npm 时把 package.json 的 name 临时换成 npm 包名。
//
// 为什么需要它：git 源看到的 `name` 是显示名（`爱派AiPy Trustoken`），
// 而 npm 只接受小写、无空格的包名。直接 `npm publish` 会被拒；一律用
// `npm run publish:npm`（release.mjs 与 release.yml 都会优先用它）。
//
// `PUBLISH_AS` 这个名字是 scripts/check.mjs 约定的（它靠它核对
// registry-entry.json 的 package 字段）。

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
