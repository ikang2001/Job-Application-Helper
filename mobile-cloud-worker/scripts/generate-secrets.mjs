import { generateKeyPairSync, randomBytes } from 'node:crypto';

const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const jwk = privateKey.export({ format: 'jwk' });
if (!jwk.x || !jwk.y || !jwk.d) throw new Error('无法生成完整的 VAPID 密钥');

const publicKey = Buffer.concat([
  Buffer.from([0x04]),
  Buffer.from(jwk.x, 'base64url'),
  Buffer.from(jwk.y, 'base64url'),
]).toString('base64url');

console.log('请立即保存以下值，不要提交到 Git：');
console.log(`MOBILE_SYNC_ADMIN_TOKEN=${randomBytes(32).toString('base64url')}`);
console.log(`VAPID_SERVER_PUBLIC_KEY=${publicKey}`);
console.log(`VAPID_SERVER_PRIVATE_KEY=${jwk.d}`);
console.log(`PUSHPLUS_CONFIG_ENCRYPTION_KEY=${randomBytes(32).toString('base64url')}`);
