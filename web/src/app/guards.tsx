import { Navigate, Outlet, useLocation } from 'react-router';
import { useAbility, useSession } from '@/auth/session';

export function RequireSession() {
  const { session } = useSession();
  const location = useLocation();
  if (!session) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  return <Outlet />;
}

export function RequireAdmin() {
  const { isAdmin } = useAbility();
  if (!isAdmin) return <Navigate to="/repositories" replace />;
  return <Outlet />;
}

export function RedirectIfSession({ children }: { children: React.ReactNode }) {
  const { session } = useSession();
  if (session) return <Navigate to="/repositories" replace />;
  return children;
}
