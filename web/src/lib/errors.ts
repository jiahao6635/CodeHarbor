/** Fixed server error codes (src/http/errors.ts) mapped to operator-facing explanations. */
const MESSAGES: Record<string, string> = {
  UNAUTHENTICATED: '身份验证失败：Key 无效、已过期或已撤销。',
  INVALID_CREDENTIAL: '云效 PAT 无效，或缺少读取用户与仓库列表的权限。',
  FORBIDDEN: '当前 Key 没有执行此操作的权限。',
  NOT_FOUND: '资源不存在，或当前身份无权访问。',
  CONFLICT: '当前状态不允许此操作。',
  RATE_LIMITED: '请求过于频繁，请稍后再试。',
  INVALID_ARGUMENT: '请求参数无效。',
  INVALID_JSON: '请求内容不是有效的 JSON。',
  INVALID_REQUEST: '请求无效。',
  REPOSITORY_SCOPE_REQUIRED: '下级 read Key 必须指定仓库范围。',
  BODY_TOO_LARGE: '请求内容过大。',
  UNSUPPORTED_MEDIA_TYPE: '请求格式不受支持。',
  CODEUP_UNAVAILABLE: '云效服务暂时不可用。',
  AUTHORIZATION_UNAVAILABLE: '授权服务暂时不可用，请稍后重试。',
  INTERNAL_ERROR: '服务内部错误。',
  NETWORK_ERROR: '无法连接到服务，请检查网络后重试。',
};

export function describeError(code: string): string {
  return MESSAGES[code] ?? `未知错误（${code}）`;
}

/** Repository and job error codes recorded by the index worker. */
const REPOSITORY_ERRORS: Record<string, string> = {
  SYNC_AUTHORIZATION_REQUIRED: '同步凭证持有人重新绑定了 PAT，需要重新授权自动同步。',
  BRANCH_DELETED: '远端分支已被删除，索引保留上一次成功的版本。',
  DISABLED_BY_ADMIN: '仓库已被管理员禁用。',
  INDEX_FAILED: '索引构建失败，保留上一次成功的索引。',
};

export function describeRepositoryError(code: string | null): string | null {
  if (!code) return null;
  return REPOSITORY_ERRORS[code] ?? code;
}
