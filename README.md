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

## 普通用户手动安装（Windows）

目前桌面端、浏览器扩展和 Native Mail Companion 是三个独立发布物，还没有合并成一个安装器。推荐按“桌面端 → 浏览器扩展 → Native Companion”的顺序安装。

### 1. 准备环境与下载文件

支持环境：

- Windows 10 / 11 x64。
- Microsoft Edge 或 Google Chrome 116+。
- 仅安装 Native Companion 时需要 Node.js 22.12+ 和 npm；桌面端、浏览器扩展本身不要求单独安装 Node.js。

从同一个 GitHub Release 下载需要的文件：

| 文件 | 本地构建位置 | 是否必需 | 用途 |
|---|---|---|---|
| `job-application-helper-desktop-*-setup.exe` | `release/desktop/` | 推荐 | Windows 投递管理、邮件审核和提醒 |
| `job-application-helper-extension.zip` | `release/` | 推荐 | 网页识别、简历资料和自动填表 |
| `job-application-helper-native-mail-companion.zip` | `release/` | 按需 | QQ、163、126、通用 IMAP，以及扩展与桌面端本机同步 |
| 对应的 `.sha256` 文件 | 与对应发布物同目录 | 推荐 | 检查下载文件是否完整 |

三个组件应尽量取自同一个 Release，避免新旧版本的数据结构或功能不一致。

### 2. 校验下载文件

在下载目录打开 PowerShell，计算文件的 SHA-256：

```powershell
Get-FileHash .\job-application-helper-desktop-*-setup.exe -Algorithm SHA256
Get-FileHash .\job-application-helper-extension.zip -Algorithm SHA256
Get-FileHash .\job-application-helper-native-mail-companion.zip -Algorithm SHA256
```

再打开对应的 `.sha256` 文件，确认其中的哈希与 PowerShell 输出一致。没有下载某个可选组件时，可以跳过对应命令。

### 3. 安装 Windows 桌面端

1. 退出正在运行的旧版“秋招投递管理器”。
2. 双击 `job-application-helper-desktop-*-setup.exe`。
3. 按安装向导选择目录并完成安装。
4. 从桌面或开始菜单启动“秋招投递管理器”。

当前构建未使用商业代码签名证书，Windows 可能显示“未知发布者”。请先确认文件来自本项目 Release，并完成 SHA-256 校验。安装新版会复用原有本机数据，通常不需要先卸载旧版。

桌面端负责投递管理、招聘邮箱审核和提醒；网页识别与自动填表仍由浏览器扩展负责。

### 4. 安装 Edge / Chrome 浏览器扩展

1. 把 `job-application-helper-extension.zip` 解压到一个长期保留的目录，例如 `D:\tools\job-application-helper-extension`。
2. Edge 打开 `edge://extensions`；Chrome 打开 `chrome://extensions`。
3. 打开页面上的“开发者模式”。
4. 点击“加载解压缩的扩展”或“加载已解压的扩展程序”。
5. 选择包含 `manifest.json` 的目录，而不是 ZIP 文件或它的上一级目录。
6. 确认“秋招网申助手”已启用，并按需将它固定到浏览器工具栏。
7. 打开扩展的“详细信息”，复制页面显示的 32 位扩展 ID；安装 Native Companion 时会用到。

浏览器不能直接加载 ZIP。扩展加载完成后不要移动或删除解压目录；如果更换了目录或扩展 ID 发生变化，需要重新安装 Native Companion。

### 5. 安装 Native Mail Companion（可选）

如果只使用扩展填表和桌面端手工管理记录，可以暂时跳过本节。需要以下任一功能时再安装：

- 在扩展或桌面端读取 QQ、163、126 或其他 IMAP TLS 邮箱。
- 在浏览器扩展和桌面端之间自动同步投递记录。

先确认 Node.js 版本：

```powershell
node --version
npm --version
```

然后把 `job-application-helper-native-mail-companion.zip` 解压到长期保留的目录，在该目录打开 PowerShell 并执行：

```powershell
npm ci --omit=dev
npm run install-host -- --browser edge --extension-id <32位扩展ID>
```

使用 Chrome 时将 `edge` 改为 `chrome`：

```powershell
npm run install-host -- --browser chrome --extension-id <32位扩展ID>
```

`<32位扩展ID>` 必须替换为扩展管理页显示的真实 ID，不要保留尖括号。安装完成后完全退出并重新打开浏览器和桌面端。

Native Companion 的目录不能随意移动。安装脚本生成的启动器和浏览器注册信息会指向当前解压目录；移动后需要在新目录重新执行安装命令。更完整的组件说明见 [native-mail-companion/README.md](native-mail-companion/README.md)。

### 6. 验证安装

依次检查：

1. 点击浏览器工具栏中的“秋招网申助手”，确认弹窗和设置页可以打开。
2. 在扩展中保存一条测试投递记录，然后打开桌面端，确认记录能够出现在桌面列表中。
3. 桌面端顶部显示“已与 Edge 本机同步”或对应的同步成功状态。
4. 如已安装 Native Companion，在扩展中配置只读 IMAP 账号，再到桌面端“招聘邮箱”执行一次扫描。

邮件账号应使用服务商提供的授权码或应用专用密码，不要把网页登录密码、授权码、API Key 或备份文件提交到代码仓库。

### 7. 更新

- **桌面端**：退出旧版后直接运行新版安装包，原有数据会继续保留。
- **浏览器扩展**：保持原解压路径不变，用新版文件替换旧文件，然后在 `edge://extensions` 或 `chrome://extensions` 点击该扩展的“重新加载”。
- **Native Companion**：用新版文件更新原目录，重新执行 `npm ci --omit=dev` 和对应的 `install-host` 命令，然后重启浏览器与桌面端。

更新扩展后应再次检查扩展 ID。如果 ID 变化，必须使用新 ID 重新安装 Native Companion。

### 8. 卸载

1. 在 Windows“设置 → 应用 → 已安装的应用”中卸载“秋招投递管理器”。
2. 在浏览器扩展管理页移除“秋招网申助手”。
3. 在 Native Companion 目录执行对应命令，删除浏览器注册信息：

```powershell
npm run uninstall-host -- --browser edge
# 或
npm run uninstall-host -- --browser chrome
```

卸载程序不等于清除全部求职数据。手工删除应用数据目录前，请先通过桌面端或扩展导出 JSON 备份。

### 常见安装问题

| 现象 | 检查方法 |
|---|---|
| 浏览器无法选择 ZIP | 必须先解压，再选择包含 `manifest.json` 的目录 |
| 找不到“加载已解压的扩展” | 先打开扩展管理页右上角的“开发者模式” |
| 提示本地邮箱组件未安装 | 检查 Node.js 版本、是否执行过 `npm ci --omit=dev` 和 `install-host` |
| Native Host 无法连接 | 核对安装命令中的浏览器类型和扩展 ID，移动过目录时重新安装 |
| 扩展有记录但桌面端没有 | 重启两端并检查桌面端本机同步状态；确认 Native Companion 已安装 |
| 更新扩展后功能仍是旧版 | 在扩展管理页点击“重新加载”，必要时重新打开相关招聘网页 |

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
