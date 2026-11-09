/**
 * Route table (hash routing so GitHub Pages refreshes work). Play renders full-bleed with its own
 * header; every other screen sits inside AppLayout. Play, the character builder and the library
 * (with its book pages) are code-split.
 */
import { lazy, Suspense, type ReactNode } from 'react';
import { useLocation, type RouteObject } from 'react-router';
import { ErrorBoundary } from '@/ui/components/ErrorBoundary';
import { HomeScreen } from '@/ui/screens/HomeScreen';
import { NewCampaignScreen } from '@/ui/screens/NewCampaignScreen';
import { SettingsScreen } from '@/ui/screens/SettingsScreen';
import { NotFoundScreen } from '@/ui/screens/NotFoundScreen';
import { AppLayout, PageLoading } from './AppLayout';
import { PageErrorFallback, RouteErrorScreen } from './ErrorScreens';

const PlayScreen = lazy(() => import('@/ui/screens/PlayScreen').then((m) => ({ default: m.PlayScreen })));
const CharacterBuilderScreen = lazy(() =>
  import('@/ui/screens/CharacterBuilderScreen').then((m) => ({ default: m.CharacterBuilderScreen })),
);
const LibraryScreen = lazy(() => import('@/ui/screens/LibraryScreen').then((m) => ({ default: m.LibraryScreen })));
/** The book page (structured imports): its own chunk, so a Library visit doesn't load the structuring job API. */
const LibrarySourceScreen = lazy(() =>
  import('@/ui/screens/LibrarySourceScreen').then((m) => ({ default: m.LibrarySourceScreen })),
);

/** Full-bleed routes get their own boundary and loading state (there is no layout around them). */
function FullBleed({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  return (
    <ErrorBoundary resetKeys={[pathname]} fallback={(props) => <PageErrorFallback {...props} />}>
      <Suspense
        fallback={
          <div className="flex min-h-dvh flex-col bg-bg">
            <PageLoading label="Setting the table…" />
          </div>
        }
      >
        {children}
      </Suspense>
    </ErrorBoundary>
  );
}

export const appRoutes: RouteObject[] = [
  {
    path: '/',
    errorElement: <RouteErrorScreen />,
    children: [
      {
        path: 'play/:id',
        element: (
          <FullBleed>
            <PlayScreen />
          </FullBleed>
        ),
      },
      {
        element: <AppLayout />,
        children: [
          { index: true, element: <HomeScreen /> },
          { path: 'new', element: <NewCampaignScreen /> },
          { path: 'campaign/:id/character', element: <CharacterBuilderScreen /> },
          { path: 'library', element: <LibraryScreen /> },
          { path: 'library/source/:sourceId', element: <LibrarySourceScreen /> },
          { path: 'settings', element: <SettingsScreen /> },
          { path: '*', element: <NotFoundScreen /> },
        ],
      },
    ],
  },
];
