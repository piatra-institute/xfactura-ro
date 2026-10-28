import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { invoiceXml } from '../../packages/xfactura-api/test/accounting/fixtures/invoice';

test('reviews unbilled sales and a later-year invoice without repeating revenue or output VAT', async ({
  page,
}, info) => {
  const origin = 'http://localhost:3100',
    request = page.request;
  expect(
    (
      await request.post('/api/accounting/auth/sign-in/email', {
        headers: { origin },
        data: {
          email: `unbilled-sales-${info.project.name}@example.test`,
          password: 'synthetic-browser-password',
        },
      })
    ).status(),
  ).toBe(200);
  const created = await request.post('/api/accounting/v1/companies', {
    headers: { origin, 'idempotency-key': randomUUID() },
    data: { name: `Servicii prestate ${info.project.name} SRL`, cui: '12345678', year: 2025 },
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
    return invoke('ledger.post', input);
  }
  const proof = await source(
      'servicii-dec2025.txt',
      'Synthetic acceptance of completed December 2025 services',
    ),
    years = await invoke('years.list', {}),
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
      description: 'Solduri inițiale',
      sourceReference: 'opening-2025',
      lines: [
        { account: '5121', debit: '1000.00', credit: '0.00' },
        { account: '1012', debit: '0.00', credit: '1000.00' },
      ],
    }),
  );
  const grant = await invoke('agents.issue', {
    name: 'Sales preparation agent',
    scopes: [
      'unbilledSales.propose',
      'unbilledSales.matchInvoice',
      'unbilledSales.proposeAdjustment',
    ],
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
  });
  const original = await invoke(
    'unbilledSales.propose',
    {
      financialYearId: previousYear.id,
      evidenceId: proof.id,
      evidenceDate: '2025-12-31',
      reference: 'SERVICII-DEC-2025',
      date: '2025-12-31',
      serviceFrom: '2025-12-01',
      serviceTo: '2025-12-31',
      customer: { name: 'Client servicii SRL', taxId: '87654321', country: 'RO' },
      currency: 'RON',
      account: '704',
      net: '100.00',
      vatCategory: 'S',
      taxPointDate: '2025-12-31',
      taxPointBasis: 'completed_service',
      reason: 'Servicii finalizate în decembrie și confirmate prin procesul-verbal de recepție',
    },
    grant.token,
  );
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`/contabilitate?company=${companyId}&financialYearId=${previousYear.id}`);
  const card = page.locator('.acc-review');
  await expect(card).toContainText('Client servicii SRL');
  await expect(card).toContainText('2025-12-01 — 2025-12-31');
  await expect(card).toContainText('Exigibilitate TVA');
  await expect(card).toContainText('TVA colectată');
  await expect(card.getByRole('table', { name: 'Efect contabil propus' })).toContainText('418');
  await expect(card.getByRole('table', { name: 'Efect contabil propus' })).toContainText('704');
  await expect(card.getByRole('table', { name: 'Efect contabil propus' })).toContainText('4427');
  await expect(
    card.getByRole('table', { name: 'Efect contabil propus' }).locator('tbody tr'),
  ).toHaveCount(3);
  await page.screenshot({
    path: info.outputPath(`unbilled-sale-review-${info.project.name}.png`),
    fullPage: true,
  });
  await card.getByRole('button', { name: 'Aprobă această versiune', exact: true }).click();
  await card.getByRole('button', { name: 'Contabilizează', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('contabilizată');
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
        { account: '5121', debit: '1000.00', credit: '0.00' },
        { account: '418', debit: '121.00', credit: '0.00' },
        { account: '4427', debit: '0.00', credit: '21.00' },
        { account: '1171', debit: '0.00', credit: '100.00' },
        { account: '1012', debit: '0.00', credit: '1000.00' },
      ],
    }),
  );
  const xml = await source(
      'factura-ian2026.xml',
      invoiceXml({
        direction: 'sale',
        number: 'VANZARE-IAN-2026',
        date: '2026-01-10',
        taxPointDate: '2025-12-31',
      }),
    ),
    invoice = await invoke('invoices.import', { evidenceId: xml.id });
  await invoke(
    'unbilledSales.matchInvoice',
    {
      financialYearId: year.id,
      invoiceId: invoice.id,
      recognitionDate: '2026-01-10',
      allocations: [{ unbilledSaleId: original.id, net: '100.00', tax: '21.00' }],
    },
    grant.token,
  );
  await page.goto(`/contabilitate?company=${companyId}&financialYearId=${year.id}`);
  await expect(card.locator('.acc-review-heading strong')).toContainText('121,00');
  await expect(card).toContainText('TVA colectată anterior');
  await expect(card.getByRole('table', { name: 'Servicii deja înregistrate' })).toContainText(
    'SERVICII-DEC-2025',
  );
  const effects = card.getByRole('table', { name: 'Efect contabil propus' });
  await expect(effects.locator('tbody tr')).toHaveCount(2);
  await expect(effects).toContainText('4111');
  await expect(effects).toContainText('418');
  await expect(effects).not.toContainText('704');
  await expect(effects).not.toContainText('4427');
  await page.screenshot({
    path: info.outputPath(`sales-invoice-match-${info.project.name}.png`),
    fullPage: true,
  });
  const originalButton = card.getByRole('button', { name: 'SERVICII-DEC-2025', exact: true });
  await originalButton.focus();
  await page.keyboard.press('Enter');
  const selector = page.getByRole('combobox', { name: 'Exercițiu financiar', exact: true });
  await expect(selector).toHaveValue(previousYear.id);
  const journal = page.locator('.acc-journal').filter({ hasText: 'SERVICII-DEC-2025' });
  await expect(journal).toHaveAttribute('open', '');
  await expect(journal.locator('summary')).toBeFocused();
  await selector.selectOption(year.id);
  await page.getByRole('button', { name: /^De verificat\s*1$/ }).click();
  await card.getByRole('button', { name: 'Aprobă această versiune', exact: true }).click();
  await card.getByRole('button', { name: 'Contabilizează', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('contabilizată');
  expect(await invoke('unbilledSales.get', { id: original.id, date: '2026-01-31' })).toMatchObject({
    status: 'matched',
    remainingGross: '0.00',
  });
  expect(await invoke('vat.summary', { financialYearId: previousYear.id })).toMatchObject({
    status: 'reconciled',
    totals: { base: '100.00', outputTax: '21.00' },
  });
  expect(await invoke('vat.summary', { financialYearId: year.id })).toMatchObject({
    status: 'reconciled',
    totals: { base: '0.00', outputTax: '0.00' },
  });
  const estimateProof = await source(
    'estimare-servicii.txt',
    'Completed January services with uncertain consideration, measured from the retained acceptance record',
  );
  const estimated = await invoke(
    'unbilledSales.propose',
    {
      financialYearId: year.id,
      evidenceId: estimateProof.id,
      evidenceDate: '2026-01-20',
      reference: 'ESTIMARE-2026',
      date: '2026-01-20',
      serviceFrom: '2026-01-01',
      serviceTo: '2026-01-20',
      customer: { name: 'Client servicii SRL', taxId: '87654321', country: 'RO' },
      currency: 'RON',
      account: '704',
      net: '100.00',
      vatCategory: 'S',
      taxPointDate: '2026-01-20',
      taxPointBasis: 'completed_service',
      measurementBasis: 'estimated_consideration',
      reason: 'Evaluare documentată a valorii estimate pentru serviciile deja finalizate',
    },
    grant.token,
  );
  const rootEntry = await post(estimated);
  const measurementProof = await source(
    'informatii-noi-venit.txt',
    'New measurement information increases the unbilled service consideration to 120 RON before invoicing',
  );
  const changed = await invoke(
    'unbilledSales.proposeAdjustment',
    {
      financialYearId: year.id,
      unbilledSaleId: estimated.id,
      reference: 'REEVALUARE-2026',
      evidenceId: measurementProof.id,
      evidenceDate: '2026-01-25',
      newInformationDate: '2026-01-25',
      date: '2026-01-25',
      periodBasis: 'current_year_estimate_change',
      changeBasis: 'new_measurement_information',
      action: 'reestimate',
      remainingNet: '120.00',
      reason: 'Informații noi privind evaluarea contraprestației pentru serviciile prestate',
    },
    grant.token,
  );
  await page.goto(`/contabilitate?company=${companyId}&financialYearId=${year.id}`);
  await expect(card).toContainText('Servicii inițiale');
  await expect(card).toContainText('Perioada TVA');
  const remaining = card.getByRole('table', { name: 'Sold nefacturat', exact: true });
  await expect(remaining).toContainText('100,00');
  await expect(remaining).toContainText('120,00');
  await expect(remaining).toContainText('4,20');
  await expect(card.getByRole('link', { name: 'informatii-noi-venit.txt' })).toHaveAttribute(
    'href',
    `${base}/evidence/${measurementProof.id}`,
  );
  await page.screenshot({
    path: info.outputPath(`sales-estimate-${info.project.name}.png`),
    fullPage: true,
  });
  await card.getByRole('button', { name: 'ESTIMARE-2026', exact: true }).focus();
  await page.keyboard.press('Enter');
  const estimateJournal = page.locator(`#journal-${rootEntry.id}`);
  await expect(estimateJournal).toHaveAttribute('open', '');
  await expect(estimateJournal.locator('summary')).toBeFocused();
  await expect(estimateJournal).toContainText('Valoare estimată');
  await page.goto(`/contabilitate?company=${companyId}&financialYearId=${year.id}`);
  await card.getByRole('button', { name: 'Aprobă această versiune', exact: true }).click();
  await card.getByRole('button', { name: 'Contabilizează', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('contabilizată');
  const changedEntry = await invoke('ledger.post', {
    id: changed.id,
    version: changed.version,
    hash: changed.hash,
  });
  const measuredXml = await source(
    'factura-reevaluata.xml',
    invoiceXml({
      direction: 'sale',
      number: 'REEVALUATA-2026',
      date: '2026-02-01',
      taxPointDate: '2026-01-20',
      net: '120.00',
      tax: '25.20',
      gross: '145.20',
    }),
  );
  const measuredInvoice = await invoke('invoices.import', { evidenceId: measuredXml.id });
  await invoke(
    'unbilledSales.matchInvoice',
    {
      financialYearId: year.id,
      invoiceId: measuredInvoice.id,
      recognitionDate: '2026-02-01',
      allocations: [{ unbilledSaleId: estimated.id, net: '120.00', tax: '25.20' }],
    },
    grant.token,
  );
  await page.reload();
  await expect(card.getByRole('table', { name: 'Servicii deja înregistrate' })).toContainText(
    '145,20',
  );
  await expect(card.getByRole('table', { name: 'Efect contabil propus' })).not.toContainText(
    '4427',
  );
  await card.getByRole('button', { name: 'Ultima ajustare', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page.locator(`#journal-${changedEntry.id}`)).toHaveAttribute('open', '');
  await expect(page.locator(`#journal-${changedEntry.id}`).locator('summary')).toBeFocused();
  await page.goto(`/contabilitate?company=${companyId}&financialYearId=${year.id}`);
  await card.getByRole('button', { name: 'Aprobă această versiune', exact: true }).click();
  await card.getByRole('button', { name: 'Contabilizează', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('contabilizată');
  expect(await invoke('unbilledSales.get', { id: estimated.id, date: '2026-02-28' })).toMatchObject(
    { status: 'matched', adjustedNet: '120.00', remainingGross: '0.00', matchedGross: '145.20' },
  );
  expect(
    await invoke('unbilledSales.reconcile', { financialYearId: year.id, date: '2026-02-28' }),
  ).toMatchObject({ status: 'reconciled' });
  expect(await invoke('vat.summary', { financialYearId: year.id })).toMatchObject({
    status: 'reconciled',
    totals: { base: '120.00', outputTax: '25.20' },
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});
