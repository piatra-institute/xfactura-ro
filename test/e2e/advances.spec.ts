import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { invoiceXml } from '../../packages/xfactura-api/test/accounting/fixtures/invoice';
import { finalInvoiceXml } from '../../packages/xfactura-api/test/accounting/fixtures/advance';

test('reviews bank advances, matched invoices, final allocations, unused credits and cash refunds', async ({
  page,
}, info) => {
  const origin = 'http://localhost:3100',
    request = page.request;
  expect(
    (
      await request.post('/api/accounting/auth/sign-in/email', {
        headers: { origin },
        data: {
          email: `advances-${info.project.name}@example.test`,
          password: 'synthetic-browser-password',
        },
      })
    ).status(),
  ).toBe(200);
  const created = await request.post('/api/accounting/v1/companies', {
    headers: { origin, 'idempotency-key': randomUUID() },
    data: { name: `Avansuri ${info.project.name} SRL`, cui: '12345678', year: 2026 },
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
  async function post(p: { id: string; version: number; hash: string }) {
    const input = { id: p.id, version: p.version, hash: p.hash };
    await invoke('books.approve', input);
    return invoke('ledger.post', input);
  }
  const proof = await source(
      'contract-avans.txt',
      'Contract for future domestic services with an advance paid before invoicing',
    ),
    years = await invoke('years.list', {}),
    year = years.find((row: { kind: string }) => row.kind === 'financial');
  for (const regime of [
    { axis: 'vat', value: 'normal_vat' },
    { axis: 'vat_collection', value: 'no' },
  ])
    await invoke('regimes.record', {
      ...regime,
      effectiveFrom: '2026-01-01',
      evidenceId: proof.id,
    });
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
  async function statement(
    from: string,
    to: string,
    opening: string,
    closing: string,
    rows: string,
  ) {
    const evidence = await source(
      `${randomUUID()}.csv`,
      `movement_id,booking_date,amount,currency,reference\n${rows}`,
    );
    return invoke('bank.importStatement', {
      evidenceId: evidence.id,
      bankAccount: 'RO00ADVANCE',
      statementId: randomUUID(),
      from,
      to,
      opening,
      closing,
    });
  }
  await statement(
    '2026-01-01',
    '2026-01-31',
    '1000.00',
    '1121.00',
    'ADV,2026-01-10,121.00,RON,Client advance\n',
  );
  const movement = (await invoke('bank.movements', { matched: false })).items[0],
    grant = await invoke('agents.issue', {
      name: 'Advance preparation',
      scopes: [
        'advances.proposePayment',
        'advances.proposeInvoice',
        'advances.proposeFinalInvoice',
        'advances.proposeCreditNote',
        'advances.proposeRefund',
      ],
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
    });
  const terms = {
    financialYearId: year.id,
    direction: 'sale',
    counterparty: { name: 'Partner SRL', taxId: '87654321', country: 'RO' },
    account: '704',
    vatCategory: 'S',
    counterpartyVatCollection: 'no',
    evidenceId: proof.id,
    evidenceDate: '2026-01-01',
    reference: 'CONTRACT-2026',
    serviceExpectedOn: '2026-03-31',
    reason: 'Avans contractual pentru serviciile viitoare, separat de emiterea facturii',
  };
  const payment = await invoke(
    'advances.proposePayment',
    { ...terms, movementId: movement.id, net: '100.00' },
    grant.token,
  );
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const location = `/contabilitate?company=${companyId}&financialYearId=${year.id}`,
    card = page.locator('.acc-review'),
    effects = card.getByRole('table', { name: 'Efect contabil propus' });
  async function reviewAndPost() {
    await card.getByRole('button', { name: 'Aprobă această versiune', exact: true }).click();
    await card.getByRole('button', { name: 'Contabilizează', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('contabilizată');
    await expect(card).toHaveCount(0);
  }
  await page.goto(location);
  await expect(card).toContainText('Serviciu estimat pentru');
  await expect(card).toContainText('TVA colectată la primirea avansului');
  await expect(effects).toContainText('419');
  await expect(effects).toContainText('4427');
  await expect(effects).not.toContainText('704');
  expect((await request.get(`${base}/evidence/${proof.id}`)).status()).toBe(200);
  await page.screenshot({
    path: info.outputPath(`advance-payment-${info.project.name}.png`),
    fullPage: true,
  });
  await reviewAndPost();
  const xml = await source(
      'factura-avans.xml',
      invoiceXml({
        number: 'AVANS-2026',
        date: '2026-02-01',
        direction: 'sale',
        taxPointDate: '2026-01-10',
      }),
    ),
    invoice = await invoke('invoices.import', { evidenceId: xml.id });
  await invoke(
    'advances.proposeInvoice',
    {
      financialYearId: year.id,
      invoiceId: invoice.id,
      recognitionDate: '2026-02-01',
      taxPointDate: '2026-01-10',
      account: '704',
      deduction: 'none',
      counterpartyVatCollection: 'no',
      paymentIds: [payment.id],
      evidenceId: proof.id,
      evidenceDate: '2026-01-01',
      reference: 'CONTRACT-2026',
      serviceExpectedOn: '2026-03-31',
      reason: terms.reason,
    },
    grant.token,
  );
  await page.reload();
  await expect(card.getByRole('table', { name: 'Încasări asociate', exact: true })).toContainText(
    '121,00',
  );
  await expect(card).toContainText('TVA colectată anterior');
  await expect(card).toContainText('TVA nouă la facturare');
  await card.getByRole('button', { name: 'Deschide avansul 1', exact: true }).focus();
  await page.keyboard.press('Enter');
  const originalPayment = page
    .locator('.acc-journal')
    .filter({ hasText: 'Avans client · CONTRACT-2026' });
  await expect(originalPayment).toHaveAttribute('open', '');
  await expect(originalPayment.locator('summary')).toBeFocused();
  await page.goto(location);
  await reviewAndPost();
  expect(await invoke('vat.summary', { financialYearId: year.id })).toMatchObject({
    status: 'reconciled',
    totals: { outputTax: '21.00' },
  });
  const finalXml = await source(
      'factura-finala.xml',
      finalInvoiceXml({
        number: 'FINALA-2026',
        date: '2026-03-10',
        direction: 'sale',
        serviceNet: '40.00',
        net: '0.00',
        tax: '0.00',
        gross: '0.00',
        advances: [{ number: 'AVANS-2026', lineId: 'A1', net: '40.00' }],
      }),
    ),
    finalInvoice = await invoke('invoices.import', { evidenceId: finalXml.id });
  await invoke(
    'advances.proposeFinalInvoice',
    {
      financialYearId: year.id,
      invoiceId: finalInvoice.id,
      recognitionDate: '2026-03-10',
      serviceDate: '2026-03-10',
      taxPointDate: '2026-03-10',
      treatmentEvidenceId: proof.id,
      account: '704',
      deduction: 'none',
      counterpartyVatCollection: 'no',
      allocations: [{ advanceInvoiceId: invoice.id, lineId: 'A1', net: '40.00', tax: '8.40' }],
    },
    grant.token,
  );
  await page.reload();
  const allocations = card.getByRole('table', { name: 'Avansuri regularizate', exact: true });
  await expect(allocations).toContainText('AVANS-2026');
  await expect(allocations).toContainText('60,00');
  await expect(allocations).toContainText('8,40');
  await expect(effects).toContainText('704');
  await expect(effects).not.toContainText('4427');
  await page.screenshot({
    path: info.outputPath(`advance-final-${info.project.name}.png`),
    fullPage: true,
  });
  await card.getByRole('button', { name: 'AVANS-2026', exact: true }).focus();
  await page.keyboard.press('Enter');
  const originalInvoice = page
    .locator('.acc-journal')
    .filter({ hasText: 'Factură de avans · AVANS-2026' });
  await expect(originalInvoice).toHaveAttribute('open', '');
  await expect(originalInvoice.locator('summary')).toBeFocused();
  await page.goto(location);
  await reviewAndPost();
  const agreement = await source(
      'anulare-avans.txt',
      'Current written agreement cancels only the unprovided remainder of the advance',
    ),
    creditXml = await source(
      'credit-avans.xml',
      invoiceXml({
        credit: true,
        direction: 'sale',
        number: 'CREDIT-AVANS',
        originalNumber: 'AVANS-2026',
        date: '2026-04-01',
        net: '60.00',
        tax: '12.60',
        gross: '72.60',
      }),
    ),
    credit = await invoke('invoices.import', { evidenceId: creditXml.id });
  await invoke(
    'advances.proposeCreditNote',
    {
      financialYearId: year.id,
      invoiceId: credit.id,
      originalInvoiceId: invoice.id,
      recognitionDate: '2026-04-01',
      decisionDate: '2026-04-01',
      treatmentEvidenceId: agreement.id,
      kind: 'cancellation',
      periodBasis: 'current_period_event',
      reason:
        'Acord curent pentru anularea avansului neutilizat, păstrând serviciile deja prestate',
    },
    grant.token,
  );
  await page.reload();
  await expect(card).toContainText('Avans disponibil fără TVA');
  await expect(card).toContainText('Avans rămas fără TVA');
  await expect(effects).toContainText('4427');
  await expect(effects).not.toContainText('704');
  await reviewAndPost();
  await statement(
    '2026-04-01',
    '2026-04-30',
    '1121.00',
    '1072.60',
    'CREDIT-REFUND,2026-04-10,-72.60,RON,Unused invoice advance refund\nNEW,2026-04-20,24.20,RON,Second bank advance\n',
  );
  const rows = (await invoke('bank.movements', { matched: false })).items;
  await post(
    await invoke('settlements.propose', {
      financialYearId: year.id,
      movementId: rows.find((row: { amount: string }) => row.amount === '-72.60').id,
      allocations: [{ invoiceId: invoice.id, amount: '-72.60' }],
    }),
  );
  const second = await invoke(
    'advances.proposePayment',
    {
      ...terms,
      movementId: rows.find((row: { amount: string }) => row.amount === '24.20').id,
      net: '20.00',
      serviceExpectedOn: '2026-06-30',
      reference: 'SECOND-ADVANCE',
    },
    grant.token,
  );
  await post(second);
  await statement(
    '2026-05-01',
    '2026-05-31',
    '1072.60',
    '1048.40',
    'BANK-REFUND,2026-05-10,-24.20,RON,Refund before invoice\n',
  );
  await invoke(
    'advances.proposeRefund',
    {
      financialYearId: year.id,
      paymentId: second.id,
      movementId: (await invoke('bank.movements', { matched: false })).items[0].id,
      evidenceId: agreement.id,
      decisionDate: '2026-05-10',
      periodBasis: 'current_period_event',
      reason: 'Restituirea integrală a celui de-al doilea avans înainte de facturare',
    },
    grant.token,
  );
  await page.reload();
  await expect(card).toContainText('Sumă restituită');
  await expect(card).toContainText('TVA stornată');
  await expect(card.getByRole('button', { name: 'Deschide avansul', exact: true })).toBeVisible();
  await page.screenshot({
    path: info.outputPath(`advance-refund-${info.project.name}.png`),
    fullPage: true,
  });
  await reviewAndPost();
  expect(await invoke('advances.getPayment', { id: second.id, date: '2026-05-31' })).toMatchObject({
    status: 'refunded',
    remainingGross: '0.00',
  });
  expect(
    await invoke('advances.reconcile', { financialYearId: year.id, date: '2026-05-31' }),
  ).toMatchObject({ status: 'reconciled' });
  expect(await invoke('vat.summary', { financialYearId: year.id })).toMatchObject({
    status: 'reconciled',
    totals: { outputTax: '8.40' },
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});
