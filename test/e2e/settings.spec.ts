import { expect, test, type BrowserContext, type Page, type TestInfo } from '@playwright/test';
import { changeFact, chooseOption, factEditor, openProfile, profileRow } from './support/profile';
import { keep, signInWithCompany } from './support/session';
import { createCompany, currentCompany, openSection, openTab, typeDate } from './support/shell';

/** The setup's question, as the engine names its axis. */
const question = (page: Page) => page.locator('.acc-setup').getByRole('heading', { level: 2 });

/** Answers the setup's question with one of the engine's labels. */
async function answer(page: Page, name: string, choice: string) {
  await expect(question(page)).toHaveText(name);
  await expect(question(page)).toBeFocused();
  await page.getByRole('button', { name: choice, exact: true }).click();
  // The next question, or Acasă after the last one.
  await expect(page.getByRole('heading', { level: 2, name, exact: true })).toHaveCount(0);
}

const home = (page: Page) => page.getByRole('heading', { level: 1, name: 'Acasă', exact: true });

/**
 * The person's session from this file's first sign-in. Signing in is rate limited per address,
 * so the file's later tests open their companies in it; a test run alone signs in itself.
 */
let session: Awaited<ReturnType<BrowserContext['cookies']>> | undefined;

/** Signs in, or reuses the file's session, and creates a company from „Companie nouă”. */
async function withCompany(page: Page, info: TestInfo, name: string) {
  if (!session) {
    const errors = await signInWithCompany(page, info, 'accounting', name);
    session = await page.context().cookies();
    return errors;
  }
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.context().addCookies(session);
  await page.goto('/contabilitate');
  await expect(page.locator('.acc-app')).toBeVisible();
  await createCompany(page, name);
  return errors;
}

