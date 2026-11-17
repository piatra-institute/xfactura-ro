import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { ProposalView } from '../../packages/xfactura-api/source/engine/contracts';
import {
  invoiceXml,
  type XmlInput,
} from '../../packages/xfactura-api/test/engine/fixtures/invoice';
import { iban } from '../../packages/xfactura-api/test/engine/fixtures/bank';
import { capability, evidence } from './support/books';
import { signInWithCompany } from './support/session';
import { profileRow } from './support/profile';
import { expectTheme, openMenu, openSection, openTab } from './support/shell';

/**
 * Saves every view in both themes for review, to test-results/screens (not committed). It runs
 * only with XFACTURA_SCREENSHOTS=1: `XFACTURA_SCREENSHOTS=1 bun run test:e2e test/e2e/screens.spec.ts`.
 */
test.skip(process.env.XFACTURA_SCREENSHOTS !== '1', 'Set XFACTURA_SCREENSHOTS=1 to save screens.');

const folder = join('test-results', 'screens');
const slug = (name: string) =>
  name
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

/** Waits until no part of the screen says it is loading. */
async function settled(page: Page) {
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0, { timeout: 15000 });
}

async function bookInvoice(page: Page, xml: XmlInput, account: string) {
  const file = await evidence(page, `${xml.number}.xml`, invoiceXml(xml), 'application/xml');
  const document = await capability<{ id: string }>(page, 'invoices.import', {
    evidenceId: file.id,
  });
  const proposal = await capability<ProposalView>(page, 'proposals.propose', {
    treatment: 'invoices.recognize',
    input: { documentId: document.id, account },
  });
  const binding = {
    proposalId: proposal.id,
    version: proposal.version,
    effectHash: proposal.effectHash,
  };
  await capability(page, 'proposals.approve', binding);
  await capability(page, 'ledger.post', binding);
}

test('every view, light and dark', async ({ page }, info) => {
  test.setTimeout(300000);
  await mkdir(folder, { recursive: true });
  const shoot = async (name: string) => {
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await expectTheme(page, scheme);
      await page.screenshot({
        path: join(folder, `${info.project.name}-${scheme}-${slug(name)}.png`),
        fullPage: true,
        animations: 'disabled',
      });
    }
    await page.emulateMedia({ colorScheme: 'light' });
  };

  await page.goto('/contabilitate');
  await expect(page.getByRole('heading', { name: 'Autentificare', exact: true })).toBeVisible();
  await shoot('login');

  await signInWithCompany(page, info, 'accounting', `Exemplu Ecrane ${info.project.name} SRL`);
  // A new company opens on its setup's first question.
  await expect(page.locator('.acc-setup')).toBeVisible();
  await settled(page);
  await shoot('Configurare');
  const proof = await evidence(page, 'certificat-tva.pdf', 'Certificat sintetic');
  for (const [axis, value] of Object.entries({
    'entity.form': 'srl',
    'vat.status': 'normal_vat',
    'vat.period': 'monthly',
    employer: 'no',
  }))
    await capability(page, 'profile.record', {
      axis,
      value,
      effectiveFrom: '2026-01-01',
      evidenceId: proof.id,
    });
  await bookInvoice(
    page,
    {
      direction: 'sale',
      number: 'FV-101',
      date: '2026-10-15',
      net: '12500.00',
      tax: '2625.00',
      gross: '15125.00',
    },
    '704',
  );
  await bookInvoice(
    page,
    { number: 'FP-202', date: '2026-10-20', net: '1840.50', tax: '386.51', gross: '2227.01' },
    '628',
  );
  const pending = await evidence(
    page,
    'FP-203.xml',
    invoiceXml({
      number: 'FP-203',
      date: '2026-11-03',
      net: '300.00',
      tax: '63.00',
      gross: '363.00',
    }),
    'application/xml',
  );
  await capability(page, 'invoices.import', { evidenceId: pending.id });
  await capability(page, 'treasury.createAccount', {
    kind: 'bank',
    name: 'Cont curent',
    iban,
    currency: 'RON',
    ledgerAccount: '5121',
    openedOn: '2026-01-01',
  });
  await page.reload();
  await openSection(page, 'Acasă');
  await settled(page);
  if (info.project.name === 'mobile')
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await expectTheme(page, scheme);
      await openMenu(page);
      // On a touch screen the drawer is revealed once no on-screen keyboard is moving.
      await expect(page.locator('.acc-drawer-overlay')).toHaveCSS('opacity', '1');
      await expect.poll(async () => (await page.locator('.acc-drawer').boundingBox())?.x).toBe(0);
      await page.screenshot({
        path: join(folder, `${info.project.name}-${scheme}-meniu.png`),
        animations: 'disabled',
      });
      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog', { name: 'Meniu', exact: true })).toBeHidden();
    }
  await page.emulateMedia({ colorScheme: 'light' });

  for (const name of ['Acasă', 'De verificat', 'Întrebări', 'Documente', 'Bancă', 'Declarații']) {
    await openSection(page, name);
    await settled(page);
    await shoot(name);
  }
  await openSection(page, 'Registre');
  for (const tab of await page.getByRole('tab').allTextContents()) {
    await openTab(page, tab);
    await settled(page);
    await shoot(`Registre ${tab}`);
  }
  await openSection(page, 'Setări');
  for (const tab of ['Companie', 'Exerciții și luni', 'Membri', 'Export']) {
    await openTab(page, tab);
    await settled(page);
    await shoot(`Setări ${tab}`);
  }
  // A fact's change form and its history open under its row; a month's close under the month.
  await openTab(page, 'Companie');
  const vat = profileRow(page, 'Regimul de TVA');
  await vat.getByRole('button', { name: 'Schimbă', exact: true }).click();
  await expect(page.locator('.acc-fact-editor')).toBeVisible();
  await shoot('Setări Companie schimbare');
  await vat.getByRole('button', { name: 'Istoric', exact: true }).click();
  await expect(page.locator('.acc-history-table')).toBeVisible();
  await shoot('Setări Companie istoric');
  await openTab(page, 'Exerciții și luni');
  await settled(page);
  await page.getByRole('button', { name: 'Verifică luna octombrie 2026', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Închiderea lunii octombrie 2026' })).toBeVisible();
  await shoot('Setări închiderea lunii');
  await page.goto('/contabilitate/componente');
  await expect(page.getByRole('heading', { level: 1, name: 'Componente' })).toBeVisible();
  await shoot('Componente');
  await page.goto('/contabilitate?company=new');
  await expect(page.getByRole('heading', { level: 1, name: 'Companie nouă' })).toBeVisible();
  await shoot('Companie nouă');
});
