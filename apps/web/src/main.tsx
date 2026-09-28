import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { RegistryProvider, switchAccessContext } from '@platform/ui';
import '@platform/ui/styles.css';
import { registry } from './compose.tsx';
import { router } from './router.tsx';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5_000,
      retry: (failureCount, error) => {
        // Never retry a refusal: it will be refused again.
        const code = (error as { code?: string }).code;
        if (code === 'forbidden' || code === 'unauthenticated' || code === 'not_found') return false;
        return failureCount < 2;
      },
      refetchOnWindowFocus: false,
    },
  },
});

/**
 * Establishes the application session before anything queries the API.
 *
 * `switchAccessContext` records who the application is acting as. On first boot
 * that is not a switch and nothing is torn down; if the identity ever changes it
 * aborts the previous identity's in-flight requests and empties the cache before
 * the new one reads anything.
 */
function Boot() {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void switchAccessContext(queryClient)
      .then(() => setReady(true))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  if (error) {
    return (
      <div className="pf-state pf-state--error" role="alert">
        Nie udalo sie nawiazac sesji aplikacji: {error}. Sprawdz, czy backend dziala na porcie 8791.
      </div>
    );
  }
  if (!ready) return <div className="pf-state">Uruchamianie aplikacji…</div>;

  return (
    <RegistryProvider registry={registry}>
      <RouterProvider router={router} />
    </RegistryProvider>
  );
}

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <Boot />
    </QueryClientProvider>
  </StrictMode>,
);
