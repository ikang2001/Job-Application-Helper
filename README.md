# 秋招网申助手

一个本地优先的求职辅助工具套件，包含浏览器扩展、Windows 桌面端、招聘邮箱审核、本机同步和可选的手机只读页面。它帮助用户填写网申、管理多份简历、跟踪投递进度，并在测评、笔试或面试前收到提醒。

> 项目不会代替用户提交申请。自动填表、邮件分类、时间推断和 AI 结果都应在使用前人工核对。

## 组成

| 模块 | 用途 | 主要目录 |
|---|---|---|
| Chrome / Edge 扩展 | 资料管理、简历解析、网页表单识别与填充、投递候选确认 | `src/`、`public/` |
| Windows 桌面端 | 投递记录、招聘会、邮件人工审核、近期安排和桌面提醒 | `desktop-app/` |
| Native Mail Companion | QQ、163、126 和通用 IMAP；扩展与桌面端本机同步 | `native-mail-companion/` |
| 手机只读页面 | 查看投递记录与近期安排，接收 Web Push 或 PushPlus 提醒 | `mobile-app/` |
| 手机同步服务 | Cloudflare Workers + KV 部署，或 Node.js 自托管 | `mobile-cloud-worker/`、`mobile-cloud/` |

桌面端目前只提供 Windows 版本；macOS 用户仍可使用浏览器扩展和手机网页。macOS 桌面安装包需要在 Mac 上另行构建和签名。

## 主要功能

### 网申与简历

- 保存多套相互独立的个人资料和简历，并在投递不同岗位时快速切换。
- 解析 PDF、DOCX、Markdown、TXT 和结构化 JSON 简历。
- 快速填充常见网申字段，不配置 AI 也能使用。
- AI 扫描整页空白字段，或框选局部区域进行图文匹配；支持 OpenAI 及兼容接口。
- 信息窗口支持一键复制资料，并尝试写入当前聚焦的网页控件。
- 自动填入后读取网页最终值，尽量避免网页组件回滚却误报成功。

### 投递管理

- 记录公司、岗位、来源、链接、状态、投递日期、地点、JD、备注和求职时间线。
- 支持搜索、筛选、排序、收藏、按公司分组、JSON/CSV 导入导出。
- 识别网页提交成功信号并生成“投递候选”，必须人工确认后才写入；候选支持批量忽略。
- 独立管理招聘会、报名状态、时间地点、目标公司和准备事项。

### 邮件审核

- Gmail、Outlook 使用只读 OAuth；QQ、163、126 和其他邮箱通过本机 IMAP 组件读取。
- 结合公司名称、别名和招聘语义识别申请确认、测评、笔试、面试、Offer、拒信和职位关闭邮件。
- 邮件先进入人工审核，不会直接修改岗位状态。
- 系统自动预选邮件阶段并提取开始时间、截止时间、链接和摘要；识别不准时可手动修改后确认。
- “24 小时内”“48 小时内”等相对期限会按邮件收到时间推算，并明确标记为截止时间。
- 邮箱扫描使用增量游标，已经扫描过的历史邮件不会在正常情况下重复进入审核。

### 安排与提醒

- 桌面端和手机端均提供“近期安排”，默认按时间从近到远排列。
- 支持“全部 / 测评·笔试 / AI 面试 / 正式面试”分类。
- 每项安排可区分开始时间和截止时间，并保存独立链接。
- 桌面提醒和手机提醒相互独立，均可单独关闭。
- 默认在安排前 24 小时和 5 小时分别提醒一次。
- 完成测评、笔试或面试后可标记“已完成”，后续提醒立即停止，也可以撤销完成状态。
- 手机端可使用浏览器 Web Push；国内网络环境可配置 PushPlus App 通道，电脑关机后仍由云端定时发送。

### 数据与同步

- 扩展资料默认保存在 `chrome.storage.local`，API Key、邮箱令牌和 WebDAV 密码不会写进代码仓库。
- Native Companion 可在本机双向合并 Edge 扩展与桌面端的投递记录。
- 手机同步只上传加密快照；配对链接中的解密密钥不会发送给 Worker。
- 可选 WebDAV 用于跨电脑备份，使用 ETag 避免并发静默覆盖。

## 普通用户安装

### 浏览器扩展

1. 从 GitHub Releases 下载 `job-application-helper-extension.zip` 并解压。
2. 打开 `chrome://extensions` 或 `edge://extensions`。
3. 开启“开发者模式”，选择“加载已解压的扩展程序”。
4. 选择刚才解压得到的目录，并将扩展固定到工具栏。

浏览器不能直接加载 ZIP，必须先解压。

### Windows 桌面端

从 Releases 下载最新的 `job-application-helper-desktop-*-setup.exe`。当前构建未使用商业代码签名证书，Windows 可能提示“未知发布者”；建议先用同名 `.sha256` 文件核对安装包完整性。

桌面端负责投递管理、邮件审核与提醒；网页识别和自动填表仍由扩展负责。安装新版会复用原有本机数据，不需要先卸载旧版。

### Native Mail Companion

需要 IMAP 邮箱或扩展—桌面端本机同步时安装：

```bash
cd native-mail-companion
npm ci
npm run check
npm run install-host -- --browser edge --extension-id <你的扩展ID>
```

