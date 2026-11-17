import { expect, test, type Page } from '@playwright/test';
import type { ProposalView } from '../../packages/xfactura-api/source/engine/contracts';
import { iban } from '../../packages/xfactura-api/test/engine/fixtures/bank';
import {
  invoiceXml,
  type XmlInput,
} from '../../packages/xfactura-api/test/engine/fixtures/invoice';
import {
  formatDay,
  formatMinor,
  formatPeriod,
} from '../../packages/xfactura-web/components/accounting/format';
import type { WorkItem } from '../../packages/xfactura-web/components/accounting/work-model';
import type { Summary } from '../../packages/xfactura-web/components/accounting/workspace';
import { capability, evidence } from './support/books';
import { signInWithCompany } from './support/session';
import {
  chooseOption,
  clearSegment,
  closeMenu,
  openMenu,
  openSection,
  sections,
  typeDate,
} from './support/shell';
import { mockWorklist, openWorkRow, summary, workItem, workRow } from './support/worklist';

/** Books an invoice as an agent and a person would: imported, proposed, approved, posted. */
async function bookInvoice(page: Page, xml: XmlInput, account: string) {
  const file = await evidence(page, `${xml.number}.xml`, invoiceXml(xml), 'application/xml');
  const document = await capability<{ id: string }>(page, 'invoices.import', {
    evidenceId: file.id,
  });
  const proposal = await capability<ProposalView>(page, 'proposals.propose', {
    treatment: 'invoices.recognize',
    input: { documentId: document.id, account },
  });
  const binding = {
    proposalId: proposal.id,
    version: proposal.version,
    effectHash: proposal.effectHash,
  };
  await capability(page, 'proposals.approve', binding);
  await capability(page, 'ledger.post', binding);
}

/** A company fact a person records, as the worklist lists it. */
const need = (axis: string, message: string, changes: Partial<WorkItem> = {}) =>
  workItem(`closure.need:need:profile.fact|profile:${axis}`, {
    kind: 'closure.need',
    subject: { kind: 'need', id: `profile.fact|profile:${axis}` },
    period: null,
    message,
    causes: [{ id: `fact:${axis}`, kind: 'fact', message, subject: { kind: 'profile', id: axis } }],
    details: { code: 'FACT_UNKNOWN', fact: axis, blocks: [] },
    labels: {
      code: { label: 'Cod', type: 'text' },
      fact: { label: 'Fapt', type: 'text' },
      blocks: { label: 'Declarații afectate', type: 'text' },
    },
    next: [
      {
        operation: 'questions.ask',
        by: 'agent',
        allowed: true,
        inputHint: { kind: 'profile.fact' },
      },
      {
        operation: 'profile.record',
        by: 'human',
        allowed: true,
        inputHint: { axis, effectiveFrom: '2026-01-01' },
      },
    ],
    ...changes,
  });

const employerAxis = {
  axis: 'employer',
  name: 'Calitatea de angajator',
  yearly: false,
  values: [
    { value: 'no', label: 'Fără salariați', applies: true },
    { value: 'yes', label: 'Angajator', applies: true },
  ],
};

