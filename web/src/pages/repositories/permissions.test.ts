import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Me, Repository } from '@/api/types';
import { useAbility } from '@/auth/session';
import OnboardingPage from '@/pages/onboarding';
import RepositoriesPage from './list';
import RepositoryNewPage from './new';

const hooks = vi.hoisted(() => ({
  useRepositories: vi.fn(),
  useCodeupRepositories: vi.fn(),
  useCreateRepository: vi.fn(),
  useSyncRepository: vi.fn(),
  mutate: vi.fn(),
}));

vi.mock('@/api/hooks', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/hooks')>()),
  ...hooks,
}));
vi.mock('@/auth/session', () => ({
  useAbility: vi.fn(),
  useSession: () => ({ signIn: vi.fn() }),
}));

function setAbility(scope: Me['key_scope'], repos: Me['key_repos'], canWrite: boolean) {
  const me: Me = {
    id: 'user-123',
    username: 'Test User',
    key_scope: scope,
    key_prefix: 'ch_test',
    key_repos: repos,
    key_expires_at: null,
    can_write: canWrite,
    is_admin: canWrite && repos === null,
  };
  vi.mocked(useAbility).mockReturnValue({
    me,
    canWrite,
    isAdmin: me.is_admin,
    isUnrestricted: repos === null,
  });
}

function render(page: ReactElement) {
  return renderToStaticMarkup(createElement(MemoryRouter, null, page));
}

beforeEach(() => {
  vi.clearAllMocks();
  hooks.useRepositories.mockReturnValue({ data: [], isPending: false, isError: false });
  hooks.useCodeupRepositories.mockReturnValue({
    data: { repositories: [], next_page: null },
    isPending: false,
    isError: false,
  });
  hooks.useCreateRepository.mockReturnValue({ mutate: hooks.mutate, isPending: false });
  hooks.useSyncRepository.mockReturnValue({ mutate: hooks.mutate, isPending: false });
});

const deniedCases: {
  name: string;
  scope: Me['key_scope'];
  repos: Me['key_repos'];
  canWrite: boolean;
  keyStatus: string;
  whitelistStatus: string;
  rangeStatus: string;
}[] = [
  {
    name: 'read Key with unknown whitelist membership',
    scope: 'read',
    repos: null,
    canWrite: false,
    keyStatus: '未满足，当前为 read 类型',
    whitelistStatus: '待确认，当前 Key 无法判断白名单状态',
    rangeStatus: '已满足。',
  },
  {
    name: 'restricted read Key',
    scope: 'read',
    repos: [],
    canWrite: false,
    keyStatus: '未满足，当前为 read 类型',
    whitelistStatus: '待确认，当前 Key 无法判断白名单状态',
    rangeStatus: '未满足，请更换不限定仓库范围的 Key。',
  },
  {
    name: 'write Key outside the whitelist',
    scope: 'write',
    repos: null,
    canWrite: false,
    keyStatus: '已满足。',
    whitelistStatus: '未满足，请联系平台管理员添加。',
    rangeStatus: '已满足。',
  },
  {
    name: 'restricted write Key outside the whitelist',
    scope: 'write',
    repos: ['repo-1'],
    canWrite: false,
    keyStatus: '已满足。',
    whitelistStatus: '未满足，请联系平台管理员添加。',
    rangeStatus: '未满足，请更换不限定仓库范围的 Key。',
  },
  {
    name: 'whitelisted but restricted write Key',
    scope: 'write',
    repos: ['repo-1'],
    canWrite: true,
    keyStatus: '已满足。',
    whitelistStatus: '已满足。',
    rangeStatus: '未满足，请更换不限定仓库范围的 Key。',
  },
];

describe.each(deniedCases)('$name', ({ scope, repos, canWrite, keyStatus, whitelistStatus, rangeStatus }) => {
  it('shows clickable entries and the same persistent requirements on both pages', () => {
    setAbility(scope, repos, canWrite);
    const list = render(createElement(RepositoriesPage));
    expect(list).toMatch(/<a[^>]*href="\/repositories\/new"[^>]*>[\s\S]*?接入仓库<\/a>/);
    expect(list).toMatch(/<a[^>]*href="\/repositories\/new"[^>]*>接入第一个仓库<\/a>/);

    const page = render(createElement(RepositoryNewPage));
    for (const markup of [list, page]) {
      expect(markup).toContain('当前 Key 无法接入仓库');
      expect(markup).toContain(`write 类型 Key：${keyStatus}`);
      expect(markup).toContain(`CODEHARBOR_WRITE_USERS 白名单中：${whitelistStatus}`);
      expect(markup).toContain(`Key 不限定仓库范围（key_repos = null）：${rangeStatus}`);
      expect(markup).toContain('云效用户 ID：user-123');
    }
    expect(page).toMatch(/<a[^>]*href="\/repositories"[^>]*>返回仓库列表<\/a>/);
    expect(page).not.toContain('<form');
    expect(page).not.toContain('从云效列表选择');
    expect(page).not.toContain('接入并开始构建');
    expect(hooks.useCodeupRepositories).not.toHaveBeenCalled();
    expect(hooks.useCreateRepository).not.toHaveBeenCalled();
    expect(hooks.mutate).not.toHaveBeenCalled();
  });
});

const repository: Repository = {
  repo_id: 'repo-1',
  codeup_id: '123',
  name: 'Test Repository',
  branch: 'main',
  status: 'ready',
  indexed_commit: null,
  indexed_at: null,
  stale: false,
  error: null,
  webhook_path: '/webhook',
};

it.each([
  { name: 'loading', query: { isPending: true } },
  { name: 'error', query: { isError: true, error: new Error('Offline') } },
  { name: 'non-empty', query: { data: [repository] } },
])('keeps the header entry and explanation visible for a $name list', ({ query }) => {
  setAbility('read', null, false);
  hooks.useRepositories.mockReturnValue(query);
  const markup = render(createElement(RepositoriesPage));
  expect(markup).toMatch(/<a[^>]*href="\/repositories\/new"[^>]*>[\s\S]*?接入仓库<\/a>/);
  expect(markup).toContain('当前 Key 无法接入仓库');
});

it('preserves the administrator picker and creation form', () => {
  setAbility('write', null, true);
  const list = render(createElement(RepositoriesPage));
  expect(list).toContain('接入第一个仓库');
  expect(list).not.toContain('当前 Key 无法接入仓库');
  const page = render(createElement(RepositoryNewPage));
  expect(page).not.toContain('当前 Key 无法接入仓库');
  expect(page).toContain('<form');
  expect(page).toContain('从云效列表选择');
  expect(page).toContain('输入仓库 ID');
  expect(page).toContain('接入并开始构建');
  expect(hooks.useCodeupRepositories).toHaveBeenCalledWith(1, true);
  expect(hooks.useCreateRepository).toHaveBeenCalledTimes(1);
  expect(hooks.mutate).not.toHaveBeenCalled();
});

it('explains that only a different PAT requires renewed authorization', () => {
  const page = render(createElement(OnboardingPage));
  expect(page).toContain('只有更换为不同的 PAT');
  expect(page).toContain('重新绑定同一个 PAT 不影响已有同步授权');
});
