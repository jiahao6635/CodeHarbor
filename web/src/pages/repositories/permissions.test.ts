import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { beforeEach, expect, it, vi } from 'vitest';
import type { Me } from '@/api/types';
import { useAbility } from '@/auth/session';
import RepositoriesPage from './list';
import RepositoryNewPage from './new';

const hooks = vi.hoisted(() => ({
  useRepositories: vi.fn(),
  useCodeupRepositories: vi.fn(),
  useCreateRepository: vi.fn(),
  mutate: vi.fn(),
}));

vi.mock('@/api/hooks', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/hooks')>()),
  ...hooks,
}));
vi.mock('@/auth/session', () => ({ useAbility: vi.fn() }));

function setAbility(role: Me['role'], hasPat: boolean) {
  const me: Me = { id: 'user-123', username: 'Test User', role, has_pat: hasPat };
  vi.mocked(useAbility).mockReturnValue({ me, hasPat, isAdmin: role === 'super_admin' });
}

function render(page: ReactElement) {
  const client = new QueryClient();
  return renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(MemoryRouter, null, page)));
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
});

it.each(['member', 'super_admin'] as const)('directs an unbound %s to bind PAT', (role) => {
  setAbility(role, false);
  const list = render(createElement(RepositoriesPage));
  const page = render(createElement(RepositoryNewPage));
  expect(list).toContain('需要绑定云效 PAT');
  expect(page).toContain('href="/onboarding"');
  expect(page).not.toContain('<form');
  expect(hooks.useCodeupRepositories).not.toHaveBeenCalled();
});

it.each(['member', 'super_admin'] as const)('offers repo and branch selection to a PAT-bound %s', (role) => {
  setAbility(role, true);
  const page = render(createElement(RepositoryNewPage));
  expect(page).toContain('从云效列表选择');
  expect(page).toContain('输入仓库 ID');
  expect(page).toContain('选择分支');
  expect(page).not.toContain('value="main"');
  expect(hooks.useCodeupRepositories).toHaveBeenCalledWith(1, true);
  expect(hooks.mutate).not.toHaveBeenCalled();
});
