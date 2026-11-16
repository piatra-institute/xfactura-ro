import { Suspense } from 'react';
import AccountingPage from '@/components/accounting/page';
import './accounting.css';

export const metadata = {
  title: 'Contabilitate · xFactura',
  robots: { index: false, follow: false },
};
export default function Page() {
  return (
    <Suspense fallback={<div className="accounting acc-loading">Se încarcă…</div>}>
      <AccountingPage />
    </Suspense>
  );
}
