import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** The encryption key must be supplied independently of the database. */
export class CredentialCipher {
  private readonly key: Buffer;

  constructor(key: Buffer) {
    if (key.length !== 32) throw new Error('Credential encryption key must be 32 bytes');
    this.key = Buffer.from(key);
  }

  encrypt(plaintext: string, ownerId: string): string {
    if (!plaintext || !ownerId) throw new Error('Credential and owner are required');
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(ownerId, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return [
      'v1',
      iv.toString('base64url'),
      cipher.getAuthTag().toString('base64url'),
      ciphertext.toString('base64url'),
    ].join('.');
  }

  decrypt(encoded: string, ownerId: string): string {
    try {
      const parts = encoded.split('.');
      if (parts.length !== 4 || parts[0] !== 'v1' || !ownerId || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) {
        throw new Error();
      }
      const iv = Buffer.from(parts[1], 'base64url');
      const tag = Buffer.from(parts[2], 'base64url');
      const ciphertext = Buffer.from(parts[3], 'base64url');
      if (iv.length !== 12 || tag.length !== 16 || ciphertext.length === 0) throw new Error();
      const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
      decipher.setAAD(Buffer.from(ownerId, 'utf8'));
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    } catch {
      throw new Error('Unable to decrypt credential');
    }
  }
}

export function createAccessKey(): { token: string; hash: string; prefix: string } {
  const token = `ch_${randomBytes(32).toString('base64url')}`;
  return { token, hash: hashAccessKey(token), prefix: token.slice(0, 11) };
}

export function hashAccessKey(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}
