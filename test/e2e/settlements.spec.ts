import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { invoiceXml } from '../../packages/xfactura-api/test/accounting/fixtures/invoice';
import { iban, camt, camtEntry } from '../../packages/xfactura-api/test/accounting/fixtures/bank';

test('verifies a cross-year credit and source-linked settlement prepared through the agent API', async ({
  page,
}, info) => {
  const origin = 'http://localhost:3100',
    request = page.request;
  expect(
    (
      await request.post('/api/accounting/auth/sign-in/email', {
        headers: { origin },
        data: {
          email: `settlements-${info.project.name}@example.test`,
          password: 'synthetic-browser-password',
        },
      })
    ).status(),
  ).toBe(200);
  const created = await request.post('/api/accounting/v1/companies', {
    headers: { origin, 'idempotency-key': randomUUID() },
    data: { name: `Decontări ${info.project.name} SRL`, cui: '12345678', year: 2025 },
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
    const review = { id: proposal.id, version: proposal.version, hash: proposal.hash };
    await invoke('books.approve', review);
    return invoke('ledger.post', review);
  }
  const proof = await source(
    'proof.txt',
    'Synthetic dated service, registration and commercial concession evidence',
  );
  for (const input of [
    { axis: 'vat', value: 'normal_vat' },
    { axis: 'vat_collection', value: 'no' },
  ])
    await invoke('regimes.record', { ...input, effectiveFrom: '2025-01-01', evidenceId: proof.id });
  const years = await invoke('years.list', {}),
    previousYear = years.find((year: { kind: string }) => year.kind === 'financial');
  const year = await invoke('years.create', {
    kind: 'financial',
    label: '2026',
    from: '2026-01-01',
    to: '2026-12-31',
  });
  const xml = await source(
    'issued-2025.xml',
    invoiceXml({ direction: 'sale', number: 'INV-2025', date: '2025-12-20' }),
  );
  const invoice = await invoke('invoices.import', { evidenceId: xml.id });
  await post(
    await invoke('invoices.propose', {
      invoiceId: invoice.id,
      financialYearId: previousYear.id,
      recognitionDate: '2025-12-20',
      serviceDate: '2025-12-20',
      taxPointDate: '2025-12-20',
      treatmentEvidenceId: proof.id,
      account: '704',
      deduction: 'none',
      counterpartyVatCollection: 'no',
    }),
  );
  await post(
    await invoke('ledger.propose', {
      financialYearId: year.id,
      evidenceId: proof.id,
      date: '2026-01-01',
      purpose: 'opening',
      description: 'Poziție inițială',
      sourceReference: 'opening-2026',
      lines: [
        { account: '5121', debit: '1000.00', credit: '0.00' },
        { account: '4111', debit: '121.00', credit: '0.00' },
        { account: '1012', debit: '0.00', credit: '1000.00' },
        { account: '4427', debit: '0.00', credit: '21.00' },
        { account: '1171', debit: '0.00', credit: '100.00' },
      ],
    }),
  );
  await invoke('treasury.createAccount', {
    identifier: 'RO00MAIN',
    kind: 'bank',
    currency: 'RON',
    ledgerAccount: '5121',
    openedOn: '2026-01-01',
    evidenceId: proof.id,
  });
  await invoke('accounts.create', {
    code: '5121.SECOND',
    parentCode: '5121',
    name: 'Cont secundar',
    validFrom: '2026-01-01',
  });
  await invoke('treasury.createAccount', {
    identifier: iban,
    kind: 'bank',
    currency: 'RON',
    ledgerAccount: '5121.SECOND',
    openedOn: '2026-01-01',
    evidenceId: proof.id,
  });
  const grant = await invoke('agents.issue', {
    name: 'Settlement agent',
    scopes: ['invoices.proposeCreditNote', 'settlements.propose'],
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
  });
  const creditXml = await source(
    'credit-2026.xml',
    invoiceXml({
      direction: 'sale',
      credit: true,
      number: 'CN-2026',
      originalNumber: 'INV-2025',
      date: '2026-01-15',
      net: '20.00',
      tax: '4.20',
      gross: '24.20',
    }),
  );
  const credit = await invoke('invoices.import', { evidenceId: creditXml.id });
  await invoke(
    'invoices.proposeCreditNote',
    {
      invoiceId: credit.id,
      originalInvoiceId: invoice.id,
      financialYearId: year.id,
      recognitionDate: '2026-01-15',
      decisionDate: '2026-01-15',
      treatmentEvidenceId: proof.id,
      kind: 'commercial_discount',
      periodBasis: 'current_period_event',
      reason: 'Reducere negociată în ianuarie după prestarea serviciului',
    },
    grant.token,
  );
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`/contabilitate?company=${companyId}&financialYearId=${year.id}`);
  const selector = page.getByRole('combobox', { name: 'Exercițiu financiar', exact: true });
  const proposal = page.locator('.acc-review');
  await expect(proposal).toContainText('Motivul corecției');
  await expect(proposal).toContainText('Corecție TVA colectată');
  await expect(proposal).toContainText('-4,20');
  await proposal.getByRole('button', { name: 'INV-2025', exact: true }).click();
  await expect(selector).toHaveValue(previousYear.id);
  const original = page.locator('.acc-journal').filter({ hasText: 'INV-2025' });
  await expect(original).toHaveAttribute('open', '');
  await expect(original.locator('summary')).toBeFocused();
  await selector.selectOption(year.id);
  await page.getByRole('button', { name: /^De verificat\s*1$/ }).click();
  await page.screenshot({
    path: info.outputPath(`credit-review-${info.project.name}.png`),
    fullPage: true,
  });
  await proposal.getByRole('button', { name: 'Aprobă această versiune', exact: true }).click();
  await proposal.getByRole('button', { name: 'Contabilizează', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('contabilizată');
  const bankXml = camt({
    id: 'JAN-2026',
    from: '2026-01-01',
    to: '2026-01-31',
    opening: '0.00',
    closing: '94.80',
    entries: camtEntry({
      amount: '94.80',
      direction: 'CRDT',
      bankRef: 'RECEIPT',
      date: '2026-01-20',
      value: '2026-01-21',
      text: 'Incasare INV-2025',
    }),
  });
  const statement = await source('statement.xml', bankXml);
  await invoke('bank.importFile', {
    evidenceId: statement.id,
    financialYearId: year.id,
    format: 'camt.053',
  });
  const movements = await invoke('bank.movements', { matched: false });
  await invoke(
    'settlements.propose',
    {
      financialYearId: year.id,
      movementId: movements.items[0].id,
      allocations: [{ invoiceId: invoice.id, amount: '96.80' }],
      fee: { amount: '2.00', account: '627', evidenceId: proof.id },
    },
    grant.token,
  );
  await page.reload();
  await expect(proposal.getByRole('table').first()).toContainText('INV-2025');
  await expect(proposal.getByRole('table').first()).toContainText('96,80');
  await expect(proposal).toContainText(iban);
  await expect(proposal).toContainText('Comision bancar: 2,00');
  await expect(proposal.locator('.acc-review-heading strong')).toContainText('94,80');
  await page.screenshot({
    path: info.outputPath(`settlement-review-${info.project.name}.png`),
    fullPage: true,
  });
  await proposal.getByRole('button', { name: 'Aprobă această versiune', exact: true }).click();
  await proposal.getByRole('button', { name: 'Contabilizează', exact: true }).click();
  await expect(page.locator('.acc-balances > div').first()).toContainText(/1[.\s]094,80/);
  expect(
    (await invoke('positions.get', { invoiceId: invoice.id, date: '2026-01-31' })).balance,
  ).toBe('0.00');
  await page.getByRole('button', { name: /^Bancă/ }).click();
  await expect(page.locator('.acc-bank-row')).toContainText('Reconciliată');
  await expect(page.locator('.acc-bank-row')).toContainText('RECEIPT');
  await expect(page.locator('.acc-bank-row')).not.toContainText(/bank:[a-f0-9]{64}/);
  const sourceDetails = page.locator('.acc-bank-source');
  await sourceDetails.locator('summary').focus();
  await page.keyboard.press('Enter');
  await expect(sourceDetails).toContainText('Data valutei');
  await expect(sourceDetails).toContainText('2026-01-21');
  await expect(sourceDetails).toContainText('RECEIPT');
  const sourceLink = page.getByRole('link', { name: 'JAN-2026', exact: true });
  await expect(sourceLink).toBeVisible();
  const [download] = await Promise.all([page.waitForEvent('download'), sourceLink.click()]);
  const stream = await download.createReadStream(),
    chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  expect(Buffer.concat(chunks).toString()).toBe(bankXml);
  await page.screenshot({
    path: info.outputPath(`bank-source-${info.project.name}.png`),
    fullPage: true,
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  expect(errors).toEqual([]);
});
