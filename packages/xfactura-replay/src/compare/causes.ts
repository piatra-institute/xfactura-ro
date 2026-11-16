import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import { basename, join, resolve, sep } from 'node:path';
import { z } from 'zod';
import { classes, fail, kinds, order, syntheticAccount, type Difference } from './differences';

const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
const causeSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z-]{0,79}$/),
    explanation: z.string().min(1),
    class: z.enum(classes).exclude(['unclassified']),
    pattern: z
      .object({
        kind: z.enum(kinds),
        accountSynthetic: z
          .string()
          .regex(/^[1-9]\d{2,3}$/)
          .optional(),
        period: z.object({ from: month, to: month }).strict().optional(),
        taxCode: z
          .string()
          .regex(/^(?:[A-Z][A-Z0-9]*(?:[.-][A-Z0-9]+)*|\d{6})$/)
          .optional(),
      })
      .strict(),
    fixture: z
      .string()
      .regex(/^test\/fixtures\/[a-zA-Z0-9_/-]+\.(?:ts|json)$/)
      .optional(),
  })
  .strict();
export type Cause = z.infer<typeof causeSchema>;

/** Structural numeric slots are narrowly typed. All other content, including unknown keys,
 * is scanned before schema validation so a note cannot smuggle private evidence into a cause. */
export function validateCause(input: unknown): Cause {
  const scan = (value: unknown, path: string) => {
    if (Array.isArray(value)) {
      value.forEach((child) => scan(child, path));
      return;
    }
    if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) {
        scan(key, '$key');
        scan(child, path ? `${path}.${key}` : key);
      }
      return;
    }
    if (typeof value !== 'string' && typeof value !== 'number') return;
    const text = String(value);
    if (/(?<!\d)\d{13}(?!\d)/.test(text))
      fail('CAUSE_PERSONAL_CODE', 'Cauza conține un posibil cod personal.');
    if (/(?<![A-Z0-9])[A-Z]{2}\s*\d{2}(?:[\s-]?[A-Z0-9]){11,30}(?![A-Z0-9])/i.test(text))
      fail('CAUSE_IBAN', 'Cauza conține un posibil IBAN.');
    if (/\bRO[\s:.-]*\d{2,10}\b|\b(?:CUI|CIF)\s*[:#=-]?\s*\d{2,10}\b/i.test(text))
      fail('CAUSE_COMPANY_CODE', 'Cauza conține un posibil cod fiscal.');
    const structural = [
      'pattern.accountSynthetic',
      'pattern.period.from',
      'pattern.period.to',
      'pattern.taxCode',
    ].includes(path);
    if (structural) return;
    if (/(?<![\d.,])\d{5,10}(?![\d.,])/.test(text))
      fail('CAUSE_COMPANY_CODE', 'Cauza conține un posibil cod fiscal.');
    for (const match of text.matchAll(
      /[+-]?(?:\d+(?:[.,]\d+|[ \u00a0\u202f]\d{3}(?!\d))*|[.,]\d+)(?:e[+-]?\d+)?/gi,
    )) {
      const digits = match[0]
        .split(/e/i)[0]!
        .replace(/\D/g, '')
        .replace(/^0+|0+$/g, '');
      if (digits.length > 2)
        fail('CAUSE_AMOUNT', 'Cauza conține o sumă cu mai mult de două cifre semnificative.');
    }
  };
  scan(input, '');
  const parsed = causeSchema.safeParse(input);
  if (!parsed.success) fail('CAUSE_SCHEMA', 'Structura cauzei nu este validă.');
  const cause = parsed.data;
  if (cause.pattern.period && cause.pattern.period.from > cause.pattern.period.to)
    fail('CAUSE_PERIOD', 'Intervalul cauzei este inversat.');
  if (cause.class === 'engine-defect' && !cause.fixture)
    fail('CAUSE_FIXTURE', 'Un defect al motorului necesită o reproducere sintetică.');
  return cause;
}

export async function loadCauses(
  directory = resolve(import.meta.dir, '../../causes'),
): Promise<Cause[]> {
  const causes: Cause[] = [];
  for (const name of (await readdir(directory))
    .filter((name) => name.endsWith('.json'))
    .sort(order)) {
    const path = join(directory, name);
    if (!(await lstat(path)).isFile())
      fail('CAUSE_FILE', 'Cauzele trebuie să fie fișiere obișnuite.');
    let input: unknown;
    try {
      input = JSON.parse(await readFile(path, 'utf8'));
    } catch {
      fail('CAUSE_JSON', 'Fișierul cauzei nu este JSON valid.');
    }
    const cause = validateCause(input);
    if (basename(name, '.json') !== cause.id)
      fail('CAUSE_ID', 'Identificatorul cauzei nu corespunde fișierului.');
    if (cause.fixture) {
      let root: string;
      let fixture: string;
      try {
        root = await realpath(resolve(directory, '../test/fixtures'));
        fixture = await realpath(resolve(directory, '..', cause.fixture));
      } catch {
        fail('CAUSE_FIXTURE', 'Reproducerea sintetică nu există.');
      }
      if (!fixture.startsWith(root + sep) || !(await lstat(fixture)).isFile())
        fail('CAUSE_FIXTURE', 'Reproducerea trebuie să fie un fișier din test/fixtures.');
    }
    causes.push(cause);
  }
  return causes;
}

export function matchesCause(cause: Cause, difference: Difference): boolean {
  const pattern = cause.pattern;
  const from = difference.period.slice(0, 7);
  const to = difference.period.includes('/') ? difference.period.split('/')[1]!.slice(0, 7) : from;
  return (
    pattern.kind === difference.kind &&
    (!pattern.accountSynthetic ||
      difference.accounts.some(
        (account) => syntheticAccount(account) === pattern.accountSynthetic,
      )) &&
    (!pattern.period || (from >= pattern.period.from && to <= pattern.period.to)) &&
    (!pattern.taxCode || difference.taxCodes.includes(pattern.taxCode))
  );
}

/** Refuse ambiguous rules instead of giving filesystem ordering classification authority. */
export function applyCauses(
  differences: readonly Difference[],
  causes: readonly Cause[],
): Difference[] {
  const rules = causes.map(validateCause);
  if (new Set(rules.map((cause) => cause.id)).size !== rules.length)
    fail('CAUSE_DUPLICATE', 'Identificatorii cauzelor trebuie să fie unici.');
  return differences.map((item) => {
    if (item.status !== 'open' || item.class !== 'unclassified') return item;
    const matching = rules.filter((cause) => matchesCause(cause, item));
    if (matching.length > 1)
      fail('CAUSE_AMBIGUOUS', 'Mai multe cauze se potrivesc aceleiași diferențe.');
    return matching.length
      ? { ...item, class: matching[0]!.class, causeId: matching[0]!.id }
      : item;
  });
}
