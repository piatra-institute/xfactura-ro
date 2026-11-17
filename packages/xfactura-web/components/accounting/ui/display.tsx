'use client';

import type { ReactNode } from 'react';
import { Button, LinkButton } from './button';

export type Tone = 'neutral' | 'accent' | 'info' | 'success' | 'warning' | 'danger';

/** A count of items waiting, next to the thing they belong to. */
export function Badge({
  count,
  label,
  tone = 'neutral',
}: {
  count: number;
  /** Read instead of the bare number, for example „3 de verificat”. */
  label?: string;
  tone?: Tone;
}) {
  return (
    <span className={`acc-badge acc-tone--${tone}`} aria-label={label}>
      {count}
    </span>
  );
}

/** A short label for a structured value: a return and its months, a state, a partner. */
export function Chip({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`acc-chip acc-tone--${tone}`}>{children}</span>;
}

/** An empty list names its one next action, as a button or a link. */
export function EmptyState({
  message,
  action,
}: {
  message: string;
  action?: { label: string; onPress: () => void } | { label: string; href: string };
}) {
  return (
    <div className="acc-empty-state">
      <p>{message}</p>
      {action ? (
        'href' in action ? (
          <LinkButton href={action.href} variant="primary" size="small">
            {action.label}
          </LinkButton>
        ) : (
          <Button variant="primary" size="small" onPress={action.onPress}>
            {action.label}
          </Button>
        )
      ) : null}
    </div>
  );
}

/** The outcome of the last action: an error is an alert, a success is a status. */
export function Feedback({ error, notice }: { error?: string; notice?: string }) {
  return (
    <div className="acc-feedback" aria-live="polite">
      {error ? (
        <p role="alert" className="acc-error">
          {error}
        </p>
      ) : notice ? (
        <p role="status" className="acc-notice">
          {notice}
        </p>
      ) : null}
    </div>
  );
}
