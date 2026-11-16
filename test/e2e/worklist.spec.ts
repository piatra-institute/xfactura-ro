import { expect, test } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { invoiceXml } from '../../packages/xfactura-api/test/engine/fixtures/invoice';
import {
  approveAndPost,
  keep,
  openProposal,
  recordVatPayer,
  signInWithCompany,
} from './support/session';
import { mockWorklist, workItem } from './support/worklist';
import type { WorkItem } from '../../packages/xfactura-web/components/accounting/work-model';

test('an unbooked document reaches approval and posting from the worklist', async ({
  page,
}, info) => {
  const observed: WorkItem[] = [];
  const reads: Promise<void>[] = [];
  page.on('response', (response) => {
    if (response.url().endsWith('/capabilities/work.list') && response.ok())
      reads.push(
        response
          .json()
          .then((body: { items: WorkItem[] }) => {
            observed.push(...body.items);
          })
          .catch(() => {
            // Filter changes discard older responses; only completed bodies are diagnostic evidence.
          }),
      );
  });
  const errors = await signInWithCompany(
    page,
    info,
    'accounting',
    `Verificare ${info.project.name} SRL`,
  );
  await expect(page.locator('.acc-worklist')).toHaveAttribute('aria-busy', 'false');
  const more = page.getByRole('button', { name: 'Mai multe elemente', exact: true });
  for (let count = 0; count < 20 && (await more.isVisible()); count++) {
    await more.click();
    await expect(page.locator('.acc-worklist')).toHaveAttribute('aria-busy', 'false');
  }
  await expect(more).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('new-company-worklist.png'), fullPage: true });
  await keep(page, 'certificat-verificare.pdf', 'Certificat sintetic TVA');
  await recordVatPayer(page, 'certificat-verificare.pdf');
  await keep(page, 'LUCRU-1.xml', invoiceXml({ number: 'LUCRU-1' }), 'application/xml');
  await page
    .locator('tr', { hasText: 'LUCRU-1.xml' })
    .getByRole('button', { name: 'Factură e-Factura', exact: true })
    .click();
  await expect(page.getByRole('status')).toContainText('Documentul e-Factura a fost importat.');

  await page.getByRole('button', { name: 'De verificat', exact: true }).click();
  await page.getByRole('combobox', { name: 'Familie', exact: true }).selectOption('documents');
  await page.getByRole('combobox', { name: 'Severitate', exact: true }).selectOption('warn');
  await expect(page).toHaveURL(/family=documents/);
  await expect(page).toHaveURL(/severity=warn/);
  await page.reload();
  await expect(page.getByRole('combobox', { name: 'Familie', exact: true })).toHaveValue(
    'documents',
  );
  await expect(page.getByRole('combobox', { name: 'Severitate', exact: true })).toHaveValue('warn');
  const document = page.locator('[data-work-kind="document.unproposed"]', { hasText: 'LUCRU-1' });
  await expect(document).toBeVisible();
  await document.locator('summary').click();
  await expect(document.getByText(/Așteaptă un agent/)).toBeVisible();
  await document.getByRole('link', { name: 'Deschide Documente', exact: true }).click();
  await page
    .locator('.acc-review', { hasText: 'Factură primită LUCRU-1' })
    .getByRole('button', { name: 'Pregătește înregistrarea', exact: true })
    .click();
  await expect(page.getByRole('status')).toContainText('pregătită pentru verificare');

  const proposal = await openProposal(page);
  await expect(proposal.getByRole('link', { name: 'LUCRU-1.xml', exact: true })).toBeVisible();
  await expect(proposal.getByRole('heading', { name: 'Efectul exact', exact: true })).toBeVisible();
  await expect(proposal.getByRole('cell', { name: '628', exact: true })).toBeVisible();
  await expect(proposal.getByRole('cell', { name: '4426', exact: true })).toHaveCSS(
    'white-space',
    'nowrap',
  );
  await expect(proposal.getByRole('heading', { name: 'Factură', exact: true })).toHaveAttribute(
    'class',
    'acc-proposal-title',
  );
  await page.screenshot({ path: info.outputPath('invoice-review.png'), fullPage: true });
  await expect(proposal.locator('code')).toContainText(/^[a-f0-9]{64}$/);
  await approveAndPost(page);
  await expect(page.locator('[data-work-kind^="proposal."]')).toHaveCount(0);
  await page.getByRole('combobox', { name: 'Familie', exact: true }).selectOption('documents');
  await expect(document).toHaveCount(0);
  await expect(
    page.getByText('Niciun element pentru filtrele alese.', { exact: true }),
  ).toBeVisible();
  expect(errors).toEqual([]);
  await Promise.all(reads);
  const snapshot = info.outputPath('engine-worklist.json');
  await writeFile(
    snapshot,
    JSON.stringify([...new Map(observed.map((item) => [item.id, item])).values()], null, 2),
  );
  await info.attach('engine-worklist.json', {
    path: snapshot,
    contentType: 'application/json',
  });
});

