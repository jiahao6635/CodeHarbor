import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, type ReactNode, useCallback, useContext, useEffect, useState } from 'react';
import { ApiError, apiFetch, configureApi } from '@/api/client';
import { queryKeys } from '@/api/hooks';
import type { Me } from '@/api/types';
import { toastError } from '@/lib/toast';

interface SessionContextValue {
  me: Me | null;
  loading: boolean;
  error: Error | null;
  refreshSession: () => Promise<void>;
  signOut: () => Promise<void>;
  expired: boolean;
}

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const client = useQueryClient();
  const [expired, setExpired] = useState(false);
  const me = useQuery({
    queryKey: queryKeys.me,
    queryFn: async ({ signal }) => {
      try {
        return await apiFetch<Me>('/api/v1/me', { signal, keepSession: true });
      } catch (error) {
        if (error instanceof ApiError && error.code === 'UNAUTHENTICATED') return null;
        throw error;
      }
    },
    staleTime: 60_000,
    retry: false,
  });

  const clearSession = useCallback(
    (expiredSession: boolean) => {
      setExpired(expiredSession);
      void client.cancelQueries();
      client.setQueryData(queryKeys.me, null);
      client.removeQueries({ predicate: (query) => query.queryKey[0] !== 'me' });
      client.getMutationCache().clear();
    },
    [client],
  );

  useEffect(() => configureApi(() => clearSession(true)), [clearSession]);

  async function signOut() {
    try {
      await apiFetch('/api/v1/auth/logout', { method: 'POST', keepSession: true });
      clearSession(false);
    } catch (error) {
      if (error instanceof ApiError && error.code === 'UNAUTHENTICATED') clearSession(false);
      else toastError(error, '退出失败');
    }
  }

  return (
    <SessionContext.Provider
      value={{
        me: me.data ?? null,
        loading: me.isPending,
        error: me.error,
        refreshSession: async () => {
          await me.refetch({ throwOnError: true });
        },
        signOut,
        expired,
      }}
    >
      {children}
    </SessionContext.Provider>
  );
}

export function useSession(): SessionContextValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error('useSession must be used within SessionProvider');
  return value;
}

export function useAbility() {
  const { me } = useSession();
  return { me, hasPat: me?.has_pat ?? false, isAdmin: me?.role === 'super_admin' };
}
