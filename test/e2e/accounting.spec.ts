import { test, expect } from '@playwright/test';

test('company setup, review, posting, reconciliation and export', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/contabilitate');
  await expect(page.getByRole('heading', { name: 'Autentificare', exact: true })).toBeVisible();
  await expect(page.locator('.accounting')).toHaveCSS('background-color', 'rgb(0, 0, 0)');
  await expect(page.locator('footer')).toHaveCount(0);
  await page.getByLabel('Email', { exact: true }).fill(`${info.project.name}@example.test`);
  await page.getByLabel('Parolă', { exact: true }).fill('synthetic-browser-password');
  await page.getByRole('button', { name: 'Intră în cont', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Companie nouă', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Adaugă compania', exact: true })).toHaveCount(1);
  await expect(page.getByRole('combobox', { name: 'Companie', exact: true })).toHaveCount(0);
  const companyName = `Servicii ${info.project.name} SRL`;
  await page.getByLabel('Denumire companie', { exact: true }).fill(companyName);
  await expect(page.getByLabel('Denumire companie', { exact: true })).toHaveCSS(
    'box-shadow',
    'none',
  );
  await expect(page.getByLabel('Denumire companie', { exact: true })).toHaveCSS(
    'outline-style',
    'none',
  );
  await page.getByLabel('CUI', { exact: true }).fill('12345678');
  await page.getByRole('button', { name: 'Adaugă compania', exact: true }).click();
  await expect(page.getByRole('heading', { name: companyName, exact: true })).toBeVisible();
  await expect(page.locator('.acc-onboarding')).toHaveCount(0);
  await expect(
    page.getByText('Ce lipsește pentru înlocuirea contabilității', { exact: true }),
  ).toHaveCount(0);
  await expect(page.locator('.accounting')).not.toContainText(
    /versiune de test|Regulile fiscale nu sunt aprobate|Revizuire fiscală independentă/,
  );
  await page.getByRole('combobox', { name: 'Companie', exact: true }).focus();
  await expect(page.getByRole('combobox', { name: 'Companie', exact: true })).toHaveCSS(
    'box-shadow',
    'none',
  );

  const opening = page
    .locator('form')
    .filter({ has: page.getByRole('heading', { name: 'Poziția inițială', exact: true }) });
  await opening.getByLabel(/Fișier original/).setInputFiles({
    name: 'opening.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('Approved synthetic opening: Dr 5121 / Cr 1012 = RON 1000.00'),
  });
  await opening.getByLabel('Sold inițial în RON', { exact: true }).fill('1000.00');
  await opening.getByRole('button', { name: 'Pregătește poziția inițială' }).click();
  await page.getByRole('button', { name: 'Aprobă această versiune', exact: true }).click();
  await page.getByRole('button', { name: 'Contabilizează', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('contabilizată');

  await page.getByText('Adaugă o factură de servicii', { exact: true }).click();
  const purchase = page
    .locator('details')
    .filter({ has: page.getByText('Adaugă o factură de servicii', { exact: true }) });
  await purchase.getByLabel(/Fișier original/).setInputFiles({
    name: 'supplier.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('Synthetic domestic service invoice P-1, RON 100.00, no VAT'),
  });
  await purchase.getByLabel('Furnizor', { exact: true }).fill('Furnizor SRL');
  await purchase.getByLabel('CUI furnizor', { exact: true }).fill('87654321');
  await purchase.getByLabel('Număr factură', { exact: true }).fill('P-1');
  await purchase.getByLabel('Sumă în RON', { exact: true }).fill('100.00');
  await purchase.getByLabel('Data facturii', { exact: true }).fill('2026-10-01');
  await purchase.getByLabel('Data serviciului', { exact: true }).fill('2026-10-01');
  await purchase
    .getByLabel('Serviciul și scopul cheltuielii', { exact: true })
    .fill('Servicii de administrare');
  await purchase.getByRole('button', { name: 'Pregătește factura' }).click();
  await page.getByRole('button', { name: 'Aprobă această versiune', exact: true }).click();
  await page.getByRole('button', { name: 'Contabilizează', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('contabilizată');

  await page.getByRole('button', { name: /^Bancă/ }).click();
  await page.getByText('Importă un extras bancar', { exact: true }).click();
  const bank = page
    .locator('details')
    .filter({ has: page.getByText('Importă un extras bancar', { exact: true }) });
  await bank.getByLabel(/Fișier original/).setInputFiles({
    name: 'statement.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(
      'movement_id,booking_date,amount,currency,reference\nPAY-1,2026-10-03,-100.00,RON,P-1\n',
    ),
  });
  await bank.getByLabel('Cont bancar', { exact: true }).fill('RO00TESTACCOUNT');
  await bank.getByLabel('Identificator extras', { exact: true }).fill('OCT-2026');
  await bank.getByLabel('De la', { exact: true }).fill('2026-10-01');
  await bank.getByLabel('Până la', { exact: true }).fill('2026-10-31');
  await bank.getByLabel('Sold inițial în RON', { exact: true }).fill('1000.00');
  await bank.getByLabel('Sold final în RON', { exact: true }).fill('900.00');
  await bank.getByRole('button', { name: 'Importă și verifică soldurile' }).click();
  await page
    .getByRole('combobox', { name: 'Factură', exact: true })
    .selectOption({ label: 'Furnizor SRL · P-1' });
  await page.getByRole('button', { name: 'Confirmă plata', exact: true }).click();
  await expect(page.getByText('Reconciliată', { exact: true })).toBeVisible();
  const balances = page.getByRole('definition');
  await expect(balances).toHaveText(['900,00 RON', '0,00 RON', '100,00 RON']);
  await page.reload();
  await expect(page.getByRole('heading', { name: companyName, exact: true })).toBeVisible();
  await expect(page.getByRole('definition')).toHaveText(['900,00 RON', '0,00 RON', '100,00 RON']);
  await page.getByRole('button', { name: 'Registre', exact: true }).click();
  await expect(page.locator('.acc-journal')).toHaveCount(3);

  await page.getByRole('button', { name: 'Export complet', exact: true }).click();
  const downloadLink = page.getByRole('link', { name: 'Descarcă exportul', exact: true });
  await expect(downloadLink).toBeVisible({ timeout: 15000 });
  const [download] = await Promise.all([page.waitForEvent('download'), downloadLink.click()]);
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  const exported = JSON.parse(Buffer.concat(chunks).toString());
  expect(exported.data.journals).toHaveLength(3);
  expect(exported.originals).toHaveLength(3);
  await expect(page.locator('.accounting')).toHaveCSS('background-color', 'rgb(0, 0, 0)');
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  expect(overflow).toBe(false);
  expect(
    await page
      .locator('.acc-tabs')
      .evaluate((element) => element.scrollWidth <= element.clientWidth),
  ).toBe(true);
  await expect(page.getByText('Exportul este în pregătire.', { exact: true })).toHaveCount(0);
  expect(errors).toEqual([]);
  await page.screenshot({
    path: `test-results/accounting-${info.project.name}.png`,
    fullPage: true,
  });
});