test('worklist pages prioritize people, explain access and require a dismissal reason', async ({
  page,
}, info) => {
  const agent = workItem('Extras de explicat', {
    kind: 'bank.unexplained',
    next: [
      {
        operation: 'proposals.propose',
        by: 'agent',
        allowed: true,
        inputHint: { treatment: 'bank.settle', input: { movementId: 'movement' } },
      },
    ],
  });
  const denied = workItem('Plată cu acces restricționat', {
    next: [
      {
        operation: 'proposals.propose',
        by: 'agent',
        allowed: false,
        inputHint: {},
        needs: ['payroll', 'personal', 'health'],
      },
    ],
  });
  const deniedPermission = workItem('Document fără drept de închidere', {
    next: [{ operation: 'work.dispose', by: 'human', allowed: false, inputHint: {} }],
  });
  const decision = workItem('Document de clasat', {
    due: '2026-02-01',
    next: [
      {
        operation: 'work.dispose',
        by: 'human',
        allowed: true,
        inputHint: {
          id: 'Document de clasat',
          fingerprint: 'a'.repeat(64),
          disposition: 'no_booking',
        },
      },
    ],
  });
  const action = workItem('Lună de închis', {
    kind: 'action.awaitingDecision',
    subject: { kind: 'action', id: 'close' },
    next: [
      {
        operation: 'actions.approve',
        by: 'human',
        allowed: true,
        inputHint: { id: 'close', previewHash: 'b'.repeat(64) },
      },
    ],
  });
  const items = [denied, agent, decision, deniedPermission, action];
  const calls: { operation: string; input: Record<string, unknown>; key?: string }[] = [];
  let dismissed = false;
  let approved = false;
  await mockWorklist(page, (operation, input, key) => {
    calls.push({ operation, input, key });
    if (operation === 'work.list') {
      const next = input.after === 'page:2' ? 'page:3' : input.after ? null : 'page:2';
      const found =
        input.after === 'page:2'
          ? []
          : input.after === 'page:3'
            ? [action]
            : [denied, agent, decision, deniedPermission];
      return {
        body: {
          items: found.filter(
            (item) =>
              (!dismissed || item !== decision) &&
              (!approved || item !== action) &&
              (!input.kinds || (input.kinds as string[]).includes(item.kind)),
          ),
          next,
          asOfSeq: 1,
        },
      };
    }
    if (operation === 'work.get')
      return {
        body: {
          state: 'open',
          item: items.find((item) => item.id === input.id),
          disposition: null,
        },
      };
    if (operation === 'actions.get')
      return {
        body: {
          id: 'close',
          previewHash: 'b'.repeat(64),
          preview: {
            month: '2026-01',
            findings: [],
            balances: [{ account: '5121', closing: '1000.00' }],
          },
        },
      };
    if (operation === 'work.dispose') dismissed = true;
    if (operation === 'actions.approve') approved = true;
    return { body: {} };
  });
  await page.goto('/contabilitate');
  await expect(page.locator('.acc-work-message')).toHaveText([
    'Document de clasat',
    'Extras de explicat',
    'Plată cu acces restricționat',
    'Document fără drept de închidere',
  ]);
  await expect(
    page
      .getByRole('region', { name: 'Așteaptă decizia ta', exact: true })
      .locator('.acc-work-message'),
  ).toHaveText(['Document de clasat']);
  await expect(
    page
      .getByRole('region', { name: 'Așteaptă un agent', exact: true })
      .locator('.acc-work-message'),
  ).toHaveText(['Extras de explicat']);
  await expect(
    page
      .getByRole('region', { name: 'Necesită alt acces sau ajutor', exact: true })
      .locator('.acc-work-message'),
  ).toHaveText(['Plată cu acces restricționat', 'Document fără drept de închidere']);
  await expect(
    page.getByText('Lipsește accesul la: date salariale, date personale, date de sănătate.'),
  ).toBeVisible();
  await expect(page.getByText('Lipsește permisiunea pentru „Închide cu motiv”.')).toBeVisible();
  const decisionRow = page.locator('.acc-work-item', { hasText: 'Document de clasat' });
  await expect(decisionRow).toContainText('Termen: 2026-02-01');
  await expect(decisionRow).toContainText('Perioadă: 2026-01');
  await decisionRow.locator('summary').focus();
  await page.keyboard.press('Enter');
  const dismiss = decisionRow.getByRole('button', { name: 'Închide cu motiv', exact: true });
  await dismiss.click();
  expect(calls.filter((call) => call.operation === 'work.dispose')).toHaveLength(0);
  await decisionRow.getByLabel('Motivul închiderii').fill('Nu necesită înregistrare contabilă.');
  await dismiss.click();
  await expect(decisionRow).toHaveCount(0);
  expect(calls.find((call) => call.operation === 'work.dispose')).toMatchObject({
    input: {
      id: decision.id,
      fingerprint: decision.fingerprint,
      disposition: 'no_booking',
      reason: 'Nu necesită înregistrare contabilă.',
    },
    key: expect.any(String),
  });
  await page.getByRole('button', { name: 'Mai multe elemente' }).click();
  await expect.poll(() => calls.some((call) => call.input.after === 'page:2')).toBe(true);
  await page.getByRole('button', { name: 'Mai multe elemente' }).click();
  const actionRow = page.locator('.acc-work-item', { hasText: 'Lună de închis' });
  await actionRow.locator('summary').click();
  await expect(actionRow.getByText('1 000,00 RON', { exact: true })).toBeVisible();
  await actionRow.getByRole('button', { name: 'Aprobă această previzualizare' }).click();
  await expect(actionRow).toHaveCount(0);
  expect(calls.find((call) => call.operation === 'actions.approve')).toMatchObject({
    input: { id: 'close', previewHash: 'b'.repeat(64) },
    key: expect.any(String),
  });
  expect(calls.some((call) => call.operation === 'proposals.propose')).toBe(false);
  await page.getByRole('combobox', { name: 'Familie' }).selectOption('bank');
  await expect(page.locator('.acc-work-message')).toHaveText(['Extras de explicat']);
  await page.getByRole('combobox', { name: 'Severitate' }).selectOption('block');
  await expect
    .poll(() =>
      calls.some((call) => call.operation === 'work.list' && call.input.severity === 'block'),
    )
    .toBe(true);
  await page.goBack();
  await expect(page.getByRole('combobox', { name: 'Severitate' })).toHaveValue('');
  await expect(page.getByRole('button', { name: 'Adaugă documente' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({ path: info.outputPath('worklist.png'), fullPage: true });
});

test('a stale approval reloads the exact version and acknowledgements before posting', async ({
  page,
}, info) => {
  let version = 1;
  let approved = false;
  let posted = false;
  const calls: { operation: string; input: Record<string, unknown> }[] = [];
  const hash = () => (version === 1 ? 'a' : 'b').repeat(64);
  const item = () =>
    workItem('proposal:one', {
      kind: approved ? 'proposal.approved' : 'proposal.awaitingApproval',
      subject: { kind: 'proposal', id: 'one' },
      message: 'Propunere de verificat',
      next: [
        {
          operation: approved ? 'ledger.post' : 'proposals.approve',
          by: approved ? 'agent' : 'human',
          allowed: true,
          inputHint: { proposalId: 'one', version, effectHash: hash(), acknowledge: ['CHECK'] },
        },
      ],
    });
  await mockWorklist(page, (operation, input) => {
    calls.push({ operation, input });
    if (operation === 'work.list')
      return { body: { items: posted ? [] : [item()], next: null, asOfSeq: version } };
    if (operation === 'work.get')
      return {
        body: {
          state: posted ? 'resolved' : 'open',
          item: posted ? null : item(),
          disposition: null,
        },
      };
    if (operation === 'proposals.get')
      return {
        body: {
          id: 'one',
          treatment: 'ledger.general',
          subject: 'opening',
          status: approved ? 'approved' : 'proposed',
          version,
          effectHash: hash(),
          rules: { mode: 'preview', used: [] },
          issues: [
            { code: 'CHECK', severity: 'ack', message: 'Confirmă documentul justificativ.' },
          ],
          effect: {
            date: '2026-01-01',
            description: 'Sold inițial sintetic',
            lines: [
              { account: '5121', side: 'D', amount: '1000.00' },
              { account: '1012', side: 'C', amount: '1000.00' },
            ],
            taxEntries: [],
            explanation: { summary: 'Sold susținut de balanța de deschidere.' },
          },
          input: {},
        },
      };
    if (operation === 'proposals.approve' && version === 1) {
      version = 2;
      return {
        status: 409,
        body: {
          error: {
            code: 'STALE',
            message: 'Pozițiile citite de propunere s-au schimbat. Reîncărcați datele.',
          },
        },
      };
    }
    if (operation === 'proposals.approve') approved = true;
    if (operation === 'ledger.post') posted = true;
    return { body: {} };
  });
  await page.goto('/contabilitate');
  await page.locator('.acc-work-item > summary').click();
  const approve = page.getByRole('button', { name: 'Aprobă această versiune', exact: true });
  await expect(approve).toBeDisabled();
  await page.getByRole('checkbox', { name: 'Confirmă documentul justificativ.' }).focus();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Shift+Tab');
  await expect(
    page.getByRole('checkbox', { name: 'Confirmă documentul justificativ.' }),
  ).toBeFocused();
  await expect(page.locator('.acc-warning label')).toHaveCSS('text-decoration-line', 'underline');
  await expect(page.getByRole('heading', { name: 'Notă contabilă', exact: true })).toHaveJSProperty(
    'tagName',
    'H4',
  );
  await page.getByRole('checkbox', { name: 'Confirmă documentul justificativ.' }).check();
  await approve.click();
  await expect(page.locator('.accounting').getByRole('alert')).toContainText(
    'Registrele s-au schimbat.',
  );
  await expect(page.locator('.acc-review code')).toHaveText('b'.repeat(64));
  await expect(approve).toBeDisabled();
  expect(calls.filter((call) => call.operation === 'work.get').length).toBeGreaterThan(1);
  await page.getByRole('checkbox', { name: 'Confirmă documentul justificativ.' }).check();
  await page.screenshot({ path: info.outputPath('review.png'), fullPage: true });
  await approve.click();
  await page.getByRole('button', { name: 'Contabilizează', exact: true }).click();
  await expect(page.getByText('Nimic nu așteaptă verificare.', { exact: true })).toBeVisible();
  expect(
    calls.filter((call) => call.operation === 'proposals.approve').map((call) => call.input),
  ).toEqual([
    { proposalId: 'one', version: 1, effectHash: 'a'.repeat(64), acknowledge: ['CHECK'] },
    { proposalId: 'one', version: 2, effectHash: 'b'.repeat(64), acknowledge: ['CHECK'] },
  ]);
  expect(calls.find((call) => call.operation === 'ledger.post')?.input).toEqual({
    proposalId: 'one',
    version: 2,
    effectHash: 'b'.repeat(64),
  });
});

test('worklist loading, engine errors and empty state are explicit', async ({ page }) => {
  let release: () => void = () => {};
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  let fail = true;
  await mockWorklist(page, async (operation) => {
    if (operation === 'work.list') {
      await pending;
      return fail
        ? {
            status: 503,
            body: {
              error: {
                code: 'BUSY',
                message: 'Baza de date este ocupată. Reîncercați cu aceeași cheie.',
              },
            },
          }
        : { body: { items: [], next: null, asOfSeq: 1 } };
    }
    return { body: {} };
  });
  await page.goto('/contabilitate');
  await expect(page.getByText('Se încarcă lista…', { exact: true })).toBeVisible();
  release();
  await expect(page.locator('.accounting').getByRole('alert')).toHaveText(
    'Baza de date este ocupată. Reîncercați cu aceeași cheie.',
  );
  fail = false;
  await page.getByRole('button', { name: 'Reîncearcă' }).click();
  await expect(page.getByText('Nimic nu așteaptă verificare.', { exact: true })).toBeVisible();
});

test('browser history keeps the company and its worklist together', async ({ page }) => {
  const reads: string[] = [];
  page.on('request', (request) => {
    if (request.url().endsWith('/capabilities/work.list')) reads.push(request.url());
  });
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
  await expect(page.getByText('Nimic nu așteaptă verificare.')).toBeVisible();
  await page.getByRole('button', { name: 'Registre', exact: true }).click();
  await page.getByRole('button', { name: 'De verificat', exact: true }).click();
  await page.getByRole('combobox', { name: 'Companie', exact: true }).selectOption('company-b');
  await expect(page.getByRole('heading', { name: 'Compania B SRL', exact: true })).toBeVisible();
  await expect.poll(() => reads.at(-1)).toContain('/companies/company-b/');
  await page.goBack();
  await expect(page.getByRole('heading', { name: 'Compania A SRL', exact: true })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole('combobox', { name: 'Companie', exact: true })).toHaveValue(
    'company-a',
  );
  await expect.poll(() => reads.at(-1)).toContain('/companies/company-a/');
});
