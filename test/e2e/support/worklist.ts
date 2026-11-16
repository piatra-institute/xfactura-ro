import type { Page } from '@playwright/test';
import type { WorkItem } from '../../../packages/xfactura-web/components/accounting/work-model';

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
    fingerprint: 'a'.repeat(64),
    next: [],
    asOfSeq: 1,
    ...changes,
  };
}

/** Synthetic wire responses exercise states that a single real company cannot hold at once. */
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
        ].map((id) => ({ id })),
      },
      'years.list': {
        items: [
          { id: 'year', kind: 'financial', label: '2026', from: '2026-01-01', to: '2026-12-31' },
        ],
        next: null,
      },
      'evidence.list': { items: [], next: null },
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
    const result = operation
      ? Object.hasOwn(common, operation)
        ? { body: common[operation] }
        : await handle(
            operation,
            route.request().postDataJSON(),
            route.request().headers()['idempotency-key'],
          )
      : {
          body: url.pathname.endsWith('/session')
            ? { id: 'person', name: 'Persoană sintetică', email: 'worklist@example.test' }
            : [{ id: 'company', name: 'Verificare sintetică SRL', cui: '12345678' }],
        };
    await route.fulfill({
      status: result.status ?? 200,
      contentType: 'application/json',
      body: JSON.stringify(result.body),
    });
  });
}
