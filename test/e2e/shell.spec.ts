import { expect, test } from '@playwright/test';
import { signInWithCompany } from './support/session';
import {
  chooseCompany,
  chooseMonth,
  chooseTheme,
  clearSegment,
  closeMenu,
  createCompany,
  currentCompany,
  drawerClosed,
  expectTheme,
  menuClosed,
  openAccount,
  openCompanies,
  openMenu,
  openSection,
  openTab,
  sections,
  surfaceTheme,
  typeDate,
} from './support/shell';
import { mockWorklist } from './support/worklist';

const sectionNames = [
  'Acasă',
  'De verificat',
  'Întrebări',
  'Documente',
  'Bancă',
  'Registre',
  'Declarații',
  'Setări',
];

test('every section is one click away in the sidebar, without scrolling', async ({
  page,
}, info) => {
  test.skip(info.project.name !== 'desktop', 'The sidebar is a drawer on narrow screens.');
  await mockWorklist(page, () => ({ body: { items: [], next: null, asOfSeq: 1 } }));
  await page.goto('/contabilitate?company=company');
  await expect(page.getByRole('heading', { level: 1, name: 'Acasă', exact: true })).toBeVisible();
  const viewport = page.viewportSize()!;
  await expect(sections(page).getByRole('link')).toHaveText(sectionNames);
  for (const name of sectionNames) {
    const link = sections(page).getByRole('link', { name, exact: true });
    const box = (await link.boundingBox())!;
    expect(box.y + box.height, name).toBeLessThanOrEqual(viewport.height);
    await link.click();
    await expect(page.getByRole('heading', { level: 1, name, exact: true })).toBeVisible();
    await expect(link).toHaveAttribute('aria-current', 'page');
    await expect(sections(page).locator('[aria-current="page"]')).toHaveCount(1);
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
  }
  const account = page.getByRole('button', { name: 'Persoană sintetică', exact: true });
  const box = (await account.boundingBox())!;
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
  // Sidebar entries are links: the address of each section can be opened in a new tab.
  await expect(sections(page).getByRole('link', { name: 'Bancă', exact: true })).toHaveAttribute(
    'href',
    '/contabilitate?company=company&view=bank',
  );
});

test('old Registre addresses for Documente and Bancă open their own sections', async ({ page }) => {
  await mockWorklist(page, () => ({ body: { items: [], next: null, asOfSeq: 1 } }));
  await page.goto('/contabilitate?company=company&view=registers&section=bank&register=jurnal');
  await expect(page.getByRole('heading', { level: 1, name: 'Bancă', exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/contabilitate\?company=company&view=bank$/);
  await page.goto('/contabilitate?company=company&view=registers&section=documents');
  await expect(
    page.getByRole('heading', { level: 1, name: 'Documente', exact: true }),
  ).toBeVisible();
  await expect(page).toHaveURL(/\/contabilitate\?company=company&view=documents$/);
  // Without a view, the company opens on Acasă.
  await page.goto('/contabilitate?company=company');
  await expect(page.getByRole('heading', { level: 1, name: 'Acasă', exact: true })).toBeVisible();
});

test('on a narrow screen the sidebar is a drawer behind the menu button', async ({
  page,
}, info) => {
  test.skip(info.project.name !== 'mobile', 'The drawer belongs to narrow screens.');
  await mockWorklist(page, () => ({ body: { items: [], next: null, asOfSeq: 1 } }));
  await page.goto('/contabilitate?company=company');
  await expect(page.getByRole('heading', { level: 1, name: 'Acasă', exact: true })).toBeVisible();
  await expect(sections(page)).toBeHidden();
  await expect(currentCompany(page)).toHaveText('Verificare sintetică SRL');
  const menu = page.getByRole('button', { name: 'Meniu', exact: true });
  await menu.click();
  const drawer = page.getByRole('dialog', { name: 'Meniu', exact: true });
  await expect(drawer).toBeVisible();
  await expect(sections(page).getByRole('link')).toHaveText(sectionNames);
  await expect(sections(page).getByRole('link', { name: 'Acasă', exact: true })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await page.keyboard.press('Escape');
  await expect(drawer).toBeHidden();
  await expect(menu).toBeFocused();
  await menu.click();
  await sections(page).getByRole('link', { name: 'Bancă', exact: true }).click();
  await expect(drawer).toBeHidden();
  await expect(page.getByRole('heading', { level: 1, name: 'Bancă', exact: true })).toBeVisible();
  await expect(page).toHaveURL(/view=bank/);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('the theme chosen in the account menu is kept across a reload', async ({ page }) => {
  await mockWorklist(page, () => ({ body: { items: [], next: null, asOfSeq: 1 } }));
  await page.goto('/contabilitate?company=company');
  await expect(page.getByRole('heading', { level: 1, name: 'Acasă', exact: true })).toBeVisible();
  await expectTheme(page, 'light');
  await chooseTheme(page, 'Întunecat');
  await expectTheme(page, 'dark');
  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: 'Acasă', exact: true })).toBeVisible();
  await expectTheme(page, 'dark');

  await page.emulateMedia({ colorScheme: 'dark' });
  await chooseTheme(page, 'Luminos');
  await expectTheme(page, 'light');
  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: 'Acasă', exact: true })).toBeVisible();
  await expectTheme(page, 'light');
  await chooseTheme(page, 'Sistem');
  await expectTheme(page, 'dark');
  await expect(page.locator('html')).not.toHaveAttribute('data-acc-theme');
  await page.emulateMedia({ colorScheme: 'light' });
  await expectTheme(page, 'light');
});

