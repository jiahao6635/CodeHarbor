import { useQueryClient } from '@tanstack/react-query';
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { configureApi } from '@/api/client';
import type { Me } from '@/api/types';

const STORAGE_KEY = 'codeharbor.session';

interface Session {
  token: string;
  me: Me;
}

interface SessionContextValue {
  session: Session | null;
  /** Starts a session with a key that has already been validated against /api/v1/me. */
  signIn: (token: string, me: Me) => void;
  signOut: (reason?: 'manual' | 'expired') => void;
  /** Reflects a fresh /me payload into the session without re-entering the key. */
  updateMe: (me: Me) => void;
  signOutReason: 'manual' | 'expired' | null;
}

const SessionContext = createContext<SessionContextValue | null>(null);

// sessionStorage only: the key disappears when the tab closes and never reaches localStorage.
function readStored(): Session | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Session>;
    if (typeof parsed.token !== 'string' || !parsed.me || typeof parsed.me !== 'object') return null;
    return { token: parsed.token, me: parsed.me as Me };
  } catch {
    return null;
  }
}

function writeStored(session: Session | null) {
  try {
    if (session) sessionStorage.setItem(STORAGE_KEY, JSON.stringify(session));
    else sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Storage may be unavailable (private mode quotas); the in-memory session still works for this page.
  }
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(readStored);
  const [signOutReason, setSignOutReason] = useState<'manual' | 'expired' | null>(null);
  const client = useQueryClient();

  const signOut = useCallback(
    (reason: 'manual' | 'expired' = 'manual') => {
      setSession(null);
      writeStored(null);
      setSignOutReason(reason);
      client.clear();
    },
    [client],
  );

  const signIn = useCallback((token: string, me: Me) => {
    const next = { token, me };
    setSession(next);
    writeStored(next);
    setSignOutReason(null);
  }, []);

  const updateMe = useCallback((me: Me) => {
    setSession((current) => {
      if (!current) return current;
      const next = { ...current, me };
      writeStored(next);
      return next;
    });
  }, []);

  // The API client reads the token lazily so the latest session is always used.
  const tokenRef = useMemo(() => ({ current: session?.token ?? null }), [session?.token]);
  useEffect(() => {
    configureApi({ token: () => tokenRef.current, onUnauthenticated: () => signOut('expired') });
  }, [tokenRef, signOut]);

  const value = useMemo(
    () => ({ session, signIn, signOut, updateMe, signOutReason }),
    [session, signIn, signOut, updateMe, signOutReason],
  );
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error('useSession must be used within SessionProvider');
  return value;
}

/** Page capabilities derived from the key, mirroring src/authorization.ts; the server still decides. */
export function useAbility() {
  const { session } = useSession();
  const me = session?.me;
  return {
    me,
    canWrite: me?.can_write ?? false,
    isAdmin: me?.is_admin ?? false,
    /** Self-scoped keys (repos null) can browse the Codeup repository list and manage every own key. */
    isUnrestricted: me ? me.key_repos === null : false,
  };
}
