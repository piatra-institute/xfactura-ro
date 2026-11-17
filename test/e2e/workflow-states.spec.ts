import { expect, test, type Page } from '@playwright/test';
import type { Declaration } from '../../packages/xfactura-web/components/accounting/deadlines';
import type { Question } from '../../packages/xfactura-web/components/accounting/questions';
import type { ActionView } from '../../packages/xfactura-api/source/engine/contracts';
import { mockWorklist } from './support/worklist';
import { openSection, typeDate } from './support/shell';

const capabilities = [
  'questions.list',
  'questions.answer',
  'questions.withdraw',
  'proposals.list',
  'proposals.get',
  'obligations.calendar',
  'declarations.list',
  'declarations.prepare',
  'declarations.validate',
  'declarations.authorize.request',
  'declarations.pdf',
  'declarations.importSigned',
  'declarations.recordSubmission',
  'declarations.recordOutcome',
  'declarations.reopen.request',
  'actions.get',
  'actions.list',
  'actions.approve',
  'actions.execute',
  'company.members',
  'agents.list',
  'evidence.record',
  'parties.get',
  'documents.get',
  'rules.parameters',
];
const common = {
  'capabilities.list': { capabilities: capabilities.map((id) => ({ id })) },
  'company.members': { items: [{ userId: 'person', name: 'Ana Sintetică' }], next: null },
  'agents.list': { items: [{ id: 'agent', name: 'Agent sintetic' }], next: null },
};
const question = (id: string, changes: Partial<Question> = {}): Question => ({
  id,
  kind: 'vehicle.use',
  subject: { kind: 'vehicle', id: 'B123XFA' },
  params: {},
  prompt: 'Vehiculul B123XFA este folosit exclusiv pentru activitatea economică?',
  status: 'open',
  askedBy: 'person',
  agentId: 'agent',
  createdAt: '2026-01-01T09:00:00Z',
  due: null,
  answer: null,
  ...changes,
});
const answer = {
  id: 'answer',
  value: { use: 'mixed', from: '2026-01-01' },
  evidenceId: 'answer-evidence',
  answeredBy: 'person',
  at: '2026-01-02T09:00:00Z',
};
const obligation = {
  kind: 'D100',
  period: '2026-01',
  deadline: 'D100.micro',
  start: '2026-01-01',
  end: '2026-01-31',
  due: '2026-02-25',
  nominal: '2026-02-25',
  status: 'overdue',
  artifactId: null as string | null,
  versions: ['deadline-version'],
  gap: null,
  conflict: null,
  basis: {
    rule: 'Regula sintetică a obligației',
    facts: ['Fapt sintetic păstrat'],
    clauses: ['Clauza sintetică a obligației'],
  },
  blockers: [],
  waiting: null,
};

test('questions retain pagination, open-first chronology, filters, names and unsupported schemas', async ({
  page,
}) => {
  const first = question('old-answered', { status: 'answered', answer });
  const second = question('new-open', {
    createdAt: '2026-02-01T00:00:00Z',
    subject: { kind: 'party', id: '00000000-0000-4000-8000-000000000001' },
    prompt: 'Întrebare despre 00000000-0000-4000-8000-000000000001',
  });
  const third = question('old-open', {
    createdAt: '2026-01-02T00:00:00Z',
    kind: 'payroll.absences',
    params: { month: '2026-01' },
  });
  const withdrawn = question('withdrawn', { status: 'withdrawn' });
  const cursors: unknown[] = [];
  await mockWorklist(
    page,
    (operation, input) => {
      if (operation === 'questions.list') {
        cursors.push(input.after);
        return {
          body: {
            items: input.after ? [third, withdrawn] : [first, second],
            next: input.after ? null : 'page2',
          },
        };
      }
      if (operation === 'proposals.list') return { body: { items: [], next: null } };
      if (operation === 'parties.get') return { body: { name: 'Furnizor Sintetic SRL' } };
      return { body: { items: [], next: null } };
    },
    common,
  );
  await page.goto('/contabilitate?view=questions');
  await expect(page.locator('[data-question-id]')).toHaveCount(4);
  expect(
    await page
      .locator('[data-question-id]')
      .evaluateAll((rows) => rows.map((row) => row.getAttribute('data-question-id'))),
  ).toEqual(['old-open', 'new-open', 'old-answered', 'withdrawn']);
  expect(cursors).toContain('page2');
  await expect(
    page.getByText('Întrebare despre Furnizor Sintetic SRL', { exact: true }),
  ).toBeVisible();
  await page
    .locator('[data-question-id="old-open"]')
    .getByRole('link', { name: 'Răspunde la întrebare', exact: true })
    .click();
  await expect(
    page.getByText(
      'Schema acestui tip de întrebare nu poate fi redată prin câmpurile disponibile. Răspunsul nu poate fi introdus în această interfață.',
      { exact: true },
    ),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Păstrează răspunsul', exact: true })).toHaveCount(
    0,
  );
  await expect(page.locator('textarea')).toHaveCount(0);
  await page
    .getByRole('combobox', { name: 'Starea întrebării', exact: true })
    .selectOption('withdrawn');
  await expect(page).toHaveURL(/questionStatus=withdrawn/);
  await page.reload();
  await expect(page.locator('[data-question-id]')).toHaveCount(1);
  await openSection(page, 'Declarații');
  await expect(page).not.toHaveURL(/questionStatus=|question=/);
});

