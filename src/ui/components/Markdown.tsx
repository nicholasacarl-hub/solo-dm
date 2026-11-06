/**
 * Safe markdown renderer (GitHub-flavored, no raw HTML). Use for DM narration, rules text,
 * homebrew and imported content. Links open in a new tab.
 */
import { memo } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { cn } from '@/lib/cn';

const components: Components = {
  a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer noopener" className="text-accent underline underline-offset-2" />,
};

export const Markdown = memo(function Markdown({
  children,
  className,
  variant = 'prose',
}: {
  children: string;
  className?: string;
  /** 'narration' = DM story text styling; 'prose' = rules/reference text. */
  variant?: 'narration' | 'prose';
}) {
  return (
    <div
      className={cn(
        variant === 'narration'
          ? 'narration'
          : 'prose prose-sm max-w-none text-text prose-headings:font-display prose-headings:text-text prose-strong:text-text prose-a:text-accent dark:prose-invert',
        className,
      )}
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components} skipHtml>
        {children}
      </ReactMarkdown>
    </div>
  );
});
