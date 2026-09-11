# 后端工程化开发复盘汇总

> 随开发过程持续更新，只记录真实发生或有证据支持的事件。不得记录密钥、令牌、完整个人数据或敏感请求体。

## 1. 基本信息

| 项目 | 内容 |
|---|---|
| 项目/需求 | Job-Application-Helper 完整求职管理增强闭环 |
| 技术栈与环境 | TypeScript 6、React 19、Vite 8、Chrome Extension Manifest V3、Node 24 / Windows |
| 开始时间 | 2026-09-03 |
| 完成时间 | 2026-09-03（代码与自动化交付） |
| 当前结论 | 可交付；真实 OAuth/IMAP 与 Chrome/Edge 烟测需在用户账号环境执行 |
| 相关版本/提交 | 工作区未初始化独立 Git 提交历史 |

## 2. 结果摘要

- 交付内容：多模型/OpenAI Responses、投递生命周期、网页检测、邮箱监控、调度、Backup V3 和 Native companion 均已实现。
- 已完成验证：`npm run check:all`、`npm run package:all`、根项目与 Native companion 的 `npm audit` 均通过；两个独立 ZIP 和 SHA-256 已生成。
- 未完成验证：真实 OAuth 邮箱、真实 IMAP 账号、Native host 安装，以及 Chrome/Edge 手工烟测。
- 遗留风险：客户端 BYOK、外部 OAuth client ID 未配置、稳定扩展 ID 尚未确定。

## 3. 阶段摘要

| 阶段 | 完成内容 | 验证证据 | 新增事件数 | 遗留事项 |
|---|---|---|---:|---|
| Step 1 需求分析 | 已核对现有架构和完整规格范围 | 源码审计、规格 v0.3.0 | 0 | 外部账号只能做可配置交付 |
| Step 2 架构设计 | 模块按事件、网页检测、邮件 Provider、Native bridge 拆分 | 规格与实现边界一致 | 1 | 无 |
| Step 3 代码骨架 | Native companion 协议、存储和 IMAP adapter 已建立 | companion strict typecheck | 0 | 无 |
| Step 4 增量实现 | 多模型、OpenAI、网页事件、邮箱和 Native IMAP host 已实现 | 根项目全量测试；companion 12 tests + build | 1 | 外部账号验收 |
| Step 5 测试排错 | 修复同步假冲突、依赖公告和静态检查 warning | 全量回归、0-warning lint 与双项目 audit 通过 | 2 | 无 |
| Step 6 整合运维 | 完成构建、Native 入口修正、双 ZIP 和 SHA-256 | `check:all`、`package:all`、Native EOF 启动测试 | 1 | OAuth/Native/浏览器实机验证 |

## 4. 事件索引

| ID | 阶段 | 类型 | 标题 | 状态 | 结论 |
|---|---|---|---|---|---|
| DEV-001 | Step 5 | 犯错 | LLM 默认字段改变旧同步哈希 | 已解决 | 备份哈希读取保留旧存储形态 |
| DEV-002 | Step 5 | 踩坑 | npm ci 卡在 canvas 预编译下载 | 已解决 | 移除孤立原生依赖后干净安装通过 |
| DEV-003 | Step 6 | 预判风险 | 客户端直连无法安全保管 API Key | 遗留 | 支持 BYOK，同时建设本机 bridge 边界 |
| DEV-004 | Step 6 | 难点 | OAuth/Native 功能依赖外部注册和真实账户 | 外部验收待执行 | 代码可配置并用 mock/contract test 验证，实机需用户凭据 |
| DEV-005 | Step 5 | 预判风险 | 依赖审计存在高危公告 | 已解决 | 依赖升级、全量回归和双项目 audit 已通过 |
| DEV-006 | Step 4 | 犯错 | MIME 地址边界产生隐式 any | 已解决 | 第三方数据先收为 unknown 再用类型守卫 |
| DEV-007 | Step 4 | 犯错 | 隐私投影伪装为完整 UserProfile | 已解决 | 为外发最小视图定义专用类型 |

## 5. 事件详情

### DEV-001：LLM 默认字段改变旧同步哈希

