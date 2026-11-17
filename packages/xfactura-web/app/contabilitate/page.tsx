import { Suspense } from 'react';
import AccountingPage from '@/components/accounting/page';
import { ThemeScript } from '@/components/accounting/ui/theme';
import './tokens.css';
import './base.css';
import './components.css';
import './shell.css';

export const metadata = {
  title: 'Contabilitate · xFactura',
  robots: { index: false, follow: false },
};
export default function Page() {
  return (
    <>
      <ThemeScript />
      <Suspense
        fallback={
          <div className="accounting acc-boot" lang="ro">
            Se încarcă…
          </div>
        }
      >
        <AccountingPage />
      </Suspense>
    </>
  );
}