Chrome 将 `edge` 改为 `chrome`。扩展 ID 可在浏览器扩展管理页查看。邮箱授权码保存在操作系统凭据存储中，不应写入源码或配置文件。

## 基本使用

1. 在扩展设置页建立一套或多套简历资料并保存。
2. 打开招聘网站表单，使用“快速填充”；需要更强语义匹配时再配置自己的 AI API Key。
3. 填写完成后人工检查所有字段，再由用户自己提交。
4. 在扩展或桌面端确认投递候选，维护岗位状态和笔试、测评、面试时间。
5. 如需邮件识别，在邮箱监控中配置只读 OAuth 或 IMAP。
6. 邮件命中后在“招聘邮箱”中核对公司、岗位、阶段、时间和链接，再点击确认。
7. 在“近期安排”中查看按时间排序的任务；完成后及时标记，避免继续提醒。

## 手机查看与提醒

手机页面需要部署自己的同步服务，不要共用他人的管理口令或 Cloudflare KV。

Cloudflare 部署说明见 [mobile-cloud-worker/README.md](mobile-cloud-worker/README.md)。部署完成后：

1. 在桌面端打开“手机查看”。
2. 填写自己的 Worker 地址和管理口令，创建配对二维码。
3. 用手机扫码并将页面添加到主屏幕。
4. 在手机页面单独开启浏览器提醒，或填写自己的 PushPlus token。

电脑关机后桌面弹窗无法出现，但 Cloudflare 定时任务仍可发送手机提醒。手机端默认只读，避免误触修改求职记录。

## 开发

### 环境

- Node.js 22 LTS（最低满足 Vite 要求的 Node.js 20.19 也可）
- npm
- Chrome 或 Edge 116+
- Windows 桌面打包需要 Windows；macOS 桌面打包需要 macOS 和相应签名环境

### 安装与检查

```bash
npm ci
npm run install:native
npm run install:desktop
npm run check:all
```

常用命令：

```bash
npm run dev                 # 扩展开发服务
npm run build               # 构建扩展
npm run package:extension   # 生成扩展 ZIP
npm run check:native        # 检查 Native Companion
npm run check:desktop       # 检查桌面端
npm run package:desktop     # 生成 Windows 安装包
npm run package:release     # 生成全部发布产物
```

Cloudflare Worker 单独在 `mobile-cloud-worker/` 中执行 `npm ci`、`npm test`、`npm run check`。

## 仓库结构

```text
.
├─ src/                       浏览器扩展源码
├─ public/                    图标及静态资源
├─ tests/                     扩展测试夹具
├─ desktop-app/               Electron 桌面端
├─ native-mail-companion/     Native Messaging 与 IMAP
├─ mobile-app/                手机 PWA 静态页面
├─ mobile-cloud-worker/       Cloudflare Workers 后端
├─ mobile-cloud/              可选 Node.js 自托管后端
├─ scripts/                   构建与打包脚本
├─ docs/                      架构和设计资料
└─ .github/workflows/         GitHub Release 自动构建
```

## 上传到 GitHub

推荐把当前项目目录作为一个独立仓库。应上传源码、锁文件、构建脚本、公开文档和示例配置，即上面“仓库结构”中的目录，以及根目录的 `package*.json`、`manifest.json`、TypeScript/Vite 配置、README、LICENSE 和 `.github/`。

以下内容不要上传：

- `node_modules/`、`dist/`、`release/`、`.artifacts/` 等依赖和构建产物；正式安装包放 GitHub Releases，不放源码提交。
- `.env*`、`.dev.vars`、真实 `wrangler.jsonc`、私钥、证书和任何 API Key/token。
- JSON/CSV 备份、简历原文件、本机同步文件、邮件数据、OAuth 会话和 WebDAV 配置。
- 个人调研报告、自用工程规格和本地开发笔记。

仓库已提供脱敏后的 `mobile-cloud-worker/wrangler.example.jsonc` 与 `.dev.vars.example`。发布前至少执行：

```bash
git status --short --ignored
git grep -nEi "(api[_-]?key|client[_-]?secret|password|access[_-]?token|refresh[_-]?token|private[_-]?key)"
npm run check:all
```

检查 `git grep` 的结果，只允许变量名、说明文字和测试假数据，不能包含真实值。GitHub Release 工作流要求扩展的 `package.json`、`package-lock.json` 和 `manifest.json` 版本与 `vX.Y.Z` 标签一致；桌面端的 package 与 lock 版本需彼此一致。

## 隐私与安全

- 这是客户端 BYOK 模式。AI API Key 保存在本机扩展存储中，安全强度低于受控服务端；建议使用独立、限额 Key 并定期轮换。
- 简历、表单内容和邮件摘要可能包含敏感个人信息。启用 AI 前应确认相应服务商的数据处理政策。
- JSON 备份和 CSV 导出是明文敏感文件，不要放进公开仓库、公开网盘或聊天记录。
- 若密钥曾经提交到 Git，删除文件并不能使其失效；必须立即在服务商处撤销并重新生成，再清理 Git 历史。
- 发现安全问题时请通过仓库的私密安全报告渠道联系维护者，不要在公开 Issue 中粘贴凭据或个人数据。

## 技术栈

- React 19、TypeScript 6、Vite 8
- Chrome Extension Manifest V3
- Electron 44
- Cloudflare Workers、KV、Web Push
- Node.js Native Messaging、IMAP TLS

## License

[MIT](LICENSE)
