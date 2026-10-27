import { test, expect, type Page } from '@playwright/test';

async function addPurchase(page: Page, number: string, amount: string, date: string) {
  await page.getByText('Adaugă o factură de servicii', { exact: true }).click();
  const form = page
    .locator('details')
    .filter({ has: page.getByText('Adaugă o factură de servicii', { exact: true }) });
  await form.getByLabel(/Fișier original/).setInputFiles({
    name: `${number}.txt`,
    mimeType: 'text/plain',
    buffer: Buffer.from(`Synthetic supplier invoice ${number}, RON ${amount}, no VAT`),
  });
  for (const [label, value] of [
    ['Furnizor', 'Furnizor SRL'],
    ['CUI furnizor', '87654321'],
    ['Număr factură', number],
    ['Sumă în RON', amount],
    ['Data facturii', date],
    ['Data serviciului', date],
    ['Serviciul și scopul cheltuielii', 'Servicii documentate'],
  ])
    await form.getByLabel(label, { exact: true }).fill(value);
  await form.getByRole('button', { name: 'Pregătește factura', exact: true }).click();
  await page.getByRole('button', { name: 'Aprobă această versiune', exact: true }).click();
  await page.getByRole('button', { name: 'Contabilizează', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('contabilizată');
  await page.getByText('Adaugă o factură de servicii', { exact: true }).click();
}

async function correctionForm(page: Page, index: number) {
  await page.getByRole('button', { name: 'Registre', exact: true }).click();
  const entry = page.locator('.acc-journal').nth(index);
  if (!((await entry.getAttribute('open')) !== null)) await entry.locator('summary').click();
  await entry.getByRole('button', { name: 'Corectează', exact: true }).click();
  return entry.locator('form');
}

test('corrects a closed-month purchase, revises an approval, withdraws a draft and reverses an unpaid purchase', async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/contabilitate');
  await page
    .getByLabel('Email', { exact: true })
    .fill(`corrections-${info.project.name}@example.test`);
  await page.getByLabel('Parolă', { exact: true }).fill('synthetic-browser-password');
  await page.getByRole('button', { name: 'Intră în cont', exact: true }).click();
  await page
    .getByLabel('Denumire companie', { exact: true })
    .fill(`Corecții ${info.project.name} SRL`);
  await page.getByLabel('CUI', { exact: true }).fill('12345678');
  await page.getByLabel('An contabil', { exact: true }).fill('2026');
  await page.getByRole('button', { name: 'Adaugă compania', exact: true }).click();
  const opening = page
    .locator('form')
    .filter({ has: page.getByRole('heading', { name: 'Poziția inițială', exact: true }) });
  await opening.getByLabel(/Fișier original/).setInputFiles({
    name: 'opening.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('Approved synthetic opening RON 1000.00'),
  });
  await opening.getByLabel('Sold inițial în RON', { exact: true }).fill('1000.00');
  await opening.getByRole('button', { name: 'Pregătește poziția inițială' }).click();
  await page.getByRole('button', { name: 'Aprobă această versiune', exact: true }).click();
  await page.getByRole('button', { name: 'Contabilizează', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('contabilizată');
  await addPurchase(page, 'P-1', '100.00', '2026-10-01');
  await page.getByRole('button', { name: /^Bancă/ }).click();
  await page.getByText('Importă un extras bancar', { exact: true }).click();
  const bank = page
    .locator('details')
    .filter({ has: page.getByText('Importă un extras bancar', { exact: true }) });
  await bank.getByLabel(/Fișier original/).setInputFiles({
    name: 'statement.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(
      'movement_id,booking_date,amount,currency,reference\nPART-1,2026-10-05,-40.00,RON,P-1\n',
    ),
  });
  for (const [label, value] of [
    ['Cont bancar', 'RO00FIXTURE'],
    ['Identificator extras', 'OCT'],
    ['De la', '2026-10-01'],
    ['Până la', '2026-10-31'],
    ['Sold inițial în RON', '1000.00'],
    ['Sold final în RON', '960.00'],
  ])
    await bank.getByLabel(label, { exact: true }).fill(value);
  await bank.getByRole('button', { name: 'Importă și verifică soldurile', exact: true }).click();
  await page
    .getByRole('combobox', { name: 'Factură', exact: true })
    .selectOption({ label: 'Furnizor SRL · P-1' });
  await page.getByRole('button', { name: 'Confirmă plata', exact: true }).click();
  await expect(page.getByText('Reconciliată', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Registre', exact: true }).click();
  await page.getByText('Închiderea unei luni', { exact: true }).click();
  await page.getByLabel('Luna', { exact: true }).fill('2026-10');
  await page.getByRole('button', { name: 'Închide luna contabilă', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('închisă');
  let form = await correctionForm(page, 1);
  await form.getByLabel(/Fișier original/).setInputFiles({
    name: 'correction.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('Reviewed amount correction; retain original invoice and posting'),
  });
  await form.getByLabel('Data corecției', { exact: true }).fill('2026-11-01');
  await form.getByLabel('Sumă corectată în RON', { exact: true }).fill('90.00');
  await form
    .getByLabel('Motivul corecției', { exact: true })
    .fill('Suma a fost introdusă greșit în înregistrarea inițială');
  await form.getByRole('button', { name: 'Pregătește corecția', exact: true }).click();
  const proposal = page.locator('.acc-review').filter({
    has: page.getByRole('heading', { name: 'Corecție · înregistrarea #2', exact: true }),
  });
  await expect(proposal.locator('tbody tr')).toHaveCount(4);
  await proposal.getByRole('button', { name: 'Înregistrarea #2', exact: true }).click();
  const linkedOriginal = page.locator('.acc-journal').nth(1);
  await expect(linkedOriginal.locator('summary')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(
    linkedOriginal.getByRole('link', { name: 'Document justificativ', exact: true }),
  ).toBeFocused();
  await page.getByRole('button', { name: /^De verificat/ }).click();
  await proposal.getByRole('button', { name: 'Aprobă această versiune', exact: true }).click();
  await expect(proposal.getByText('Versiune aprobată', { exact: true })).toBeVisible();
  await proposal.getByRole('button', { name: 'Modifică', exact: true }).click();
  await proposal.getByLabel('Sumă corectată în RON', { exact: true }).fill('80.00');
  await proposal.getByRole('button', { name: 'Salvează propunerea', exact: true }).click();
  await expect(proposal.getByText('Versiune aprobată', { exact: true })).toHaveCount(0);
  await expect(proposal).toContainText('versiunea 2');
  await page.screenshot({
    path: `.impeccable/review/correction-review-${info.project.name}.png`,
    fullPage: true,
  });
  await proposal.getByRole('button', { name: 'Aprobă această versiune', exact: true }).click();
  await proposal.getByRole('button', { name: 'Contabilizează corecția', exact: true }).click();
  await expect(page.getByRole('definition')).toHaveText(['960,00 RON', '40,00 RON', '80,00 RON']);
  await page.getByRole('button', { name: 'Registre', exact: true }).click();
  const original = page.locator('.acc-journal').nth(1);
  await expect(original).toHaveAttribute('open', '');
  await original
    .getByRole('button', { name: 'Corectată prin înregistrarea #4', exact: true })
    .click();
  await expect(page.locator('.acc-journal').nth(3)).toHaveAttribute('open', '');
  await expect(page.locator('.acc-journal').nth(3).locator('summary')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(
    page
      .locator('.acc-journal')
      .nth(3)
      .getByRole('link', { name: 'Document justificativ', exact: true }),
  ).toBeFocused();
  await page
    .locator('.acc-journal')
    .nth(3)
    .getByRole('button', { name: 'Înregistrarea corectată #2', exact: true })
    .click();
  await expect(original).toHaveAttribute('open', '');
  await expect(original.locator('tbody')).toContainText('100,00 RON');
  form = await correctionForm(page, 3);
  await form
    .getByRole('combobox', { name: 'Document existent', exact: true })
    .selectOption({ label: 'correction.txt' });
  await form.getByRole('combobox', { name: 'Acțiune', exact: true }).selectOption('reverse');
  await expect(form.getByLabel('Sumă corectată în RON', { exact: true })).toHaveCount(0);
  await form.getByLabel('Data corecției', { exact: true }).fill('2026-11-02');
  await form
    .getByLabel('Motivul corecției', { exact: true })
    .fill('Verificarea unei stornări cu plată alocată');
  await form.getByRole('button', { name: 'Pregătește corecția', exact: true }).click();
  await expect(page.locator('.acc-feedback').getByRole('alert')).toContainText('plățile alocate');
  await form.getByRole('combobox', { name: 'Acțiune', exact: true }).selectOption('replace');
  await form.getByLabel('Sumă corectată în RON', { exact: true }).fill('70.00');
  await form.getByRole('button', { name: 'Pregătește corecția', exact: true }).click();
  await page.getByRole('button', { name: 'Retrage propunerea', exact: true }).click();
  await expect(page.getByText('Propuneri retrase', { exact: true })).toBeVisible();
  await addPurchase(page, 'P-2', '50.00', '2026-11-03');
  form = await correctionForm(page, 4);
  await form
    .getByRole('combobox', { name: 'Document existent', exact: true })
    .selectOption({ label: 'correction.txt' });
  await form.getByRole('combobox', { name: 'Acțiune', exact: true }).selectOption('reverse');
  await form.getByLabel('Data corecției', { exact: true }).fill('2026-11-04');
  await form
    .getByLabel('Motivul corecției', { exact: true })
    .fill('Înregistrarea nu trebuia inclusă în contabilitate');
  await form.getByRole('button', { name: 'Pregătește corecția', exact: true }).click();
  await page.getByRole('button', { name: 'Aprobă această versiune', exact: true }).click();
  await page.getByRole('button', { name: 'Contabilizează corecția', exact: true }).click();
  await expect(page.getByRole('definition')).toHaveText(['960,00 RON', '40,00 RON', '80,00 RON']);
  await page.reload();
  await expect(page.getByRole('definition')).toHaveText(['960,00 RON', '40,00 RON', '80,00 RON']);
  await page.getByRole('button', { name: 'Registre', exact: true }).click();
  await expect(page.locator('.acc-journal')).toHaveCount(6);
  await page.locator('.acc-journal').last().locator('summary').click();
  await expect(page.locator('.acc-journal').last()).toContainText(
    'Înregistrarea nu trebuia inclusă în contabilitate',
  );
  await expect(page.locator('.acc-journal').last()).toContainText('Sumă corectată: 0,00 RON');
  await page.screenshot({
    path: `.impeccable/review/correction-journal-${info.project.name}.png`,
    fullPage: true,
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(
    false,
  );
  expect(errors).toEqual([]);
});