test('the stored theme paints the first HTML, before any script of the interface runs', async ({
  page,
}) => {
  await page.addInitScript(() => localStorage.setItem('xfactura.accounting.theme', 'dark'));
  // Hold every script file back: only the HTML, its inline theme script and the styles remain,
  // so nothing hydrates and no effect can correct the theme afterwards.
  let held = 0;
  await page.route(/\.js(\?|$)/, (route) => {
    held++;
    return route.abort();
  });
  await page.goto('/contabilitate', { waitUntil: 'domcontentloaded' });
  // The page stays as the server sent it: the interface never loads to check the session.
  await expect(page.locator('.accounting.acc-boot')).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-acc-theme', 'dark');
  expect(await surfaceTheme(page)).toBe('dark');
  expect(held).toBeGreaterThan(0);
  expect(await page.evaluate(() => 'next' in window)).toBe(false);
  // A light system and no stored choice paint light, the same way.
  await page.addInitScript(() => localStorage.removeItem('xfactura.accounting.theme'));
  await page.goto('/contabilitate', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('.accounting.acc-boot')).toBeVisible();
  await expect(page.locator('html')).not.toHaveAttribute('data-acc-theme');
  expect(await surfaceTheme(page)).toBe('light');
});

test('menus and the drawer are painted in the theme, like the page under them', async ({
  page,
}, info) => {
  await mockWorklist(page, () => ({ body: { items: [], next: null, asOfSeq: 1 } }));
  await page.goto('/contabilitate?company=company');
  await expect(page.getByRole('heading', { level: 1, name: 'Acasă', exact: true })).toBeVisible();
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await expectTheme(page, theme);
    await openAccount(page);
    await expect.poll(() => surfaceTheme(page, '.acc-menu-popover', '--acc-raised')).toBe(theme);
    if (info.project.name === 'mobile')
      await expect.poll(() => surfaceTheme(page, '.acc-drawer', '--acc-sidebar')).toBe(theme);
    await page.keyboard.press('Escape');
    await menuClosed(page);
    await closeMenu(page);
  }
});

