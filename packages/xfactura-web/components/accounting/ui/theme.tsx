'use client';

import { useServerInsertedHTML } from 'next/navigation';
import { useLayoutEffect, useRef, useSyncExternalStore } from 'react';

/** `system` follows the operating system; the other two are a person's explicit choice. */
export type Theme = 'system' | 'light' | 'dark';
export const themeLabels: Record<Theme, string> = {
  system: 'Sistem',
  light: 'Luminos',
  dark: 'Întunecat',
};

const key = 'xfactura.accounting.theme';
const attribute = 'data-acc-theme';
const listeners = new Set<() => void>();

function stored(): Theme {
  try {
    const value = localStorage.getItem(key);
    return value === 'light' || value === 'dark' ? value : 'system';
  } catch {
    return 'system';
  }
}

/** Writes the choice onto `<html>`, where the token files read it. */
function apply(theme: Theme) {
  if (theme === 'system') document.documentElement.removeAttribute(attribute);
  else document.documentElement.setAttribute(attribute, theme);
}

/** The same rule as `apply`, run while the HTML is parsed so the first paint has the theme. */
const script = `(function(){try{var t=localStorage.getItem(${JSON.stringify(key)});if(t==="light"||t==="dark")document.documentElement.setAttribute(${JSON.stringify(attribute)},t)}catch(e){}})()`;

/** Inserts the theme script into the server HTML once; place it outside any Suspense boundary. */
export function ThemeScript() {
  const inserted = useRef(false);
  useServerInsertedHTML(() => {
    if (inserted.current) return null;
    inserted.current = true;
    return <script dangerouslySetInnerHTML={{ __html: script }} />;
  });
  // React's development remount resets <html> to its own attributes; apply the choice again.
  useLayoutEffect(() => apply(stored()), []);
  return null;
}

/** The stored theme and a way to change it; every reader updates together. */
export function useTheme() {
  const theme = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      const onStorage = (event: StorageEvent) => {
        if (event.key === key) {
          apply(stored());
          listener();
        }
      };
      window.addEventListener('storage', onStorage);
      return () => {
        listeners.delete(listener);
        window.removeEventListener('storage', onStorage);
      };
    },
    stored,
    () => 'system' as Theme,
  );
  const setTheme = (next: Theme) => {
    try {
      if (next === 'system') localStorage.removeItem(key);
      else localStorage.setItem(key, next);
    } catch {
      // Without storage the choice still holds for this page.
    }
    apply(next);
    listeners.forEach((listener) => listener());
  };
  return { theme, setTheme };
}
