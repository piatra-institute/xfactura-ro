import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { invoiceXml } from '../../packages/xfactura-api/test/accounting/fixtures/invoice';

test('reviews an estimate increase and residual release without rewriting the accrual or matched invoice', async ({
  page,
}, info) => {
  const origin = 'http://localhost:3100',
    request = page.request;
  expect(
    (
      await request.post('/api/accounting/auth/sign-in/email', {
        headers: { origin },
        data: {
          email: `accrual-adjustments-${info.project.name}@example.test`,
          password: 'synthetic-browser-password',
        },
      })
    ).status(),
  ).toBe(200);
  const created = await request.post('/api/accounting/v1/companies', {
    headers: { origin, 'idempotency-key': randomUUID() },
    data: { name: `Estimări ${info.project.name} SRL`, cui: '12345678', year: 2026 },
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
      'receptie-ianuarie.txt',
      'Synthetic acceptance of completed January services',
    ),
    changed = await source(
      'estimare-februarie.txt',
      'Synthetic new information changing the remaining estimate',
    ),
    years = await invoke('years.list', {}),
    year = years.find((row: { kind: string }) => row.kind === 'financial');
  for (const input of [
    { axis: 'vat', value: 'normal_vat' },
    { axis: 'vat_collection', value: 'no' },
  ])
    await invoke('regimes.record', { ...input, effectiveFrom: '2026-01-01', evidenceId: proof.id });
  await post(
    await invoke('ledger.propose', {
      financialYearId: year.id,
      evidenceId: proof.id,
      date: '2026-01-01',
      purpose: 'opening',
      description: 'Solduri inițiale',
      sourceReference: 'opening',
      lines: [
        { account: '5121', debit: '1000.00', credit: '0.00' },
        { account: '1012', debit: '0.00', credit: '1000.00' },
      ],
    }),
  );
  const original = await invoke('accruals.propose', {
    financialYearId: year.id,
    evidenceId: proof.id,
    evidenceDate: '2026-01-31',
    reference: 'SERVICII-IAN-2026',
    date: '2026-01-31',
    serviceFrom: '2026-01-01',
    serviceTo: '2026-01-31',
    supplier: { name: 'Furnizor servicii SRL', taxId: '87654321', country: 'RO' },
    currency: 'RON',
    account: '628',
    net: '100.00',
    vatCategory: 'S',
    taxPointDate: '2026-01-31',
    deduction: 'full',
    counterpartyVatCollection: 'no',
    reason: 'Servicii primite și documentate prin procesul-verbal de recepție',
  });
  await post(original);
  const grant = await invoke('agents.issue', {
    name: 'Estimate preparation agent',
    scopes: ['accruals.proposeAdjustment', 'accruals.matchInvoice'],
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
  });
  const adjustment = {
    financialYearId: year.id,
    accrualId: original.id,
    reference: 'ESTIMARE-FEB-2026',
    evidenceId: changed.id,
    evidenceDate: '2026-02-10',
    newInformationDate: '2026-02-10',
    date: '2026-02-10',
    periodBasis: 'current_year_estimate_change',
    action: 'reestimate',
    remainingNet: '120.00',
    reason: 'Informații noi confirmă un cost estimat de 120 lei pentru serviciile nefacturate',
  };
  await invoke('accruals.proposeAdjustment', adjustment, grant.token);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`/contabilitate?company=${companyId}&financialYearId=${year.id}`);
  const card = page.locator('.acc-review'),
    comparison = card.getByRole('table', { name: 'Sold nefacturat', exact: true });
  await expect(card).toContainText('Data informației noi');
  await expect(card).toContainText('2026-02-10');
  await expect(comparison).toContainText('121,00');
  await expect(comparison).toContainText('145,20');
  await expect(comparison).toContainText('24,20');
  const effects = card.getByRole('table', { name: 'Efect contabil propus' });
  await expect(effects.locator('tbody tr')).toHaveCount(3);
  await expect(effects).toContainText('20,00');
  await expect(effects).toContainText('4,20');
  await expect(effects).not.toContainText('4426');
  await page.screenshot({
    path: info.outputPath(`estimate-increase-${info.project.name}.png`),
    fullPage: true,
  });
  await card.getByRole('button', { name: 'SERVICII-IAN-2026', exact: true }).focus();
  await page.keyboard.press('Enter');
  const root = page.locator('.acc-journal').filter({ hasText: 'SERVICII-IAN-2026' });
  await expect(root).toHaveAttribute('open', '');
  await expect(root.locator('summary')).toBeFocused();
  await page.getByRole('button', { name: /^De verificat\s*1$/ }).click();
  await card.getByRole('button', { name: 'Aprobă această versiune', exact: true }).click();
  await card.getByRole('button', { name: 'Contabilizează', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('contabilizată');
  const xml = await source(
      'factura-partiala.xml',
      invoiceXml({
        number: 'PARTIAL-FEB',
        date: '2026-02-15',
        taxPointDate: '2026-01-31',
        net: '40.00',
        tax: '8.40',
        gross: '48.40',
      }),
    ),
    invoice = await invoke('invoices.import', { evidenceId: xml.id });
  await invoke(
    'accruals.matchInvoice',
    {
      financialYearId: year.id,
      invoiceId: invoice.id,
      recognitionDate: '2026-02-15',
      receivedDate: '2026-02-15',
      receiptEvidenceId: changed.id,
      allocations: [{ accrualId: original.id, net: '40.00', tax: '8.40' }],
    },
    grant.token,
  );
  await page.reload();
  await expect(card.getByRole('table', { name: 'Servicii deja înregistrate' })).toContainText(
    '145,20',
  );
  await card.getByRole('button', { name: 'Ultima ajustare', exact: true }).click();
  const estimate = page.locator('.acc-journal').filter({ hasText: 'ESTIMARE-FEB-2026' });
  await expect(estimate).toHaveAttribute('open', '');
  await expect(estimate.locator('summary')).toBeFocused();
  await page.getByRole('button', { name: /^De verificat\s*1$/ }).click();
  await card.getByRole('button', { name: 'Aprobă această versiune', exact: true }).click();
  await card.getByRole('button', { name: 'Contabilizează', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('contabilizată');
  await invoke(
    'accruals.proposeAdjustment',
    {
      ...adjustment,
      reference: 'STORNARE-REST-FEB',
      action: 'release',
      remainingNet: '0.00',
      evidenceDate: '2026-02-20',
      newInformationDate: '2026-02-20',
      date: '2026-02-20',
      reason: 'Informațiile noi confirmă anularea costului nefacturat rămas',
    },
    grant.token,
  );
  await page.reload();
  await expect(comparison).toContainText('96,80');
  await expect(comparison).toContainText('-96,80');
  await expect(comparison).toContainText('0,00');
  await expect(effects).toContainText('80,00');
  await expect(effects).not.toContainText('4426');
  await page.screenshot({
    path: info.outputPath(`estimate-release-${info.project.name}.png`),
    fullPage: true,
  });
  await card.getByRole('button', { name: 'Aprobă această versiune', exact: true }).click();
  await card.getByRole('button', { name: 'Contabilizează', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('contabilizată');
  expect(await invoke('accruals.get', { id: original.id, date: '2026-02-28' })).toMatchObject({
    status: 'released',
    matchedGross: '48.40',
    adjustedNet: '40.00',
    remainingGross: '0.00',
    adjustmentCount: 2,
  });
  expect(
    await invoke('positions.get', { invoiceId: invoice.id, date: '2026-02-28' }),
  ).toMatchObject({ balance: '48.40' });
  expect(await invoke('vat.summary', { financialYearId: year.id })).toMatchObject({
    status: 'reconciled',
    totals: { inputTax: '8.40' },
  });
  const balances = await invoke('ledger.balance', { financialYearId: year.id });
  expect(balances.balances.find((row: { account: string }) => row.account === '628').closing).toBe(
    '40.00',
  );
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});