test('a new company answers its setup one question at a time and the profile shows it', async ({
  page,
}, info) => {
  const errors = await withCompany(page, info, `Configurare ${info.project.name} SRL`);
  const setup = page.locator('.acc-setup');
  // The first question, from the first day of the company's first financial year.
  await expect(question(page)).toHaveText('Forma juridică');
  await expect(setup).toContainText('Întrebarea 1 din 7');
  await expect(setup.getByRole('group', { name: 'De la', exact: true })).toContainText(
    '01.01.2026',
  );
  await expect(setup.getByRole('button', { name: 'Înapoi', exact: true })).toHaveCount(0);
  // The choices are the engine's labels.
  await expect(setup.getByRole('button', { name: /^Persoană fizică autorizată/ })).toBeVisible();
  await answer(page, 'Forma juridică', 'Societate cu răspundere limitată (SRL)');
  await answer(page, 'Regimul de TVA', 'Plătitor de TVA');
  // A VAT payer is asked its VAT period; „Înapoi” shows the answer given, and choosing it again
  // moves on without recording it twice.
  await expect(question(page)).toHaveText('Perioada fiscală de TVA');
  await expect(setup).toContainText('Întrebarea 3 din 9');
  await setup.getByRole('button', { name: 'Înapoi', exact: true }).click();
  await expect(question(page)).toHaveText('Regimul de TVA');
  await expect(setup.getByRole('button', { name: 'Plătitor de TVA', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await answer(page, 'Regimul de TVA', 'Plătitor de TVA');
  await answer(page, 'Perioada fiscală de TVA', 'Lunară');
  await answer(page, 'Sistemul TVA la încasare', 'Fără TVA la încasare');
  await answer(
    page,
    'Regimul de impozitare (profit sau microîntreprindere)',
    'Impozit pe veniturile microîntreprinderilor',
  );
  // Without employees, the 112's period is not asked.
  await answer(page, 'Calitatea de angajator', 'Fără salariați');
  await answer(page, 'Activitatea cu bunuri și stocuri', 'Numai servicii');
  await answer(page, 'Regimuri speciale excluse (accize, grup fiscal, IFRS)', 'Niciunul');
  // „Mai târziu” leaves the last question for later: the setup ends on Acasă, which offers it.
  await expect(question(page)).toHaveText('Categoria de mărime a entității');
  await setup.getByRole('button', { name: 'Mai târziu', exact: true }).click();
  await expect(home(page)).toBeVisible();
  const prompt = page.locator('.acc-setup-prompt');
  await expect(prompt).toContainText('O întrebare de configurare fără răspuns');
  await prompt.getByRole('link', { name: 'Configurează compania', exact: true }).click();
  await expect(question(page)).toHaveText('Categoria de mărime a entității');
  await expect(setup).toContainText('Întrebarea 1 din 1');
  await answer(page, 'Categoria de mărime a entității', 'Microentitate');
  await expect(home(page)).toBeVisible();
  await expect(setup).toHaveCount(0);
  await expect(prompt).toHaveCount(0);

  await openProfile(page);
  for (const [axis, value] of [
    ['Forma juridică', 'Societate cu răspundere limitată (SRL)'],
    ['Regimul de TVA', 'Plătitor de TVA'],
    ['Perioada fiscală de TVA', 'Lunară'],
    ['Sistemul TVA la încasare', 'Fără TVA la încasare'],
    ['Regimul de impozitare (profit sau microîntreprindere)', 'Impozit pe veniturile'],
    ['Calitatea de angajator', 'Fără salariați'],
    ['Activitatea cu bunuri și stocuri', 'Numai servicii'],
    ['Categoria de mărime a entității', 'Microentitate'],
  ] as const) {
    await expect(profileRow(page, axis)).toContainText(value);
    await expect(profileRow(page, axis)).toContainText('01.01.2026');
  }
  await expect(profileRow(page, 'Forma juridică')).not.toContainText('implicit');
  // Axes of a PFA, II or IF do not apply to an SRL and are not shown.
  await expect(profileRow(page, 'Opțiunea pentru plata CAS')).toHaveCount(0);
  // An answer without a document is kept as the person's statement; the one given again after
  // „Înapoi” was not recorded a second time.
  const vat = profileRow(page, 'Regimul de TVA');
  await vat.getByRole('button', { name: 'Istoric', exact: true }).click();
  await expect(vat.getByRole('button', { name: 'Istoric', exact: true })).toHaveAttribute(
    'aria-expanded',
    'true',
  );
  const history = page.locator('.acc-history-table tbody tr');
  await expect(history).toHaveCount(1);
  await expect(history).toContainText('Declarație');
  await expect(history).toContainText('în vigoare');
  expect(errors).toEqual([]);
});

test('a fact is changed from a day, corrected, confirmed for the year and kept in its history', async ({
  page,
}, info) => {
  const errors = await withCompany(page, info, `Corectare ${info.project.name} SRL`);
  // A document kept before is offered to cite; from the setup, Documente is in the sidebar.
  await keep(page, 'certificat-tva.pdf', 'Certificat sintetic de înregistrare în scopuri de TVA');
  await openProfile(page);
  // Before the legal form is recorded, the engine reads an SRL and says so.
  await expect(profileRow(page, 'Forma juridică')).toContainText('implicit');
  await expect(profileRow(page, 'Regimul de TVA')).toContainText('—');
  await expect(
    profileRow(page, 'Regimul de TVA').getByRole('button', { name: 'Corectează' }),
  ).toHaveCount(0);

  await changeFact(page, 'Regimul de TVA', 'Plătitor de TVA', '01.02.2026', 'certificat-tva.pdf');
  const vat = profileRow(page, 'Regimul de TVA');
  await vat.getByRole('button', { name: 'Corectează', exact: true }).click();
  const editor = factEditor(page);
  await expect(editor).toContainText('Înlocuiește Plătitor de TVA, de la 01.02.2026');
  await chooseOption(editor, 'Valoare', 'Neplătitor de TVA');
  await editor.getByRole('button', { name: 'Salvează', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Faptul a fost corectat.');
  await expect(vat).toContainText('Neplătitor de TVA');
  await expect(vat).toContainText('01.02.2026');

  await vat.getByRole('button', { name: 'Istoric', exact: true }).click();
  const history = page.locator('.acc-history-table');
  const replaced = history.getByRole('row').filter({ hasText: 'înlocuit' });
  await expect(replaced).toContainText('Plătitor de TVA');
  await expect(
    replaced.getByRole('link', { name: 'certificat-tva.pdf', exact: true }),
  ).toBeVisible();
  const inEffect = history.getByRole('row').filter({ hasText: 'în vigoare' });
  await expect(inEffect).toContainText('Neplătitor de TVA');
  await expect(inEffect).toContainText('Declarație');
  await vat.getByRole('button', { name: 'Istoric', exact: true }).click();
  await expect(history).toHaveCount(0);

  // A yearly fact is stated from the first day of a year, here with a file uploaded in place;
  // stated for last year, it asks to be confirmed for this one.
  const year = new Date().getFullYear();
  const size = profileRow(page, 'Categoria de mărime a entității');
  await size.getByRole('button', { name: 'Schimbă', exact: true }).click();
  const sizeEditor = factEditor(page);
  await expect(sizeEditor.getByRole('group', { name: 'De la', exact: true })).toContainText(
    `01.01.${year}`,
  );
  await chooseOption(sizeEditor, 'Valoare', 'Microentitate');
  await typeDate(sizeEditor, 'De la', `01.01.${year - 1}`);
  await sizeEditor.locator('input[type="file"]').setInputFiles({
    name: 'situatii-financiare.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from('Situații financiare sintetice'),
  });
  await expect(sizeEditor).toContainText('situatii-financiare.pdf');
  await sizeEditor.getByRole('button', { name: 'Salvează', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Faptul a fost înregistrat.');
  await expect(size).toContainText(`01.01.${year - 1}`);
  await size.getByRole('button', { name: `Confirmă pentru ${year}`, exact: true }).click();
  await expect(page.getByRole('status')).toContainText(`Faptul a fost confirmat pentru ${year}.`);
  await expect(size).toContainText(`01.01.${year}`);
  await expect(size).toContainText('Microentitate');
  await expect(size.getByRole('button', { name: /^Confirmă pentru/ })).toHaveCount(0);
  await size.getByRole('button', { name: 'Istoric', exact: true }).click();
  await expect(
    page.locator('.acc-history-table').getByRole('link', { name: 'situatii-financiare.pdf' }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});

test('a member is invited by a link shown once, reads the profile without its actions and is revoked', async ({
  page,
  browser,
}, info) => {
  const name = `Membri ${info.project.name} SRL`;
  const owner = `accounting-${info.project.name}@example.test`;
  const invited = `bank-${info.project.name}@example.test`;
  const errors = await withCompany(page, info, name);
  await openSection(page, 'Setări');
  await openTab(page, 'Membri');
  const ownerRow = page.getByRole('row').filter({ hasText: owner });
  await expect(ownerRow).toContainText('Proprietar');
  await expect(ownerRow.getByRole('button', { name: 'Revocă' })).toHaveCount(0);

  await page.getByLabel('Email', { exact: true }).fill(invited);
  await chooseOption(page.locator('.acc-invite-form'), 'Rol', 'Vizitator');
  await page.getByRole('button', { name: 'Invită', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Invitația a fost creată.');
  const link = page.getByRole('textbox', { name: `Link de invitație pentru ${invited}` });
  const address = await link.inputValue();
  expect(address).toMatch(/\/contabilitate#invite=[0-9a-f]{64}$/);
  await expect(page.locator('.acc-invitation')).toContainText('expiră în 48 de ore');
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.getByRole('button', { name: 'Copiază linkul', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Copiat', exact: true })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(address);
  // The link is shown once: leaving Membri drops it.
  await openTab(page, 'Export');
  await openTab(page, 'Membri');
  await expect(page.getByRole('textbox', { name: /^Link de invitație/ })).toHaveCount(0);

  // The invited person, in a browser of their own, joins through the link as a viewer: the
  // profile's values without its actions, and no setup to answer.
  const { viewport, userAgent, deviceScaleFactor, isMobile, hasTouch } = info.project.use;
  const other = await browser.newContext({
    viewport,
    userAgent,
    deviceScaleFactor,
    isMobile,
    hasTouch,
  });
  const guest = await other.newPage();
  await guest.goto(address);
  await expect(guest.getByRole('heading', { name: 'Autentificare', exact: true })).toBeVisible();
  await guest.getByLabel('Email', { exact: true }).fill(invited);
  await guest.getByLabel('Parolă', { exact: true }).fill('synthetic-browser-password');
  await guest.getByRole('button', { name: 'Intră în cont', exact: true }).click();
  await expect(currentCompany(guest)).toHaveText(name);
  await expect(home(guest)).toBeVisible();
  await expect(guest.locator('.acc-setup-prompt')).toHaveCount(0);
  await openProfile(guest);
  await expect(profileRow(guest, 'Forma juridică')).toContainText('implicit');
  await expect(guest.locator('.acc-profile').getByRole('button')).toHaveCount(0);
  await openTab(guest, 'Membri');
  await expect(guest.getByRole('row').filter({ hasText: invited })).toContainText('Vizitator');
  await expect(guest.getByRole('button', { name: 'Revocă' })).toHaveCount(0);
  await expect(guest.getByRole('button', { name: 'Invită' })).toHaveCount(0);

  // The owner revokes the access, after confirming it; the company leaves the person's list.
  await openTab(page, 'Export');
  await openTab(page, 'Membri');
  const member = page.getByRole('row').filter({ hasText: invited });
  await expect(member).toContainText('Vizitator');
  await member.getByRole('button', { name: 'Revocă', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Revocă accesul', exact: true });
  await expect(dialog).toContainText(invited);
  await dialog.getByRole('button', { name: 'Revocă', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('a fost revocat.');
  await expect(dialog).toHaveCount(0);
  await expect(member).toHaveCount(0);
  await guest.reload();
  await expect(guest.locator('.acc-app')).toBeVisible();
  await expect(currentCompany(guest)).not.toHaveText(name);
  await other.close();
  expect(errors).toEqual([]);
});

test('the complete export is requested, followed and downloaded; the months keep their address', async ({
  page,
}, info) => {
  const errors = await withCompany(page, info, `Export ${info.project.name} SRL`);
  const company = new URL(page.url()).searchParams.get('company');
  await openSection(page, 'Setări');
  await openTab(page, 'Export');
  await page.getByRole('button', { name: 'Cere exportul', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Exportul a fost cerut.');
  await expect(page).toHaveURL(/section=export&export=/);
  const download = page.getByRole('link', { name: 'Descarcă exportul', exact: true });
  await expect(download).toBeVisible({ timeout: 30000 });
  await expect(page.locator('.acc-export')).toContainText('Gata de descărcat');
  const response = await page.request.get((await download.getAttribute('href'))!);
  expect(response.ok()).toBe(true);
  // The address keeps the export, so a reload still shows it.
  await page.reload();
  await expect(download).toBeVisible();

  // The months' former address opens Exerciții și luni under Setări.
  await page.goto(`/contabilitate?company=${company}&view=settings&section=periods`);
  await expect(page.getByRole('heading', { level: 1, name: 'Setări', exact: true })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Exerciții și luni', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  const year = page.locator('a.acc-year-card');
  await expect(year).toHaveAttribute('aria-current', 'true');
  await expect(year).toContainText('ian–dec 2026');
  await expect(page.locator('.acc-month-row')).toHaveCount(12);
  await expect(page.locator('.acc-month-row').first()).toContainText('ianuarie 2026');
  await expect(page.locator('.acc-month-row').first()).toContainText('deschisă');
  expect(errors).toEqual([]);
});
