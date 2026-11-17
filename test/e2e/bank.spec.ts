import { expect, test, type Page } from '@playwright/test';
import type { ProposalView } from '../../packages/xfactura-api/source/engine/contracts';
import { iban, mt940 } from '../../packages/xfactura-api/test/engine/fixtures/bank';
import { invoiceXml } from '../../packages/xfactura-api/test/engine/fixtures/invoice';
import { capability, evidence } from './support/books';
import { approveInPlace, choose, select } from './support/entry';
import { keep, signInWithCompany } from './support/session';
import { chooseMonth, openSection, typeDate } from './support/shell';

/** The company pays VAT from 2026, as its certificate says. */
async function vatPayer(page: Page) {
  const certificate = await evidence(page, 'certificat-tva.pdf', 'Certificat sintetic TVA');
  await capability(page, 'profile.record', {
    axis: 'vat.status',
    value: 'normal_vat',
    effectiveFrom: '2026-01-01',
    evidenceId: certificate.id,
  });
}

test('a document uploaded on Documente is imported and booked from its row', async ({
  page,
}, info) => {
  const errors = await signInWithCompany(page, info, 'bank', `Documente ${info.project.name} SRL`);
  await vatPayer(page);
  await keep(page, 'INV-1.xml', invoiceXml({ number: 'INV-1' }), 'application/xml');
  const file = page.locator('tr', { hasText: 'INV-1.xml' });
  // An XML file may be an invoice, a statement or BNR rates; a PDF is read by an agent.
  await expect(file.getByRole('button', { name: 'Cursuri BNR', exact: true })).toBeVisible();
  await expect(
    page.locator('tr', { hasText: 'certificat-tva.pdf' }).getByRole('button'),
  ).toHaveCount(0);
  await file.getByRole('button', { name: 'Factură e-Factura', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Documentul e-Factura a fost importat.');

  const documents = page.locator('.acc-documents-table');
  const row = documents.locator('tr[data-document]', { hasText: 'INV-1' });
  await expect(row).toContainText('01.10.2026');
  await expect(row).toContainText('Factură primită');
  await expect(row).toContainText('Companie 87654321');
  await expect(row).toContainText('121,00 RON');
  await select(page, 'Înregistrare', 'Neînregistrate');
  await expect(page).toHaveURL(/documentBooked=unbooked/);
  await expect(row).toBeVisible();

  await page
    .getByRole('button', { name: 'Înregistrează Factură primită INV-1', exact: true })
    .click();
  const booking = page.getByRole('form', { name: 'Înregistrarea Factură primită INV-1' });
  // The account is chosen by code or by name.
  await choose(booking, 'Cont de cheltuieli', 'serviciile executate', /^628/);
  await booking.getByRole('button', { name: 'Pregătește înregistrarea', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('pregătită pentru verificare');
  const proposal = documents.locator('.acc-review');
  await expect(proposal.getByRole('cell', { name: '4426', exact: true })).toBeVisible();
  await approveInPlace(proposal);

  // Booked, it leaves the unbooked documents and links to its entry.
  await expect(
    page.getByText('Niciun document pentru filtrele alese.', { exact: true }),
  ).toBeVisible();
  await select(page, 'Înregistrare', 'Înregistrate');
  await expect(row).toContainText('Înregistrat');
  await chooseMonth(page, 'Luna', '2026-11');
  await expect(page).toHaveURL(/documentMonth=2026-11/);
  await expect(row).toHaveCount(0);
  await page.getByRole('button', { name: 'Arată toate documentele', exact: true }).click();
  await row
    .getByRole('link', { name: 'Deschide nota contabilă a documentului Factură primită INV-1' })
    .click();
  await expect(
    page.getByRole('heading', { level: 1, name: 'Registre', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('heading', { name: /^Înregistrarea 1 · / })).toBeVisible();
  await expect(page.locator('.acc-register-table')).toContainText('628');
  expect(errors).toEqual([]);
});

test('a bank movement is explained against an open invoice', async ({ page }, info) => {
  const errors = await signInWithCompany(page, info, 'bank', `Banca ${info.project.name} SRL`);
  await vatPayer(page);
  const file = await evidence(
    page,
    'INV-1.xml',
    invoiceXml({ number: 'INV-1' }),
    'application/xml',
  );
  const document = await capability<{ id: string }>(page, 'invoices.import', {
    evidenceId: file.id,
  });
  const recognized = await capability<ProposalView>(page, 'invoices.recognize.propose', {
    documentId: document.id,
    account: '628',
  });
  const binding = {
    proposalId: recognized.id,
    version: recognized.version,
    effectHash: recognized.effectHash,
  };
  await capability(page, 'proposals.approve', { ...binding, acknowledge: [] });
  await capability(page, 'ledger.post', binding);

  await openSection(page, 'Bancă');
  await page.getByRole('button', { name: 'Cont nou', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Cont nou' });
  await dialog.getByRole('textbox', { name: 'Denumire', exact: true }).fill('Cont curent');
  await dialog.getByRole('textbox', { name: 'IBAN', exact: true }).fill(iban);
  await expect(dialog.getByRole('combobox', { name: 'Cont contabil', exact: true })).toHaveValue(
    /^5121/,
  );
  await typeDate(dialog, 'Deschis la', '01.01.2026');
  await dialog.getByRole('button', { name: 'Configurează contul', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Contul a fost configurat.');
  await expect(dialog).toBeHidden();
  const account = page.getByRole('link', { name: /^Cont curent/ });
  await expect(account).toHaveAttribute('aria-current', 'true');
  await expect(account).toContainText('RO49 AAAA 1B31 0075 9384 0000');
  await expect(account).toContainText(/RON$/);

  await keep(page, 'extras.sta', mt940);
  await page
    .locator('tr', { hasText: 'extras.sta' })
    .getByRole('button', { name: 'Extras bancar', exact: true })
    .click();
  await expect(page.getByRole('status')).toContainText('Extrasul a fost importat.');

  await openSection(page, 'Bancă');
  await expect(page.getByRole('button', { name: /Stare$/ })).toContainText('De explicat (3)');
  const movements = page.locator('.acc-movements-table');
  const payment = movements.locator('tr[data-movement]', { hasText: '−100,00 RON' });
  await expect(payment).toContainText('05.10.2026');
  await payment.getByRole('button', { name: /^Explică / }).click();
  const explanation = page.getByRole('form', { name: /^Explicația mișcării/ });
  await choose(explanation, 'Factură decontată', 'INV-1', /INV-1/);
  // The movement's own amount is offered as the part the invoice settles.
  await expect(
    explanation.getByRole('textbox', { name: 'Sumă decontată', exact: true }),
  ).toHaveValue('100,00');
  await explanation.getByRole('button', { name: 'Pregătește explicația', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('pregătită pentru verificare');
  const proposal = movements.locator('.acc-review');
  await expect(proposal.getByRole('cell', { name: '401', exact: true })).toBeVisible();
  await approveInPlace(proposal);
  await expect(payment).toContainText('Explicată');

  await select(page, 'Stare', 'Explicate (1)');
  await expect(page).toHaveURL(/movementState=settled/);
  await expect(movements.locator('tr[data-movement]')).toHaveCount(1);
  await expect(payment).toBeVisible();
  await select(page, 'Stare', 'De explicat (2)');
  await expect(payment).toHaveCount(0);
  await expect(movements.locator('tr[data-movement]', { hasText: '−2,03 RON' })).toHaveCount(1);
  expect(errors).toEqual([]);
});
