# 邮箱连接修复版：保留数据升级

配套版本：扩展 1.1.41、桌面端 1.1.36、Native Companion 1.1.2。

下载地址：[v1.1.41 发布页](https://github.com/ikang2001/Job-Application-Helper/releases/tag/v1.1.41)。请使用同一发布页中的三个组件及对应校验文件。

## 修复范围

此前每下载一封正文都会重新启动本地组件并登录邮箱，可能触发服务商登录限流；服务端的 `Too many login attempts` 又被显示成笼统的 `Command failed`。
本版一轮扫描复用一个组件进程和一条 IMAP 连接，同账号串行执行。插件与桌面端互斥扫描，重复点击合并；限流后等待 30、60、120 分钟，显示下一次重试时间，到期自动恢复。成功访问后重置退避。这些是应用的重试间隔，不保证邮箱服务商届时解封。

普通网络／认证／限流失败不清空有效游标。每个完整页面先保存审核结果，再保存游标，后续页失败不会跳过。已有审核邮件不重复下载正文，仍可使用本地摘要补齐时间与匹配公司；确认／忽略状态不会被扫描覆盖。邮件继续只读，不标记已读。

招聘识别、岗位匹配和日期提取规则、投递管理、提醒与本机同步规则不在此次修改范围。

## 先保留回退与数据

1. 备份 `%APPDATA%\job-application-helper-desktop` 和 `%LOCALAPPDATA%\JobApplicationHelper`；不要把这些含隐私的备份上传 Git。
2. 在插件的数据备份页导出个人数据；另保留浏览器当前用户目录中该扩展的 `Local Extension Settings/<扩展ID>`。关闭浏览器后复制可得到稳定的 LevelDB 文件备份。
3. 记下当前扩展 ID、已加载扩展目录、Native 组件目录与桌面安装目录，保留旧安装包。
4. 不要卸载扩展、删除浏览器配置、删除邮箱账号或清空桌面数据。授权码留在操作系统凭据库，不需要再次输入。

## 按顺序更新三个组件

1. 从托盘真正退出旧桌面端，关闭其他正在扫描此邮箱的客户端；先在扩展管理页暂时关闭该扩展（不要删除）。
2. 校验三个压缩包／安装包 SHA256。解压 Native Companion 到原组件目录或一个固定的新目录，在其中执行 `npm ci --omit=dev`。包内包含已构建的 `dist`，不需要再次构建。若更换组件目录，在该目录执行：

   ```powershell
   npm run install-host -- --browser edge --extension-id <原扩展ID>
   ```

   Chrome 使用 `--browser chrome`。注册脚本只更新启动器与注册信息，不清空邮箱账号、凭据或投递数据。不要把临时解压目录删除，否则组件启动路径会失效。

3. 解压扩展包，将文件覆盖到**原来加载扩展的同一个目录**，然后在 `edge://extensions` / `chrome://extensions` 启用并重新加载原扩展。确认版本是 1.1.41、扩展 ID 不变。不要“删除再重新添加”，也不要另选新目录加载成另一个扩展，否则看起来会像没有旧数据。
4. 运行 `job-application-helper-desktop-1.1.36-setup.exe`，安装到原桌面目录后启动。安装程序不需要删除 `%APPDATA%` 或 `%LOCALAPPDATA%` 下的数据。
5. 核对原有岗位、收藏、笔试／面试安排、已确认／忽略审核记录及其状态均在。首次仅手动扫描一次；若显示限流与重试时间，保持应用运行等待自动恢复，不连续点击连接或测试，不反复更换授权码。

新版客户端若提示 Native 组件不支持会话，请完成第 2 步，不能只更新桌面端。

## 校验与回退

用 PowerShell 对照 `.sha256` 文件：

```powershell
Get-FileHash -Algorithm SHA256 -LiteralPath .\job-application-helper-desktop-1.1.36-setup.exe
Get-FileHash -Algorithm SHA256 -LiteralPath .\job-application-helper-extension.zip
Get-FileHash -Algorithm SHA256 -LiteralPath .\job-application-helper-native-mail-companion.zip
```

如需回退，先关闭三个组件，恢复旧组件文件并覆盖安装旧桌面包。此版本没有迁移业务数据，不应通过删除用户数据来回退。不要在新增投递后直接用旧备份覆盖当前数据，以免丢失升级后的新增记录。

下载或更新源码不等于正在运行的桌面端和扩展已经升级。请按以上步骤覆盖更新，以各自界面上的版本号为准；不需要卸载扩展或清除已有数据。
