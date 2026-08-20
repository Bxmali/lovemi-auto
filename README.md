# Lovemi Auto

Lovemi 专属自动化桌面端（React + Electron）。Phase 1：**邮箱管理**。

视觉对齐 [Lovemi Characters](https://app.lovemi.ai/characters/) 与 [ackr.app/help](https://ackr.app/help/)：暗底、粉点缀、GSAP 动效。

## 快速开始

```bash
npm install
npm run dev
```

Windows 与 macOS 均可：`npm run dev` 会自动去掉 `ELECTRON_RUN_AS_NODE`。首次启动若本地库存为空，会从仓库 `backups/accounts-*.json` 导入邮箱账号（需本机 Electron `safeStorage`）。本地代理默认 `127.0.0.1:7897`。

## 功能（Phase 1）

- 导入账号（`email:password` / `email:password:refresh_token:client_id`）
- 卡片墙 / 表格双视图、搜索筛选
- 详情抽屉、模拟验证码动效
- Electron `safeStorage` 本机加密保存

真实收信（IMAP / 自有 Azure Graph）见下一里程碑。

## 文档

见 [`docs/PRD-email-hub.md`](docs/PRD-email-hub.md)。