| 字段 | 内容 |
|---|---|
| 日期/阶段 | 2026-09-03 / Step 5 |
| 模块 | LLM 配置、WebDAV Sync |
| 分类 | 犯错 |
| 状态 | 已解决 |
| 背景与目标 | 旧单模型配置规范化为模型列表和显式 API 模式 |
| 现象与证据 | 两个 backup-sync 用例从 synced 变为 conflict |
| 影响 | 用户升级后即使未改业务数据也可能出现虚假同步冲突 |
| 排查过程 | 对比本地、远端和 lastSyncedHash 的 canonical 数据 |
| 根因 | `getBackupData()` 在计算哈希前给旧配置补了默认字段 |
| 解决方案 | 只在运行时读取和显式保存 LLM 配置时规范化；同步哈希保留已存形态 |
| 涉及位置 | `src/shared/storage.ts` |
| 验证证据 | `src/shared/backup-sync.test.ts` 全部通过；随后 `npm test` 通过 |
| 残余风险 | 未来 Backup V3 仍需显式 hash schema/version |
| 预防措施 | 所有新增默认字段必须覆盖旧哈希等价性测试 |

### DEV-002：npm ci 卡在 canvas 预编译下载

| 字段 | 内容 |
|---|---|
| 日期/阶段 | 2026-09-03 / Step 5 |
| 模块 | 依赖安装 |
| 分类 | 踩坑 |
| 状态 | 已解决 |
| 背景与目标 | 从锁文件建立干净依赖树 |
| 现象与证据 | `npm ci` 曾长时间停在 `prebuild-install`，进程指向仅被孤立图标脚本使用的 canvas |
| 影响 | 干净环境安装耗时或失败，影响 CI 可重复性 |
| 排查过程 | 检查 Node 子进程和最终 `npm ls --depth=0` |
| 根因 | Node 24/Windows 下 canvas 预编译二进制获取不稳定 |
| 解决方案 | 移除未接入构建链的 `canvas` 和孤立图标生成脚本，保留已生成 PNG 与 SVG 源文件 |
| 涉及位置 | `package.json`、`package-lock.json`、`scripts/generate-icons.js` |
| 验证证据 | 干净 `npm ci --no-audit` 成功；随后 `npm run check:all` 通过 |
| 残余风险 | 若未来恢复自动 PNG 生成，需要选用可重复的跨平台渲染工具 |
| 预防措施 | 发布依赖不得包含未被构建或测试引用的原生模块 |

### DEV-003：客户端直连无法安全保管 API Key

| 字段 | 内容 |
|---|---|
| 日期/阶段 | 2026-09-03 / Step 6 |
| 模块 | LLM、Secret |
| 分类 | 预判风险 |
| 状态 | 遗留 |
| 背景与目标 | 浏览器扩展直接调用用户选择的模型服务 |
| 现象与证据 | Key 当前存于 `chrome.storage.local`，官方不建议在客户端暴露 Key |
| 影响 | 本机恶意扩展、调试环境或备份泄漏可获得 Key |
| 排查过程 | 核对 Storage、消息路由、Backup 和官方认证要求 |
| 根因 | 纯客户端架构没有可信 secret 边界 |
| 解决方案 | 个人 BYOK 明示风险；普通消息禁止返回 secret；新增 Native bridge/后端扩展点 |
| 涉及位置 | `src/shared/storage.ts`、`src/background/index.ts`、Backup、Native companion |
| 验证证据 | Backup V3、消息授权和最小化 Prompt 测试通过；README 已明示 BYOK 风险 |
| 残余风险 | BYOK 直连仍不能等价于服务端密钥保护 |
| 预防措施 | 限额 Key、轮换、secret 不进日志/备份、优先本机 bridge |

### DEV-004：OAuth/Native 功能依赖外部注册和真实账户

