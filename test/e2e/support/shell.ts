import { expect, type Locator, type Page } from '@playwright/test';
import { formatMonth } from '../../../packages/xfactura-web/components/accounting/format';

/** On a narrow screen the sidebar sits in a drawer behind the menu button; this opens it. */
export async function openMenu(page: Page) {
  // The shell is there before its sidebar or the menu button can be looked for.
  await expect(page.locator('.acc-app')).toBeVisible();
  const button = page.getByRole('button', { name: 'Meniu', exact: true });
  if (await button.isVisible()) {
    await button.click();
    await expect(page.getByRole('dialog', { name: 'Meniu', exact: true })).toBeVisible();
  }
}

/** The sidebar's section links, in the sidebar or in the open drawer. */
export const sections = (page: Page) =>
  page.getByRole('navigation', { name: 'Secțiuni', exact: true });

/** Opens a section from the sidebar, as a person would, and waits for its context bar. */
export async function openSection(page: Page, name: string) {
  await openMenu(page);
  await sections(page).getByRole('link', { name, exact: true }).click();
  await drawerClosed(page);
  await expect(page.getByRole('heading', { level: 1, name, exact: true })).toBeVisible();
}

/** Opens one part of a section, from the tabs under the context bar. */
export async function openTab(page: Page, name: string) {
  const tab = page.getByRole('tab', { name, exact: true });
  await tab.click();
  await expect(tab).toHaveAttribute('aria-selected', 'true');
}

/** The company the screen belongs to, as the switcher or the top bar names it. */
export const currentCompany = (page: Page) =>
  page.locator('.acc-company-current').filter({ visible: true });

/** Opens the company switcher in the sidebar. */
export async function openCompanies(page: Page) {
  await openMenu(page);
  await page.locator('.acc-switcher').filter({ visible: true }).click();
  await expect(page.getByRole('menu')).toBeVisible();
}

/** Waits until the drawer, if a narrow screen opened one, has closed. */
export async function drawerClosed(page: Page) {
  await expect(page.getByRole('dialog', { name: 'Meniu', exact: true })).toBeHidden();
}

/** Opens a company from the switcher. */
export async function chooseCompany(page: Page, name: string) {
  await openCompanies(page);
  await page.getByRole('menuitem', { name, exact: true }).click();
  await drawerClosed(page);
  await expect(currentCompany(page)).toHaveText(name);
}

/** Creates a company from the switcher's „Companie nouă” page. */
export async function createCompany(page: Page, name: string, cui = '12345678', year = '2026') {
  if (!(await page.getByRole('heading', { level: 1, name: 'Companie nouă' }).isVisible())) {
    await openCompanies(page);
    await page.getByRole('menuitem', { name: 'Companie nouă', exact: true }).click();
    await drawerClosed(page);
  }
  await expect(page.getByRole('heading', { level: 1, name: 'Companie nouă' })).toBeVisible();
  await page.getByLabel('Denumire', { exact: true }).fill(name);
  await page.getByLabel('CUI', { exact: true }).fill(cui);
  await page.getByLabel('An contabil', { exact: true }).fill(year);
  await page.getByRole('button', { name: 'Adaugă compania', exact: true }).click();
  await drawerClosed(page);
  await expect(currentCompany(page)).toHaveText(name);
  // A new company opens on its setup, a part of Setări.
  await expect(page.getByRole('heading', { level: 1, name: 'Setări', exact: true })).toBeVisible();
  await expect(page).toHaveURL(/view=settings&section=setup/);
}

/** The account menu at the foot of the sidebar. */
export async function openAccount(page: Page) {
  await openMenu(page);
  await page.locator('.acc-account').filter({ visible: true }).click();
  await expect(page.getByRole('menu')).toBeVisible();
}

/** Chooses Sistem, Luminos or Întunecat in the account menu. */
export async function chooseTheme(page: Page, theme: 'Sistem' | 'Luminos' | 'Întunecat') {
  await openAccount(page);
  await page.getByRole('menuitemradio', { name: theme, exact: true }).click();
  await menuClosed(page);
  await closeMenu(page);
}

/** Waits until an open menu has finished closing, so the next Escape reaches what is under it. */
export async function menuClosed(page: Page) {
  await expect(page.getByRole('menu')).toBeHidden();
  await expect(page.locator('.acc-menu-popover')).toHaveCount(0);
}

/** Closes the drawer with Escape, when a narrow screen has it open. */
export async function closeMenu(page: Page) {
  const drawer = page.getByRole('dialog', { name: 'Meniu', exact: true });
  if (await drawer.isVisible()) {
    // Escape reaches the drawer once focus is back inside it, after a menu in it has closed; just
    // opened, the drawer holds focus itself.
    await expect
      .poll(() => drawer.evaluate((element) => element.contains(document.activeElement)))
      .toBe(true);
    await page.keyboard.press('Escape');
    await drawerClosed(page);
  }
}

