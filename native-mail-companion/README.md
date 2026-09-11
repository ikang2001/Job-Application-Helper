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