test('a date typed as 17.11.2026 and a month chosen by name reach the engine as ISO values', async ({
  page,
}) => {
  const inputs: Record<string, Record<string, unknown>> = {};
  await mockWorklist(
    page,
    (operation, input) => {
      inputs[operation] = input;
      if (operation === 'periods.close.request')
        return {
          body: {
            id: 'close',
            status: 'requested',
            previewHash: 'a'.repeat(64),
            preview: { month: input.month, findings: [] },
          },
        };
      return { body: { items: [], next: null, asOfSeq: 1 } };
    },
    {
      'capabilities.list': {
        capabilities: ['ledger.general.propose', 'periods.close.request', 'periods.list'].map(
          (id) => ({ id }),
        ),
      },
      'evidence.list': {
        items: [
          {
            id: 'proof',
            filename: 'nota-sintetica.pdf',
            hash: 'a'.repeat(64),
            mediaType: 'application/pdf',
            size: 10,
          },
        ],
        next: null,
      },
    },
  );
  await page.goto('/contabilitate?company=company&view=review');
  await page.getByText('Notă contabilă nouă', { exact: true }).click();
  await typeDate(page, 'Data', '17.11.2026');
  await page.getByLabel('Referință', { exact: true }).fill('NC-1');
  await page.getByLabel('Explicație', { exact: true }).fill('Notă sintetică');
  await page.getByLabel('Cont', { exact: true }).nth(0).fill('5121');
  await page.getByLabel('Sumă (lei)', { exact: true }).nth(0).fill('10,00');
  await page.getByLabel('Cont', { exact: true }).nth(1).fill('1012');
  await page.getByLabel('Sumă (lei)', { exact: true }).nth(1).fill('10,00');
  // Part of a date is no date: the form is refused, with the reason on the field.
  await clearSegment(page, 'Data', 1);
  await page.getByRole('button', { name: 'Pregătește propunerea', exact: true }).click();
  await expect(
    page.getByText('Data este incompletă: completează ziua, luna și anul sau golește câmpul.'),
  ).toBeVisible();
  expect(inputs['ledger.general.propose']).toBeUndefined();
  await typeDate(page, 'Data', '17.11.2026');
  await page.getByRole('button', { name: 'Pregătește propunerea', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('pregătită pentru verificare');
  expect(inputs['ledger.general.propose']).toMatchObject({ date: '2026-11-17' });

  await openSection(page, 'Setări');
  await openTab(page, 'Luni');
  await page.getByRole('button', { name: 'Verifică luna', exact: true }).click();
  await expect(page.getByText('Alege luna.', { exact: true })).toBeVisible();
  expect(inputs['periods.close.request']).toBeUndefined();
  await chooseMonth(page, 'Luna', '2026-11');
  await page.getByRole('button', { name: 'Verifică luna', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Verificările au fost rulate.');
  expect(inputs['periods.close.request']).toEqual({ month: '2026-11' });
});

test('„Companie nouă” in the company switcher creates a company and opens it', async ({
  page,
}, info) => {
  const first = `Comutator ${info.project.name} SRL`;
  const second = `Comutator nou ${info.project.name} SRL`;
  const errors = await signInWithCompany(page, info, 'accounting', first);
  await openCompanies(page);
  await page.getByRole('menuitem', { name: 'Companie nouă', exact: true }).click();
  await drawerClosed(page);
  await expect(page).toHaveURL(/company=new/);
  await expect(page.getByRole('heading', { level: 1, name: 'Companie nouă' })).toBeVisible();
  // Nothing about other companies sits in a company's screens; the form is its own page.
  await expect(page.getByText('Adaugă o companie')).toHaveCount(0);
  await createCompany(page, second, '87654321');
  const created = new URL(page.url()).searchParams.get('company');
  expect(created).toBeTruthy();
  expect(created).not.toBe('new');
  if (info.project.name === 'desktop') {
    // A company without a profile lists dozens of returns: the page grows far past the
    // viewport, and the sidebar's foot stays on screen however far it scrolls.
    await openSection(page, 'De verificat');
    await expect(page.locator('.acc-worklist')).toHaveAttribute('aria-busy', 'false');
    const causes = page.locator('.acc-work-cause > summary');
    for (let index = 0; index < (await causes.count()); index++) await causes.nth(index).click();
    const viewport = page.viewportSize()!;
    expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBeGreaterThan(
      viewport.height * 2,
    );
    for (const to of ['middle', 'bottom'] as const) {
      await page.evaluate(
        (to) =>
          window.scrollTo(
            0,
            to === 'bottom' ? document.documentElement.scrollHeight : window.innerHeight * 1.5,
          ),
        to,
      );
      for (const control of [
        sections(page).getByRole('link', { name: 'Setări', exact: true }),
        page.locator('.acc-account'),
      ]) {
        const box = (await control.boundingBox())!;
        expect(box.y, to).toBeGreaterThanOrEqual(0);
        expect(box.y + box.height, to).toBeLessThanOrEqual(viewport.height);
      }
    }
  }
  await openCompanies(page);
  await expect(page.getByRole('menuitem', { name: first, exact: true })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: second, exact: true })).toBeVisible();
  await page.getByRole('menuitem', { name: first, exact: true }).click();
  await drawerClosed(page);
  await expect(currentCompany(page)).toHaveText(first);
  expect(errors).toEqual([]);
});

test('„Companie nouă” belongs to no company and returns to the one it was opened from', async ({
  page,
}) => {
  await mockWorklist(page, () => ({ body: { items: [], next: null, asOfSeq: 1 } }));
  await page.route('**/api/accounting/v1/companies', (route) =>
    route.fulfill({
      json: [
        { id: 'company-a', name: 'Compania A SRL', cui: '12345678' },
        { id: 'company-b', name: 'Compania B SRL', cui: '87654321' },
      ],
    }),
  );
  await page.goto('/contabilitate?company=company-a');
  await expect(currentCompany(page)).toHaveText('Compania A SRL');
  await chooseCompany(page, 'Compania B SRL');
  await openCompanies(page);
  await page.getByRole('menuitem', { name: 'Companie nouă', exact: true }).click();
  await drawerClosed(page);
  await expect(page.getByRole('heading', { level: 1, name: 'Companie nouă' })).toBeVisible();
  await expect(currentCompany(page)).toHaveText('Companie nouă');
  // The sidebar would open another company's sections; on this page it offers none.
  await openMenu(page);
  await expect(sections(page)).toHaveCount(0);
  await page.locator('.acc-switcher').filter({ visible: true }).click();
  await expect(page.getByRole('menuitem', { name: 'Companie nouă', exact: true })).toHaveAttribute(
    'data-current',
    'true',
  );
  await expect(
    page.getByRole('menuitem', { name: 'Compania B SRL', exact: true }),
  ).not.toHaveAttribute('data-current');
  await page.keyboard.press('Escape');
  await menuClosed(page);
  await closeMenu(page);
  await page.getByRole('link', { name: 'Renunță', exact: true }).click();
  await expect(currentCompany(page)).toHaveText('Compania B SRL');
  await expect(page).toHaveURL(/company=company-b/);
});

test('address values that name inherited properties fall back to a known view', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await mockWorklist(page, () => ({ body: { items: [], next: null, asOfSeq: 1 } }));
  await page.goto('/contabilitate?company=company&view=registers&section=toString');
  await expect(
    page.getByRole('heading', { level: 1, name: 'Registre', exact: true }),
  ).toBeVisible();
  await page.goto('/contabilitate?company=company&view=constructor');
  await expect(page.getByRole('heading', { level: 1, name: 'Acasă', exact: true })).toBeVisible();
  await page.goto('/contabilitate?company=company&view=settings&section=__proto__');
  await expect(page.getByRole('heading', { level: 1, name: 'Setări', exact: true })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Profil și acces', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  expect(errors).toEqual([]);
});