/**
 * The theme a surface is painted in, read from its background: `light` or `dark` when it is
 * opaque and exactly the theme token it should show (`--acc-canvas` for the interface,
 * `--acc-raised` for a menu); anything else, a transparent background included, is reported as
 * such and fails.
 */
export async function surfaceTheme(page: Page, selector = '.accounting', token = '--acc-canvas') {
  return page
    .locator(selector)
    .first()
    .evaluate((element, token) => {
      const shown = getComputedStyle(element).backgroundColor;
      const probe = document.createElement('div');
      probe.style.backgroundColor = `var(${token})`;
      element.append(probe);
      const expected = getComputedStyle(probe).backgroundColor;
      probe.remove();
      const [r = 0, g = 0, b = 0, alpha = 1] = (shown.match(/[\d.]+/g) ?? []).map(Number);
      if (alpha < 1) return `transparent: ${shown}`;
      if (shown !== expected) return `${shown} is not ${token} (${expected})`;
      return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 > 0.5 ? 'light' : 'dark';
    }, token);
}

/** The interface is painted in the theme: its canvas is opaque and the theme's canvas token. */
export async function expectTheme(page: Page, theme: 'light' | 'dark') {
  await expect.poll(() => surfaceTheme(page)).toBe(theme);
}

/** A select by its label: its button is named by the value shown, then the label. */
export const selectButton = (scope: Page | Locator, label: string) =>
  scope.getByRole('button', {
    name: new RegExp(`${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`),
  });

/** Chooses an option of a select by its label, as a person does. */
export async function chooseOption(scope: Page | Locator, label: string, option: string) {
  await selectButton(scope, label).click();
  await pageOf(scope).getByRole('option', { name: option, exact: true }).click();
  await expect(selectButton(scope, label)).toContainText(option);
}

/** The Exercițiu select in the context bar. */
export const yearSelect = (page: Page) =>
  page.locator('.acc-contextbar').getByRole('button', { name: /Exercițiu$/ });

/** Chooses a financial year in the context bar by its label. */
export async function chooseYear(page: Page, label: string) {
  // A select without options does not open: wait until the company's years have loaded.
  await expect(yearSelect(page)).not.toContainText('Alege');
  await yearSelect(page).click();
  await page.getByRole('option', { name: label, exact: true }).click();
  await expect(yearSelect(page)).toContainText(label);
}

const pageOf = (scope: Page | Locator): Page => ('keyboard' in scope ? scope : scope.page());

/** Empties one segment of a date field (0 day, 1 month, 2 year) with Backspace, as a person does. */
export async function clearSegment(scope: Page | Locator, label: string, index: number) {
  const segment = scope
    .getByRole('group', { name: label, exact: true })
    .getByRole('spinbutton')
    .nth(index);
  await segment.click();
  for (let press = 0; press < 5 && !(await segment.getAttribute('data-placeholder')); press++)
    await pageOf(scope).keyboard.press('Backspace');
  await expect(segment).toHaveAttribute('data-placeholder');
}

/** Types a day into a date field as a person does, digits only: `17.11.2026`. */
export async function typeDate(scope: Page | Locator, label: string, date: string) {
  const field = scope.getByRole('group', { name: label, exact: true });
  await field.getByRole('spinbutton').first().click();
  await pageOf(scope).keyboard.type(date.replace(/\D/g, ''));
  await expect(field).toContainText(date);
}

/** A month field by its label. */
export const monthField = (scope: Page | Locator, label: string) =>
  scope.getByRole('group', { name: label, exact: true });

/** Chooses a month (`YYYY-MM`) in a month field: the year by its arrows, then the month. */
export async function chooseMonth(scope: Page | Locator, label: string, month: string) {
  const field = monthField(scope, label);
  await field.getByRole('button').click();
  const dialog = pageOf(scope).getByRole('dialog', { name: label, exact: true });
  await expect(dialog).toBeVisible();
  const target = Number(month.slice(0, 4));
  for (let step = 0; step < 40; step++) {
    const shown = Number(await dialog.locator('.acc-month-year').textContent());
    if (shown === target) break;
    await dialog
      .getByRole('button', { name: shown > target ? 'Anul anterior' : 'Anul următor' })
      .click();
  }
  await dialog.getByRole('button', { name: formatMonth(month), exact: true }).click();
  await expect(field).toContainText(formatMonth(month));
}
