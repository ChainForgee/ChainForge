import argon2 from 'argon2';
import type { HashOptions } from 'argon2';

const ARGON2ID_OPTIONS: HashOptions = {
  type: argon2.argon2id,
  memoryCost: 65536,
  timeCost: 3,
  parallelism: 1,
  hashLength: 32,
};

export function maskApiKeyPreview(rawKey: string): string {
  const prefix = rawKey.slice(0, 6);
  const suffix = rawKey.slice(-4);
  return `${prefix}...${suffix}`;
}

export function hashApiKey(rawKey: string): Promise<string> {
  return argon2.hash(rawKey, ARGON2ID_OPTIONS);
}

export function isArgon2idHash(
  value: string | null | undefined,
): value is string {
  return typeof value === 'string' && value.startsWith('$argon2id$');
}

export async function verifyApiKeyHash(
  hash: string | null | undefined,
  rawKey: string,
): Promise<boolean> {
  if (!isArgon2idHash(hash)) return false;

  try {
    return await argon2.verify(hash, rawKey);
  } catch {
    return false;
  }
}
