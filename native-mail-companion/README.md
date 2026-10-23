# Native Companion

这是 `Job-Application-Helper` 的本机桥接组件：为 QQ、163、126 和其他支持 IMAP TLS 的邮箱提供只读访问，同时在 Edge 扩展与 Windows 桌面端之间自动同步投递记录。它不会发送、删除、移动邮件，也不会修改已读状态。

## 安装依赖与验证

```bash
npm ci
npm run check
```

## 安装到浏览器

先在 `chrome://extensions` 或 `edge://extensions` 查看扩展 ID，然后执行：

```bash
npm run install-host -- --browser chrome --extension-id <32位扩展ID>
npm run install-host -- --browser edge --extension-id <32位扩展ID>
```

Chrome 和 Edge 的扩展 ID 不同时，需要分别安装。更新源码后先重新运行 `npm run build`；Host manifest 指向本目录生成的启动器和 `dist/index.js`。

卸载：

```bash
npm run uninstall-host -- --browser chrome
npm run uninstall-host -- --browser edge
```

## 安全边界

- 邮箱授权码通过 Native Messaging 发送一次，并写入操作系统 Keyring。
- 非敏感账号配置写入当前用户配置目录，文件不含授权码。
- 只读取 INBOX；正文最多返回 256 KiB，附件不返回。
- 投递记录写入 `%LOCALAPPDATA%\JobApplicationHelper\application-records-sync.json`，按记录更新时间合并，并使用删除标记传播删除操作。
- 共享文件不包含 API Key、邮箱授权码、WebDAV 密码、简历文件或其他扩展设置。
- stdout 只承载 Native Messaging 帧，诊断信息写 stderr。
- Native Host 到扩展的单条响应严格限制在 1 MiB 内。

## 1.1.2 邮箱连接修复

- `PING` 可选返回 `capabilities: ["imap-session-v1"]`；新版客户端在扫描前验证能力，不支持时明确提示升级。
- `BEGIN_SESSION` / `END_SESSION` 在同一 Native Messaging 端口内复用一条 IMAP 连接；旧的单请求协议和本机投递同步保持兼容。
- `RATE_LIMITED` 与 `ACCOUNT_BUSY` 保留错误类型，可附带 ISO 格式 `retryAt`。限流采用 30、60、120 分钟应用重试间隔，成功访问后重置；不是服务商解封时间承诺。
- `%LOCALAPPDATA%\JobApplicationHelper\mail-runtime` 为独立运行状态目录，仅保存账号哈希对应的失败次数、冷却时间和占用进程号，不含邮箱地址、授权码和邮件正文。
- 同一邮箱跨进程使用 Windows 命名管道互斥，异常退出后系统自动释放；关闭端口、扫描结束或空闲超时会释放邮箱连接。
- 无需数据迁移、清空账号或重新授权。完整步骤见项目 `docs/mail-recovery-upgrade.md`。
