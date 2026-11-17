'use client';

import { useEffect, useRef } from 'react';
import { formatDateTime } from './format';

/** Parse only the engine's instant; the formatter supplies the Bucharest time-zone conversion. */
export function AccountingTime({ instant }: { instant: string }) {
  return <time dateTime={instant}>{formatDateTime(instant)}</time>;
}

export function useOpenedHeading(open: boolean) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (open) heading.current?.focus();
  }, [open]);
  return heading;
}