test('answer money reaches the engine verbatim and engine validation stays visible', async ({
  page,
}) => {
  const item = question('leave', {
    kind: 'leave.untaken',
    subject: { kind: 'company', id: 'company' },
    params: { year: 2026 },
    prompt: 'Ce concedii au rămas neefectuate?',
  });
  const values: unknown[] = [];
  await mockWorklist(
    page,
    (operation, input) => {
      if (operation === 'questions.list') return { body: { items: [item], next: null } };
      if (operation === 'proposals.list') return { body: { items: [], next: null } };
      if (operation === 'questions.answer') {
        values.push(input.value);
        return {
          status: 422,
          body: { error: { code: 'VALIDATION', message: 'Valoarea introdusă nu este validă.' } },
        };
      }
      return { body: { items: [], next: null } };
    },
    {
      ...common,
      'evidence.list': { items: [{ id: 'proof', filename: 'calcul-concedii.pdf' }], next: null },
    },
  );
  await page.goto('/contabilitate?view=questions&question=leave');
  await page.getByLabel('Zile de concediu neefectuate', { exact: true }).fill('2');
  await page.getByLabel('Indemnizație (lei)', { exact: true }).fill(' 12,34 ');
  await page.getByLabel('Contribuții (lei)', { exact: true }).fill('0.50');
  await page
    .getByRole('combobox', { name: 'Sumă calculată pe statele de salarii', exact: true })
    .selectOption('true');
  await page
    .getByRole('combobox', { name: 'Document justificativ', exact: true })
    .selectOption('proof');
  await page.getByRole('button', { name: 'Păstrează răspunsul', exact: true }).click();
  const error = page.locator('.acc-question-body form').getByRole('alert');
  await expect(error).toHaveText('Valoarea introdusă nu este validă.');
  await expect(error).toBeFocused();
  await expect(page.getByLabel('Indemnizație (lei)', { exact: true })).toHaveValue(' 12,34 ');
  expect(values).toEqual([
    { days: 2, amount: ' 12,34 ', contributions: '0.50', measured: true, evidenceId: 'proof' },
  ]);
});

