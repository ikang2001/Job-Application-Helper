# 手机只读同步服务

本目录是独立的密文中继，配合 `mobile-app/` 和桌面端 1.1.8 使用。服务端只保存 AES-256-GCM 密文；没有手机配对密钥，无法读取投递内容。

部署要求：Node.js 22 或 Docker、持久化磁盘、公开 HTTPS 地址。必须设置长度不少于 16 字符的 `MOBILE_SYNC_ADMIN_TOKEN`，并把 `MOBILE_SYNC_DATA_DIR` 指向持久化目录。不要把 8787 端口直接以 HTTP 暴露到公网，应由部署平台或 Caddy/Nginx 提供 HTTPS。

```powershell
$env:MOBILE_SYNC_ADMIN_TOKEN = '<随机长设置码>'
$env:MOBILE_SYNC_DATA_DIR = '<持久化目录>'
npm start
```

部署完成后，在桌面端点“手机查看”，填写公开 HTTPS 地址和同一个设置码，建立配对并扫码。设置码只负责创建配对；电脑持有写入令牌，手机二维码只包含读取令牌和端到端密钥。

生产环境需定期备份 `MOBILE_SYNC_DATA_DIR`。轮换设置码不会破坏已有设备；如怀疑手机配对链接泄露，应在桌面端更换服务/重新配对，并在云端删除对应随机设备 ID 的凭据和密文文件。
