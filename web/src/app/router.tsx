import { lazy, Suspense } from 'react';
import { createBrowserRouter, Navigate, RouterProvider } from 'react-router';
import { Skeleton } from '@/components/ui/skeleton';
import { RedirectIfSession, RequireAdmin, RequireSession } from './guards';
import { AppShell } from './shell';

const LoginPage = lazy(() => import('@/pages/login'));
const OnboardingPage = lazy(() => import('@/pages/onboarding'));
const RepositoriesPage = lazy(() => import('@/pages/repositories/list'));
const RepositoryNewPage = lazy(() => import('@/pages/repositories/new'));
const RepositoryDetailPage = lazy(() => import('@/pages/repositories/detail'));
const KeysPage = lazy(() => import('@/pages/keys'));
const McpPage = lazy(() => import('@/pages/mcp'));
const AdminRepositoriesPage = lazy(() => import('@/pages/admin/repositories'));
const AdminUsersPage = lazy(() => import('@/pages/admin/users'));
const AdminKeysPage = lazy(() => import('@/pages/admin/keys'));
const AdminAuditPage = lazy(() => import('@/pages/admin/audit'));
const AdminPerformancePage = lazy(() => import('@/pages/admin/performance'));
const NotFoundPage = lazy(() => import('@/pages/not-found'));
const RouteErrorPage = lazy(() => import('@/pages/error'));

function PageFallback() {
  return (
    <div role="status" className="flex flex-col gap-4" aria-busy="true" aria-label="加载中">
      <Skeleton className="h-7 w-48" />
      <Skeleton className="h-4 w-96 max-w-full" />
      <Skeleton className="h-64 w-full" />
    </div>
  );
}

const page = (element: React.ReactNode) => <Suspense fallback={<PageFallback />}>{element}</Suspense>;

const router = createBrowserRouter(
  [
    {
      errorElement: page(<RouteErrorPage />),
      children: [
        {
          path: '/login',
          element: page(
            <RedirectIfSession>
              <LoginPage />
            </RedirectIfSession>,
          ),
        },
        {
          element: <RequireSession />,
          children: [
            {
              element: <AppShell />,
              children: [
                { index: true, element: <Navigate to="/repositories" replace /> },
                { path: 'repositories', element: page(<RepositoriesPage />) },
                { path: 'repositories/new', element: page(<RepositoryNewPage />) },
                { path: 'repositories/:id', element: page(<RepositoryDetailPage />) },
                { path: 'onboarding', element: page(<OnboardingPage />) },
                { path: 'keys', element: page(<KeysPage />) },
                { path: 'mcp', element: page(<McpPage />) },
                {
                  path: 'admin',
                  element: <RequireAdmin />,
                  children: [
                    { index: true, element: <Navigate to="/admin/repositories" replace /> },
                    { path: 'repositories', element: page(<AdminRepositoriesPage />) },
                    { path: 'users', element: page(<AdminUsersPage />) },
                    { path: 'keys', element: page(<AdminKeysPage />) },
                    { path: 'audit', element: page(<AdminAuditPage />) },
                    { path: 'performance', element: page(<AdminPerformancePage />) },
                  ],
                },
                { path: '*', element: page(<NotFoundPage />) },
              ],
            },
          ],
        },
      ],
    },
  ],
  { basename: '/ui' },
);

export function AppRouter() {
  return <RouterProvider router={router} />;
}