test('a new company completes its profile from the card without opening Setări and its worklist turns into the 2026 returns', async ({
  page,
}, info) => {
  test.setTimeout(180000);
  const errors = await signInWithCompany(
    page,
    info,
    'accounting',
    `Profil ${info.project.name} SRL`,
  );
  await openSection(page, 'De verificat');
  if (info.project.name === 'desktop')
    await expect(
      sections(page).getByRole('link', { name: 'De verificat', exact: true }),
    ).toHaveAccessibleDescription(/^\d+\+? de făcut de tine$/);
  const card = page.getByRole('region', { name: 'Profilul firmei', exact: true });
  await expect(card.locator('.acc-fact').first()).toBeVisible();
  // The returns blocked by a fact wait on the person, collapsed into the fact's row.
  const employer = page.locator('[data-cause="fact:employer"]');
  await expect(
    page.getByRole('region', { name: 'De făcut de tine', exact: true }).locator(employer),
  ).toBeVisible();
  await expect(employer.locator('.acc-work-line .acc-chip').first()).toHaveText(/^D112 · ian/);
  await expect(page.getByText(/nespecificat/)).toHaveCount(0);
  // Its action reaches the fact's control in the card.
  await employer.getByRole('button', { name: 'Completează', exact: true }).click();
  await expect(card.locator('[data-fact="employer"]').getByRole('button').first()).toBeFocused();
  await page.screenshot({ path: info.outputPath('new-company-review.png'), fullPage: true });

  for (let round = 0; round < 15 && (await card.count()); round++) {
    const fact = card.locator('.acc-fact').first();
    const key = await fact.getAttribute('data-fact');
    await fact.getByRole('button').first().click();
    await page.getByRole('option').first().click();
    await fact.getByRole('button', { name: 'Salvează', exact: true }).click();
    await expect(card.locator(`[data-fact="${key}"]`)).toHaveCount(0);
    expect(page.url()).not.toContain('view=settings');
  }
  await expect(card).toHaveCount(0);
  await expect(page.getByRole('status')).toContainText('Faptul a fost înregistrat.');
  await expect(page.locator('.acc-worklist')).toHaveAttribute('aria-busy', 'false');
  // The worklist now lists the year's returns themselves: one row per return and state, its
  // periods as one chip, opened to each period with its own deadline and action.
  await expect(page.locator('.acc-work-cause[data-cause^="fact:"]')).toHaveCount(0);
  const top = page.locator('.acc-worklist > .acc-work-group > .acc-work-list > li');
  const groups = top.and(page.locator('.acc-work-return'));
  await expect(groups.first()).toBeVisible();
  const keys = await groups.evaluateAll((rows) =>
    rows.map((row) => row.getAttribute('data-return-group')!),
  );
  expect(new Set(keys).size).toBe(keys.length);
  const statusLabels: Record<string, string> = {
    overdue: 'Termen depășit',
    due: 'De pregătit',
    blocked: 'Blocată',
  };
  // A return in a state that has a row of its own appears nowhere else at the top.
  for (const key of keys) {
    const [form, status] = key.split('|') as [string, string];
    await expect(
      top
        .and(page.locator(`[data-work-id^="obligation.due:obligation:${form}|"]`))
        .filter({ hasText: statusLabels[status] ?? status }),
    ).toHaveCount(0);
  }
  const group = groups.first();
  const [form] = keys[0]!.split('|') as [string];
  await expect(group.locator('.acc-work-title').first()).toHaveText(form);
  await expect(group.locator(':scope > .acc-work-line')).toContainText(/Termen \d{2}\.\d{2}\.2026/);
  const count = Number(
    /^(\d+)/.exec((await group.locator('.acc-work-meta-text').first().textContent()) ?? '')![1],
  );
  expect(count).toBeGreaterThan(1);
  await expect(group.getByRole('link', { name: 'Deschide', exact: true })).toHaveAttribute(
    'href',
    new RegExp(`view=deadlines.*return=${form}%7C2026`),
  );
  await openWorkRow(group);
  const periods = group.locator('.acc-work-members > li');
  await expect(periods).toHaveCount(count);
  for (const title of await periods.locator('.acc-work-title').allTextContents())
    expect(title).toMatch(new RegExp(`^${form} · .*2026$`));
  await expect(periods.filter({ hasText: /Termen \d{2}\.\d{2}\.2026/ })).toHaveCount(count);
  await expect(periods.getByRole('link', { name: 'Deschide', exact: true })).toHaveCount(count);
  await page.screenshot({ path: info.outputPath('profile-complete-review.png'), fullPage: true });

  await openSection(page, 'Acasă');
  await expect(page.getByRole('region', { name: 'Profilul firmei' })).toHaveCount(0);
  // Acasă groups the same way, then shows at most five rows.
  const now = page.locator('.acc-home-work > li');
  await expect(now.first()).toBeVisible();
  expect(await now.count()).toBeLessThanOrEqual(5);
  const homeKeys = await now
    .and(page.locator('.acc-work-return'))
    .evaluateAll((rows) => rows.map((row) => row.getAttribute('data-return-group')));
  expect(new Set(homeKeys).size).toBe(homeKeys.length);
  const deadlines = page.getByRole('region', { name: 'Termene', exact: true });
  await expect(deadlines.locator('.acc-deadline-day time').first()).toHaveText(
    /^\d{1,2} \p{L}+( \d{4})?$/u,
  );
  expect(errors).toEqual([]);
});

