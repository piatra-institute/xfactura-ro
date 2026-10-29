import { requireCondition } from '../errors';
import { isSupportedCurrency } from '../money';
import { isLocalDate, type LocalDate } from '../time';
import { sourceXml, type XmlElement } from '../xml/source-xml';

export const bnrNamespace = 'http://www.bnr.ro/xsd';

/** One BNR reference rate: `rate` lei for `multiplier` units of `currency` on `date`. */
export type ReferenceRate = { currency: string; date: LocalDate; rate: string; multiplier: number };

const decimal = /^(0|[1-9]\d{0,6})\.\d{1,6}$/;

/**
 * Reads a BNR reference-rate file (the daily nbrfxrates.xml or a yearly archive). Only
 * currencies with a minor unit are kept; gold (XAU) and SDR (XDR) are not invoice currencies.
 */
export function parseBnrRates(bytes: Uint8Array): ReferenceRate[] {
  const root = sourceXml(bytes);
  requireCondition(
    root.local === 'DataSet' && root.uri === bnrNamespace,
    'BNR_FORMAT',
    'Documentul nu este un fișier de cursuri BNR.',
  );
  const body = root.children.find((child) => child.local === 'Body');
  requireCondition(body, 'BNR_FORMAT', 'Fișierul BNR nu are conținut.');
  const origin = body.children.find((child) => child.local === 'OrigCurrency')?.text.trim();
  requireCondition(
    origin === 'RON',
    'BNR_FORMAT',
    'Cursurile BNR trebuie să fie exprimate în lei.',
  );
  const rates: ReferenceRate[] = [];
  const seen = new Set<string>();
  for (const cube of body.children.filter((child: XmlElement) => child.local === 'Cube')) {
    const date = cube.attributes.date ?? '';
    requireCondition(isLocalDate(date), 'BNR_DATE', 'Dată BNR invalidă.');
    for (const rate of cube.children.filter((child) => child.local === 'Rate')) {
      const currency = rate.attributes.currency ?? '';
      const multiplier = Number(rate.attributes.multiplier ?? '1');
      const value = rate.text.trim();
      requireCondition(
        /^[A-Z]{3}$/.test(currency) && [1, 100].includes(multiplier) && decimal.test(value),
        'BNR_RATE',
        `Curs BNR invalid pentru ${currency || 'o monedă'}.`,
      );
      if (!isSupportedCurrency(currency)) continue;
      const key = `${date}/${currency}`;
      requireCondition(!seen.has(key), 'BNR_DUPLICATE', 'Curs BNR duplicat în același fișier.');
      seen.add(key);
      rates.push({ currency, date, rate: value, multiplier });
    }
  }
  requireCondition(rates.length > 0, 'BNR_EMPTY', 'Fișierul BNR nu conține cursuri.');
  return rates.sort((a, b) =>
    a.date === b.date ? (a.currency < b.currency ? -1 : 1) : a.date < b.date ? -1 : 1,
  );
}
