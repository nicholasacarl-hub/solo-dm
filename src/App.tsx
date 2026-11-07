/**
 * App root: appearance (theme, text size), the router, toasts, and a top-level error boundary.
 */
import { createHashRouter, RouterProvider } from 'react-router';
import { Toaster } from '@/ui/components/toast';
import { ErrorBoundary } from '@/ui/components/ErrorBoundary';
import { AppCrashScreen } from '@/ui/shell/ErrorScreens';
import { appRoutes } from '@/ui/shell/routes';
import { useAppearance } from '@/ui/shell/useAppearance';

const router = createHashRouter(appRoutes);

export function App() {
  useAppearance();
  return (
    <ErrorBoundary fallback={({ error }) => <AppCrashScreen error={error} />}>
      <RouterProvider router={router} />
      <Toaster />
    </ErrorBoundary>
  );
}
