# Lovemi Auto

Lovemi 专属自动化桌面端（React + Electron）：邮箱管理、角色创建/立绘复刻、互动等。

## 快速开始（macOS / Windows）

```bash
npm install
npm run dev
```

- Windows 与 macOS 共用同一套命令；`npm run dev` 会去掉 `ELECTRON_RUN_AS_NODE`，避免 Electron 被当成 Node。
- Windows 打包：`npm run dist:win`（产出 NSIS 安装包到 `release/`）。
- 本地 HTTP 代理默认可填 `127.0.0.1:7890` / `7897`（按你本机 Clash / V2 端口改）。
- 推特资源默认落到系统「下载」目录下的 `推特资源/`（可在创建角色页改路径）。
- 水印脚本需要本机 Python3（Windows 可用 `py -3` 或安装 python.org 发行版）。

首次启动若本地库存为空，会尝试从仓库 `backups/accounts-*.json` 导入（需 Electron `safeStorage`）。macOS 加密的 `accounts.enc` 无法在 Windows 直接解密，请用明文 backups 迁移。

## 文档

- 立绘复刻提示词（东亚主文档 + 欧美微调）：[`docs/prompts-east-asian-portrait.md`](docs/prompts-east-asian-portrait.md)
- 邮箱 PRD：[`docs/PRD-email-hub.md`](docs/PRD-email-hub.md)

## 功能概览

- 邮箱账号导入 / 卡片墙
- 创建角色：识图 → 短 `appearance_tags` + 本地 `portrait_prompt` 草稿 → Lovemi 生图
- 东亚：`language=zh-CN` + 中文名；欧美：`language=en-US` + 英文名（外观提示词仍可用中文）
