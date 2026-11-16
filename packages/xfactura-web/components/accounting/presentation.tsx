'use client';

import { useEffect, useRef } from 'react';

const bucharestTime = new Intl.DateTimeFormat('ro-RO', {
  dateStyle: 'short',
  timeStyle: 'short',
  timeZone: 'Europe/Bucharest',
});
const romanianMonth = new Intl.DateTimeFormat('ro-RO', {
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
});

/** Parse only the engine's instant; the platform supplies the time-zone conversion. */
export function AccountingTime({ instant }: { instant: string }) {
  return <time dateTime={instant}>{bucharestTime.format(new Date(instant))}</time>;
}

/** A selected ISO month is a display value, never a browser-derived reporting deadline. */
export function monthLabel(month: string) {
  try {
    return romanianMonth.format(new Date(month));
  } catch {
    return month;
  }
}

export function useOpenedHeading(open: boolean) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (open) heading.current?.focus();
  }, [open]);
  return heading;
}