test('Acasă shows the money and the next returns as company.summary states them', async ({
  page,
}, info) => {
  const requests: string[] = [];
  page.on('request', (request) => requests.push(request.url()));
  const errors = await signInWithCompany(page, info, 'accounting', `Bani ${info.project.name} SRL`);
  const proof = await evidence(page, 'profil-bani.pdf', 'Profil sintetic');
  for (const [axis, value] of Object.entries({
    'entity.form': 'srl',
    'vat.status': 'normal_vat',
    'vat.period': 'monthly',
    employer: 'no',
  }))
    await capability(page, 'profile.record', {
      axis,
      value,
      effectiveFrom: '2026-01-01',
      evidenceId: proof.id,
    });
  await capability(page, 'treasury.createAccount', {
    kind: 'bank',
    name: 'Cont curent',
    iban,
    currency: 'RON',
    ledgerAccount: '5121',
    openedOn: '2026-01-01',
  });
  const opening = await capability<ProposalView>(page, 'ledger.general.propose', {
    date: '2026-01-01',
    purpose: 'opening',
    reference: 'DESCHIDERE-BANI',
    description: 'Sold inițial la bancă',
    evidenceId: proof.id,
    lines: [
      { account: '5121', side: 'D', amount: '4321.09' },
      { account: '1012', side: 'C', amount: '4321.09' },
    ],
  });
  const binding = {
    proposalId: opening.id,
    version: opening.version,
    effectHash: opening.effectHash,
  };
  await capability(page, 'proposals.approve', binding);
  await capability(page, 'ledger.post', binding);
  await bookInvoice(
    page,
    {
      direction: 'sale',
      number: 'FV-301',
      date: '2026-10-15',
      net: '12500.00',
      tax: '2625.00',
      gross: '15125.00',
    },
    '704',
  );
  await bookInvoice(
    page,
    { number: 'FP-302', date: '2026-10-20', net: '1840.50', tax: '386.51', gross: '2227.01' },
    '628',
  );
  const stated = await capability<Summary>(page, 'company.summary');
  await openSection(page, 'Acasă');
  const money = page.getByRole('region', { name: 'Bani', exact: true });
  await expect(money).toHaveAttribute('aria-busy', 'false');
  const line = (block: string, name: string) =>
    money
      .locator('.acc-money-block', { has: page.getByRole('heading', { name: block, exact: true }) })
      .locator('.acc-statement-line', { hasText: name });
  for (const account of stated.cash.accounts)
    await expect(line('Bancă și casă', account.name)).toContainText(
      formatMinor(account.balance.minor, account.balance.currency),
    );
  for (const total of stated.cash.totals)
    await expect(line('Bancă și casă', `Total ${total.currency}`)).toContainText(
      formatMinor(total.minor, total.currency),
    );
  for (const [block, owed, side] of [
    ['Clienți', 'De încasat', stated.receivables],
    ['Furnizori', 'De plătit', stated.payables],
  ] as const) {
    expect(side.currencies.length).toBeGreaterThan(0);
    for (const currency of side.currencies) {
      await expect(line(block, owed).filter({ hasText: currency.currency })).toContainText(
        formatMinor(currency.total, currency.currency),
      );
      if (currency.overdueCount)
        await expect(line(block, 'Restante')).toContainText(
          formatMinor(currency.overdue, currency.currency),
        );
    }
  }
  if (stated.tax)
    await expect(line('Stat', 'Sold')).toContainText(formatMinor(stated.tax.net.minor, 'RON'));
  else await expect(money).toContainText('Poziția nu se calculează');
  const deadlines = page.getByRole('region', { name: 'Termene', exact: true });
  await expect(deadlines.locator('.acc-deadline')).toHaveCount(stated.deadlines.length);
  for (const deadline of stated.deadlines) {
    const row = deadlines.locator(`[data-return="${deadline.kind}|${deadline.period}"]`);
    await expect(row).toContainText(`${deadline.kind} ${formatPeriod(deadline.period)}`);
    if (deadline.due)
      await expect(row.locator('time')).toHaveText(
        formatDay(deadline.due, stated.date.slice(0, 4)),
      );
  }
  await page.screenshot({ path: info.outputPath('home.png'), fullPage: true });
  // Acasă reads the summary; it neither reads the trial balance nor adds anything up.
  expect(requests.some((url) => url.endsWith('/capabilities/ledger.trialBalance'))).toBe(false);
  expect(errors).toEqual([]);
});

