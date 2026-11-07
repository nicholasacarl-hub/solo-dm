/**
 * Password-style input with a show/hide toggle, for API keys and access tokens.
 */
import { forwardRef, useState, type InputHTMLAttributes } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { cn } from '@/lib/cn';
import { IconButton, Input } from './ui';

export interface SecretInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  /** What is hidden, for the toggle's label: "Show {noun}". */
  noun?: string;
}

export const SecretInput = forwardRef<HTMLInputElement, SecretInputProps>(function SecretInput(
  { noun = 'value', className, ...rest },
  ref,
) {
  const [shown, setShown] = useState(false);
  return (
    <div className="relative">
      <Input
        ref={ref}
        type={shown ? 'text' : 'password'}
        autoComplete="off"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        className={cn('pr-11 font-mono', className)}
        {...rest}
      />
      <IconButton
        label={shown ? `Hide ${noun}` : `Show ${noun}`}
        size="sm"
        className="absolute top-1 right-1"
        onClick={() => setShown((v) => !v)}
      >
        {shown ? <EyeOff className="size-4" aria-hidden /> : <Eye className="size-4" aria-hidden />}
      </IconButton>
    </div>
  );
});
