import { defineConfig } from 'vite';

// 仅回归页使用公开组件资产；不代理招聘 API，不转发用户登录信息。
export default defineConfig({
  server: {
    host: '127.0.0.1', port: 5182, strictPort: true,
    proxy: {
      '/ats-assets/': {
        target: 'https://apply.vendor.example', changeOrigin: true,
        rewrite: path => path.replace('/ats-assets/', '/schoolOut/assets/'),
      },
    },
  },
});
