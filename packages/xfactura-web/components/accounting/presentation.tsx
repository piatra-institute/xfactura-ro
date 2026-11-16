'use client';

import { useEffect, useRef } from 'react';
import { formatMoney } from './api';

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

/** An engine amount without its currency, for a table whose caption names the currency. */
export function formatAmount(value: string) {
  return formatMoney(value, '').trim();
}

/** An engine quantity (`12.500`, thousandths) with the Romanian decimal comma. */
export function formatQuantity(value: string) {
  const negative = value.startsWith('-');
  const [whole = '0', fraction = ''] = value.replace('-', '').split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return `${negative ? '−' : ''}${grouped}${fraction ? `,${fraction}` : ''}`;
}