test('Acasă states every figure as the summary gives it, its gaps in one line, and the sidebar counts what waits', async ({
  page,
}, info) => {
  const requests: string[] = [];
  page.on('request', (request) => requests.push(request.url()));
  const decision = workItem('action.awaitingDecision:action:close', {
    kind: 'action.awaitingDecision',
    subject: { kind: 'action', id: 'close' },
    message: 'Închiderea lunii octombrie 2026 așteaptă aprobarea ta.',
    period: '2026-10',
    next: [
      {
        operation: 'actions.approve',
        by: 'human',
        allowed: true,
        inputHint: { id: 'close', previewHash: 'b'.repeat(64) },
      },
    ],
  });
  const stated = summary({
    cash: {
      accounts: [
        {
          id: 'bank',
          kind: 'bank',
          name: 'Cont curent',
          ledgerAccount: '5121',
          currency: 'RON',
          balance: { minor: '1234567', currency: 'RON' },
          ledgerBalance: { minor: '1234567', currency: 'RON' },
        },
        {
          id: 'euro',
          kind: 'bank',
          name: 'Cont în euro',
          ledgerAccount: '5124',
          currency: 'EUR',
          balance: { minor: '50000', currency: 'EUR' },
          ledgerBalance: { minor: '248750', currency: 'RON' },
        },
        {
          id: 'cash',
          kind: 'cash',
          name: 'Casa',
          ledgerAccount: '5311',
          currency: 'RON',
          balance: { minor: '0', currency: 'RON' },
          ledgerBalance: { minor: '0', currency: 'RON' },
        },
      ],
      // Not the sum of the accounts: the interface shows the engine's total as stated.
      totals: [
        { minor: '9999999', currency: 'RON' },
        { minor: '50000', currency: 'EUR' },
      ],
    },
    receivables: {
      count: 3,
      currencies: [
        { currency: 'RON', total: '1512500', count: 2, overdue: '1000000', overdueCount: 1 },
        { currency: 'EUR', total: '20000', count: 1, overdue: '0', overdueCount: 0 },
      ],
      unrepresented: {
        code: 'UNSUPPORTED',
        accounts: [{ account: '4118', balance: { minor: '50000', currency: 'RON' } }],
      },
    },
    payables: {
      count: 1,
      currencies: [{ currency: 'RON', total: '222701', count: 1, overdue: '0', overdueCount: 0 }],
      unrepresented: null,
    },
    tax: null,
    taxReason: { code: 'RULE_GAP', message: 'Lipsește regula.', details: {} },
    work: {
      total: 12,
      by: { person: 4, agent: 6, neither: 2 },
      severity: { block: 3, warn: 8, info: 1 },
      complete: false,
      next: 'obligations:',
      asOfSeq: 1,
    },
    deadlines: [
      {
        kind: 'D100',
        period: '2026-09',
        deadline: 'D100.micro',
        due: '2026-10-26',
        status: 'overdue',
        artifactId: null,
      },
      {
        kind: 'D300',
        period: '2026-10',
        deadline: 'D300',
        due: '2026-11-25',
        status: 'due',
        artifactId: null,
      },
      {
        kind: 'D406',
        period: '2026-Q4',
        deadline: 'D406',
        due: '2027-02-01',
        status: 'due',
        artifactId: null,
      },
      {
        kind: 'D112',
        period: '2026-11',
        deadline: 'D112',
        due: null,
        status: 'blocked',
        artifactId: null,
      },
    ],
  });
  await mockWorklist(
    page,
    (operation) => {
      if (operation === 'questions.list')
        return { body: { items: [{ id: 'q1' }, { id: 'q2' }], next: null } };
      if (operation === 'work.get')
        return { body: { state: 'open', item: decision, disposition: null } };
      if (operation === 'actions.get')
        return {
          body: {
            id: 'close',
            previewHash: 'b'.repeat(64),
            preview: { month: '2026-10', findings: [] },
          },
        };
      return { body: { items: [], next: null, asOfSeq: 1 } };
    },
    {
      'company.summary': stated,
      'work.list:human': [
        need('employer', 'Nu este înregistrat dacă firma are salariați.'),
        decision,
      ],
      'profile.current': { date: '2026-11-17', items: [employerAxis], next: null, groups: [] },
    },
  );
  await page.goto('/contabilitate?company=company');
  const money = page.getByRole('region', { name: 'Bani', exact: true });
  const block = (name: string) =>
    money.locator('.acc-money-block', { has: page.getByRole('heading', { name, exact: true }) });
  await expect(block('Bancă și casă').locator('.acc-statement-line')).toHaveText([
    'Cont curent12.345,67 RON',
    'Cont în euro500,00 EUR',
    'Casa0,00 RON',
    'Total RON99.999,99 RON',
    'Total EUR500,00 EUR',
  ]);
  await expect(block('Clienți').locator('.acc-statement-line')).toHaveText([
    'De încasat2 poziții deschise15.125,00 RON',
    'Restante1 poziție restantă10.000,00 RON',
    'De încasat1 poziție deschisă200,00 EUR',
  ]);
  await expect(block('Clienți').locator('.acc-amount--danger')).toHaveText('10.000,00 RON');
  // A balance the open items cannot show is named in one line, outside the total.
  await expect(block('Clienți').locator('.acc-money-note')).toHaveText(
    'Fără evidență pe parteneri, în afara totalului: 4118.',
  );
  await expect(block('Furnizori').locator('.acc-statement-line')).toHaveText([
    'De plătit1 poziție deschisă2.227,01 RON',
  ]);
  // The tax position's typed gap is one line, never a zero.
  await expect(block('Stat')).toHaveText(
    'StatPoziția nu se calculează: lipsește o regulă fiscală aprobată.',
  );
  const deadlines = page.getByRole('region', { name: 'Termene', exact: true });
  await expect(deadlines.locator('.acc-deadline-day')).toHaveText([
    '26 octombrie',
    '25 noiembrie',
    '1 februarie 2027',
    '',
  ]);
  await expect(deadlines.locator('.acc-deadline-return')).toHaveText([
    'D100 septembrie 2026',
    'D300 octombrie 2026',
    'D406 trimestrul IV 2026',
    'D112 noiembrie 2026',
  ]);
  await expect(deadlines.locator('.acc-deadline-status')).toHaveText([
    'Termen depășit',
    'De pregătit',
    'De pregătit',
    'Blocată',
  ]);
  await expect(
    deadlines.locator('[data-return="D300|2026-10"]').getByRole('link', { name: 'Deschide' }),
  ).toHaveAttribute('href', /view=deadlines.*return=D300%7C2026-10/);
  // De făcut acum: the fact to record first, then what waits on the person, with its action.
  const now = page.getByRole('region', { name: 'De făcut acum', exact: true });
  await expect(now.getByRole('region', { name: 'Profilul firmei' })).toBeVisible();
  await expect(now.locator('.acc-work-title')).toHaveText([decision.message]);
  await now.getByRole('button', { name: 'Aprobă', exact: true }).click();
  await expect(
    now.getByRole('button', { name: 'Aprobă această previzualizare', exact: true }),
  ).toBeVisible();
  await expect(now.getByRole('link', { name: /^De verificat/ })).toHaveText('De verificat4+');
  // The sidebar counts what waits on the person; „+” when the engine stopped counting early.
  await openMenu(page);
  const review = sections(page).getByRole('link', { name: 'De verificat', exact: true });
  await expect(review).toHaveAccessibleDescription('4+ de făcut de tine');
  await expect(review.locator('.acc-badge')).toHaveText('4+');
  await expect(
    sections(page).getByRole('link', { name: 'Întrebări', exact: true }),
  ).toHaveAccessibleDescription('2 deschise');
  await closeMenu(page);
  await page.screenshot({ path: info.outputPath('home-summary.png'), fullPage: true });
  expect(requests.some((url) => url.endsWith('/capabilities/ledger.trialBalance'))).toBe(false);
});

