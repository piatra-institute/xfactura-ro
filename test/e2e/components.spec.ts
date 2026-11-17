import { expect, test, type Page } from '@playwright/test';
import { chooseMonth, clearSegment, typeDate } from './support/shell';

/** A form of the component page, its submit button and what it last submitted. */
function sample(page: Page, title: string) {
  const form = page.getByRole('form', { name: title, exact: true });
  return {
    form,
    submit: () => form.getByRole('button', { name: 'Trimite', exact: true }).click(),
    sent: form.getByRole('status', { name: 'Valori trimise' }),
  };
}

test.beforeEach(async ({ page }) => {
  await page.goto('/contabilitate/componente');
  await expect(page.getByRole('heading', { level: 1, name: 'Componente' })).toBeVisible();
});

test('a date field submits a whole date or nothing, never part of one', async ({ page }) => {
  const { form, submit, sent } = sample(page, 'Date');
  await submit();
  await expect(form.getByText('Completează data.', { exact: true })).toBeVisible();
  await expect(sent).toHaveText('');
  await typeDate(form, 'Data obligatorie', '17.11.2026');
  await clearSegment(form, 'Data obligatorie', 1);
  await submit();
  await expect(
    form.getByText('Data este incompletă: completează ziua, luna și anul sau golește câmpul.'),
  ).toBeVisible();
  await expect(sent).toHaveText('');
  await typeDate(form, 'Data obligatorie', '17.11.2026');
  // The optional date, fully cleared, submits empty.
  for (const index of [0, 1, 2]) await clearSegment(form, 'Data opțională', index);
  await submit();
  await expect(sent).toHaveText(JSON.stringify({ required: '2026-11-17', optional: '' }));
});

test('a month field refuses a value outside its bounds, set before or after', async ({ page }) => {
  const early = sample(page, 'Lună în afara limitelor');
  await expect(
    early.form.getByText('Alege o lună începând cu ianuarie 2027.', { exact: true }),
  ).toBeVisible();
  await early.submit();
  await expect(early.sent).toHaveText('');
  await chooseMonth(early.form, 'Luna de dinainte', '2027-03');
  await early.submit();
  await expect(early.sent).toHaveText(JSON.stringify({ early: '2027-03' }));

  const bounded = sample(page, 'Luni');
  await bounded.submit();
  await expect(bounded.sent).toHaveText(JSON.stringify({ bounded: '2026-11' }));
  await bounded.form.getByRole('button', { name: 'Începe limita în 2027', exact: true }).click();
  await expect(
    bounded.form.getByText('Alege o lună între ianuarie 2027 și decembrie 2027.', { exact: true }),
  ).toBeVisible();
  await expect(bounded.form.getByRole('group', { name: 'Luna limitată' })).toHaveAttribute(
    'data-invalid',
    'true',
  );
  await bounded.form.getByRole('button', { name: 'Trimite', exact: true }).click();
  // The earlier submission stays: this one was refused.
  await expect(bounded.sent).toHaveText(JSON.stringify({ bounded: '2026-11' }));
});

test('a money field refuses an empty required amount and text that is not one', async ({
  page,
}) => {
  const { form, submit, sent } = sample(page, 'Sume');
  await submit();
  await expect(form.getByText('Completează suma.', { exact: true })).toBeVisible();
  await expect(sent).toHaveText('');
  const amount = form.getByLabel('Sumă obligatorie', { exact: true });
  await amount.fill('1.2.3');
  await amount.blur();
  await expect(
    form.getByText('Scrie suma ca 1.234,56, cu cel mult două zecimale.', { exact: true }),
  ).toBeVisible();
  await submit();
  await expect(sent).toHaveText('');
  await amount.fill('1.234,5');
  const yen = form.getByLabel('Sumă în yeni', { exact: true });
  await yen.fill('12,5');
  await yen.blur();
  await expect(
    form.getByText('Scrie suma ca 1.234, fără zecimale.', { exact: true }),
  ).toBeVisible();
  await submit();
  await expect(sent).toHaveText('');
  await yen.fill('1.234');
  await submit();
  // JPY has no minor unit, so no `.00`; the disabled amount is not submitted.
  await expect(sent).toHaveText(JSON.stringify({ amount: '1234.50', yen: '1234' }));
  await expect(amount).toHaveValue('1.234,50');
});

test('a combobox filters its options by code and by name as they are typed', async ({ page }) => {
  const { form, submit, sent } = sample(page, 'Conturi');
  const input = form.getByRole('combobox', { name: 'Cont', exact: true });
  await input.click();
  await input.fill('411');
  await expect(page.getByRole('option')).toHaveText(['4111Clienți']);
  await input.fill('furn');
  await expect(page.getByRole('option')).toHaveText(['401Furnizori']);
  await input.fill('banci lei');
  await expect(page.getByRole('option')).toHaveText(['5121Conturi la bănci în lei']);
  // On a touch screen the list is revealed once no on-screen keyboard is moving.
  await expect(page.locator('.acc-listbox-popover')).toHaveCSS('opacity', '1');
  await page.getByRole('option').click();
  await submit();
  await expect(sent).toHaveText(JSON.stringify({ account: '5121', kind: 'general' }));
});
