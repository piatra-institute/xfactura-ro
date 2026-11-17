import { expect, type Locator, type Page } from '@playwright/test';
import { openSection, openTab } from './shell';

const pageOf = (scope: Page | Locator): Page => ('keyboard' in scope ? scope : scope.page());

/** Scrolls a field to the middle of the screen and lets the scroll settle: a scroll that arrives
 * after a list opened would close it. */
async function centre(field: Locator) {
  await field.evaluate(
    (element) =>
      new Promise<void>((settled) => {
        element.scrollIntoView({ block: 'center' });
        requestAnimationFrame(() => requestAnimationFrame(() => settled()));
      }),
  );
}

/**
 * Types into a combobox, as a person searches, and picks the option the text names with the
 * arrow keys and Enter, as a keyboard does: the list is not scrolled to, which would close it.
 */
export async function choose(
  scope: Page | Locator,
  combobox: string,
  typed: string,
  option: RegExp = new RegExp(`^${typed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
) {
  const page = pageOf(scope);
  const field = scope.getByRole('combobox', { name: combobox, exact: true });
  // Focusing a field low on a phone scrolls the page, and scrolling closes the list: centre it.
  await centre(field);
  await field.fill(typed);
  const options = page.getByRole('listbox').getByRole('option');
  await expect(options.filter({ hasText: option }).first()).toBeAttached();
  const index = await options.evaluateAll(
    (elements, { source, flags }) =>
      elements.findIndex((element) => new RegExp(source, flags).test(element.textContent ?? '')),
    { source: option.source, flags: option.flags },
  );
  expect(index, `${combobox}: ${option}`).toBeGreaterThanOrEqual(0);
  for (let step = 0; step <= index; step++) await field.press('ArrowDown');
  await expect(options.nth(index)).toHaveAttribute('data-focused', 'true');
  await field.press('Enter');
  await expect(page.getByRole('listbox')).toHaveCount(0);
}

/** Chooses a value of a select by its visible label. */
export async function select(scope: Page | Locator, label: string, value: string) {
  const trigger = scope.getByRole('button', { name: new RegExp(`${label}$`) });
  await centre(trigger);
  await trigger.click();
  await expect(pageOf(scope).locator('.acc-listbox-popover')).toHaveCSS('opacity', '1');
  await pageOf(scope)
    .getByRole('listbox')
    .getByRole('option', { name: value, exact: true })
    .click();
  await expect(scope.getByRole('button', { name: new RegExp(`${label}$`) })).toContainText(value);
}

/** One line's field: `Cont`, `Debit`, `Credit`, `Explicație` and the others, by line number. */
export const cell = (page: Page, name: string, line: number) =>
  page.getByRole(
    name === 'Cont' || name === 'Partener' || name === 'Factură' ? 'combobox' : 'textbox',
    {
      name: `${name}, linia ${line}`,
      exact: true,
    },
  );

/** The totals the engine's preview states under the lines. */
export const entryTotals = (page: Page) => page.locator('.acc-entry-grid tfoot');

/** Opens Registre → Registrul jurnal and its context bar's „Notă contabilă nouă”. */
export async function openJournalEntry(page: Page) {
  await openSection(page, 'Registre');
  await openTab(page, 'Registrul jurnal');
  await page.getByRole('link', { name: 'Notă contabilă nouă', exact: true }).click();
  await expect(page.getByRole('heading', { level: 2, name: 'Notă contabilă nouă' })).toBeVisible();
  await expect(page).toHaveURL(/register=jurnal/);
  await expect(page).toHaveURL(/entry=new/);
}

/** Approves the proposal shown in place and posts it. */
export async function approveInPlace(scope: Page | Locator) {
  const page = pageOf(scope);
  await scope.getByRole('button', { name: 'Aprobă această versiune', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Versiunea a fost aprobată.');
  await scope.getByRole('button', { name: 'Contabilizează', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Înregistrarea a fost contabilizată.');
}