| 字段 | 内容 |
|---|---|
| 日期/阶段 | 2026-09-03 / Step 6 |
| 模块 | Gmail、Outlook、Native IMAP |
| 分类 | 难点 |
| 状态 | 外部验收待执行 |
| 背景与目标 | 交付可工作的多邮箱只读同步 |
| 现象与证据 | 仓库没有 Google/Microsoft OAuth client ID，也没有用户邮箱授权码 |
| 影响 | 无法在本环境完成真实账户端到端授权 |
| 排查过程 | 核对 manifest、Chrome Identity、Provider 注册要求和 Native Host ID 绑定 |
| 根因 | OAuth 和 IMAP 认证必须由实际账号持有人授权 |
| 解决方案 | 实现可配置 OAuth/PKCE、Provider adapter、mock/contract test 和安装说明；实机验证留明确清单 |
| 涉及位置 | `src/services/mail/`、`manifest.json`、`native-mail-companion/` |
| 验证证据 | Gmail/Outlook/Native IMAP provider、OAuth、cursor、错误隔离和调度测试均通过；真实授权尚未执行 |
| 残余风险 | 未提供真实 client ID/账号时只能完成离线契约验证 |
| 预防措施 | 不把 mock 通过描述成真实账号已验证 |

### DEV-005：依赖审计存在高危公告

| 字段 | 内容 |
|---|---|
| 日期/阶段 | 2026-09-03 / Step 5 |
| 模块 | 供应链 |
| 分类 | 预判风险 |
| 状态 | 已解决 |
| 背景与目标 | 发布前安全门禁 |
| 现象与证据 | `npm audit --package-lock-only --audit-level=high` 返回 2 high、1 moderate |
| 影响 | 恶意 PDF 等输入可能触发已知漏洞 |
| 排查过程 | 读取 npm audit 公告和受影响版本范围 |
| 根因 | 锁定的 PDF.js、nanoid、xmldom 版本落在受影响范围 |
| 解决方案 | 将 PDF.js 升级到修复版本，并用 overrides 固定 Mammoth/Vite 的受影响传递依赖 |
| 涉及位置 | `package.json`、`package-lock.json` |
| 验证证据 | 解析版本为 `pdfjs-dist 6.3.289`、`@xmldom/xmldom 0.8.15`、`nanoid 3.3.18`；`npm run check:all`、根项目及 Native companion 的 `npm audit` 通过 |
| 残余风险 | 仍需用真实复杂 PDF/DOCX 样本做浏览器侧人工回归 |
| 预防措施 | CI 增加 audit 门禁和依赖更新 SLA |

### DEV-006：MIME 地址边界产生隐式 any

| 字段 | 内容 |
|---|---|
| 日期/阶段 | 2026-09-03 / Step 4 |
| 模块 | Native companion / MIME 地址归一化 |
| 分类 | 犯错 |
| 状态 | 已解决 |
| 背景与目标 | 将 mailparser 的收件人对象转成字符串列表 |
| 现象与证据 | 首次 `npm run typecheck` 报 TS7006，共 3 处隐式 any |
| 影响 | strict 构建失败，第三方输入边界不清晰 |
| 排查过程 | 定位 `addressList()` 对未知数组元素的 map/filter 链 |
| 根因 | 对动态 `entry.value` 使用 Array.isArray 后未显式收窄元素类型 |
| 解决方案 | map 参数声明为 unknown，逐项检查 object/address，再用类型谓词收窄字符串 |
| 涉及位置 | `native-mail-companion/src/imapService.ts` |
| 验证证据 | `native-mail-companion: npm run check` 通过：strict typecheck、12 tests、build |
| 残余风险 | mailparser 的复杂 group address 仍需 fixture 覆盖 |
| 预防措施 | 所有第三方 MIME/JSON 输入统一从 unknown 开始验证 |

### DEV-007：隐私投影伪装为完整 UserProfile

