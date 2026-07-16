import { createHash, timingSafeEqual } from 'node:crypto';

const PHP_PASSWORD_SALT_LENGTH = 9;
const PHP_SHA1_LENGTH = 40;
const PHP_PASSWORD_HASH_LENGTH = PHP_PASSWORD_SALT_LENGTH + PHP_SHA1_LENGTH;
const BCRYPT_HASH_PATTERN = /^\$2[aby]\$\d{2}\$/;

/**
 * PHP's legacy PwdHash format is:
 *   9-character salt + SHA1(plainPassword + salt)
 *
 * The salt was generated from an MD5 digest, so the stored legacy value is
 * 49 hexadecimal characters long.
 */
export function isLegacyPhpPasswordHash(value: string): boolean {
  return (
    value.length === PHP_PASSWORD_HASH_LENGTH &&
    /^[a-f0-9]+$/i.test(value)
  );
}

export function isBcryptPasswordHash(value: string): boolean {
  return BCRYPT_HASH_PATTERN.test(value);
}

export function verifyLegacyPhpPassword(
  plainPassword: string,
  storedHash: string,
): boolean {
  if (!isLegacyPhpPasswordHash(storedHash)) return false;

  const salt = storedHash.slice(0, PHP_PASSWORD_SALT_LENGTH);
  const digest = createHash('sha1')
    .update(plainPassword + salt)
    .digest('hex');
  const expectedHash = salt + digest;

  return timingSafeEqual(
    Buffer.from(expectedHash, 'utf8'),
    Buffer.from(storedHash, 'utf8'),
  );
}