test('Acasă names one action where it has nothing to show, and a summary it cannot read', async ({
  page,
}) => {
  let fail = true;
  await mockWorklist(
    page,
    (operation) => {
      if (operation === 'company.summary')
        return fail
          ? { status: 503, body: { error: { message: 'Situația nu poate fi citită acum.' } } }
          : { body: summary() };
      return { body: { items: [], next: null, asOfSeq: 1 } };
    },
    { 'company.summary': undefined },
  );
  await page.goto('/contabilitate?company=company');
  const money = page.getByRole('region', { name: 'Bani', exact: true });
  await expect(money.getByRole('alert')).toHaveText('Situația nu poate fi citită acum.');
  fail = false;
  await money.getByRole('button', { name: 'Reîncearcă', exact: true }).click();
  await expect(money.getByText('Niciun cont bancar sau de casă.')).toBeVisible();
  await expect(money.getByRole('link', { name: 'Adaugă un cont', exact: true })).toHaveAttribute(
    'href',
    /view=bank/,
  );
  await expect(money).toContainText('Nicio poziție deschisă.');
  const deadlines = page.getByRole('region', { name: 'Termene', exact: true });
  await expect(deadlines.getByText('Nicio declarație de depus.')).toBeVisible();
  await expect(
    deadlines.getByRole('link', { name: 'Deschide Declarații', exact: true }),
  ).toHaveAttribute('href', /view=deadlines/);
  const now = page.getByRole('region', { name: 'De făcut acum', exact: true });
  await expect(now.getByText('Nimic nu așteaptă decizia ta.')).toBeVisible();
  await expect(now.getByRole('link', { name: 'Adaugă documente', exact: true })).toBeVisible();
});

