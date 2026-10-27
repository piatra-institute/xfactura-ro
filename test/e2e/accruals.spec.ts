import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { invoiceXml } from '../../packages/xfactura-api/test/accounting/fixtures/invoice';

test('reviews a purchase accrual and a later-year invoice without recognizing the expense twice', async ({
  page,
}, info) => {
  const origin = 'http://localhost:3100',
    request = page.request;
  expect(
    (
      await request.post('/api/accounting/auth/sign-in/email', {
        headers: { origin },
        data: {
          email: `accruals-${info.project.name}@example.test`,
          password: 'synthetic-browser-password',
        },
      })
    ).status(),
  ).toBe(200);
  const created = await request.post('/api/accounting/v1/companies', {
    headers: { origin, 'idempotency-key': randomUUID() },
    data: { name: `Servicii ${info.project.name} SRL`, cui: '12345678', year: 2025 },
  });
  expect(created.status()).toBe(200);
  const companyId = (await created.json()).id,
    base = `/api/accounting/v1/companies/${companyId}`;
  async function invoke(id: string, input: unknown, token?: string) {
    const response = await request.post(`${base}/capabilities/${id}`, {
      headers: {
        origin,
        'idempotency-key': randomUUID(),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      data: input,
    });
    expect(response.status(), await response.text()).toBe(200);
    return response.json();
  }
  async function source(filename: string, contents: string) {
    return invoke('evidence.record', {
      filename,
      mediaType: filename.endsWith('.xml') ? 'application/xml' : 'text/plain',
      base64: Buffer.from(contents).toString('base64'),
    });
  }
  async function post(proposal: { id: string; version: number; hash: string }) {
    const input = { id: proposal.id, version: proposal.version, hash: proposal.hash };
    await invoke('books.approve', input);
    await invoke('ledger.post', input);
  }
  const proof = await source(
      'receptie-dec2025.txt',
      'Synthetic signed acceptance of services completed in December 2025',
    ),
    receipt = await source(
      'primire-feb2026.txt',
      'Synthetic dated invoice receipt on 10 February 2026',
    );
  const years = await invoke('years.list', {}),
    previousYear = years.find((year: { kind: string }) => year.kind === 'financial');
  for (const input of [
    { axis: 'vat', value: 'normal_vat' },
    { axis: 'vat_collection', value: 'no' },
  ])
    await invoke('regimes.record', { ...input, effectiveFrom: '2025-01-01', evidenceId: proof.id });
  await post(
    await invoke('ledger.propose', {
      financialYearId: previousYear.id,
      evidenceId: proof.id,
      date: '2025-01-01',
      purpose: 'opening',
      description: 'Poziție inițială',
      sourceReference: 'opening-2025',
      lines: [
        { account: '5121', debit: '5000.00', credit: '0.00' },
        { account: '1012', debit: '0.00', credit: '5000.00' },
      ],
    }),
  );
  const grant = await invoke('agents.issue', {
    name: 'Accrual preparation agent',
    scopes: ['accruals.propose', 'accruals.matchInvoice'],
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
  });
  const accrual = await invoke(
    'accruals.propose',
    {
      financialYearId: previousYear.id,
      evidenceId: proof.id,
      evidenceDate: '2025-12-31',
      reference: 'CONTRACT-DEC-2025',
      date: '2025-12-31',
      serviceFrom: '2025-12-01',
      serviceTo: '2025-12-31',
      supplier: { name: 'Furnizor servicii SRL', taxId: '87654321', country: 'RO' },
      currency: 'RON',
      account: '611',
      net: '100.00',
      vatCategory: 'S',
      taxPointDate: '2025-12-31',
      deduction: 'full',
      counterpartyVatCollection: 'no',
      reason: 'Servicii prestate în decembrie, confirmate prin procesul-verbal de recepție',
    },
    grant.token,
  );
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`/contabilitate?company=${companyId}&financialYearId=${previousYear.id}`);
  const card = page.locator('.acc-review');
  await expect(card).toContainText('Perioada serviciilor');
  await expect(card).toContainText('2025-12-01 — 2025-12-31');
  await expect(card).toContainText('TVA în așteptarea facturii');
  await expect(card.locator('tbody tr')).toHaveCount(3);
  await page.screenshot({
    path: info.outputPath(`accrual-review-${info.project.name}.png`),
    fullPage: true,
  });
  await card.getByRole('button', { name: 'Aprobă această versiune', exact: true }).click();
  await card.getByRole('button', { name: 'Contabilizează', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('contabilizată');
  await expect(page.locator('.acc-balances > div').nth(2)).toContainText('100,00');
  const year = await invoke('years.create', {
    kind: 'financial',
    label: '2026',
    from: '2026-01-01',
    to: '2026-12-31',
  });
  await post(
    await invoke('ledger.propose', {
      financialYearId: year.id,
      evidenceId: proof.id,
      date: '2026-01-01',
      purpose: 'opening',
      description: 'Solduri reportate',
      sourceReference: 'opening-2026',
      lines: [
        { account: '5121', debit: '5000.00', credit: '0.00' },
        { account: '4428', debit: '21.00', credit: '0.00' },
        { account: '1171', debit: '100.00', credit: '0.00' },
        { account: '408', debit: '0.00', credit: '121.00' },
        { account: '1012', debit: '0.00', credit: '5000.00' },
      ],
    }),
  );
  const xml = await source(
    'factura-feb2026.xml',
    invoiceXml({ number: 'INV-FEB-2026', date: '2026-02-03', taxPointDate: '2025-12-31' }),
  );
  const invoice = await invoke('invoices.import', { evidenceId: xml.id });
  await invoke(
    'accruals.matchInvoice',
    {
      financialYearId: year.id,
      invoiceId: invoice.id,
      recognitionDate: '2026-02-10',
      receivedDate: '2026-02-10',
      receiptEvidenceId: receipt.id,
      allocations: [{ accrualId: accrual.id, net: '100.00', tax: '21.00' }],
    },
    grant.token,
  );
  await page.goto(`/contabilitate?company=${companyId}&financialYearId=${year.id}`);
  await expect(card.locator('.acc-review-heading strong')).toContainText('121,00');
  await expect(card).toContainText('Factura primită la');
  await expect(card).toContainText('2026-02-10');
  await expect(card.getByRole('table', { name: 'Servicii deja înregistrate' })).toContainText(
    'CONTRACT-DEC-2025',
  );
  await expect(card.getByRole('table', { name: 'Servicii deja înregistrate' })).toContainText(
    '0,00',
  );
  await expect(
    card.getByRole('table', { name: 'Efect contabil propus' }).locator('tbody tr'),
  ).toHaveCount(4);
  await expect(card.getByRole('table', { name: 'Efect contabil propus' })).not.toContainText('611');
  await page.screenshot({
    path: info.outputPath(`invoice-match-review-${info.project.name}.png`),
    fullPage: true,
  });
  await card.getByRole('button', { name: 'CONTRACT-DEC-2025', exact: true }).click();
  const selector = page.getByRole('combobox', { name: 'Exercițiu financiar', exact: true });
  await expect(selector).toHaveValue(previousYear.id);
  const original = page.locator('.acc-journal').filter({ hasText: 'CONTRACT-DEC-2025' });
  await expect(original).toHaveAttribute('open', '');
  await expect(original.locator('summary')).toBeFocused();
  await selector.selectOption(year.id);
  await page.getByRole('button', { name: /^De verificat\s*1$/ }).click();
  await card.getByRole('button', { name: 'Aprobă această versiune', exact: true }).click();
  await card.getByRole('button', { name: 'Contabilizează', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('contabilizată');
  expect(await invoke('accruals.get', { id: accrual.id, date: '2026-02-28' })).toMatchObject({
    status: 'matched',
    remainingGross: '0.00',
  });
  const before = await invoke('ledger.balance', { financialYearId: previousYear.id }),
    after = await invoke('ledger.balance', { financialYearId: year.id });
  expect(before.balances.find((row: { account: string }) => row.account === '611').closing).toBe(
    '100.00',
  );
  expect(after.balances.some((row: { account: string }) => row.account === '611')).toBe(false);
  expect(await invoke('vat.summary', { financialYearId: year.id })).toMatchObject({
    status: 'reconciled',
    totals: { inputTax: '21.00' },
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});
