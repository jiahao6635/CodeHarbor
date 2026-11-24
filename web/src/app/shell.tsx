import {
  ClipboardText,
  GitBranch,
  Key,
  List,
  LockKey,
  Moon,
  Plugs,
  Pulse,
  ShieldCheck,
  SignOut,
  Sun,
  UsersThree,
  X,
} from '@phosphor-icons/react';
import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router';
import { useAbility, useSession } from '@/auth/session';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/cn';
import { useTheme } from './theme';

interface NavItem {
  to: string;
  label: string;
  icon: typeof GitBranch;
  end?: boolean;
}

const PRIMARY: NavItem[] = [
  { to: '/repositories', label: '仓库', icon: GitBranch },
  { to: '/keys', label: 'Key', icon: Key },
  { to: '/onboarding', label: '云效凭证', icon: LockKey },
  { to: '/mcp', label: 'MCP 接入', icon: Plugs },
];

const ADMIN: NavItem[] = [
  { to: '/admin/repositories', label: '仓库', icon: GitBranch },
  { to: '/admin/users', label: '用户', icon: UsersThree },
  { to: '/admin/keys', label: 'Key', icon: Key },
  { to: '/admin/audit', label: '审计', icon: ClipboardText },
  { to: '/admin/performance', label: '运行状态', icon: Pulse },
];

function NavGroup({ title, items, collapsed }: { title?: string; items: NavItem[]; collapsed: boolean }) {
  return (
    <div className="flex flex-col gap-0.5">
      {title && !collapsed ? (
        <p className="mb-1 px-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">{title}</p>
      ) : null}
      {items.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          end={item.end}
          title={collapsed ? item.label : undefined}
          className={({ isActive }) =>
            cn(
              'relative flex h-9 items-center gap-3 rounded-sm px-3 text-sm font-medium text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground',
              isActive &&
                'bg-muted text-foreground before:absolute before:top-1.5 before:bottom-1.5 before:left-0 before:w-0.5 before:rounded-full before:bg-accent',
              collapsed && 'justify-center px-0',
            )
          }
        >
          <item.icon className="size-5 shrink-0" aria-hidden="true" />
          {collapsed ? <span className="sr-only">{item.label}</span> : <span>{item.label}</span>}
        </NavLink>
      ))}
    </div>
  );
}

export function AppShell() {
  const { me, signOut } = useSession();
  const { isAdmin } = useAbility();
  const { theme, toggle } = useTheme();
  const location = useLocation();
  const [drawerOpen, setDrawerOpen] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: close the mobile drawer on every navigation
  useEffect(() => setDrawerOpen(false), [location.pathname]);

  const sidebar = (collapsed: boolean) => (
    <nav aria-label="主导航" className="flex flex-1 flex-col gap-6">
      <NavGroup items={PRIMARY} collapsed={collapsed} />
      {isAdmin ? (
        <NavGroup title="管理" items={ADMIN.map((item) => ({ ...item, icon: item.icon }))} collapsed={collapsed} />
      ) : null}
    </nav>
  );

  return (
    <div className="flex min-h-dvh">
      {/* Desktop sidebar: full at >=1280px, icon rail between 1024px and 1280px, hidden below. */}
      <aside className="hidden w-14 shrink-0 flex-col border-r border-border bg-sidebar p-2 lg:flex xl:w-60 xl:p-3">
        <div className="mb-6 flex h-9 items-center gap-2 px-1 xl:px-2">
          <ShieldCheck className="size-6 shrink-0 text-accent" weight="duotone" aria-hidden="true" />
          <span className="hidden text-base font-semibold xl:inline">CodeHarbor</span>
        </div>
        <div className="hidden flex-1 xl:flex">{sidebar(false)}</div>
        <div className="flex flex-1 xl:hidden">{sidebar(true)}</div>
      </aside>

      {/* Mobile drawer */}
      {drawerOpen ? (
        <div className="fixed inset-0 z-40 lg:hidden">
          <button
            type="button"
            className="absolute inset-0 bg-[rgba(2,6,23,0.6)]"
            aria-label="关闭导航"
            onClick={() => setDrawerOpen(false)}
          />
          <aside className="absolute inset-y-0 left-0 flex w-60 flex-col border-r border-border bg-sidebar p-3 shadow-xl">
            <div className="mb-6 flex h-9 items-center justify-between px-2">
              <span className="flex items-center gap-2 text-base font-semibold">
                <ShieldCheck className="size-6 text-accent" weight="duotone" aria-hidden="true" />
                CodeHarbor
              </span>
              <Button variant="ghost" size="icon-sm" aria-label="关闭导航" onClick={() => setDrawerOpen(false)}>
                <X />
              </Button>
            </div>
            {sidebar(false)}
          </aside>
        </div>
      ) : null}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-12 items-center gap-3 border-b border-border bg-background/95 px-4 backdrop-blur-sm">
          <Button
            variant="ghost"
            size="icon-sm"
            className="lg:hidden"
            aria-label="打开导航"
            onClick={() => setDrawerOpen(true)}
          >
            <List />
          </Button>
          <div className="min-w-0 flex-1" />
          {me ? (
            <div className="flex min-w-0 items-center gap-2 text-sm">
              <span className="hidden truncate font-medium sm:inline">{me.username}</span>
              <Badge tone={isAdmin ? 'accent' : 'neutral'}>{isAdmin ? '超级管理员' : '成员'}</Badge>
            </div>
          ) : null}
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={toggle}
            aria-label={theme === 'dark' ? '切换到浅色主题' : '切换到深色主题'}
          >
            {theme === 'dark' ? <Sun /> : <Moon />}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => void signOut()}>
            <SignOut aria-hidden="true" />
            退出
          </Button>
        </header>
        <main className="mx-auto w-full max-w-[1280px] flex-1 p-4 sm:p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
