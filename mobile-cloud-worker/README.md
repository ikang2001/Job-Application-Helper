# Cloudflare 手机同步服务

该目录包含手机只读页面的 Cloudflare Workers + KV 后端。桌面端上传 AES-256-GCM 密文，Worker 保存设备令牌哈希和密文快照，不持有手机端解密密钥。

## 部署

```bash
npm ci
npm run generate:secrets
```

1. 复制 `wrangler.example.jsonc` 为 `wrangler.jsonc`。
2. 登录 Cloudflare：`npx wrangler login`。
3. 创建 KV：`npx wrangler kv namespace create MOBILE_SYNC_KV`，将返回的 ID 写入 `wrangler.jsonc`。
4. 将生成的 `VAPID_SERVER_PUBLIC_KEY` 写入 `wrangler.jsonc`，并修改 `VAPID_SUBJECT`。
5. 没有自定义域名时删除 `routes`；有域名时将 `jobs.example.com` 换成自己的域名。
6. 依次设置三个云端 Secret：

```bash
npx wrangler secret put MOBILE_SYNC_ADMIN_TOKEN
npx wrangler secret put VAPID_SERVER_PRIVATE_KEY
npx wrangler secret put PUSHPLUS_CONFIG_ENCRYPTION_KEY
```

最后执行：

```bash
npm run check
npm run deploy
```

部署后访问 `https://你的域名/api/health`，应返回 `ok: true`。在桌面端“手机查看”中填写服务地址和 `MOBILE_SYNC_ADMIN_TOKEN`，建立配对并扫码。

## 本地开发

复制 `.dev.vars.example` 为 `.dev.vars` 并填入生成的三个私密值，然后运行 `npm run dev`。`wrangler.jsonc` 和 `.dev.vars` 已被根目录 `.gitignore` 排除，禁止强制提交。

## 安全说明

- `MOBILE_SYNC_ADMIN_TOKEN` 是桌面端创建设备时使用的管理口令。
- `VAPID_SERVER_PRIVATE_KEY` 用于浏览器 Web Push 签名。
- `PUSHPLUS_CONFIG_ENCRYPTION_KEY` 用于加密保存用户的 PushPlus token。
- VAPID 公钥可以公开；私钥、管理口令、PushPlus 加密密钥必须只放在 Cloudflare Secret 或本机 `.dev.vars`。
- KV 免费版存在短暂的最终一致性延迟，手机刷新后即可读取最新快照。