| 字段 | 内容 |
|---|---|
| 日期/阶段 | 2026-09-03 / Step 4 |
| 模块 | LLM Prompt 隐私投影 |
| 分类 | 犯错 |
| 状态 | 已解决 |
| 背景与目标 | 从完整资料中删除当前表单不需要的身份证、手机、邮箱和简历附件 |
| 现象与证据 | `tsc` 报 TS2790：不能 delete 完整 PersonalInfo 的必填属性 |
| 影响 | 生产构建失败，且返回类型错误暗示视图仍是完整领域对象 |
| 排查过程 | 核对 UserProfile/PersonalInfo 的必填契约和 Prompt 实际消费方式 |
| 根因 | 最小化后的外发视图错误声明为 UserProfile |
| 解决方案 | 新增 LLMProfileContext，personal 使用 Partial，并从返回对象中结构性移除 resume |
| 涉及位置 | `src/services/llm/prompts.ts` |
| 验证证据 | 定向 LLM 测试和后续 `tsc -b` |
| 残余风险 | 新增高敏感字段时需同步更新投影策略 |
| 预防措施 | 外部协议 DTO 不复用完整持久化 Entity 类型 |

## 6. 分类汇总

### 踩坑

- DEV-002：原生 canvas 依赖影响干净安装稳定性。

### 犯过的错误

- DEV-001：在同步哈希边界进行运行时 normalization，制造业务等价数据的哈希漂移。

### 主要难点

- DEV-004：外部 OAuth/IMAP 认证无法靠本地 mock 代替真实授权。

## 7. 可复用解决经验

| 关联事件 | 问题模式 | 推荐解法 | 适用前提 | 不适用条件 | 验证方法 |
|---|---|---|---|---|---|
| DEV-001 | 新增默认字段导致同步哈希漂移 | 区分存储形态和运行时规范形态，或版本化 canonical hash | 旧数据参与冲突检测 | 明确执行一次性迁移并重建基线时 | 旧/新配置的四象限同步测试 |
| DEV-004 | 外部认证缺少真实凭据 | 交付可配置 adapter + contract test + 实机验收清单 | 凭据由用户持有 | 需要宣称真实账号已验证时 | 用户环境 smoke test |

## 8. 关键技术决策

| 决策 | 候选方案 | 最终选择 | 选择依据 | 代价/风险 |
|---|---|---|---|---|
| 投递生命周期 | 只保存 status / 事件溯源 | events 为事实、status 为投影 | 可追踪、可撤销、适合邮件乱序 | 迁移和 UI 更复杂 |
| 邮箱接入 | 扩展直连 IMAP / Native Messaging | OAuth API + Native companion | MV3 无普通 TCP socket | 需要外部安装和稳定扩展 ID |
| LLM 协议 | 全部 Chat / 显式多 transport | Responses + Chat + Claude | 兼容旧服务并支持官方 OpenAI | 测试矩阵扩大 |

## 9. 未解决问题与技术债

| 编号 | 问题 | 风险 | 临时措施 | 建议后续动作 | 优先级 |
|---|---|---|---|---|---|
| TD-001 | 客户端 BYOK | Key 可提取 | 明示风险、限制消息和备份 | 本机 bridge/后端 | P0 |
| TD-003 | OAuth 无 client ID | 真实邮箱不可授权 | 可配置占位 | 用户注册并填写 | P0 |

## 10. 最终复盘

### 做得好的地方

- 外部协议均收口到 adapter，核心状态变化使用确定性事件和幂等 source key。
- 新旧 OpenAI 协议、Backup 版本和旧投递记录均保留明确兼容路径。
- 两个发布包在生成时验证关键入口并输出 SHA-256，Native companion 保持独立门禁且 `dist/index.js` 可直接启动。

### 可以改进的地方

- React 19 的旧 test renderer 会输出弃用和 `act` 环境提示；不影响测试退出码，但后续应迁移到受支持的 DOM 测试方案。
- OAuth/IMAP 仍缺少真实账号 fixture，跨浏览器安装验证需要稳定扩展 ID。

### 下次直接复用的经验

- 先把外部响应规范化为领域事件，再修改业务记录，能同时守住幂等、撤销和错误隔离。
- Backup hash 必须基于稳定存储形态，运行时默认值不能隐式改变同步等价性。
- Native Messaging 的协议、凭据存储和安装器必须独立于扩展 ZIP 验证。

### 验证与已知限制

- 已完成验证：完整自动化闭环、lint、build、package、Native companion 和双项目 audit。
- 未完成验证：真实 OAuth/IMAP 账号、Native host 安装和 Chrome/Edge 手工烟测。
- 已知限制：见第 9 节。
