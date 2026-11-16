import { expect, test } from '@playwright/test';
import { mockWorklist, workItem } from './support/worklist';

const capabilities = [
  'questions.list',
  'questions.answer',
  'questions.withdraw',
  'proposals.list',
  'obligations.calendar',
  'declarations.list',
  'declarations.prepare',
  'actions.list',
  'company.members',
  'agents.list',
  'stock.items.list',
  'rules.parameters',
];
const common = {
  'capabilities.list': { capabilities: capabilities.map((id) => ({ id })) },
  'company.members': { items: [{ userId: 'person', name: 'Ana Sintetică' }], next: null },
  'agents.list': { items: [], next: null },
};
const years = [
  { id: 'year-2025', kind: 'financial', label: '2025', from: '2025-01-01', to: '2025-12-31' },
  { id: 'year-2026', kind: 'financial', label: '2026', from: '2026-01-01', to: '2026-12-31' },
];
const obligation = (kind: string, period = '2026-10') => ({
  kind,
  period,
  deadline: kind,
  start: `${period}-01`,
  end: `${period}-31`,
  nominal: '2026-11-25',
  due: '2026-11-25',
  status: 'due',
  artifactId: null,
  versions: [],
  gap: null,
  conflict: null,
  basis: { rule: 'Regulă sintetică', facts: [], clauses: [] },
  blockers: [],
  waiting: null,
});
const question = (kind: string, value: unknown = null) => ({
  id: kind,
  kind,
  subject: { kind: 'vehicle', id: 'B123XFA' },
  params: {},
  prompt: 'Întrebare sintetică pentru persoana responsabilă',
  status: value === null ? 'open' : 'answered',
  askedBy: 'person',
  agentId: null,
  createdAt: '2026-11-16T13:52:10.848Z',
  due: null,
  answer:
    value === null
      ? null
      : {
          id: 'answer',
          value,
          evidenceId: 'proof',
          answeredBy: 'person',
          at: '2026-11-16T13:52:10.848Z',
        },
});

test('return links select the exercise and focus its heading; changing exercise clears incompatible filters', async ({
  page,
}) => {
  const item = workItem('older-return', {
    kind: 'obligation.due',
    subject: { kind: 'obligation', id: 'D300|2025-10' },
    period: '2025-10',
    details: { kind: 'D300', status: 'due' },
  });
  const calendarCalls: Record<string, unknown>[] = [];
  await mockWorklist(
    page,
    (operation, input) => {
      if (operation === 'work.list') return { body: { items: [item], next: null, asOfSeq: 1 } };
      if (operation === 'work.get') return { body: { state: 'open', item, disposition: null } };
      if (operation === 'obligations.calendar') {
        calendarCalls.push(input);
        return {
          body: {
            items: [
              obligation('D300', String(input.from).startsWith('2025') ? '2025-10' : '2026-10'),
            ],
            next: null,
          },
        };
      }
      return { body: { items: [], next: null } };
    },
    { ...common, 'years.list': { items: years, next: null } },
  );
  await page.goto('/contabilitate?company=company&year=year-2026');
  await page.locator('[data-work-id="older-return"] > summary').click();
  await page.getByRole('link', { name: 'Deschide declarația în Termene', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Exercițiu', exact: true })).toHaveValue(
    'year-2025',
  );
  await expect(page.getByRole('heading', { name: 'D300 · 2025-10', exact: true })).toBeFocused();
  const summary = page.locator('[data-return="D300|2025-10"] > summary');
  await summary.focus();
  await page.keyboard.press('Enter');
  await expect(page).not.toHaveURL(/return=/);
  await expect(page.locator('[data-return="D300|2025-10"]')).not.toHaveAttribute('open');
  await expect(summary).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'D300 · 2025-10', exact: true })).toBeFocused();
  await page.getByLabel('Luna încheierii perioadei', { exact: true }).fill('2025-10');
  await page.locator('[data-return="D300|2025-10"] > summary').click();
  await page.getByRole('combobox', { name: 'Exercițiu', exact: true }).selectOption('year-2026');
  await expect(page).not.toHaveURL(/return=|month=/);
  await expect(page.getByLabel('Luna încheierii perioadei', { exact: true })).toHaveValue('');
  await expect.poll(() => calendarCalls.at(-1)).toEqual({ from: '2026-01', to: '2026-12' });
  await expect(
    page.getByText('Perioade încheiate între 2026-01-01 și 2026-12-31', { exact: true }),
  ).toBeVisible();
});

