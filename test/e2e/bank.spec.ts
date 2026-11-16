import { expect, test } from '@playwright/test';
import { iban, mt940 } from '../../packages/xfactura-api/test/engine/fixtures/bank';
import { invoiceXml } from '../../packages/xfactura-api/test/engine/fixtures/invoice';
import { approveAndPost, keep, recordVatPayer, signInWithCompany } from './support/session';

test('an imported invoice is recognized and its payment explained', async ({ page }, info) => {
  const errors = await signInWithCompany(page, info, 'bank', `Banca ${info.project.name} SRL`);
  await keep(page, 'certificat-tva.pdf', 'Certificat de înregistrare în scopuri de TVA');
  await recordVatPayer(page, 'certificat-tva.pdf');
  await keep(page, 'INV-1.xml', invoiceXml({ number: 'INV-1' }), 'application/xml');
  await page
    .locator('tr', { hasText: 'INV-1.xml' })
    .getByRole('button', { name: 'Factură e-Factura', exact: true })
    .click();
  await expect(page.getByRole('status')).toContainText('Documentul e-Factura a fost importat.');
  const invoice = page.locator('.acc-review', { hasText: 'Factură primită INV-1' });
  await invoice.getByRole('button', { name: 'Pregătește înregistrarea', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('pregătită pentru verificare');
  await approveAndPost(page);

  await page.getByRole('button', { name: 'Registre', exact: true }).click();
  await page.getByRole('button', { name: 'Bancă', exact: true }).click();
  await page.getByText('Adaugă un cont bancar sau o casă', { exact: true }).click();
  await page.getByLabel('Denumire', { exact: true }).fill('Cont curent');
  await page.getByLabel('IBAN (gol pentru casă)', { exact: true }).fill(iban);
  await page.getByLabel('Deschis la', { exact: true }).fill('2026-01-01');
  await page.getByRole('button', { name: 'Configurează contul', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Contul a fost configurat.');

  await keep(page, 'extras.sta', mt940);
  await page
    .locator('tr', { hasText: 'extras.sta' })
    .getByRole('button', { name: 'Extras bancar', exact: true })
    .click();
  await expect(page.getByRole('status')).toContainText('Extrasul a fost importat.');

  await page.getByRole('button', { name: 'Bancă', exact: true }).click();
  const payment = page.locator('.acc-review', { hasText: '−100,00 RON' });
  await payment
    .getByRole('combobox', { name: 'Factură decontată', exact: true })
    .selectOption({ index: 1 });
  await payment.getByLabel('Sumă decontată', { exact: true }).fill('100,00');
  await payment.getByRole('button', { name: 'Pregătește explicația', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('pregătită pentru verificare');
  await approveAndPost(page);

  await page.getByRole('button', { name: 'Registre', exact: true }).click();
  await page.getByRole('button', { name: 'Bancă', exact: true }).click();
  await expect(page.locator('.acc-review', { hasText: '−100,00 RON' })).toHaveCount(0);
  await expect(page.locator('.acc-review', { hasText: '−2,03 RON' })).toHaveCount(1);
  expect(errors).toEqual([]);
});
