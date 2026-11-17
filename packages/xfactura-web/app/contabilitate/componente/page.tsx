import { notFound } from 'next/navigation';
import { ThemeScript } from '@/components/accounting/ui/theme';
import '../tokens.css';
import '../base.css';
import '../components.css';
import '../shell.css';

export const metadata = {
  title: 'Componente · xFactura',
  robots: { index: false, follow: false },
};

/**
 * The shared widgets on one page, for development and the browser suite. Production builds answer
 * 404 and, since the import sits in a branch the build resolves at compile time, leave the
 * gallery and the widgets only it uses out of every bundle.
 */
export default async function Page() {
  if (process.env.NODE_ENV === 'production') notFound();
  else {
    const { default: Gallery } = await import('@/components/accounting/gallery');
    return (
      <>
        <ThemeScript />
        <Gallery />
      </>
    );
  }
}
