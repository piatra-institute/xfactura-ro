import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { invoiceXml } from '../../packages/xfactura-api/test/accounting/fixtures/invoice';
import { invoiceZip } from '../../packages/xfactura-api/test/accounting/fixtures/archive';

test('reviews agent-prepared VAT invoice lines and keeps financial years separate', async ({
  page,
}, info) => {
  const origin = 'http://localhost:3100';
  const request = page.request;
  const login = await request.post('/api/accounting/auth/sign-in/email', {
    headers: { origin },
    data: {
      email: `ledger-${info.project.name}@example.test`,
      password: 'synthetic-browser-password',
    },
  });
  expect(login.status()).toBe(200);
  const created = await request.post('/api/accounting/v1/companies', {
    headers: { origin, 'idempotency-key': randomUUID() },
    data: { name: `Contabilitate ${info.project.name} SRL`, cui: '12345678', year: 2025 },
  });
  expect(created.status()).toBe(200);
  const companyId = (await created.json()).id;
  const base = `/api/accounting/v1/companies/${companyId}`;
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
  const source = await invoke('evidence.record', {
    filename: 'registration-and-service-proof.txt',
    mediaType: 'text/plain',
    base64: Buffer.from('Independent synthetic VAT registration and delivery proof').toString(
      'base64',
    ),
  });
  for (const input of [
    { axis: 'vat', value: 'normal_vat' },
    { axis: 'vat_collection', value: 'no' },
  ])
    await invoke('regimes.record', {
      ...input,
      effectiveFrom: '2025-01-01',
      evidenceId: source.id,
    });
  const year = await invoke('years.create', {
    kind: 'financial',
    label: '2026',
    from: '2026-01-01',
    to: '2026-12-31',
  });
  const grant = await invoke('agents.issue', {
    name: 'Invoice import agent',
    scopes: ['evidence.record', 'invoices.importArchive', 'invoices.propose'],
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
  });
  const original = await invoke(
    'evidence.record',
    {
      filename: 'efactura-issued.zip',
      mediaType: 'application/zip',
      base64: Buffer.from(
        invoiceZip({ 'facturi/issued.xml': invoiceXml({ direction: 'sale' }) }),
      ).toString('base64'),
    },
    grant.token,
  );
  const imported = await invoke('invoices.importArchive', { evidenceId: original.id }, grant.token);
  expect(imported.signatureVerification).toBe('not_performed');
  const invoice = { id: imported.entries[0].invoiceId };
  await invoke(
    'invoices.propose',
    {
      invoiceId: invoice.id,
      financialYearId: year.id,
      recognitionDate: '2026-10-01',
      serviceDate: '2026-10-01',
      taxPointDate: '2026-10-01',
      treatmentEvidenceId: source.id,
      account: '704',
      deduction: 'none',
      counterpartyVatCollection: 'no',
    },
    grant.token,
  );
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`/contabilitate?company=${companyId}`);
  await expect(page.getByRole('combobox', { name: 'Companie', exact: true })).toHaveValue(
    companyId,
  );
  const selector = page.getByRole('combobox', { name: 'Exercițiu financiar', exact: true });
  await expect(selector).toHaveValue(
    (await invoke('years.list', {})).find(
      (item: { kind: string; from: string }) =>
        item.kind === 'financial' && item.from === '2025-01-01',
    ).id,
  );
  await selector.selectOption(year.id);
  const proposal = page
    .locator('.acc-review')
    .filter({ has: page.getByRole('heading', { name: 'INV-1 · Companie 87654321', exact: true }) });
  await expect(proposal).toBeVisible();
  await expect(proposal.locator('tbody tr')).toHaveCount(3);
  await expect(proposal.locator('tbody tr').nth(2)).toContainText('4427');
  await expect(proposal.locator('tbody tr').nth(2)).toContainText('21,00');
  await expect(proposal).toContainText('Exigibilitate TVA');
  const archives = proposal.locator('.acc-invoice-sources');
  await archives.locator('summary').focus();
  await page.keyboard.press('Enter');
  await expect(
    archives.getByRole('link', { name: 'efactura-issued.zip', exact: true }),
  ).toBeVisible();
  await expect(archives).toContainText('facturi/issued.xml');
  expect(Buffer.from(await (await request.get(`${base}/evidence/${original.id}`)).body())).toEqual(
    Buffer.from(invoiceZip({ 'facturi/issued.xml': invoiceXml({ direction: 'sale' }) })),
  );
  expect(
    Buffer.from(
      await (await request.get(`${base}/evidence/${imported.entries[0].evidenceId}`)).body(),
    ).toString(),
  ).toBe(invoiceXml({ direction: 'sale' }));
  await selector.focus();
  await selector.press('Tab');
  await expect(page.getByRole('button', { name: 'Export complet', exact: true })).toBeFocused();
  await page.screenshot({
    path: info.outputPath(`invoice-review-${info.project.name}.png`),
    fullPage: true,
  });
  await proposal.getByRole('button', { name: 'Aprobă această versiune', exact: true }).click();
  await proposal.getByRole('button', { name: 'Contabilizează', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('contabilizată');
  await page.getByRole('button', { name: 'Registre', exact: true }).click();
  await expect(page.locator('.acc-journal')).toHaveCount(1);
  await expect(page.locator('.acc-content table').first()).toContainText('4427');
  await page.reload();
  await expect(selector).toHaveValue(year.id);
  await page.getByRole('button', { name: 'Registre', exact: true }).click();
  await expect(page.locator('.acc-journal')).toHaveCount(1);
  await page.screenshot({
    path: info.outputPath(`general-ledger-${info.project.name}.png`),
    fullPage: true,
  });
  await selector.selectOption({ label: '2025' });
  await expect(page.locator('.acc-journal')).toHaveCount(0);
  await selector.selectOption(year.id);
  await expect(page.locator('.acc-journal')).toHaveCount(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  expect(errors).toEqual([]);
});
