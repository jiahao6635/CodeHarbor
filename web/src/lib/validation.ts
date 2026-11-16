import { z } from 'zod';

// Mirrors src/http/validation.ts and src/routes/repositories.ts on the server.
const GIT_REF_FORBIDDEN = /[ ~^:?*[]/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
const CONTROL_CHARACTERS = /[\x00-\x1f\x7f]/;

export const branchName = z
  .string()
  .trim()
  .min(1, '请输入分支名')
  .max(255, '分支名过长')
  .refine((value) => !CONTROL_CHARACTERS.test(value), '分支名包含非法字符')
  .refine(
    (value) =>
      !value.startsWith('-') &&
      !value.includes('..') &&
      !value.includes('\\') &&
      !value.includes('@{') &&
      !GIT_REF_FORBIDDEN.test(value),
    '不是有效的 Git 分支名',
  );

export const codeupRepositoryId = z
  .string()
  .trim()
  .regex(/^\d{1,30}$/, '云效仓库 ID 必须是数字');

export const identifier = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/, '不是有效的仓库 ID');

export const accessKey = z
  .string()
  .trim()
  .min(1, '请输入 CodeHarbor Key')
  .max(512, 'Key 过长')
  .refine((value) => !CONTROL_CHARACTERS.test(value), 'Key 包含非法字符');

export const pat = z
  .string()
  .min(1, '请输入云效个人访问令牌')
  .max(4096, '令牌过长')
  .refine((value) => !CONTROL_CHARACTERS.test(value), '令牌包含非法字符');

export const EXPIRY_OPTIONS = [
  { label: '1 天', seconds: 86_400 },
  { label: '7 天', seconds: 7 * 86_400 },
  { label: '30 天', seconds: 30 * 86_400 },
  { label: '90 天', seconds: 90 * 86_400 },
] as const;

export const MAX_EXPIRES_IN = 90 * 86_400;
