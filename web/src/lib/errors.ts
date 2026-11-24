/** Fixed server error codes (src/http/errors.ts) mapped to operator-facing explanations. */
const MESSAGES: Record<string, string> = {
  UNAUTHENTICATED: '登录已失效，请重新使用飞书登录。',
  INVALID_CREDENTIAL: '云效 PAT 无效，或缺少读取用户与仓库列表的权限。',
  FORBIDDEN: '当前账号没有执行此操作的权限。',
  NOT_FOUND: '资源不存在，或当前身份无权访问。',
  CODEUP_ACCOUNT_CONFLICT: '该云效账号已关联其他用户，或你已绑定另一个云效账号。',
  LEGACY_KEY_INELIGIBLE: '此旧 Key 已撤销、过期、未限定仓库，或持有人尚未认领账号。',
  PAT_REQUIRED: '请先绑定云效 PAT。',
  PAT_INVALID: '云效 PAT 已失效，请重新绑定。',
  PAT_CHANGED: '云效 PAT 已更新，请重试。',
  CODEUP_BRANCH_SCOPE_REQUIRED: '无法读取分支。请确认 PAT 已开通代码管理的分支只读权限。',
  BRANCH_NOT_FOUND: '该分支已不可用。请刷新并重新选择分支。',
  REPOSITORY_BRANCH_CONFLICT: '仓库已接入并跟踪另一个分支。',
  LAST_SUPER_ADMIN: '至少保留一位启用的超级管理员。',
  CONFLICT: '当前状态不允许此操作。',
  RATE_LIMITED: '请求过于频繁，请稍后再试。',
  INVALID_ARGUMENT: '请求参数无效。',
  INVALID_JSON: '请求内容不是有效的 JSON。',
  INVALID_REQUEST: '请求无效。',
  REPOSITORY_SCOPE_REQUIRED: '请为 API Key 至少选择一个仓库。',
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
