import { expect, type Locator, type Page } from '@playwright/test';
import { openSection, typeDate } from './shell';

/** Opens Setări on Companie, the company's profile. */
export async function openProfile(page: Page) {
  await openSection(page, 'Setări');
  await expect(page.getByRole('tab', { name: 'Companie', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.locator('.acc-profile')).toBeVisible();
}

/** A profile axis's row, by the axis's name as the engine gives it. */
export const profileRow = (page: Page, name: string) =>
  page.getByRole('row').filter({ has: page.getByRole('rowheader', { name, exact: true }) });

/** The change or correction form open under a row. */
export const factEditor = (page: Page) => page.locator('.acc-fact-editor');

/** Chooses an option of a shared Select by the field's label and the option's label. */
export async function chooseOption(scope: Locator, label: string, option: string) {
  // A select names itself by its value, then its label: „Alege Valoare”, „2026 Exercițiu”.
  await scope.getByRole('button', { name: new RegExp(`${label}$`) }).click();
  await scope.page().getByRole('option', { name: option, exact: true }).click();
}

/**
 * Records a value on an axis from a day through the row's „Schimbă”, citing a kept document
 * when one is named, and waits until the row shows it.
 */
export async function changeFact(
  page: Page,
  axis: string,
  value: string,
  date: string,
  document?: string,
) {
  const row = profileRow(page, axis);
  await row.getByRole('button', { name: 'Schimbă', exact: true }).click();
  const editor = factEditor(page);
  await chooseOption(editor, 'Valoare', value);
  await typeDate(editor, 'De la', date);
  if (document) {
    const picker = editor.getByRole('combobox', { name: 'Document', exact: true });
    await picker.click();
    await picker.fill(document);
    // On a touch screen the list is revealed once no on-screen keyboard is moving.
    await expect(page.locator('.acc-listbox-popover')).toHaveCSS('opacity', '1');
    await page.getByRole('option', { name: document, exact: true }).click();
  }
  await editor.getByRole('button', { name: 'Salvează', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Faptul a fost înregistrat.');
  await expect(editor).toHaveCount(0);
  await expect(row).toContainText(value);
  await expect(row).toContainText(date);
}