test('a cause row collapses its returns into chips and its action reaches the fact in the card', async ({
  page,
}, info) => {
  const message = 'Nu este înregistrat dacă firma are salariați.';
  const cause = {
    id: 'fact:employer',
    kind: 'fact' as const,
    message,
    subject: { kind: 'profile', id: 'employer' },
  };
  const card = need('employer', message, {
    details: {
      code: 'FACT_UNKNOWN',
      fact: 'employer',
      blocks: ['D112|2026-01', 'D112|2026-02', 'D112|2026-03', 'D112|2026-05'],
    },
  });
  const blocked = (period: string, severity: WorkItem['severity'] = 'block') =>
    workItem(`obligation.due:obligation:D112|${period}`, {
      kind: 'obligation.due',
      subject: { kind: 'obligation', id: `D112|${period}` },
      severity,
      period,
      message: `D112 pentru ${period} depinde de: ${message}`,
      causes: [cause],
      details: { kind: 'D112', period, status: 'blocked', gap: message },
      labels: {
        kind: { label: 'Declarație', type: 'text' },
        period: { label: 'Perioadă', type: 'period' },
        status: { label: 'Stare', type: 'text' },
        gap: { label: 'Ce lipsește', type: 'text' },
      },
      next: [{ operation: 'questions.ask', by: 'agent', allowed: true, inputHint: { kind: 'x' } }],
    });
  const items = [
    card,
    blocked('2026-01'),
    blocked('2026-02'),
    blocked('2026-03'),
    blocked('2026-05', 'warn'),
  ];
  await mockWorklist(
    page,
    (operation, input) => {
      if (operation === 'work.list') return { body: { items, next: null, asOfSeq: 1 } };
      if (operation === 'work.get')
        return {
          body: {
            state: 'open',
            item: items.find((item) => item.id === input.id),
            disposition: null,
          },
        };
      return { body: {} };
    },
    {
      'work.list:human': [card],
      'profile.current': { date: '2026-11-17', items: [employerAxis], next: null, groups: [] },
    },
  );
  await page.goto('/contabilitate?company=company&view=review');
  // The fact is a row of the card, not of the list.
  const fact = page.locator('[data-fact="employer"]');
  await expect(fact).toBeVisible();
  await expect(workRow(page, card.id)).toHaveCount(0);
  const row = page.locator('.acc-work-cause');
  await expect(row).toHaveCount(1);
  await expect(
    page.getByRole('region', { name: 'De făcut de tine', exact: true }).locator(row),
  ).toBeVisible();
  await expect(row.locator('.acc-work-toggle').first()).toHaveText(message);
  await expect(row.locator(':scope > .acc-work-line .acc-chip')).toHaveText([
    'D112 · ian–mar 2026, mai 2026',
    'Blocant',
  ]);
  await expect(page.locator('.acc-work-title')).toHaveText([message]);
  await page.screenshot({ path: info.outputPath('cause-row.png'), fullPage: true });
  await row.getByRole('button', { name: 'Completează', exact: true }).click();
  await expect(fact.getByRole('button', { name: /Calitatea de angajator$/ })).toBeFocused();
  // Opened, the row lists its returns, each its own row.
  await openWorkRow(row);
  await expect(row.locator('.acc-work-members .acc-work-title')).toHaveText([
    'D112 · ianuarie 2026',
    'D112 · februarie 2026',
    'D112 · martie 2026',
    'D112 · mai 2026',
  ]);
  await openWorkRow(workRow(row, 'obligation.due:obligation:D112|2026-02'));
  await expect(workRow(row, 'obligation.due:obligation:D112|2026-02')).toContainText(
    'Perioadăfebruarie 2026',
  );
});

