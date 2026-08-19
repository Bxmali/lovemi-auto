# Lovemi Auto · PRD Phase 1（邮箱管理）

| 项 | 内容 |
|----|------|
| 产品 | Lovemi Auto |
| 技术 | React + Electron + GSAP + Zustand |
| 语言 | 标准中文 |
| 规模 | 100–1000 账号（列表可扩展虚拟滚动） |
| 仓库 | `/Users/tangguoquan/Documents/PycharmProjects/LovemiAuto` |

## 本期交付

- Electron 桌面壳（暗色 Lovemi 主题）
- 侧栏导航（邮箱实装，其余占位）
- 邮箱管理：导入 / 搜索 / 筛选 / 卡片·表格双视图 / 详情抽屉
- 导入格式：`邮箱:密码` 或 `邮箱:密码:刷新令牌:客户端ID`
- 本机 `safeStorage` 加密持久化（Electron 环境）
- GSAP：启动入场、邮箱页 stagger、抽屉滑入、验证码位动画
- 「模拟取码」占位（真实 Graph/IMAP 下一里程碑）

## 明确不做

- 不在仓库中预置、提交任何真实账号或令牌
- 不提供账号采购 / 成品号市集能力
- 不在本阶段接通未授权第三方 OAuth 令牌批量读信

## 本地运行

```bash
cd /Users/tangguoquan/Documents/PycharmProjects/LovemiAuto
npm install
npm run dev
```

浏览器预览：Vite 会起 `http://localhost:5173`；Electron 窗口由 `vite-plugin-electron` 自动拉起。

## 安全说明

请在应用内「导入账号」粘贴**你自有、已获授权**的测试邮箱。勿把密钥贴进聊天、Git 或公开文档。
