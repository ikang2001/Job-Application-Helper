export function validateEnvelope(deviceId, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidEnvelope();
  if (
    value.schemaVersion !== 1
    || value.deviceId !== deviceId
    || !Number.isSafeInteger(value.revision)
    || value.revision <= 0
    || typeof value.updatedAt !== 'string'
    || !Number.isFinite(Date.parse(value.updatedAt))
    || value.algorithm !== 'A256GCM'
    || !validBase64Url(value.iv, 16, 24)
    || !validBase64Url(value.authTag, 20, 28)
    || !validBase64Url(value.ciphertext, 1, 7_000_000)
  ) {
    throw invalidEnvelope();
  }
}

export function validDeviceId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(value);
}

function validBase64Url(value, minimum, maximum) {
  return typeof value === 'string'
    && value.length >= minimum
    && value.length <= maximum
    && /^[A-Za-z0-9_-]+$/.test(value);
}

function invalidEnvelope() {
  const error = new Error('加密快照格式无效');
  error.code = 'INVALID_ENVELOPE';
  return error;
}
