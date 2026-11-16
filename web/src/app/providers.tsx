import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import { Toaster } from 'sonner';
import { ApiError } from '@/api/client';
import { SessionProvider } from '@/auth/session';
import { ThemeProvider } from './theme';

function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: (count, error) => {
          // Auth and permission failures never resolve by retrying.
          if (error instanceof ApiError && [401, 403, 404, 429].includes(error.status)) return false;
          return count < 2;
        },
        refetchOnWindowFocus: true,
        staleTime: 5_000,
      },
    },
  });
}

export function Providers({ children }: { children: React.ReactNode }) {
  const [client] = useState(createQueryClient);
  return (
    <ThemeProvider>
      <QueryClientProvider client={client}>
        <SessionProvider>
          {children}
          <Toaster position="bottom-right" richColors closeButton toastOptions={{ duration: 4000 }} />
        </SessionProvider>
      </QueryClientProvider>
    </ThemeProvider>
  );
}