test('preparation buttons are offered only where this view collects the required options', async ({
  page,
}) => {
  const writes: string[] = [];
  await mockWorklist(
    page,
    (operation) => {
      if (operation === 'obligations.calendar')
        return {
          body: {
            items: ['D394', 'D100', 'D300', 'D406', 'D398'].map((kind) => obligation(kind)),
            next: null,
          },
        };
      if (operation === 'declarations.prepare') writes.push(operation);
      return { body: { items: [], next: null } };
    },
    common,
  );
  await page.goto('/contabilitate?view=deadlines');
  for (const kind of ['D394', 'D100']) {
    const card = page.locator(`[data-return="${kind}|2026-10"]`);
    await card.locator(':scope > summary').click();
    await expect(
      card.getByText(
        `Pregătirea declarației ${kind} necesită detalii pe care această interfață nu le colectează.`,
        { exact: true },
      ),
    ).toBeVisible();
    await expect(
      card.getByRole('button', { name: 'Pregătește declarația', exact: true }),
    ).toHaveCount(0);
  }
  const d300 = page.locator('[data-return="D300|2026-10"]');
  await d300.locator(':scope > summary').click();
  await expect(d300.getByLabel('Nume declarant', { exact: true })).toBeVisible();
  await expect(
    d300.getByRole('button', { name: 'Pregătește declarația', exact: true }),
  ).toBeVisible();
  for (const kind of ['D406', 'D398']) {
    const card = page.locator(`[data-return="${kind}|2026-10"]`);
    await card.locator(':scope > summary').click();
    await expect(
      card.getByRole('button', { name: 'Pregătește declarația', exact: true }),
    ).toBeVisible();
  }
  expect(writes).toEqual([]);
});

test('saved stock answers resolve the article by name and saved instants use Romanian Bucharest time', async ({
  page,
}, info) => {
  const itemId = '00000000-0000-4000-8000-000000000001';
  const item = {
    ...question('stock.item', { itemId, factor: '2.500000' }),
    subject: { kind: 'supplierItem', id: 'FURNIZOR / HÂRTIE' },
  };
  await mockWorklist(
    page,
    (operation) => {
      if (operation === 'questions.list') return { body: { items: [item], next: null } };
      if (operation === 'stock.items.list')
        return { body: { items: [{ id: itemId, name: 'Hârtie A4 sintetică' }], next: null } };
      return { body: { items: [], next: null } };
    },
    {
      ...common,
      'evidence.list': { items: [{ id: 'proof', filename: 'raspuns-sintetic.json' }], next: null },
    },
  );
  await page.goto('/contabilitate?view=questions&question=stock.item');
  const card = page.locator('[data-question-id="stock.item"]');
  await expect(
    card.getByRole('heading', { name: 'Articolul furnizorului', exact: true }),
  ).toBeFocused();
  const saved = card.locator('.acc-question-body > .acc-work-details');
  await expect(saved).toContainText('Hârtie A4 sintetică');
  await expect(saved).toContainText('2.500000');
  const time = card.locator('.acc-question-body > p time');
  await expect(time).toHaveText('16.11.2026, 15:52');
  await expect(time).toHaveAttribute('datetime', '2026-11-16T13:52:10.848Z');
  const technical = card.locator('.acc-question-body > .acc-technical');
  await technical.getByText('Detalii tehnice', { exact: true }).click();
  await expect(technical).toContainText('2026-11-16T13:52:10.848Z');
  await page.screenshot({ path: info.outputPath('saved-stock-answer.png'), fullPage: true });
});

