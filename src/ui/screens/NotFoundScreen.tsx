/** Route: anything unknown. */
import { ArrowLeft, Compass } from 'lucide-react';
import { ButtonLink } from '@/ui/components/ButtonLink';
import { Page, useDocumentTitle } from '@/ui/shell/Page';

export function NotFoundScreen() {
  useDocumentTitle('Page not found');
  return (
    <Page width="narrow">
      <div className="mx-auto max-w-md rounded-2xl border border-border bg-surface p-6 shadow-card">
        <Compass className="size-7 text-accent" aria-hidden />
        <h1 className="mt-3 font-display text-xl font-semibold tracking-wide">Lost in the fog</h1>
        <p className="mt-2 text-sm text-muted">
          There’s nothing at this address. The link may be old, or the campaign may have been deleted.
        </p>
        <ButtonLink to="/" variant="primary" className="mt-5" icon={<ArrowLeft className="size-4" aria-hidden />}>
          Back to campaigns
        </ButtonLink>
      </div>
    </Page>
  );
}