test('a changed answer rechecks citations and reports engine-marked stale proposals', async ({
  page,
}) => {
  let item = question('vehicle', { status: 'answered', answer });
  let changed = false;
  let rechecks = 0;
  const proposal = {
    id: 'proposal',
    treatment: 'invoices.recognize',
    version: 2,
    status: 'proposed',
    basis: { answers: [{ questionId: item.id }] },
    issues: [],
    effect: { description: 'Factura AUTO-1' },
  };
  await mockWorklist(
    page,
    (operation, input) => {
      if (operation === 'questions.list') return { body: { items: [item], next: null } };
      if (operation === 'proposals.list') return { body: { items: [proposal], next: null } };
      if (operation === 'questions.answer') {
        changed = true;
        item = { ...item, answer: { ...answer, id: 'answer-2', value: input.value } };
        return { body: item };
      }
      if (operation === 'proposals.get') {
        rechecks++;
        expect(changed).toBe(true);
        expect(input.recheck).toBe(true);
        return {
          body: {
            ...proposal,
            status: 'stale',
            check: { stale: true, changed: [{ kind: 'answer', id: item.id }] },
          },
        };
      }
      return { body: { items: [], next: null } };
    },
    common,
  );
  await page.goto('/contabilitate?view=questions&question=vehicle');
  await page
    .getByRole('combobox', { name: 'Folosirea vehiculului', exact: true })
    .selectOption('mixed');
  await typeDate(page, 'De la', '03.01.2026');
  await page.getByRole('button', { name: 'Păstrează răspunsul', exact: true }).click();
  await expect(
    page.getByText(
      'Răspunsul a schimbat propunerile care îl citează. Motorul le marchează ca depășite; este necesară revizuirea lor.',
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    page.getByRole('link', { name: 'Deschide De verificat', exact: true }),
  ).toBeVisible();
  expect(rechecks).toBe(1);
});

test('an unanswered question is withdrawn with the entered reason', async ({ page }) => {
  let item = question('withdraw');
  let entered: unknown;
  await mockWorklist(
    page,
    (operation, input) => {
      if (operation === 'questions.list') return { body: { items: [item], next: null } };
      if (operation === 'questions.withdraw') {
        entered = input.reason;
        item = { ...item, status: 'withdrawn' };
        return { body: item };
      }
      return { body: { items: [], next: null } };
    },
    common,
  );
  await page.goto('/contabilitate?view=questions&question=withdraw');
  await page.getByText('Retrage întrebarea', { exact: true }).click();
  const reason = '  Întrebarea dublează documentul păstrat.  ';
  await page.getByLabel('Motivul retragerii', { exact: true }).fill(reason);
  await page.getByRole('button', { name: 'Retrage întrebarea fără răspuns', exact: true }).click();
  await expect(page.locator('.acc-status')).toHaveText('Retrasă');
  expect(entered).toBe(reason);
  await expect(page.getByRole('button', { name: 'Păstrează răspunsul', exact: true })).toHaveCount(
    0,
  );
});

test('question and deadline reads show loading, empty and retryable error states', async ({
  page,
}) => {
  let resolve: (value: { body: unknown }) => void = () => {};
  let first = true;
  let failed = false;
  const pending = new Promise<{ body: unknown }>((done) => {
    resolve = done;
  });
  await mockWorklist(
    page,
    (operation) => {
      if (operation === 'questions.list') {
        if (first) {
          first = false;
          return pending;
        }
        return { status: 503, body: { error: { message: 'Întrebările nu pot fi citite.' } } };
      }
      if (operation === 'obligations.calendar')
        return failed
          ? { status: 503, body: { error: { message: 'Calendar indisponibil.' } } }
          : { body: { items: [], next: null } };
      return { body: { items: [], next: null } };
    },
    common,
  );
  await page.goto('/contabilitate?view=questions');
  await expect(page.getByText('Se încarcă întrebările…', { exact: true })).toBeVisible();
  resolve({ body: { items: [], next: null } });
  await expect(page.getByText('Nu sunt întrebări.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Reîncarcă întrebările', exact: true }).click();
  await expect(page.locator('.acc-content').getByRole('alert')).toContainText(
    'Întrebările nu pot fi citite.',
  );
  await expect(page.getByText('Nu sunt întrebări.', { exact: true })).toHaveCount(0);
  await openSection(page, 'Declarații');
  await expect(
    page.getByText('Nimic de depus pentru perioadele alese.', { exact: true }),
  ).toBeVisible();
  failed = true;
  await page.getByRole('button', { name: 'Reîncarcă termenele', exact: true }).click();
  await expect(page.locator('.acc-content').getByRole('alert')).toContainText(
    'Calendar indisponibil.',
  );
});

for (const code of ['FORMAT_GAP', 'RULE_GAP', 'UNSUPPORTED'])
  test(`${code} blocks preparation with the engine text`, async ({ page }) => {
    await mockWorklist(
      page,
      (operation) => {
        if (operation === 'obligations.calendar')
          // D398 accepts empty options; D100's required declarant has no collector in this view.
          return {
            body: { items: [{ ...obligation, kind: 'D398', period: '2026-Q1' }], next: null },
          };
        if (operation === 'declarations.prepare')
          return {
            status: 422,
            body: { error: { code, message: `Explicația motorului pentru ${code}.` } },
          };
        return { body: { items: [], next: null } };
      },
      common,
    );
    await page.goto('/contabilitate?view=deadlines&return=D398%7C2026-Q1');
    await page.getByRole('button', { name: 'Pregătește declarația', exact: true }).click();
    await expect(page.locator('.acc-return-life').getByRole('alert')).toHaveText(
      `${code}: Explicația motorului pentru ${code}.`,
    );
    await expect(page.locator('.acc-work-meta .acc-error')).toContainText('2026-02-25');
  });

async function mockLifecycle(page: Page, stale = false) {
  const artifact: Declaration = {
    id: 'artifact',
    kind: 'D100',
    period: '2026-01',
    format: 'Format sintetic',
    state: stale ? 'validated_official' : 'prepared',
    evidenceId: 'xml',
    xmlHash: 'a'.repeat(64),
    supersedesId: null,
    steps: [
      {
        state: 'prepared',
        actor: null,
        detail: '{"amount":"100.01"}',
        evidenceId: null,
        at: '2026-02-01T09:00:00Z',
      },
    ],
  };
  const actions: ActionView[] = [];
  const writes: { operation: string; input: Record<string, unknown> }[] = [];
  const step = (
    state: string,
    detail: string | null = null,
    evidenceId: string | null = null,
    actor: string | null = null,
  ) => {
    artifact.state = state;
    artifact.steps.push({ state, detail, evidenceId, actor, at: '2026-02-02T09:00:00Z' });
  };
  await mockWorklist(
    page,
    (operation, input) => {
      if (operation === 'obligations.calendar')
        return {
          body: {
            items: [{ ...obligation, artifactId: artifact.id, status: 'prepared' }],
            next: null,
          },
        };
      if (operation === 'declarations.list') return { body: { items: [artifact], next: null } };
      if (operation === 'rules.parameters')
        return {
          body: {
            items: [
              {
                id: 'deadline-version',
                citations: [
                  {
                    source: 'Sursă sintetică',
                    locator: 'Articol sintetic',
                    clause: 'Clauză sintetică',
                  },
                ],
              },
            ],
            next: null,
          },
        };
      if (operation === 'actions.list') return { body: { items: actions, next: null } };
      if (operation === 'actions.get')
        return { body: actions.find((action) => action.id === input.id) };
      writes.push({ operation, input });
      if (operation === 'declarations.validate') {
        step('validated_official', null, null, 'Validator sintetic');
        return { body: artifact };
      }
      if (
        operation === 'declarations.authorize.request' ||
        operation === 'declarations.reopen.request'
      ) {
        const action: ActionView = {
          id: `action-${actions.length}`,
          operation: operation.replace('.request', ''),
          input: { artifactId: artifact.id },
          preview: {
            artifactId: artifact.id,
            kind: artifact.kind,
            period: artifact.period,
            xmlHash: artifact.xmlHash,
            findings: [],
          },
          previewHash: 'b'.repeat(64),
          status: 'requested',
          result: null,
        };
        actions.push(action);
        return { body: action };
      }
      if (operation === 'actions.approve') {
        if (stale)
          return {
            status: 409,
            body: { error: { code: 'STALE', message: 'Registrele s-au schimbat de la cerere.' } },
          };
        actions.find((action) => action.id === input.id)!.status = 'approved';
        return { body: actions.at(-1) };
      }
      if (operation === 'actions.execute') {
        const action = actions.find((action) => action.id === input.id)!;
        action.status = 'executed';
        if (action.operation === 'declarations.authorize') step('authorized');
        return { body: action };
      }
      if (operation === 'declarations.pdf') {
        step('exported_for_signing', null, 'pdf', 'Validator sintetic');
        return { body: artifact };
      }
      if (operation === 'declarations.importSigned')
        step('signed_imported', null, String(input.evidenceId));
      if (operation === 'declarations.recordSubmission')
        step(
          'submitted',
          `Depusă la ${input.submittedOn}.`,
          String(input.receiptEvidenceId),
          String(input.registrationNumber),
        );
      if (operation === 'declarations.recordOutcome')
        step(String(input.outcome), String(input.detail), String(input.evidenceId));
      return { body: { artifactId: artifact.id } };
    },
    {
      ...common,
      'evidence.list': {
        items: [
          { id: 'xml', filename: 'D100.xml' },
          { id: 'pdf', filename: 'D100.pdf' },
          { id: 'uploaded', filename: 'recipisa.pdf' },
        ],
        next: null,
      },
    },
  );
  await page.route('**/evidence', (route) => route.fulfill({ json: { id: 'uploaded' } }));
  await page.route('**/evidence/pdf', (route) =>
    route.fulfill({ contentType: 'application/pdf', body: '%PDF-1.4\n%%EOF' }),
  );
  return { artifact, writes };
}

test('a return follows exact-preview authorization, PDF download, signed import, receipts and reviewed reopening', async ({
  page,
}, info) => {
  const { artifact, writes } = await mockLifecycle(page);
  await page.goto('/contabilitate?view=deadlines&return=D100%7C2026-01');
  await expect(
    page.getByText('Sursă sintetică · Articol sintetic · Clauză sintetică', { exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Validează cu validatorul ANAF', exact: true }).click();
  await page.getByRole('button', { name: 'Cere previzualizarea autorizării', exact: true }).click();
  await page.getByRole('button', { name: 'Aprobă autorizarea acestui XML', exact: true }).click();
  await page.getByRole('button', { name: 'Autorizează declarația', exact: true }).click();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Descarcă PDF-ul pentru semnare', exact: true }).click();
  expect((await download).suggestedFilename()).toBe('D100-2026-01.pdf');
  await page.getByLabel('PDF semnat', { exact: true }).setInputFiles({
    name: 'semnat.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from('%PDF-synthetic'),
  });
  await page
    .getByRole('button', { name: 'Păstrează și importă PDF-ul semnat', exact: true })
    .click();
  await page.getByLabel('Număr de înregistrare', { exact: true }).fill('REG-SINTETIC');
  await typeDate(page, 'Data depunerii', '03.02.2026');
  await page.getByLabel('Recipisa depunerii', { exact: true }).setInputFiles({
    name: 'recipisa.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from('Recipisă sintetică'),
  });
  await page
    .getByRole('button', { name: 'Înregistrează depunerea și recipisa', exact: true })
    .click();
  await page.getByRole('combobox', { name: 'Răspuns ANAF', exact: true }).selectOption('accepted');
  await page.getByLabel('Documentul răspunsului ANAF', { exact: true }).setInputFiles({
    name: 'acceptare.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from('Acceptare sintetică'),
  });
  await page.getByLabel('Mesajul ANAF (opțional)', { exact: true }).fill('Declarație acceptată.');
  await page.getByRole('button', { name: 'Înregistrează răspunsul ANAF', exact: true }).click();
  await expect(page.locator('[data-declaration-state]')).toHaveCount(7);
  await page.getByText('Redeschide perioada pentru corectare', { exact: true }).click();
  await page
    .getByLabel('Motivul redeschiderii', { exact: true })
    .fill('Corectarea documentului justificativ.');
  await page
    .getByRole('button', { name: 'Cere previzualizarea redeschiderii', exact: true })
    .click();
  await page.getByRole('button', { name: 'Aprobă redeschiderea', exact: true }).click();
  await page.getByRole('button', { name: 'Redeschide perioada', exact: true }).click();
  expect(
    writes.filter((write) => write.operation === 'actions.approve').map((write) => write.input),
  ).toEqual([
    { id: 'action-0', previewHash: 'b'.repeat(64) },
    { id: 'action-1', previewHash: 'b'.repeat(64) },
  ]);
  expect(writes.find((write) => write.operation === 'declarations.importSigned')?.input).toEqual({
    artifactId: artifact.id,
    evidenceId: 'uploaded',
  });
  expect(
    writes.find((write) => write.operation === 'declarations.recordSubmission')?.input,
  ).toMatchObject({
    registrationNumber: 'REG-SINTETIC',
    submittedOn: '2026-02-03',
    receiptEvidenceId: 'uploaded',
  });
  expect(
    writes.some(
      (write) => write.operation.includes('spv.') || write.operation === 'declarations.authorize',
    ),
  ).toBe(false);
  await page.screenshot({ path: info.outputPath('declaration-life.png'), fullPage: true });
});

test('a stale declaration authorization cannot be approved again until a new preview is requested', async ({
  page,
}) => {
  await mockLifecycle(page, true);
  await page.goto('/contabilitate?view=deadlines&return=D100%7C2026-01');
  await page.getByRole('button', { name: 'Cere previzualizarea autorizării', exact: true }).click();
  const approve = page.getByRole('button', { name: 'Aprobă autorizarea acestui XML', exact: true });
  await approve.click();
  await expect(
    page.getByText(
      'Previzualizarea este depășită. Solicită o previzualizare nouă înainte de a continua.',
      { exact: true },
    ),
  ).toBeVisible();
  await expect(approve).toBeDisabled();
  await page.getByRole('button', { name: 'Cere previzualizarea autorizării', exact: true }).click();
  await expect(approve).toBeEnabled();
});