test('conditional evidence requirements are described without labelling them optional', async ({
  page,
}) => {
  const items = [
    question('vehicle.use'),
    { ...question('profit.account'), params: { account: '623' } },
    { ...question('receivable.collectibility'), params: { yearEnd: '2026-12-31' } },
  ];
  await mockWorklist(
    page,
    (operation) => {
      if (operation === 'questions.list') return { body: { items, next: null } };
      return { body: { items: [], next: null } };
    },
    common,
  );
  await page.goto('/contabilitate?view=questions&question=vehicle.use');
  await page
    .getByRole('combobox', { name: 'Folosirea vehiculului', exact: true })
    .selectOption('business_only');
  await expect(page.locator('select[name="logEvidenceId"]')).toHaveAccessibleName(
    /Foaie de parcurs \(necesară dacă/,
  );
  await expect(page.locator('select[name="logEvidenceId"]')).not.toHaveAttribute('required');
  await page
    .locator('[data-question-id="profit.account"]')
    .getByRole('link', { name: 'Răspunde la întrebare', exact: true })
    .click();
  await page
    .getByRole('combobox', { name: 'Natura cheltuielii sau venitului', exact: true })
    .selectOption('sponsorship');
  await expect(page.locator('select[name="evidenceIds"]')).toHaveAccessibleName(
    /Documente justificative \(necesare pentru sponsorizare\)/,
  );
  await page
    .locator('[data-question-id="receivable.collectibility"]')
    .getByRole('link', { name: 'Răspunde la întrebare', exact: true })
    .click();
  await page
    .getByRole('combobox', { name: 'Starea creanței', exact: true })
    .selectOption('doubtful');
  await expect(page.locator('select[name="evidenceIds"]')).toHaveAccessibleName(
    /Documente justificative \(necesare dacă starea/,
  );
});

test('D300 presents retained rows and balances with captions and exact amounts; the selected month has a Romanian label', async ({
  page,
}, info) => {
  const artifact = {
    id: 'd300',
    kind: 'D300',
    period: '2026-10',
    state: 'prepared',
    format: 'Format sintetic',
    evidenceId: 'xml',
    xmlHash: 'a'.repeat(64),
    supersedesId: null,
    steps: [
      {
        state: 'prepared',
        actor: null,
        at: '2026-11-16T13:52:10.848Z',
        evidenceId: null,
        detail: JSON.stringify({
          period: '2026-10',
          rows: { R9_1: 100040, R9_2: 21008, R30_2: -25 },
          balances: { R41_2: 0, R42_2: 110 },
        }),
      },
    ],
  };
  await mockWorklist(
    page,
    (operation) => {
      if (operation === 'obligations.calendar')
        return {
          body: {
            items: [{ ...obligation('D300'), status: 'prepared', artifactId: artifact.id }],
            next: null,
          },
        };
      if (operation === 'declarations.list') return { body: { items: [artifact], next: null } };
      return { body: { items: [], next: null } };
    },
    common,
  );
  await page.goto('/contabilitate?view=deadlines&return=D300%7C2026-10&month=2026-10');
  await expect(page.locator('.accounting')).toHaveAttribute('lang', 'ro');
  await expect(page.getByText('Luna selectată: octombrie 2026', { exact: true })).toBeVisible();
  const rows = page.getByRole('table', { name: 'Rândurile declarației', exact: true });
  await expect(rows).toBeVisible();
  await expect(rows.locator('tbody > tr')).toHaveCount(3);
  await expect(rows.locator('[data-d300-element="R9_1"]')).toContainText('Livrări de bunuri');
  await expect(rows.locator('[data-d300-element="R9_1"] > td:last-child')).toHaveText('100040');
  await expect(rows.locator('[data-d300-element="R30_2"] > td:last-child')).toHaveText('-25');
  await expect(rows.locator('[data-d300-element="R9_2"] > td:last-child')).toHaveCSS(
    'text-align',
    'right',
  );
  const balances = page.getByRole('table', { name: 'Soldurile declarației', exact: true });
  await expect(balances.locator('[data-d300-element="R41_2"]')).toContainText('Sold TVA de plată');
  await expect(balances.locator('[data-d300-element="R41_2"] > td:last-child')).toHaveText('0');
  await expect(balances.locator('[data-d300-element="R42_2"] > td:last-child')).toHaveText('110');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('d300-rows.png'), fullPage: true });
});
