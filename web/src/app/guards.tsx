import { Navigate, Outlet, useLocation } from 'react-router';
import { useAbility, useSession } from '@/auth/session';
import { ErrorNotice } from '@/components/error-notice';
import { Button } from '@/components/ui/button';

function SessionStatus() {
  const { error, refreshSession } = useSession();
  return (
    <main className="mx-auto max-w-lg space-y-3 p-6">
      {error ? (
        <>
          <ErrorNotice error={error} title="无法检查登录状态" />
          <Button variant="secondary" onClick={() => void refreshSession().catch(() => undefined)}>
            重试
          </Button>
        </>
      ) : (
        <p role="status">正在检查登录状态…</p>
      )}
    </main>
  );
}

export function RequireSession() {
  const { me, loading, error } = useSession();
  const location = useLocation();
  if (!me && (loading || error)) return <SessionStatus />;
  if (!me) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  return <Outlet />;
}

export function RequireAdmin() {
  const { isAdmin } = useAbility();
  if (!isAdmin) return <Navigate to="/repositories" replace />;
  return <Outlet />;
}

export function RedirectIfSession({ children }: { children: React.ReactNode }) {
  const { me, loading } = useSession();
  if (loading) return <SessionStatus />;
  if (me) return <Navigate to="/repositories" replace />;
  return children;
}
