# 秋招投递管理器桌面端

该应用是浏览器扩展的独立 Windows 投递记录客户端。扩展负责网页识别与填表，桌面端负责记录查看、搜索、维护和同步。两者不直接访问对方的内部存储，而是通过 Native companion 管理的本机共享文件自动双向合并投递记录。

数据接入：

- 默认自动同步 `%LOCALAPPDATA%\JobApplicationHelper\application-records-sync.json`；桌面端监听文件变化，Edge 端保存后立即推送并定时拉取。
- 列表可直接切换投递状态并快捷填写备注；笔试、测评和面试分别记录独立时间与链接。保存后立即写入 Edge 共用记录文件，列表与详情页中的 HTTP/HTTPS 链接均可用系统默认浏览器直接打开。
- 导入扩展“导出完整数据”生成的 Backup V3 JSON；导入会替换桌面端当前记录。
- 导入/导出 Application Records CSV V1/V2；CSV 导入按 ID 和现有去重规则合并。
- 配置与扩展相同的 WebDAV 服务，通过 `job-application-helper/job-application-helper.json` 同步。

共享文件只包含投递记录、revision 和删除标记，不包含 API Key、邮箱授权码、WebDAV 密码、简历文件或扩展设置。WebDAV 是可选的异地备份；其密码使用 Electron `safeStorage` 交给 Windows 系统加密后保存。

开发命令：

```text
npm ci
npm run check
npm run smoke:main
npm run package:win
```

Windows 安装包输出到根项目 `release/desktop/`。
