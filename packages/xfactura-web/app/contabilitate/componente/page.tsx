import { notFound } from 'next/navigation';
import Gallery from '@/components/accounting/gallery';
import { ThemeScript } from '@/components/accounting/ui/theme';
import '../tokens.css';
import '../base.css';
import '../components.css';
import '../shell.css';

export const metadata = {
  title: 'Componente · xFactura',
  robots: { index: false, follow: false },
};

/** The shared widgets on one page, for development and the browser suite; absent in production. */
export default function Page() {
  if (process.env.NODE_ENV === 'production') notFound();
  return (
    <>
      <ThemeScript />
      <Gallery />
    </>
  );
}
