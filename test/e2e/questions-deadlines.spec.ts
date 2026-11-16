import { expect, test } from '@playwright/test';
import type { ProposalView } from '../../packages/xfactura-api/source/engine/contracts';
import type { Question } from '../../packages/xfactura-web/components/accounting/questions';
import type { Declaration } from '../../packages/xfactura-web/components/accounting/deadlines';
import type { WorkItem } from '../../packages/xfactura-web/components/accounting/work-model';
import { invoiceXml } from '../../packages/xfactura-api/test/engine/fixtures/invoice';
import { capability, evidence } from './support/books';
import { approveAndPost, signInWithCompany } from './support/session';

test('a vehicle purchase asks a person, retains the answer and is revised by an agent before human approval', async ({
  page,
}, info) => {
  const errors = await signInWithCompany(
    page,
    info,
    'accounting',
    `Vehicul ${info.project.name} SRL`,
  );
  const proof = await evidence(page, 'certificat-tva-sintetic.pdf', 'Certificat sintetic');
  await capability(page, 'profile.record', {
    axis: 'vat.status',
    value: 'normal_vat',
    effectiveFrom: '2026-01-01',
    evidenceId: proof.id,
  });
  const xml = await evidence(
    page,
    'AUTO-10.xml',
    invoiceXml({
      number: 'AUTO-10',
      date: '2026-10-05',
      net: '1500.00',
      tax: '315.00',
      gross: '1815.00',
      lines: [{ rate: '21', net: '1500.00', name: 'Închiriere vehicul B-123-XFA' }],
    }),
    'application/xml',
  );
  const document = await capability<{ id: string }>(page, 'invoices.import', {
    evidenceId: xml.id,
  });
  const agent = await capability<{ token: string }>(page, 'agents.issue', {
    name: 'Agent de pregătire sintetic',
    scopes: [
      'proposals.propose',
      'invoices.recognize.propose',
      'proposals.revise',
      'invoices.recognize.revise',
      'questions.ask',
      'work.list',
    ],
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
  });
  const input = {
    documentId: document.id,
    account: '612',
    deduction: 'limited',
    vehicle: 'B-123-XFA',
  };
  const blocked = await capability<ProposalView>(
    page,
    'proposals.propose',
    { treatment: 'invoices.recognize', input },
    agent.token,
  );
  expect(blocked.status).toBe('blocked');
  const needed = await capability<{ items: WorkItem[] }>(
    page,
    'work.list',
    { kinds: ['question.needed'] },
    agent.token,
  );
  const ask = needed.items
    .find((item) => item.subject.id === blocked.id)!
    .next.find((step) => step.operation === 'questions.ask')!;
  const question = await capability<Question>(page, 'questions.ask', ask.inputHint, agent.token);
  await page.getByRole('button', { name: 'Reîncarcă lista', exact: true }).click();
  await page.getByRole('combobox', { name: 'Familie', exact: true }).selectOption('proposals');
  const work = page.locator('[data-work-kind="question.needed"]');
  await work.locator(':scope > summary').click();
  await work.getByRole('link', { name: 'Deschide întrebarea în Întrebări', exact: true }).click();
  await expect(page).toHaveURL(/view=questions.*question=/);
  const card = page.locator(`[data-question-id="${question.id}"]`);
  await expect(
    card.getByRole('heading', { name: 'Folosirea vehiculului', exact: true }),
  ).toBeFocused();
  await expect(card).toContainText('Agent de pregătire sintetic');
  await expect(card).toContainText('AUTO-10');
  await card
    .getByRole('combobox', { name: 'Folosirea vehiculului', exact: true })
    .selectOption('mixed');
  await card.getByLabel('De la', { exact: true }).fill('2026-01-01');
  await expect(card.getByRole('link', { name: 'AUTO-10.xml', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({ path: info.outputPath('question-form.png'), fullPage: true });
  await card.getByRole('button', { name: 'Păstrează răspunsul', exact: true }).click();
  await expect(card.getByRole('heading', { name: 'Răspuns păstrat', exact: true })).toBeVisible();
  const answered = await capability<{ items: Question[] }>(page, 'questions.list', {
    kind: 'vehicle.use',
  });
  expect(answered.items[0]!.answer?.value).toEqual({ use: 'mixed', from: '2026-01-01' });
  const waiting = await capability<{ items: WorkItem[] }>(
    page,
    'work.list',
    { kinds: ['question.needed'] },
    agent.token,
  );
  const revise = waiting.items
    .find((item) => item.subject.id === blocked.id)!
    .next.find((step) => step.operation === 'proposals.revise')!;
  const revised = await capability<ProposalView>(
    page,
    'proposals.revise',
    revise.inputHint,
    agent.token,
  );
  expect(revised.status).toBe('proposed');
  expect(revised.basis?.answers[0]?.questionId).toBe(question.id);
  await approveAndPost(page);
  const posted = await capability<ProposalView>(page, 'proposals.get', { id: revised.id });
  expect(posted.status).toBe('posted');
  await page.getByRole('button', { name: 'Întrebări', exact: true }).click();
  await page
    .getByRole('combobox', { name: 'Starea întrebării', exact: true })
    .selectOption('answered');
  await expect(page).toHaveURL(/questionStatus=answered/);
  await card.getByRole('link', { name: 'Vezi răspunsul', exact: true }).click();
  await expect(card.getByRole('link', { name: 'AUTO-10.xml', exact: true })).toBeVisible();
  await expect(
    card.locator(`a[href$="/evidence/${answered.items[0]!.answer!.evidenceId}"]`),
  ).toHaveText(/^raspuns-.*\.json$/);
  await page.screenshot({ path: info.outputPath('questions.png'), fullPage: true });
  expect(errors).toEqual([]);
});

test('a VAT deadline prepares D300, shows the validator response and retains the reached stages', async ({
  page,
}, info) => {
  const errors = await signInWithCompany(
    page,
    info,
    'accounting',
    `Declarații ${info.project.name} SRL`,
    '18547290',
  );
  const proof = await evidence(page, 'profil-sintetic.pdf', 'Profil sintetic');
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
  await capability(page, 'sales.seller.record', {
    details: {
      name: 'Declarații Sintetice SRL',
      vatId: 'RO18547290',
      address: {
        lines: ['Str. Exemplului 10'],
        city: 'Galați',
        subdivision: 'RO-GL',
        country: 'RO',
      },
    },
  });
  await page.getByRole('button', { name: 'Reîncarcă lista', exact: true }).click();
  await page.getByRole('combobox', { name: 'Familie', exact: true }).selectOption('deadlines');
  const work = page
    .locator('[data-work-kind="obligation.due"]')
    .filter({ hasText: 'Decontul de TVA (D300) pentru octombrie 2026' });
  await work.locator(':scope > summary').click();
  await work.getByRole('link', { name: 'Deschide declarația în Termene', exact: true }).click();
  await expect(page).toHaveURL(/view=deadlines/);
  const card = page.locator('[data-return="D300|2026-10"]');
  await expect(card).toContainText('2026-11-25');
  await expect(card).toContainText('Regula obligației');
  await page.getByLabel('Luna încheierii perioadei', { exact: true }).fill('2026-10');
  await card.locator(':scope > summary').click();
  await card.getByLabel('Nume declarant', { exact: true }).fill('Popescu');
  await card.getByLabel('Prenume declarant', { exact: true }).fill('Ana');
  await card.getByLabel('Funcția declarantului', { exact: true }).fill('Administrator');
  await card.getByLabel('Cod CAEN', { exact: true }).fill('6201');
  await card.getByLabel('Bancă', { exact: true }).fill('Banca Exemplu');
  await card.getByLabel('Cont bancar', { exact: true }).fill('RO49AAAA1B31007593840000');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({ path: info.outputPath('declaration-form.png'), fullPage: true });
  const preparation = page.waitForResponse((response) =>
    response.url().endsWith('/capabilities/declarations.prepare'),
  );
  await card.getByRole('button', { name: 'Pregătește declarația', exact: true }).click();
  const response = await preparation;
  expect(response.ok(), await response.text()).toBe(true);
  const prepared = (await response.json()) as Declaration;
  await expect(card.locator('[data-declaration-state="prepared"]')).toBeVisible();
  if (prepared.state === 'prepared') {
    const validation = page.waitForResponse((response) =>
      response.url().endsWith('/capabilities/declarations.validate'),
    );
    await card.getByRole('button', { name: 'Validează cu validatorul ANAF', exact: true }).click();
    const result = await validation;
    if (result.ok()) {
      const validated = (await result.json()) as Declaration;
      await expect(card.locator(`[data-declaration-state="${validated.state}"]`)).toBeVisible();
    } else {
      const resultBody = (await result.json()) as { error: { code: string; message: string } };
      expect(['VALIDATOR_UNAVAILABLE', 'NO_OFFICIAL_VALIDATOR']).toContain(resultBody.error.code);
      await expect(card.getByRole('alert')).toContainText(resultBody.error.message);
      test.info().annotations.push({
        type: 'official-validator',
        description: `${resultBody.error.code}: ${resultBody.error.message}`,
      });
    }
  } else await expect(card.locator(`[data-declaration-state="${prepared.state}"]`)).toBeVisible();
  await expect(card.getByText('Persoană neindicată de motor', { exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath('deadlines.png'), fullPage: true });
  const retained = await capability<{ items: Declaration[] }>(page, 'declarations.list');
  expect(retained.items.find((artifact) => artifact.id === prepared.id)?.steps[0]?.state).toBe(
    'prepared',
  );
  expect(errors).toEqual([]);
});
