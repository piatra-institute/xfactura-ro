import { test, expect, type Download } from '@playwright/test';

async function contents(download: Download) {
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

test('existing invoicer retains imported data and generates JSON, PDF and XML without provider keys', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const seller = {
    vatNumber: '12345678',
    vatPayer: false,
    name: 'Furnizor Fixture SRL',
    address: 'Strada Exemplu 1',
    city: 'Cluj-Napoca',
    county: 'Cluj',
    country: 'România',
  };
  const buyer = {
    ...seller,
    vatNumber: '87654321',
    name: 'Client Fixture SRL',
    address: 'Strada Exemplu 2',
  };
  const invoice = {
    id: 'invoice-fixture',
    seller,
    buyer,
    metadata: {
      number: 'REG-001',
      currency: 'RON',
      issueDate: Date.UTC(2026, 9, 1),
      dueDate: Date.UTC(2026, 9, 31),
    },
    products: [
      { name: 'Serviciu fixture', price: 100, quantity: 1, vatRate: 0, vatIncluded: false },
    ],
  };
  const fixture = {
    defaultSeller: seller.vatNumber,
    companies: { [seller.vatNumber]: seller, [buyer.vatNumber]: buyer },
    invoices: { [invoice.id]: invoice },
    inventory: {},
  };
  await page.goto('/');
  await page.getByRole('button', { name: 'setări', exact: true }).click();
  await Promise.all([
    page.waitForEvent('load'),
    page.locator('input[type="file"][accept=".json"]').setInputFiles({
      name: 'import.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(fixture)),
    }),
  ]);
  await page.getByRole('button', { name: 'setări', exact: true }).click();
  const [jsonDownload] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'export', exact: true }).click(),
  ]);
  const exported = JSON.parse((await contents(jsonDownload)).toString());
  expect(exported.invoices).toEqual(fixture.invoices);
  expect(exported.companies).toEqual(fixture.companies);
  await page.getByRole('button', { name: 'înapoi', exact: true }).click();
  await page.getByRole('button', { name: 'facturi', exact: true }).click();
  const row = page.locator('.scrollable-view > div').filter({ hasText: 'REG-001' });
  await expect(row).toHaveCount(1);
  await row.getByRole('button').click();
  const editor = page
    .locator('.scrollable-view')
    .filter({ has: page.getByText('editare factură', { exact: true }) });
  await expect(editor.getByRole('button', { name: 'export pdf', exact: true })).toBeEnabled();
  const [pdf] = await Promise.all([
    page.waitForEvent('download'),
    editor.getByRole('button', { name: 'export pdf', exact: true }).click(),
  ]);
  expect((await contents(pdf)).subarray(0, 5).toString()).toBe('%PDF-');
  const xmlResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/einvoice') && response.request().method() === 'POST',
  );
  const [xml, response] = await Promise.all([
    page.waitForEvent('download'),
    xmlResponse,
    editor.getByRole('button', { name: 'generare efactura', exact: true }).click(),
  ]);
  expect(response.ok()).toBe(true);
  const submitted = response.request().postDataJSON();
  expect(submitted.seller.vatPayer).toBe(false);
  expect(submitted.buyer.vatPayer).toBe(false);
  expect(submitted.lines[0].vatRate).toBe(0);
  const xmlText = (await contents(xml)).toString();
  expect(xmlText).toContain('<cbc:ID>REG-001</cbc:ID>');
  expect(xmlText).toContain('urn:oasis:names:specification:ubl:schema:xsd:Invoice-2');
  expect(xmlText).toContain('Furnizor Fixture SRL');
  expect(errors).toEqual([]);
});