test('the date of a fact, typed as 17.11.2026, reaches the engine as an ISO date, and part of one is refused', async ({
  page,
}) => {
  const inputs: Record<string, Record<string, unknown>> = {};
  await mockWorklist(
    page,
    (operation, input) => {
      inputs[operation] = input;
      return { body: { items: [], next: null, asOfSeq: 1 } };
    },
    {
      'work.list:human': [need('employer', 'Nu este înregistrat dacă firma are salariați.')],
      'profile.current': { date: '2026-11-17', items: [employerAxis], next: null, groups: [] },
    },
  );
  await page.goto('/contabilitate?company=company&view=review');
  const fact = page.locator('[data-fact="employer"]');
  // The date starts from the day the engine names for the fact.
  await expect(fact.getByRole('group', { name: 'De la', exact: true })).toContainText('01.01.2026');
  await chooseOption(fact, 'Calitatea de angajator', 'Angajator');
  await typeDate(fact, 'De la', '17.11.2026');
  // Part of a date is no date: the fact is not recorded, and the field says why.
  await clearSegment(fact, 'De la', 1);
  await fact.getByRole('button', { name: 'Salvează', exact: true }).click();
  await expect(
    fact.getByText('Data este incompletă: completează ziua, luna și anul sau golește câmpul.'),
  ).toBeVisible();
  expect(inputs['profile.record']).toBeUndefined();
  await typeDate(fact, 'De la', '17.11.2026');
  await fact.getByRole('button', { name: 'Salvează', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Faptul a fost înregistrat.');
  expect(inputs['profile.record']).toEqual({
    axis: 'employer',
    value: 'yes',
    effectiveFrom: '2026-11-17',
  });
});

test('a role that may not record a fact reads why instead of the controls', async ({ page }) => {
  const refused = need('employer', 'Nu este înregistrat dacă firma are salariați.');
  refused.next = refused.next.map((step) =>
    step.operation === 'profile.record'
      ? { ...step, allowed: false, reason: { kind: 'role', permission: 'review' } }
      : step,
  );
  await mockWorklist(page, () => ({ body: { items: [], next: null, asOfSeq: 1 } }), {
    'work.list:human': [refused],
    'profile.current': { date: '2026-11-17', items: [employerAxis], next: null, groups: [] },
  });
  await page.goto('/contabilitate?company=company&view=review');
  const fact = page.locator('[data-fact="employer"]');
  await expect(fact).toHaveText('Calitatea de angajatorRolul tău nu are dreptul de verificare.');
  await expect(fact.getByRole('button')).toHaveCount(0);
  await expect(fact.getByRole('group', { name: 'De la' })).toHaveCount(0);
  await chooseOption(page, 'Familie', 'Închidere');
  await expect(page.getByText('Niciun element pentru filtrele alese.')).toBeVisible();
});
