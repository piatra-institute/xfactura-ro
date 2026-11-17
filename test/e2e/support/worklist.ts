import { expect, type Locator, type Page } from '@playwright/test';
import type { WorkItem } from '../../../packages/xfactura-web/components/accounting/work-model';
import type { Summary } from '../../../packages/xfactura-web/components/accounting/workspace';

export function workItem(id: string, changes: Partial<WorkItem> = {}): WorkItem {
  return {
    id,
    kind: 'document.unproposed',
    subject: { kind: 'document', id },
    message: id,
    severity: 'warn',
    period: '2026-01',
    due: null,
    details: {},
    labels: {},
    fingerprint: 'a'.repeat(64),
    next: [],
    asOfSeq: 1,
    ...changes,
  };
}

/** A company with nothing booked and nothing waiting, as `company.summary` states it. */
export function summary(changes: Partial<Summary> = {}): Summary {
  const side = { count: 0, currencies: [], unrepresented: null };
  const zero = { minor: '0', currency: 'RON' };
  return {
    date: '2026-11-17',
    cash: { accounts: [], totals: [] },
    receivables: side,
    payables: side,
    tax: { owed: zero, overdue: zero, claims: zero, net: zero, obligations: 0 },
    taxReason: null,
    work: {
      total: 0,
      by: { person: 0, agent: 0, neither: 0 },
      severity: { block: 0, warn: 0, info: 0 },
      complete: true,
      next: null,
      asOfSeq: 1,
    },
    deadlines: [],
    ...changes,
  };
}

/**
 * Synthetic wire responses exercise states that a single real company cannot hold at once. The
 * reads of what waits on a person (`work.list` with `by: "human"`: „Profilul firmei” and Acasă)
 * answer `work.list:human` (none by default), filtered by `kinds`; every other read goes to
 * `handle` unless `overrides` names it (an override set to `undefined` sends it to `handle`).
 */
export async function mockWorklist(
  page: Page,
  handle: (
    operation: string,
    input: Record<string, unknown>,
    key: string | undefined,
  ) => { body: unknown; status?: number } | Promise<{ body: unknown; status?: number }>,
  overrides: Record<string, unknown> = {},
) {
  await page.route('**/api/accounting/**', async (route) => {
    const url = new URL(route.request().url());
    const operation = url.pathname.split('/capabilities/')[1];
    const common: Record<string, unknown> = {
      'capabilities.list': {
        capabilities: [
          'proposals.get',
          'proposals.approve',
          'proposals.withdraw',
          'ledger.post',
          'work.dispose',
          'actions.approve',
          'parties.get',
          'documents.get',
          'treasury.accounts',
          'work.list',
          'profile.current',
          'profile.record',
        ].map((id) => ({ id })),
      },
      'years.list': {
        items: [
          { id: 'year', kind: 'financial', label: '2026', from: '2026-01-01', to: '2026-12-31' },
        ],
        next: null,
      },
      'evidence.list': { items: [], next: null },
      'company.summary': summary(),
      'profile.current': { date: '2026-11-17', items: [], next: null, groups: [] },
      'ledger.trialBalance': {
        rows: [],
        totals: Object.fromEntries(
          ['opening', 'previous', 'current', 'total', 'closing'].map((column) => [
            column,
            { debit: '0.00', credit: '0.00' },
          ]),
        ),
      },
      'ledger.journal': { entries: [], next: null },
      'vat.journal': { rows: [], totals: [] },
      ...overrides,
    };
    const input = (route.request().postDataJSON() ?? {}) as Record<string, unknown>;
    const human = (common['work.list:human'] ?? []) as WorkItem[];
    const result = !operation
      ? {
          body: url.pathname.endsWith('/session')
            ? { id: 'person', name: 'Persoană sintetică', email: 'worklist@example.test' }
            : [{ id: 'company', name: 'Verificare sintetică SRL', cui: '12345678' }],
        }
      : operation === 'work.list' && input.by === 'human'
        ? {
            body: {
              items: human.filter(
                (item) => !input.kinds || (input.kinds as string[]).includes(item.kind),
              ),
              next: null,
              asOfSeq: 1,
            },
          }
        : Object.hasOwn(common, operation) && common[operation] !== undefined
          ? { body: common[operation] }
          : await handle(operation, input, route.request().headers()['idempotency-key']);
    await route.fulfill({
      status: result.status ?? 200,
      contentType: 'application/json',
      body: JSON.stringify(result.body),
    });
  });
}

/** A row of the worklist by its item id. */
export const workRow = (page: Page | Locator, id: string) => page.locator(`[data-work-id="${id}"]`);

/** Opens a row of the worklist by its title, as a person does, unless it is open already. */
export async function openWorkRow(row: Locator) {
  const toggle = row.locator('.acc-work-toggle').first();
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
}
