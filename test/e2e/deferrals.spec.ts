import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { invoiceXml } from '../../packages/xfactura-api/test/accounting/fixtures/invoice';

test('reviews a subscription schedule and next-year allocation, with a keyboard link to the original invoice', async ({
  page,
}, info) => {
  const origin = 'http://localhost:3100',
    request = page.request;
  expect(
    (
      await request.post('/api/accounting/auth/sign-in/email', {
        headers: { origin },
        data: {
          email: `deferrals-${info.project.name}@example.test`,
          password: 'synthetic-browser-password',
        },
      })
    ).status(),
  ).toBe(200);
  const created = await request.post('/api/accounting/v1/companies', {
    headers: { origin, 'idempotency-key': randomUUID() },
    data: { name: `Abonamente ${info.project.name} SRL`, cui: '12345678', year: 2025 },
  });
  expect(created.status()).toBe(200);
  const companyId = (await created.json()).id,
    base = `/api/accounting/v1/companies/${companyId}`;
  async function invoke(id: string, input: unknown, token?: string) {
    const response = await request.post(`${base}/capabilities/${id}`, {
      headers: {
        origin,
        'idempotency-key': randomUUID(),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      data: input,
    });
    expect(response.status(), await response.text()).toBe(200);
    return response.json();
  }
  async function source(filename: string, contents: string) {
    return invoke('evidence.record', {
      filename,
      mediaType: filename.endsWith('.xml') ? 'application/xml' : 'text/plain',
      base64: Buffer.from(contents).toString('base64'),
    });
  }
  async function post(proposal: { id: string; version: number; hash: string }) {
    const input = { id: proposal.id, version: proposal.version, hash: proposal.hash };
    await invoke('books.approve', input);
    await invoke('ledger.post', input);
  }
  const proof = await source(
      'contract-abonament.txt',
      'Uniform monthly subscription from January through March 2026, agreed on 1 December 2025',
    ),
    years = await invoke('years.list', {}),
    year = years.find((row: { kind: string }) => row.kind === 'financial');
  for (const input of [
    { axis: 'vat', value: 'normal_vat' },
    { axis: 'vat_collection', value: 'no' },
  ])
    await invoke('regimes.record', { ...input, effectiveFrom: '2025-01-01', evidenceId: proof.id });
  await post(
    await invoke('ledger.propose', {
      financialYearId: year.id,
      evidenceId: proof.id,
      date: '2025-01-01',
      purpose: 'opening',
      description: 'Solduri inițiale',
      sourceReference: 'opening',
      lines: [
        { account: '5121', debit: '1000.00', credit: '0.00' },
        { account: '1012', debit: '0.00', credit: '1000.00' },
      ],
    }),
  );
  const xml = await source(
      'abonament.xml',
      invoiceXml({ number: 'ABONAMENT-2026', date: '2025-12-10' }),
    ),
    invoice = await invoke('invoices.import', { evidenceId: xml.id }),
    grant = await invoke('agents.issue', {
      name: 'Subscription preparation agent',
      scopes: [
        'deferrals.proposeInvoice',
        'deferrals.proposeRelease',
        'deferrals.proposeCreditNote',
        'deferrals.proposeDiscount',
        'deferrals.proposeReschedule',
        'deferrals.proposeScopeReduction',
        'deferrals.proposeSupplement',
      ],
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
    });
  const root = await invoke(
    'deferrals.proposeInvoice',
    {
      financialYearId: year.id,
      invoiceId: invoice.id,
      recognitionDate: '2025-12-10',
      evidenceId: proof.id,
      taxPointBasis: 'early_invoice',
      account: '628',
      deduction: 'full',
      counterpartyVatCollection: 'no',
      basis: 'uniform_subscription',
      method: 'equal_calendar_months',
      serviceFrom: '2026-01-01',
      serviceTo: '2026-03-31',
      evidenceDate: '2025-12-01',
      reason: 'Abonament uniform pe trei luni, documentat prin contractul furnizorului',
    },
    grant.token,
  );
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`/contabilitate?company=${companyId}&financialYearId=${year.id}`);
  const card = page.locator('.acc-review'),
    plan = card.getByRole('table', { name: 'Plan de alocare', exact: true }),
    effects = card.getByRole('table', { name: 'Efect contabil propus' });
  await expect(plan.locator('tbody tr')).toHaveCount(3);
  await expect(plan).toContainText('2026-01-31');
  await expect(plan).toContainText('33,34');
  await expect(card).toContainText('Perioada abonamentului');
  await expect(card).toContainText('Lunar, în cote egale');
  await expect(card).toContainText('2025-12-10');
  await expect(effects).toContainText('471');
  await expect(effects).toContainText('4426');
  await expect(effects).not.toContainText('628');
  expect((await request.get(`${base}/evidence/${proof.id}`)).status()).toBe(200);
  await page.screenshot({
    path: info.outputPath(`subscription-schedule-${info.project.name}.png`),
    fullPage: true,
  });
  await card.getByRole('button', { name: 'Aprobă această versiune', exact: true }).click();
  await card.getByRole('button', { name: 'Contabilizează', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('contabilizată');
  const nextYear = await invoke('years.create', {
    kind: 'financial',
    label: '2026',
    from: '2026-01-01',
    to: '2026-12-31',
  });
  await post(
    await invoke('ledger.propose', {
      financialYearId: nextYear.id,
      evidenceId: proof.id,
      date: '2026-01-01',
      purpose: 'opening',
      description: 'Solduri reportate din 2025',
      sourceReference: 'opening2026',
      lines: [
        { account: '5121', debit: '1000.00', credit: '0.00' },
        { account: '471', debit: '100.00', credit: '0.00' },
        { account: '4426', debit: '21.00', credit: '0.00' },
        { account: '401', debit: '0.00', credit: '121.00' },
        { account: '1012', debit: '0.00', credit: '1000.00' },
      ],
    }),
  );
  await invoke(
    'deferrals.proposeRelease',
    { financialYearId: nextYear.id, deferralId: root.id, month: '2026-01-01' },
    grant.token,
  );
  await page.goto(`/contabilitate?company=${companyId}&financialYearId=${nextYear.id}`);
  await expect(card).toContainText('Luna alocată');
  await expect(card).toContainText('2026-01');
  await expect(card).toContainText('Cheltuială recunoscută');
  await expect(effects.locator('tbody tr')).toHaveCount(2);
  await expect(effects).toContainText('628');
  await expect(effects).toContainText('471');
  await expect(effects).not.toContainText('4426');
  await page.screenshot({
    path: info.outputPath(`subscription-allocation-${info.project.name}.png`),
    fullPage: true,
  });
  const sourceButton = card.getByRole('button', {
    name: /ABONAMENT-2026|Factura originală/,
    exact: true,
  });
  await sourceButton.focus();
  await page.keyboard.press('Enter');
  const original = page.locator('.acc-journal').filter({ hasText: 'ABONAMENT-2026' });
  await expect(original).toHaveAttribute('open', '');
  await expect(original.locator('summary')).toBeFocused();
  await expect(page.getByLabel('Exercițiu financiar')).toHaveValue(year.id);
  await expect(original.getByRole('table', { name: 'Plan de alocare', exact: true })).toContainText(
    '33,34',
  );
  await page.goto(`/contabilitate?company=${companyId}&financialYearId=${nextYear.id}`);
  await card.getByRole('button', { name: 'Aprobă această versiune', exact: true }).click();
  await card.getByRole('button', { name: 'Contabilizează', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('contabilizată');
  expect(await invoke('deferrals.get', { id: root.id, date: '2026-01-31' })).toMatchObject({
    allocated: '33.33',
    remaining: '66.67',
  });
  expect(
    await invoke('deferrals.reconcile', { financialYearId: nextYear.id, date: '2026-01-31' }),
  ).toMatchObject({ status: 'reconciled' });
  expect(await invoke('vat.summary', { financialYearId: nextYear.id })).toMatchObject({
    totals: { inputTax: '0.00', outputTax: '0.00' },
  });
  const obsolete = await invoke(
    'deferrals.proposeRelease',
    { financialYearId: nextYear.id, deferralId: root.id, month: '2026-02-01' },
    grant.token,
  );
  await invoke('books.approve', {
    id: obsolete.id,
    version: obsolete.version,
    hash: obsolete.hash,
  });
  const calendarAgreement = await source(
    'acord-calendar.txt',
    'New agreement extends the remaining uniform subscription through April; price and VAT unchanged',
  );
  const calendarInput = {
    financialYearId: nextYear.id,
    deferralId: root.id,
    date: '2026-02-01',
    effectiveFrom: '2026-02-01',
    serviceTo: '2026-04-30',
    evidenceId: calendarAgreement.id,
    evidenceDate: '2026-02-01',
    method: 'equal_calendar_months',
    priceUnchanged: true,
    reason: 'Acord pentru prelungirea serviciilor viitoare până la sfârșitul lunii aprilie',
  };
  const calendar = await invoke('deferrals.proposeReschedule', calendarInput, grant.token);
  await page.reload();
  const calendarCard = page.locator('[data-review-kind="reschedule"]');
  await expect(
    calendarCard.getByRole('table', { name: 'Calendar de alocare' }).locator('tbody tr'),
  ).toHaveCount(4);
  await expect(calendarCard).toContainText('22,23');
  await expect(calendarCard.getByRole('link', { name: 'acord-calendar.txt' })).toHaveAttribute(
    'href',
    `${base}/evidence/${calendarAgreement.id}`,
  );
  await page.screenshot({
    path: info.outputPath(`subscription-calendar-${info.project.name}.png`),
    fullPage: true,
  });
  await calendarCard.getByRole('button', { name: 'ABONAMENT-2026', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(original).toHaveAttribute('open', '');
  await expect(original.locator('summary')).toBeFocused();
  await page.goto(`/contabilitate?company=${companyId}&financialYearId=${nextYear.id}`);
  await calendarCard.getByRole('button', { name: 'Aprobă acest plan', exact: true }).click();
  await calendarCard.getByRole('button', { name: 'Aplică planul', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Calendarul de alocare a fost actualizat');
  await expect(calendarCard).toHaveCount(0);
  expect(await invoke('proposals.get', { id: obsolete.id })).toMatchObject({
    superseded: true,
    posted: false,
  });
  expect(await invoke('deferrals.get', { id: root.id, date: '2026-04-30' })).toMatchObject({
    remaining: '66.67',
    serviceTo: '2026-04-30',
    reschedule: { id: calendar.id, version: 1 },
  });
  await page.getByRole('button', { name: 'Registre', exact: true }).click();
  await page.getByText('Modificări ale calendarelor de alocare', { exact: true }).click();
  await page.getByText('2026-02-01 · ABONAMENT-2026 · plan 1', { exact: true }).click();
  await expect(page.getByRole('table', { name: 'Calendar de alocare' })).toContainText('22,23');
  const declinedProof = await source(
    'acord-retras.txt',
    'An alternative extension was withdrawn by both parties before it was accepted',
  );
  await invoke(
    'deferrals.proposeReschedule',
    { ...calendarInput, serviceTo: '2026-05-31', evidenceId: declinedProof.id },
    grant.token,
  );
  await page.goto(`/contabilitate?company=${companyId}&financialYearId=${nextYear.id}`);
  await calendarCard.getByRole('button', { name: 'Respinge planul', exact: true }).click();
  await calendarCard
    .getByLabel('Motivul respingerii')
    .fill('Acordul ulterior a fost retras de ambele părți');
  await calendarCard.getByRole('button', { name: 'Confirmă respingerea', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Planul a fost respins');
  await expect(calendarCard).toHaveCount(0);
  const discountAgreement = await source(
      'acord-reducere.txt',
      'Separately agreed commercial discount with subscription services and schedule unchanged',
    ),
    discountXml = await source(
      'reducere-abonament.xml',
      invoiceXml({
        credit: true,
        number: 'REDUCERE-2026',
        originalNumber: 'ABONAMENT-2026',
        date: '2026-02-01',
        net: '10.00',
        tax: '2.10',
        gross: '12.10',
      }),
    ),
    discount = await invoke('invoices.import', { evidenceId: discountXml.id });
  await invoke(
    'deferrals.proposeDiscount',
    {
      financialYearId: nextYear.id,
      invoiceId: discount.id,
      originalInvoiceId: invoice.id,
      recognitionDate: '2026-02-01',
      decisionDate: '2026-02-01',
      treatmentEvidenceId: discountAgreement.id,
      kind: 'commercial_discount',
      periodBasis: 'current_period_event',
      reason: 'Reducere de preț convenită separat, cu serviciile și calendarul neschimbate',
      servicesUnchanged: true,
    },
    grant.token,
  );
  await page.reload();
  const discountCard = page
      .locator('.acc-review')
      .filter({ hasText: 'Reducere comercială abonament' }),
    discountEffects = discountCard.getByRole('table', { name: 'Efect contabil propus' });
  await expect(discountCard).toContainText('Servicii și calendar');
  await expect(discountCard).toContainText('Neschimbate');
  await expect(discountCard).toContainText('Acord de reducere');
  await expect(discountEffects).toContainText('609');
  await expect(discountEffects).not.toContainText('471');
  await page.screenshot({
    path: info.outputPath(`subscription-discount-${info.project.name}.png`),
    fullPage: true,
  });
  await discountCard.getByRole('button', { name: 'ABONAMENT-2026', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(original).toHaveAttribute('open', '');
  await expect(original.locator('summary')).toBeFocused();
  await page.goto(`/contabilitate?company=${companyId}&financialYearId=${nextYear.id}`);
  await discountCard.getByRole('button', { name: 'Aprobă această versiune', exact: true }).click();
  await discountCard.getByRole('button', { name: 'Contabilizează', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('contabilizată');
  await expect(
    page.locator('.acc-balances > div').filter({ hasText: 'Cheltuieli cu servicii' }),
  ).toContainText('23,33');
  expect(await invoke('deferrals.get', { id: root.id, date: '2026-02-28' })).toMatchObject({
    allocated: '33.33',
    remaining: '66.67',
  });
  const agreement = await source(
      'acord-anulare.txt',
      'Written agreement cancels the unprovided February through April 2026 services',
    ),
    creditXml = await source(
      'anulare-abonament.xml',
      invoiceXml({
        credit: true,
        number: 'ANULARE-2026',
        originalNumber: 'ABONAMENT-2026',
        date: '2026-02-01',
        net: '66.67',
        tax: '14.00',
        gross: '80.67',
      }),
    ),
    credit = await invoke('invoices.import', { evidenceId: creditXml.id });
  await invoke(
    'deferrals.proposeCreditNote',
    {
      financialYearId: nextYear.id,
      invoiceId: credit.id,
      originalInvoiceId: invoice.id,
      recognitionDate: '2026-02-01',
      decisionDate: '2026-02-01',
      treatmentEvidenceId: agreement.id,
      kind: 'cancellation',
      periodBasis: 'current_period_event',
      reason: 'Acord scris pentru anularea serviciilor neprestate din februarie până în aprilie',
      cancelFrom: '2026-02-01',
    },
    grant.token,
  );
  await page.reload();
  const cancellationCard = page.locator('.acc-review').filter({ hasText: 'Anulare abonament' }),
    cancelledMonths = cancellationCard.getByRole('table', { name: 'Luni anulate', exact: true }),
    cancellationEffects = cancellationCard.getByRole('table', { name: 'Efect contabil propus' });
  await expect(cancelledMonths.locator('tbody tr')).toHaveCount(3);
  await expect(cancelledMonths).toContainText('2026-02');
  await expect(cancelledMonths).toContainText('2026-03');
  await expect(cancelledMonths).toContainText('22,23');
  await expect(
    cancellationCard.getByRole('link', { name: 'Acord · plan 1', exact: true }),
  ).toHaveAttribute('href', `${base}/evidence/${calendarAgreement.id}`);
  await expect(cancellationCard).toContainText('Sumă deja recunoscută');
  await expect(cancellationCard).toContainText('33,33');
  await expect(cancellationCard).toContainText('66,67');
  await expect(cancellationEffects).toContainText('471');
  await expect(cancellationEffects).toContainText('4426');
  await expect(cancellationEffects).not.toContainText('628');
  await page.screenshot({
    path: info.outputPath(`subscription-cancellation-${info.project.name}.png`),
    fullPage: true,
  });
  await cancellationCard.getByRole('button', { name: 'ABONAMENT-2026', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(original).toHaveAttribute('open', '');
  await expect(original.locator('summary')).toBeFocused();
  await page.goto(`/contabilitate?company=${companyId}&financialYearId=${nextYear.id}`);
  await cancellationCard
    .getByRole('button', { name: 'Aprobă această versiune', exact: true })
    .click();
  await cancellationCard.getByRole('button', { name: 'Contabilizează', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('contabilizată');
  await expect(page.locator('.acc-review')).toHaveCount(0);
  expect(await invoke('proposals.get', { id: obsolete.id })).toMatchObject({
    superseded: true,
    posted: false,
  });
  expect(await invoke('deferrals.get', { id: root.id, date: '2026-02-28' })).toMatchObject({
    allocated: '33.33',
    cancelled: '66.67',
    remaining: '0.00',
    status: 'cancelled',
  });
  expect(
    await invoke('deferrals.reconcile', { financialYearId: nextYear.id, date: '2026-02-28' }),
  ).toMatchObject({ status: 'reconciled' });
  expect(await invoke('vat.summary', { financialYearId: nextYear.id })).toMatchObject({
    status: 'reconciled',
    totals: { inputTax: '-16.10', outputTax: '0.00' },
  });
  const dayContract = await source(
    'servicii-pe-zile.txt',
    'Documented uniform daily benefit from 16 January through 15 March 2026, inclusive, agreed before invoicing',
  );
  const dayXml = await source(
    'factura-pe-zile.xml',
    invoiceXml({ number: 'ZILE-2026', date: '2026-01-01' }),
  );
  const dayInvoice = await invoke('invoices.import', { evidenceId: dayXml.id });
  const dayRoot = await invoke(
    'deferrals.proposeInvoice',
    {
      financialYearId: nextYear.id,
      invoiceId: dayInvoice.id,
      recognitionDate: '2026-01-01',
      evidenceId: dayContract.id,
      evidenceDate: '2025-12-20',
      taxPointBasis: 'early_invoice',
      account: '628',
      deduction: 'full',
      counterpartyVatCollection: 'no',
      basis: 'uniform_service',
      method: 'actual_calendar_days',
      serviceFrom: '2026-01-16',
      serviceTo: '2026-03-15',
      reason:
        'Servicii uniforme în fiecare zi calendaristică din perioada contractuală documentată',
    },
    grant.token,
  );
  await page.reload();
  const dayCard = page.locator('.acc-review');
  await expect(dayCard.getByRole('heading')).toHaveText('Servicii achiziționate · ZILE-2026');
  await expect(dayCard).toContainText('Pe zile calendaristice');
  await expect(dayCard).toContainText('59');
  const dayPlan = dayCard.getByRole('table', { name: 'Plan de alocare', exact: true });
  await expect(dayPlan.locator('tbody tr')).toHaveCount(3);
  await expect(dayPlan.locator('tbody tr').nth(0).getByRole('cell').nth(2)).toHaveText('16');
  await expect(dayPlan).toContainText('27,11');
  await expect(dayPlan).toContainText('47,46');
  await expect(dayPlan).toContainText('25,43');
  await page.screenshot({
    path: info.outputPath(`actual-day-plan-${info.project.name}.png`),
    fullPage: true,
  });
  await dayCard.getByRole('button', { name: 'Aprobă această versiune', exact: true }).click();
  await dayCard.getByRole('button', { name: 'Contabilizează', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('contabilizată');
  const daySource = await invoke('ledger.post', {
    id: dayRoot.id,
    version: dayRoot.version,
    hash: dayRoot.hash,
  });
  await post(
    await invoke(
      'deferrals.proposeRelease',
      { financialYearId: nextYear.id, deferralId: dayRoot.id, month: '2026-01-01' },
      grant.token,
    ),
  );
  const dayAgreement = await source(
    'acord-calendar-zile.txt',
    'New agreement retains January benefit and the same remaining value, extending uniform daily services through 10 April',
  );
  await invoke(
    'deferrals.proposeReschedule',
    {
      financialYearId: nextYear.id,
      deferralId: dayRoot.id,
      date: '2026-02-01',
      effectiveFrom: '2026-02-01',
      serviceTo: '2026-04-10',
      evidenceId: dayAgreement.id,
      evidenceDate: '2026-02-01',
      method: 'actual_calendar_days',
      priceUnchanged: true,
      reason: 'Prelungire documentată a serviciilor uniforme, cu valoarea viitoare neschimbată',
    },
    grant.token,
  );
  await page.reload();
  const dayCalendar = page.locator('[data-review-kind="reschedule"]');
  await expect(dayCalendar).toContainText('Calendar servicii');
  await expect(dayCalendar).toContainText('Pe zile calendaristice');
  await expect(
    dayCalendar.locator('.acc-review-meta > div').filter({ hasText: 'Final anterior' }),
  ).toContainText('2026-03-15');
  await expect(dayCalendar.getByRole('table', { name: 'Calendar de alocare' })).toContainText(
    '29,57',
  );
  await expect(dayCalendar.getByRole('table', { name: 'Calendar de alocare' })).toContainText(
    '10 zile',
  );
  await page.screenshot({
    path: info.outputPath(`actual-day-amendment-${info.project.name}.png`),
    fullPage: true,
  });
  await dayCalendar.getByRole('button', { name: 'ZILE-2026', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page.locator(`#journal-${daySource.id}`)).toHaveAttribute('open', '');
  await expect(page.locator(`#journal-${daySource.id}`).locator('summary')).toBeFocused();
  await page.goto(`/contabilitate?company=${companyId}&financialYearId=${nextYear.id}`);
  await dayCalendar.getByRole('button', { name: 'Aprobă acest plan', exact: true }).click();
  const beforeCalendar = (await invoke('journals.list', { limit: 100 })).items.length;
  await dayCalendar.getByRole('button', { name: 'Aplică planul', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Calendarul de alocare a fost actualizat');
  expect((await invoke('journals.list', { limit: 100 })).items).toHaveLength(beforeCalendar);
  expect(await invoke('deferrals.get', { id: dayRoot.id, date: '2026-04-30' })).toMatchObject({
    serviceTo: '2026-04-10',
    allocated: '27.11',
    remaining: '72.89',
    allocation: { serviceDays: 85 },
  });
  const scopeAgreement = await source(
    'acord-diminuare-servicii.txt',
    'Signed agreement cancels part of future services from 1 February; remaining benefits are uniform over the same dates',
  );
  const scopeXml = await source(
    'diminuare-servicii.xml',
    invoiceXml({
      credit: true,
      originalNumber: 'ZILE-2026',
      number: 'ZILE-REDUCERE',
      date: '2026-02-01',
      net: '20.00',
      tax: '4.20',
      gross: '24.20',
    }),
  );
  const scopeInvoice = await invoke('invoices.import', { evidenceId: scopeXml.id });
  const scope = await invoke(
    'deferrals.proposeScopeReduction',
    {
      financialYearId: nextYear.id,
      originalInvoiceId: dayInvoice.id,
      invoiceId: scopeInvoice.id,
      recognitionDate: '2026-02-01',
      decisionDate: '2026-02-01',
      treatmentEvidenceId: scopeAgreement.id,
      kind: 'cancellation',
      periodBasis: 'current_period_event',
      cancelFrom: '2026-02-01',
      changeBasis: 'cancelled_future_services',
      remainingServices: 'uniform',
      reason:
        'Acord nou privind diminuarea serviciilor viitoare, cu beneficiile rămase uniforme în aceeași perioadă',
    },
    grant.token,
  );
  await page.reload();
  const scopeCard = page.locator('.acc-review');
  await expect(scopeCard.getByRole('heading')).toHaveText(
    'Diminuare servicii viitoare · ZILE-REDUCERE',
  );
  await expect(scopeCard).toContainText('52,89');
  const scopeTable = scopeCard.getByRole('table', { name: 'Plan de alocare modificat' });
  await expect(scopeTable.locator('tbody tr')).toHaveCount(4);
  await expect(scopeTable.locator('tbody tr').nth(0)).toContainText('27,11');
  await expect(scopeTable).toContainText('21,46');
  await expect(scopeTable).toContainText('23,76');
  await expect(scopeTable).toContainText('7,67');
  await page.screenshot({
    path: info.outputPath(`scope-reduction-${info.project.name}.png`),
    fullPage: true,
  });
  const agreementDownload = await Promise.all([
    page.waitForEvent('download'),
    scopeCard.getByRole('link', { name: 'Descarcă' }).click(),
  ]);
  expect(agreementDownload[0].suggestedFilename()).toBe('acord-diminuare-servicii.txt');
  await scopeCard.getByRole('button', { name: 'Aprobă această versiune', exact: true }).click();
  await scopeCard.getByRole('button', { name: 'Contabilizează', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('contabilizată');
  await invoke('ledger.post', { id: scope.id, version: scope.version, hash: scope.hash });
  expect(await invoke('deferrals.get', { id: dayRoot.id, date: '2026-04-30' })).toMatchObject({
    cancelled: '20.00',
    remaining: '52.89',
    cancellation: { kind: 'scope_reduction' },
  });
  for (const month of ['2026-02-01', '2026-03-01', '2026-04-01'])
    await post(
      await invoke(
        'deferrals.proposeRelease',
        { financialYearId: nextYear.id, deferralId: dayRoot.id, month },
        grant.token,
      ),
    );
  expect(
    await invoke('deferrals.reconcile', { financialYearId: nextYear.id, date: '2026-04-30' }),
  ).toMatchObject({ status: 'reconciled' });
  expect(await invoke('vat.summary', { financialYearId: nextYear.id })).toMatchObject({
    status: 'reconciled',
    totals: { inputTax: '0.70', outputTax: '0.00' },
  });
  const additionAgreement = await source(
    'acord-servicii-suplimentare.txt',
    'Signed agreement for separately invoiced additional uniform future services, original invoice and recognized services unchanged',
  );
  const additionXml = await source(
    'servicii-suplimentare.xml',
    invoiceXml({
      number: 'ZILE-SUPLIMENT',
      date: '2026-02-01',
      net: '30.00',
      tax: '6.30',
      gross: '36.30',
    }),
  );
  const additionInvoice = await invoke('invoices.import', { evidenceId: additionXml.id });
  const addition = await invoke(
    'deferrals.proposeSupplement',
    {
      financialYearId: nextYear.id,
      parentDeferralId: dayRoot.id,
      changeBasis: 'additional_future_services',
      invoiceId: additionInvoice.id,
      recognitionDate: '2026-02-01',
      evidenceId: additionAgreement.id,
      evidenceDate: '2026-02-01',
      taxPointBasis: 'early_invoice',
      account: '628',
      deduction: 'full',
      counterpartyVatCollection: 'no',
      basis: 'uniform_service',
      method: 'actual_calendar_days',
      serviceFrom: '2026-02-01',
      serviceTo: '2026-03-15',
      reason:
        'Servicii viitoare suplimentare, facturate separat și uniforme în perioada noului acord',
    },
    grant.token,
  );
  await page.reload();
  const additionCard = page.locator('.acc-review');
  await expect(additionCard.getByRole('heading')).toHaveText(
    'Servicii suplimentare · ZILE-SUPLIMENT',
  );
  await expect(additionCard).toContainText('Acord suplimentar');
  await expect(
    additionCard.getByRole('table', { name: 'Plan de alocare', exact: true }),
  ).toContainText('19,53');
  await expect(
    additionCard.getByRole('table', { name: 'Plan de alocare', exact: true }),
  ).toContainText('10,47');
  await page.screenshot({
    path: info.outputPath(`supplement-${info.project.name}.png`),
    fullPage: true,
  });
  await additionCard.getByRole('button', { name: 'ZILE-2026', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page.locator(`#journal-${daySource.id}`)).toHaveAttribute('open', '');
  await expect(page.locator(`#journal-${daySource.id}`).locator('summary')).toBeFocused();
  await page.goto(`/contabilitate?company=${companyId}&financialYearId=${nextYear.id}`);
  await additionCard.getByRole('button', { name: 'Aprobă această versiune', exact: true }).click();
  await additionCard.getByRole('button', { name: 'Contabilizează', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('contabilizată');
  await invoke('ledger.post', { id: addition.id, version: addition.version, hash: addition.hash });
  for (const month of ['2026-02-01', '2026-03-01'])
    await post(
      await invoke(
        'deferrals.proposeRelease',
        { financialYearId: nextYear.id, deferralId: addition.id, month },
        grant.token,
      ),
    );
  expect(await invoke('deferrals.get', { id: dayRoot.id, date: '2026-04-30' })).toMatchObject({
    amount: '100.00',
    allocated: '80.00',
    cancelled: '20.00',
    remaining: '0.00',
  });
  expect(await invoke('deferrals.get', { id: addition.id, date: '2026-04-30' })).toMatchObject({
    amount: '30.00',
    allocated: '30.00',
    remaining: '0.00',
    supplement: { parentDeferralId: dayRoot.id },
  });
  expect(
    (
      await invoke('deferrals.list', {
        date: '2026-04-30',
        parentDeferralId: dayRoot.id,
        onlyOpen: false,
      })
    ).items,
  ).toHaveLength(1);
  expect(
    await invoke('deferrals.reconcile', { financialYearId: nextYear.id, date: '2026-04-30' }),
  ).toMatchObject({ status: 'reconciled' });
  expect(await invoke('vat.summary', { financialYearId: nextYear.id })).toMatchObject({
    status: 'reconciled',
    totals: { inputTax: '7.00', outputTax: '0.00' },
  });
  const benefitAgreement = await source(
      'contract-beneficii.txt',
      'Documented nonuniform monthly services with separately evidenced monthly acceptance',
    ),
    benefitXml = await source(
      'beneficii.xml',
      invoiceXml({ number: 'BENEFICII-2026', date: '2026-01-01' }),
    ),
    benefitInvoice = await invoke('invoices.import', { evidenceId: benefitXml.id }),
    benefits = ['20.00', '50.00', '30.00'].map((amount, index) => ({
      month: `2026-0${index + 1}-01`,
      amount,
      benefit: [
        'Configurare inițială și documentarea serviciilor',
        'Servicii operaționale și verificări lunare',
        'Predarea documentației și închiderea serviciilor',
      ][index],
    })),
    benefitRoot = await invoke(
      'deferrals.proposeInvoice',
      {
        financialYearId: nextYear.id,
        invoiceId: benefitInvoice.id,
        recognitionDate: '2026-01-01',
        evidenceId: benefitAgreement.id,
        evidenceDate: '2026-01-01',
        taxPointBasis: 'early_invoice',
        account: '628',
        deduction: 'full',
        counterpartyVatCollection: 'no',
        basis: 'documented_monthly_benefits',
        method: 'evidenced_monthly_amounts',
        serviceFrom: '2026-01-16',
        serviceTo: '2026-03-15',
        benefits,
        reason:
          'Valori lunare explicite conform serviciilor contractate, cu confirmarea realizării înainte de recunoaștere',
      },
      grant.token,
    );
  await page.reload();
  const benefitCard = page.locator('.acc-review'),
    benefitPlan = benefitCard.getByRole('table', { name: 'Plan de alocare', exact: true });
  await expect(benefitCard).toContainText('Sume lunare documentate');
  await expect(benefitPlan).toContainText(benefits[0].benefit);
  await expect(benefitPlan.locator('tbody tr').nth(1)).toContainText('50,00');
  await page.screenshot({
    path: info.outputPath(`benefit-plan-${info.project.name}.png`),
    fullPage: true,
  });
  await benefitCard.getByRole('button', { name: 'Aprobă această versiune', exact: true }).click();
  await benefitCard.getByRole('button', { name: 'Contabilizează', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('contabilizată');
  const benefitRootEntry = await invoke('ledger.post', {
    id: benefitRoot.id,
    version: benefitRoot.version,
    hash: benefitRoot.hash,
  });
  const acceptance = await source(
      'confirmare-ianuarie.txt',
      'January services completed and accepted on 31 January 2026',
    ),
    benefitRelease = await invoke(
      'deferrals.proposeRelease',
      {
        financialYearId: nextYear.id,
        deferralId: benefitRoot.id,
        month: '2026-01-01',
        benefitEvidence: { evidenceId: acceptance.id, evidenceDate: '2026-01-31' },
      },
      grant.token,
    );
  await page.reload();
  const benefitReleaseCard = page.locator('.acc-review');
  await expect(benefitReleaseCard).toContainText('Confirmarea serviciilor');
  await expect(benefitReleaseCard).toContainText('2026-01-31');
  const acceptanceDownload = await Promise.all([
    page.waitForEvent('download'),
    benefitReleaseCard.getByRole('link', { name: 'confirmare-ianuarie.txt', exact: true }).click(),
  ]);
  expect(acceptanceDownload[0].suggestedFilename()).toBe('confirmare-ianuarie.txt');
  await page.screenshot({
    path: info.outputPath(`benefit-release-${info.project.name}.png`),
    fullPage: true,
  });
  await benefitReleaseCard
    .getByRole('button', { name: 'Aprobă această versiune', exact: true })
    .click();
  await benefitReleaseCard.getByRole('button', { name: 'Contabilizează', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('contabilizată');
  await invoke('ledger.post', {
    id: benefitRelease.id,
    version: benefitRelease.version,
    hash: benefitRelease.hash,
  });
  const benefitChange = await source(
    'acord-beneficii-noi.txt',
    'New agreement changes future monthly benefits only, January and the total price remain unchanged',
  );
  await invoke(
    'deferrals.proposeReschedule',
    {
      financialYearId: nextYear.id,
      deferralId: benefitRoot.id,
      date: '2026-02-01',
      effectiveFrom: '2026-02-01',
      serviceTo: '2026-04-10',
      evidenceId: benefitChange.id,
      evidenceDate: '2026-02-01',
      method: 'evidenced_monthly_amounts',
      benefits: ['30.00', '25.00', '25.00'].map((amount, index) => ({
        month: `2026-0${index + 2}-01`,
        amount,
        benefit: 'Servicii viitoare conform acordului actualizat',
      })),
      priceUnchanged: true,
      reason:
        'Repartizarea documentată a serviciilor viitoare, cu ianuarie și valoarea totală păstrate',
    },
    grant.token,
  );
  await page.reload();
  const benefitCalendar = page.locator('[data-review-kind="reschedule"]');
  await expect(benefitCalendar).toContainText('Sume lunare documentate');
  await expect(benefitCalendar.getByRole('table', { name: 'Calendar de alocare' })).toContainText(
    benefits[0].benefit,
  );
  await expect(benefitCalendar).toContainText('Servicii viitoare conform acordului actualizat');
  await page.screenshot({
    path: info.outputPath(`benefit-amendment-${info.project.name}.png`),
    fullPage: true,
  });
  await benefitCalendar.getByRole('button', { name: 'Aprobă acest plan', exact: true }).focus();
  await page.keyboard.press('Enter');
  await benefitCalendar.getByRole('button', { name: 'Aplică planul', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Calendarul de alocare a fost actualizat');
  expect(await invoke('deferrals.get', { id: benefitRoot.id, date: '2026-02-01' })).toMatchObject({
    allocated: '20.00',
    remaining: '80.00',
    schedule: [{ amount: '20.00' }, { amount: '30.00' }, { amount: '25.00' }, { amount: '25.00' }],
  });
  expect(await invoke('vat.summary', { financialYearId: nextYear.id })).toMatchObject({
    status: 'reconciled',
    totals: { inputTax: '28.00', outputTax: '0.00' },
  });
  const benefitScopeAgreement = await source(
      'acord-reducere-beneficii.txt',
      'Partial cancellation of future services: January unchanged and each remaining monthly amount reduced explicitly',
    ),
    benefitScopeXml = await source(
      'reducere-beneficii.xml',
      invoiceXml({
        credit: true,
        number: 'BENEFICII-REDUCERE',
        originalNumber: 'BENEFICII-2026',
        date: '2026-02-01',
        net: '20.00',
        tax: '4.20',
        gross: '24.20',
      }),
    ),
    benefitScopeInvoice = await invoke('invoices.import', { evidenceId: benefitScopeXml.id }),
    benefitScope = await invoke(
      'deferrals.proposeScopeReduction',
      {
        financialYearId: nextYear.id,
        invoiceId: benefitScopeInvoice.id,
        originalInvoiceId: benefitInvoice.id,
        recognitionDate: '2026-02-01',
        decisionDate: '2026-02-01',
        treatmentEvidenceId: benefitScopeAgreement.id,
        kind: 'cancellation',
        periodBasis: 'current_period_event',
        cancelFrom: '2026-02-01',
        changeBasis: 'cancelled_future_services',
        remainingServices: 'documented_monthly_benefits',
        benefits: ['2026-02-01', '2026-03-01', '2026-04-01'].map((month) => ({
          month,
          amount: '20.00',
          benefit: 'Servicii rămase după reducerea documentată',
        })),
        reason:
          'Anularea parțială a serviciilor viitoare, cu valori lunare mai mici și ianuarie păstrat',
      },
      grant.token,
    );
  await page.reload();
  const benefitScopeCard = page.locator('.acc-review'),
    benefitScopeTable = benefitScopeCard.getByRole('table', { name: 'Plan de alocare modificat' });
  await expect(benefitScopeCard.getByRole('heading')).toHaveText(
    'Diminuare servicii viitoare · BENEFICII-REDUCERE',
  );
  await expect(benefitScopeCard).toContainText('Sume lunare documentate');
  await expect(benefitScopeTable.locator('tbody tr')).toHaveCount(4);
  await expect(benefitScopeTable.locator('tbody tr').nth(0)).toContainText(benefits[0].benefit);
  await expect(benefitScopeTable.locator('tbody tr').nth(1)).toContainText('30,00');
  await expect(benefitScopeTable.locator('tbody tr').nth(1)).toContainText('20,00');
  await expect(benefitScopeTable).toContainText('Servicii rămase după reducerea documentată');
  await page.screenshot({
    path: info.outputPath(`benefit-scope-${info.project.name}.png`),
    fullPage: true,
  });
  const scopeDownload = await Promise.all([
    page.waitForEvent('download'),
    benefitScopeCard.getByRole('link', { name: 'Descarcă', exact: true }).click(),
  ]);
  expect(scopeDownload[0].suggestedFilename()).toBe('acord-reducere-beneficii.txt');
  await benefitScopeCard.getByRole('button', { name: 'BENEFICII-2026', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page.locator(`#journal-${benefitRootEntry.id}`)).toHaveAttribute('open', '');
  await expect(page.locator(`#journal-${benefitRootEntry.id}`).locator('summary')).toBeFocused();
  await page.goto(`/contabilitate?company=${companyId}&financialYearId=${nextYear.id}`);
  await benefitScopeCard
    .getByRole('button', { name: 'Aprobă această versiune', exact: true })
    .click();
  await benefitScopeCard.getByRole('button', { name: 'Contabilizează', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('contabilizată');
  const benefitScopeEntry = await invoke('ledger.post', {
    id: benefitScope.id,
    version: benefitScope.version,
    hash: benefitScope.hash,
  });
  expect(await invoke('deferrals.get', { id: benefitRoot.id, date: '2026-02-01' })).toMatchObject({
    amount: '100.00',
    allocated: '20.00',
    cancelled: '20.00',
    remaining: '60.00',
    cancellation: { kind: 'scope_reduction' },
  });
  const secondScopeAgreement = await source(
      'a-doua-reducere.txt',
      'A separate further reduction of unprovided services, preserving the first credit and January',
    ),
    secondScopeXml = await source(
      'a-doua-reducere.xml',
      invoiceXml({
        credit: true,
        number: 'BENEFICII-REDUCERE-2',
        originalNumber: 'BENEFICII-2026',
        date: '2026-02-01',
        net: '10.00',
        tax: '2.10',
        gross: '12.10',
      }),
    ),
    secondScopeInvoice = await invoke('invoices.import', { evidenceId: secondScopeXml.id }),
    secondScope = await invoke(
      'deferrals.proposeScopeReduction',
      {
        financialYearId: nextYear.id,
        invoiceId: secondScopeInvoice.id,
        originalInvoiceId: benefitInvoice.id,
        recognitionDate: '2026-02-01',
        decisionDate: '2026-02-01',
        treatmentEvidenceId: secondScopeAgreement.id,
        kind: 'cancellation',
        periodBasis: 'current_period_event',
        cancelFrom: '2026-02-01',
        changeBasis: 'cancelled_future_services',
        remainingServices: 'documented_monthly_benefits',
        benefits: ['10.00', '20.00', '20.00'].map((amount, index) => ({
          month: `2026-0${index + 2}-01`,
          amount,
          benefit: 'Servicii rămase după a doua reducere',
        })),
        reason:
          'Diminuarea suplimentară a serviciilor viitoare, cu primul credit și ianuarie păstrate',
      },
      grant.token,
    );
  await page.reload();
  const secondScopeCard = page.locator('.acc-review');
  await expect(secondScopeCard.getByRole('heading')).toHaveText(
    'Diminuare servicii viitoare · BENEFICII-REDUCERE-2',
  );
  await expect(secondScopeCard).toContainText('Anulat anterior');
  await expect(secondScopeCard).toContainText('60,00');
  await expect(secondScopeCard).toContainText('50,00');
  await page.screenshot({
    path: info.outputPath(`sequential-credit-${info.project.name}.png`),
    fullPage: true,
  });
  await secondScopeCard.getByRole('button', { name: 'BENEFICII-REDUCERE', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page.locator(`#journal-${benefitScopeEntry.id}`)).toHaveAttribute('open', '');
  await expect(page.locator(`#journal-${benefitScopeEntry.id}`).locator('summary')).toBeFocused();
  await page.goto(`/contabilitate?company=${companyId}&financialYearId=${nextYear.id}`);
  await secondScopeCard
    .getByRole('button', { name: 'Aprobă această versiune', exact: true })
    .click();
  await secondScopeCard.getByRole('button', { name: 'Contabilizează', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('contabilizată');
  const secondScopeEntry = await invoke('ledger.post', {
    id: secondScope.id,
    version: secondScope.version,
    hash: secondScope.hash,
  });
  expect(await invoke('deferrals.get', { id: benefitRoot.id, date: '2026-02-01' })).toMatchObject({
    cancelled: '30.00',
    remaining: '50.00',
    cancellations: [
      { sequence: 1, amount: '20.00' },
      { sequence: 2, amount: '10.00' },
    ],
  });
  const reducedCalendarAgreement = await source(
    'calendar-sold-redus.txt',
    'Separate timing agreement redistributes only the reduced future balance and preserves the posted credit and January',
  );
  await invoke(
    'deferrals.proposeReschedule',
    {
      financialYearId: nextYear.id,
      deferralId: benefitRoot.id,
      date: '2026-02-01',
      effectiveFrom: '2026-02-01',
      serviceTo: '2026-05-10',
      evidenceId: reducedCalendarAgreement.id,
      evidenceDate: '2026-02-01',
      method: 'evidenced_monthly_amounts',
      benefits: ['2026-02-01', '2026-03-01', '2026-04-01', '2026-05-01'].map((month) => ({
        month,
        amount: '12.50',
        benefit: 'Servicii reprogramate după reducerea documentată',
      })),
      priceUnchanged: true,
      reason:
        'Reprogramarea soldului redus de 50 RON, cu factura, ambele reduceri și ianuarie păstrate',
    },
    grant.token,
  );
  await page.reload();
  const reducedCalendarCard = page.locator('[data-review-kind="reschedule"]'),
    reducedCalendarTable = reducedCalendarCard.getByRole('table', { name: 'Calendar de alocare' });
  await expect(reducedCalendarCard).toContainText('Reducere înregistrată');
  await expect(reducedCalendarCard).toContainText('50,00');
  await expect(reducedCalendarCard).toContainText('30,00');
  await expect(reducedCalendarTable.locator('tbody tr')).toHaveCount(5);
  await expect(reducedCalendarTable.locator('tbody tr').nth(0)).toContainText(benefits[0].benefit);
  await expect(reducedCalendarTable.locator('tbody tr').nth(1)).toContainText('10,00');
  await expect(reducedCalendarTable.locator('tbody tr').nth(1)).toContainText('12,50');
  await page.screenshot({
    path: info.outputPath(`reduced-calendar-${info.project.name}.png`),
    fullPage: true,
  });
  await reducedCalendarCard
    .getByRole('button', { name: 'BENEFICII-REDUCERE-2', exact: true })
    .focus();
  await page.keyboard.press('Enter');
  await expect(page.locator(`#journal-${secondScopeEntry.id}`)).toHaveAttribute('open', '');
  await expect(page.locator(`#journal-${secondScopeEntry.id}`).locator('summary')).toBeFocused();
  await page.goto(`/contabilitate?company=${companyId}&financialYearId=${nextYear.id}`);
  const entriesBeforeCalendar = (await invoke('journals.list', { limit: 100 })).items.length;
  await reducedCalendarCard.getByRole('button', { name: 'Aprobă acest plan', exact: true }).click();
  await reducedCalendarCard.getByRole('button', { name: 'Aplică planul', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Calendarul de alocare a fost actualizat');
  expect((await invoke('journals.list', { limit: 100 })).items).toHaveLength(entriesBeforeCalendar);
  for (const [month, date] of [
    ['2026-02-01', '2026-02-28'],
    ['2026-03-01', '2026-03-31'],
    ['2026-04-01', '2026-04-30'],
    ['2026-05-01', '2026-05-10'],
  ]) {
    const confirmation = await source(
      `confirmare-${month}.txt`,
      `Remaining services performed and accepted on ${date}`,
    );
    await post(
      await invoke(
        'deferrals.proposeRelease',
        {
          financialYearId: nextYear.id,
          deferralId: benefitRoot.id,
          month,
          benefitEvidence: { evidenceId: confirmation.id, evidenceDate: date },
        },
        grant.token,
      ),
    );
  }
  expect(await invoke('deferrals.get', { id: benefitRoot.id, date: '2026-05-31' })).toMatchObject({
    allocated: '70.00',
    cancelled: '30.00',
    remaining: '0.00',
  });
  expect(
    await invoke('deferrals.reconcile', { financialYearId: nextYear.id, date: '2026-05-31' }),
  ).toMatchObject({ status: 'reconciled' });
  expect(await invoke('vat.summary', { financialYearId: nextYear.id })).toMatchObject({
    status: 'reconciled',
    totals: { inputTax: '21.70', outputTax: '0.00' },
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});
