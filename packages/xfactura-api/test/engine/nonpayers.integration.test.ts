import { afterAll, describe, expect, test } from 'bun:test';
import path from 'node:path';
import { agent as module } from 'xfactura-core/ro/nonpayers';
import { DukIntegrator } from '../../source/engine/adapters/declaration-validator';
import type { ActionView } from '../../source/engine/kernel/actions';
import type { Actor } from '../../source/engine/kernel/commands';
import type { ProposalView } from '../../source/engine/kernel/views';
import type { WorkItem } from '../../source/engine/kernel/work';
import { invoiceXml, type XmlInput } from './fixtures/invoice';
import { scenario, type Scenario } from './scenario';

// Synthetic companies and documents; amounts computed by hand:
//   the threshold is 395.000 lei (art. 310 alin. (1)); 100.000 € at a synthetic 5,0800 = 508.000
//   lei (the VAT period's limit); a price that includes VAT holds 21/121 of VAT.
const open: Scenario[] = [];
afterAll(async () => {
  await Promise.all(open.map((s) => s.dispose()));
});
const dist = path.join(import.meta.dir, '../../../..', '.validators/anaf/dist');
const installed = DukIntegrator.available(dist) && Bun.which('java') !== null;
const official = installed ? test : test.skip;
/** ANAF's validator when installed: the return's state is then checked too, never assumed. */
const validator = () => (installed ? new DukIntegrator(dist) : undefined);
const validated = (artifact: Artifact) => {
  if (installed)
    expect([artifact.state, artifact.steps.at(-1)?.detail ?? null]).toEqual([
      'validated_official',
      null,
    ]);
};
const CUI = '18547290';
const bnr = (
  rates: { date: string; values: Record<string, string> }[],
) => `<?xml version="1.0" encoding="utf-8"?>
<DataSet xmlns="http://www.bnr.ro/xsd"><Header><Publisher>National Bank of Romania</Publisher><PublishingDate>${rates.at(-1)!.date}</PublishingDate><MessageType>DR</MessageType></Header>
<Body><Subject>Reference rates</Subject><OrigCurrency>RON</OrigCurrency>
${rates
  .map(
    (rate) =>
      `<Cube date="${rate.date}">${Object.entries(rate.values)
        .map(([code, value]) => `<Rate currency="${code}">${value}</Rate>`)
        .join('')}</Cube>`,
  )
  .join('\n')}
</Body></DataSet>`;
const declarant = { lastName: 'Popescu', firstName: 'Ana', role: 'Administrator' };
const scope = {
  'entity.form': ['srl', '2020-01-01'],
  'activity.goods': ['no', '2020-01-01'],
  'regime.excluded': ['none', '2020-01-01'],
  employer: ['no', '2020-01-01'],
} as Record<string, [string, string]>;

type Determination = {
  axis: string;
  status: string;
  value: string | null;
  effectiveFrom: string;
  changes: { value: string; effectiveFrom: string }[];
  lines: string[];
  recorded: { agrees: boolean | null; confirmed: boolean };
};
type Closure = {
  status: string;
  obligations: { kind: string; period: string; state: string; deadlinePeriod: string | null }[];
  needs: { code: string; fact: string; question: { kind: string; params: unknown } }[];
  unsupported: { trigger: string; evidenceIds: string[] }[];
};
type Artifact = {
  id: string;
  state: string;
  steps: { state: string; detail: string | null }[];
};
type Registration = {
  threshold: { crossed: string | null; transaction: { number: string | null } | null };
  registration: { due: string | null; recorded: string | null; state: string };
  exposure: {
    from: string;
    until: string;
    consideration: string;
    inclusive: { base: string; vat: string };
    added: { vat: string };
    undecided: number;
  } | null;
  purchases: { documentId: string; number: string; vat: string }[];
  deregistration: {
    date: string;
    eligible: boolean | null;
    lastReturn: { period: string; due: string | null };
    capitalGoods: {
      assetId: string;
      documentId: string | null;
      taxPeriod: string | null;
      adjustment: string | null;
    }[];
    total: string | null;
  } | null;
  unsupported: { code: string }[];
};

async function company(options: {
  year?: number;
  today: string;
  facts: Record<string, [string, string]>;
  validator?: DukIntegrator;
}) {
  let now = Date.parse(`${options.today}T10:00:00Z`);
  const s = await scenario({
    year: options.year ?? 2026,
    cui: CUI,
    clock: () => now,
    ...(options.validator ? { declarationValidator: options.validator } : {}),
  });
  open.push(s);
  const record = async (axis: string, value: string, effectiveFrom: string, file?: string) =>
    s.invoke<{ id: string }>(s.owner, 'profile.record', {
      axis,
      value,
      effectiveFrom,
      evidenceId: (await s.evidence(file ?? `${axis}-${value}-${effectiveFrom}.pdf`)).id,
    });
  for (const [axis, [value, from]] of Object.entries(options.facts))
    await record(axis, value, from);
  const file = async (filename: string, text: string) =>
    (
      await s.invoke<{ id: string }>(s.owner, 'evidence.record', {
        filename,
        mediaType: 'application/xml',
        base64: Buffer.from(text).toString('base64'),
      })
    ).id;
  await s.invoke(s.owner, 'fx.importBnr', {
    evidenceId: await file(
      'bnr.xml',
      bnr([
        { date: '2025-12-31', values: { EUR: '5.0800', USD: '4.4000' } },
        { date: '2026-10-14', values: { EUR: '5.0912', USD: '4.3755' } },
      ]),
    ),
  });
  await s.invoke(s.owner, 'sales.seller.record', {
    details: {
      name: 'Exemplu Servicii SRL',
      vatId: `RO${CUI}`,
      address: { lines: ['Str. Lungă 10'], city: 'Galați', subdivision: 'RO-GL', country: 'RO' },
    },
  });
  const anaf = await s.invoke<{ id: string }>(s.owner, 'parties.create', {
    kind: 'ro_public_institution',
    country: 'RO',
    name: 'ANAF',
  });
  const document = async (input: XmlInput) =>
    s.invoke<{ id: string }>(s.owner, 'invoices.import', {
      evidenceId: await file(`${input.number}.xml`, invoiceXml({ company: CUI, ...input })),
    });
  /** A domestic sale outside VAT (category O), or with VAT once registered. */
  const sell = async (number: string, date: string, net: string, vat?: string) => {
    const doc = await document({
      number,
      date,
      direction: 'sale',
      ...(vat
        ? { net, tax: vat, gross: (Number(net) + Number(vat)).toFixed(2) }
        : { category: 'O', rate: '0', tax: '0.00', net, gross: net }),
    });
    await s.book('invoices.recognize', { documentId: doc.id, account: '704' });
    return doc;
  };
  const buy = async (number: string, date: string, net: string, vat: string, account = '628') => {
    const doc = await document({
      number,
      date,
      net,
      tax: vat,
      gross: (Number(net) + Number(vat)).toFixed(2),
    });
    const booked = await s.book('invoices.recognize', {
      documentId: doc.id,
      account,
      deduction: 'none',
    });
    return { doc, booked };
  };
  const foreign = (input: XmlInput) =>
    document({ category: 'AE', rate: '0', tax: '0.00', ...input });
  const answer = (actor: Actor, questionId: string, value: unknown) =>
    s.invoke(actor, 'questions.answer', { questionId, value });
  return {
    s,
    anaf,
    record,
    document,
    sell,
    buy,
    foreign,
    answer,
    setToday: (date: string) => (now = Date.parse(`${date}T10:00:00Z`)),
    evaluate: async (year: number) =>
      (
        await s.invoke<{ determinations: Determination[] }>(s.owner, 'determinations.evaluate', {
          year,
        })
      ).determinations,
    registration: (year: number) => s.invoke<Registration>(s.owner, 'vat.registration', { year }),
    closure: (from: string, to: string) =>
      s.invoke<Closure>(s.owner, 'closure.evaluate', { from, to }),
    calendar: async (from: string, to: string) =>
      (
        await s.list<{ kind: string; period: string; due: string | null; status: string }>(
          s.owner,
          'obligations.calendar',
          { from, to },
        )
      ).map((item) => `${item.kind} ${item.period} ${item.due ?? '-'} ${item.status}`),
    prepare: (kind: string, period: string, extra: Record<string, unknown> = {}) =>
      s.invoke<Artifact>(s.owner, 'declarations.prepare', {
        kind,
        period,
        options: { declarant, ...extra },
      }),
    work: async () =>
      (await s.invoke<{ items: WorkItem[] }>(s.owner, 'work.list', { limit: 200 })).items,
  };
}
const find = (items: Determination[], axis: string) => items.find((item) => item.axis === axis)!;
const lines = (proposal: ProposalView) =>
  proposal.effect?.lines.map((line) => `${line.side} ${line.account} ${line.amount}`);
const taxes = (proposal: ProposalView) =>
  proposal.effect?.taxEntries.map(
    (entry) => `${entry.direction} ${entry.code} ${entry.base} ${entry.amount}`,
  );
const summary = (artifact: Artifact) => JSON.parse(artifact.steps[0]!.detail ?? 'null');
const d300 = { caen: '6201', bank: 'Banca Exemplu', account: 'RO49AAAA1B31007593840000' };
const d301 = { bank: 'Trezoreria Galati', account: 'RO12TREZ3065503XXXXXXXXX' };

describe('a non-payer crossing the small-enterprise threshold', () => {
  test('registered on time: due and valid from the crossing day, the first period from it', async () => {
    const c = await company({
      today: '2026-10-05',
      validator: validator(),
      facts: {
        ...scope,
        'vat.status': ['non_vat', '2020-01-01'],
        'vat.eu': ['none', '2020-01-01'],
        income_tax: ['micro', '2026-01-01'],
      },
    });
    await c.sell('V-1', '2026-03-10', '200000.00');
    await c.sell('V-2', '2026-09-15', '150000.00');
    // The day's sale that crosses it: the company registers from that day, declaring its VAT
    // period, and charges VAT.
    await c.record('vat.status', 'normal_vat', '2026-10-05', 'certificat-tva-art316.pdf');
    await c.record('vat.period', 'quarterly', '2026-10-05', 'certificat-tva-perioada.pdf');
    await c.sell('V-3', '2026-10-05', '50000.00', '10500.00');

    const year = await c.evaluate(2026);
    expect(find(year, 'vat.threshold')).toMatchObject({
      status: 'proposed',
      value: 'under',
      changes: [{ value: 'exceeded', effectiveFrom: '2026-10-05' }],
    });
    expect(find(year, 'vat.status')).toMatchObject({
      status: 'proposed',
      value: 'non_vat',
      changes: [{ value: 'normal_vat', effectiveFrom: '2026-10-05' }],
      recorded: { agrees: true },
    });
    // The first year's VAT period: 350.000 lei over the 277 days before registration,
    // recalculated for 365 days, 461.191,34 lei, under 508.000 lei: quarterly (art. 322 alin. (4)).
    const period = find(year, 'vat.period');
    expect(period).toMatchObject({
      status: 'proposed',
      value: 'quarterly',
      effectiveFrom: '2026-10-05',
    });
    expect(period.lines[0]).toContain('461.191,34 lei');
    expect(period.recorded.agrees).toBe(true);

    const registration = await c.registration(2026);
    expect(registration).toMatchObject({
      threshold: { crossed: '2026-10-05', transaction: { number: 'V-3' } },
      registration: { due: '2026-10-05', recorded: '2026-10-05', state: 'on_time' },
      exposure: null,
    });
    // The first return covers 5 October to the quarter's end, quarterly: no D300 for September.
    expect(
      (await c.calendar('2026-09', '2026-12')).filter((row) => row.startsWith('D300')),
    ).toEqual(['D300 2026-Q4 2027-01-25 due']);
    const prepared = await c.prepare('D300', '2026-Q4', d300);
    expect(summary(prepared).rows).toMatchObject({ R9_1: 50000, R9_2: 10500 });
    validated(prepared);
  });

  test('registered late: the VAT owed computed from the books, then booked in the first return', async () => {
    const c = await company({
      today: '2026-10-25',
      validator: validator(),
      facts: {
        ...scope,
        'vat.status': ['non_vat', '2020-01-01'],
        'vat.eu': ['none', '2020-01-01'],
        income_tax: ['micro', '2026-01-01'],
      },
    });
    await c.sell('V-1', '2026-03-10', '200000.00');
    await c.sell('V-2', '2026-09-15', '150000.00');
    await c.sell('V-3', '2026-10-05', '50000.00');
    await c.sell('V-4', '2026-10-20', '30500.00');
    const purchase = await c.buy('A-1', '2026-10-12', '1000.00', '210.00');

    // Nothing recorded: the registration is overdue, the computation asked and the returns wait.
    const due = (await c.work()).find(
      (item) => item.kind === 'determination.missing' && item.subject.id === 'vat.status/2026',
    );
    expect(due).toMatchObject({ severity: 'block', details: { conflict: true } });
    const october = await c.closure('2026-10', '2026-10');
    expect(october.status).toBe('NEEDS_EVIDENCE');
    expect(october.needs).toContainEqual(
      expect.objectContaining({ code: 'DETERMINATION_CONFLICT', fact: 'vat.status/2026' }),
    );
    expect(october.obligations.find((item) => item.kind === 'D300')).toMatchObject({
      state: 'needs_evidence',
    });
    // The exposure from the books: 80.500 lei sold without VAT from the crossing day, of which
    // 13.971,07 lei is VAT when the price included it (21/121), 16.905,00 lei if added; the
    // purchase's deduction is a person's to decide.
    const before = await c.registration(2026);
    expect(before).toMatchObject({
      threshold: { crossed: '2026-10-05', transaction: { number: 'V-3' } },
      registration: { state: 'overdue', recorded: null },
      exposure: {
        from: '2026-10-05',
        until: '2026-10-20',
        consideration: '80500.00',
        inclusive: { base: '66528.93', vat: '13971.07' },
        added: { vat: '16905.00' },
        undecided: 1,
      },
      purchases: [{ documentId: purchase.doc.id, number: 'A-1', vat: '210.00' }],
    });

    // Registered late, from the crossing day (art. 310 alin. (6^2) lit. a)).
    c.setToday('2026-11-05');
    await c.record('vat.status', 'normal_vat', '2026-10-05', 'certificat-tva-retroactiv.pdf');
    await c.record('vat.period', 'monthly', '2026-10-05', 'declaratie-mentiuni.pdf');
    expect((await c.registration(2026)).registration.state).toBe('late');
    // October's return cannot be prepared while the sales without VAT are not declared.
    const blocked = await c.s.refused(c.prepare('D300', '2026-10', d300));
    expect(JSON.stringify(blocked)).toContain('D300_LATE_REGISTRATION');

    const statement = await c.s.evidence('declaratie-nerecuperare-tva.pdf');
    const certificate = await c.s.evidence('certificat-tva-retroactiv-2.pdf');
    const input = {
      from: '2026-10-05',
      until: '2026-10-20',
      date: '2026-11-05',
      evidenceId: certificate.id,
      consideration: 'inclusive',
      considerationEvidenceId: statement.id,
      purchases: [{ documentId: purchase.doc.id, deduction: 'full' }],
    };
    // Every purchase with VAT of the range must be decided; added VAT is not covered yet.
    const undecided = await c.s.propose('vat.lateRegistration', { ...input, purchases: [] });
    expect(undecided.issues.map((issue) => issue.code)).toContain('PURCHASE_UNDECIDED');
    const added = await c.s.revise('vat.lateRegistration', undecided, {
      ...input,
      consideration: 'added',
    });
    expect(added.issues.map((issue) => issue.code)).toContain('CONSIDERATION_ADDED');
    const late = await c.s.revise('vat.lateRegistration', added, input);
    expect(lines(late)).toEqual([
      'D 635 13971.07',
      'C 4427 13971.07',
      'D 4426 210.00',
      'C 7588 210.00',
    ]);
    expect(taxes(late)).toEqual([
      'output REG-310 66528.93 13971.07',
      'input REG-310 1000.00 210.00',
    ]);
    await c.s.post(await c.s.approve(late));
    // October is now a return with nothing of its own; November declares the regularization
    // on rows 16 and 33.
    const nil = await c.prepare('D300', '2026-10', d300);
    expect(summary(nil).rows).not.toHaveProperty('R22_1');
    const first = await c.prepare('D300', '2026-11', d300);
    expect(summary(first).rows).toMatchObject({
      R16_1: 66529,
      R16_2: 13971,
      R30_1: 1000,
      R30_2: 210,
    });
    expect(summary(first).rows).not.toHaveProperty('R28_2');
    validated(nil);
    validated(first);
    // D406 of November has a code for the regularization (REG-310) on its lines: only this
    // test's partner, without a valid CUI or an address, stops it (the codes by rate are core's
    // tests, the file validated in the full year's).
    await c.s.invoke(c.s.owner, 'treasury.createAccount', {
      kind: 'bank',
      name: 'Cont curent',
      iban: 'RO49AAAA1B31007593840000',
      currency: 'RON',
      ledgerAccount: '5121',
      openedOn: '2026-01-01',
    });
    const saft = await c.s.refused(
      c.s.invoke(c.s.owner, 'declarations.prepare', {
        kind: 'D406',
        period: '2026-11',
        options: {
          contact: { firstName: 'Ana', lastName: 'Popescu', phone: '0236000000' },
          accounts: { '635': '635' },
        },
      }),
    );
    expect(
      (saft?.details as { problems: { code: string }[] }).problems.map((item) => item.code),
    ).toEqual(['D406_PARTY_CODE', 'D406_PARTY_ADDRESS']);
  });
});

describe('a non-payer with the art. 317 code', () => {
  official(
    'buying Meta ads from Ireland and an AI service from the US: VAT owed through D301, D390 for the EU supplier, both validated',
    async () => {
      const c = await company({
        today: '2026-10-30',
        validator: new DukIntegrator(dist),
        facts: {
          ...scope,
          'vat.status': ['non_vat', '2020-01-01'],
          'vat.eu': ['special', '2026-01-15'],
          income_tax: ['micro', '2026-01-01'],
        },
      });
      const meta = await c.foreign({
        number: '4567891234',
        date: '2026-10-15',
        country: 'IE',
        counterparty: 'IE9692928F',
        currency: 'EUR',
        net: '1000.00',
        gross: '1000.00',
      });
      const ai = await c.foreign({
        number: 'INV-77',
        date: '2026-10-15',
        country: 'US',
        counterparty: '941234567',
        currency: 'USD',
        net: '120.00',
        gross: '120.00',
      });
      const book = (documentId: string) =>
        c.s.propose('invoices.crossBorder', {
          documentId,
          account: '628',
          supply: 'services_general_rule',
          deduction: 'none',
          authorityId: c.anaf.id,
        });
      // A payer's default (deduct) is refused outside VAT; the revision books it.
      const refused = await c.s.propose('invoices.crossBorder', {
        documentId: meta.id,
        account: '628',
        supply: 'services_general_rule',
        authorityId: c.anaf.id,
      });
      expect(refused.issues.map((issue) => issue.code)).toContain('DEDUCTION');
      const ads = await c.s.revise('invoices.crossBorder', refused, {
        documentId: meta.id,
        account: '628',
        supply: 'services_general_rule',
        deduction: 'none',
        authorityId: c.anaf.id,
      });
      // 1.000 € at 5,0912 = 5.091,20 lei; VAT 21% = 1.069,15 lei owed to the budget (4423).
      expect(lines(ads)).toEqual([
        'D 628 5091.20',
        'C 401 5091.20',
        'D 628 1069.15',
        'C 4423 1069.15',
      ]);
      expect(taxes(ads)).toEqual([
        'output RC-EU-SERV 5091.20 1069.15',
        'input RC-EU-SERV 5091.20 1069.15',
      ]);
      expect(ads.effect?.openItems.find((item) => item.controlAccount === '4423')).toMatchObject({
        dueDate: '2026-11-25',
      });
      await c.s.post(await c.s.approve(ads));
      await c.s.post(await c.s.approve(await book(ai.id)));

      // The closure covers them now: D301 and D390 apply; nothing unsupported for them.
      const closure = await c.closure('2026-10', '2026-10');
      expect(closure.unsupported.map((item) => item.trigger)).not.toContain(
        'FOREIGN_SERVICE_PURCHASE',
      );
      expect(closure.unsupported.map((item) => item.trigger)).not.toContain('VAT_ART317');
      expect(
        closure.obligations
          .filter((item) => ['D301', 'D390'].includes(item.kind))
          .map((item) => `${item.kind} ${item.period} ${item.state}`),
      ).toEqual(['D301 2026-10 applies', 'D390 2026-10 applies']);
      expect(
        (await c.calendar('2026-10', '2026-10')).filter((row) => /^D3(01|90)/.test(row)),
      ).toEqual(['D301 2026-10 2026-11-25 due', 'D390 2026-10 2026-11-25 due']);
      // The code is held since before the first EU operation: the determination agrees.
      expect(find(await c.evaluate(2026), 'vat.eu')).toMatchObject({
        status: 'proposed',
        value: 'special',
        recorded: { agrees: true },
      });

      const special = await c.prepare('D301', '2026-10', d301);
      expect(summary(special)).toMatchObject({
        registeredArt317: true,
        payable: '1179.00',
        lines: [
          {
            section: '4',
            number: '4567891234',
            value: '1000.00 EUR',
            base: '5091.00',
            vat: '1069.00',
          },
          { section: '4.1', number: '4567891234' },
          {
            section: '4',
            number: 'INV-77',
            value: '120.00 USD',
            rate: '4.3755',
            base: '525.00',
            vat: '110.00',
          },
        ],
      });
      expect([special.state, special.steps.at(-1)?.detail ?? null]).toEqual([
        'validated_official',
        null,
      ]);
      const recap = await c.prepare('D390', '2026-10');
      expect(summary(recap).operations).toEqual([
        { type: 'S', country: 'IE', code: '9692928F', name: 'Companie IE9692928F', base: 5091 },
      ]);
      expect(recap.state).toBe('validated_official');

      // Authorizing D301 locks October's VAT ledger, like any return of a tax.
      const request = await c.s.invoke<ActionView>(c.s.owner, 'declarations.authorize.request', {
        artifactId: special.id,
      });
      await c.s.invoke(c.s.reviewer, 'actions.approve', {
        id: request.id,
        previewHash: request.previewHash,
      });
      expect(await c.s.invoke(c.s.reviewer, 'actions.execute', { id: request.id })).toMatchObject({
        status: 'executed',
        result: { locked: 'VAT 2026-10' },
      });
      expect(module.templates).toEqual([]);
    },
    120_000,
  );

  test('without the code: the VAT is still owed, the closure asks for the code and fails closed', async () => {
    const c = await company({
      today: '2026-10-30',
      facts: {
        ...scope,
        'vat.status': ['non_vat', '2020-01-01'],
        'vat.eu': ['none', '2020-01-01'],
        income_tax: ['micro', '2026-01-01'],
      },
    });
    const meta = await c.foreign({
      number: 'FB-9',
      date: '2026-10-15',
      country: 'IE',
      counterparty: 'IE9692928F',
      currency: 'EUR',
      net: '100.00',
      gross: '100.00',
    });
    const proposal = await c.s.propose('invoices.crossBorder', {
      documentId: meta.id,
      account: '628',
      supply: 'services_general_rule',
      deduction: 'none',
      authorityId: c.anaf.id,
    });
    expect(proposal.issues.map((issue) => `${issue.severity} ${issue.code}`)).toContain(
      'ack ART317_REQUIRED',
    );
    await c.s.post(await c.s.approve(proposal, c.s.reviewer, ['ART317_REQUIRED']));
    // The code the EU service requires, computed from the books: a conflict with the recorded
    // `none`, asked; D301 applies anyway, D390 waits on the code.
    expect(find(await c.evaluate(2026), 'vat.eu')).toMatchObject({
      value: 'special',
      effectiveFrom: '2026-10-15',
      recorded: { agrees: false },
    });
    const closure = await c.closure('2026-10', '2026-10');
    expect(closure.status).not.toBe('ELIGIBLE');
    expect(closure.needs).toContainEqual(
      expect.objectContaining({ code: 'DETERMINATION_CONFLICT', fact: 'vat.eu/2026' }),
    );
    expect(closure.obligations.find((item) => item.kind === 'D301')).toMatchObject({
      state: 'applies',
    });
    expect(closure.obligations.find((item) => item.kind === 'D390')).toMatchObject({
      state: 'needs_evidence',
    });
    expect(JSON.stringify(await c.s.refused(c.prepare('D390', '2026-10')))).toContain(
      'D390_NO_CODE',
    );
  });

  official(
    'selling services to an EU business: no VAT, D390 type P, validated',
    async () => {
      const c = await company({
        today: '2026-10-30',
        validator: new DukIntegrator(dist),
        facts: {
          ...scope,
          'vat.status': ['non_vat', '2020-01-01'],
          'vat.eu': ['special', '2026-02-01'],
          income_tax: ['micro', '2026-01-01'],
        },
      });
      const sale = await c.foreign({
        number: 'X-1',
        date: '2026-10-15',
        direction: 'sale',
        country: 'DE',
        counterparty: 'DE123456788',
        net: '7500.00',
        gross: '7500.00',
      });
      const booked = await c.s.book('invoices.crossBorder', {
        documentId: sale.id,
        account: '704',
        supply: 'services_general_rule',
      });
      expect(taxes(booked)).toEqual(['output EXP-EU-SERV 7500.00 0.00']);
      const closure = await c.closure('2026-10', '2026-10');
      expect(closure.unsupported.map((item) => item.trigger)).not.toContain('EU_SERVICES_NON_VAT');
      expect(closure.obligations.filter((item) => item.kind === 'D301')).toEqual([]);
      expect(closure.obligations.find((item) => item.kind === 'D390')).toMatchObject({
        state: 'applies',
      });
      const recap = await c.prepare('D390', '2026-10');
      expect(summary(recap).operations).toEqual([
        { type: 'P', country: 'DE', code: '123456788', name: 'Companie DE123456788', base: 7500 },
      ]);
      expect(recap.state).toBe('validated_official');
      // The sale abroad is not in the small-enterprise threshold's turnover (art. 310 alin. (2)).
      const threshold = find(await c.evaluate(2026), 'vat.threshold');
      expect(threshold.lines.join(' ')).toContain('0,00 lei');
    },
    120_000,
  );
});

describe('leaving the VAT system', () => {
  test('the cancellation as determined, the last D300 by the 25th after it, the capital goods adjusted', async () => {
    const c = await company({
      year: 2025,
      today: '2026-08-25',
      validator: validator(),
      facts: {
        ...scope,
        'vat.status': ['normal_vat', '2020-01-01'],
        'vat.cash': ['no', '2020-01-01'],
        'vat.period': ['quarterly', '2025-01-01'],
        income_tax: ['micro', '2025-01-01'],
      },
    });
    for (const kind of ['financial', 'fiscal'])
      await c.s.invoke(c.s.owner, 'years.create', {
        kind,
        label: '2026',
        from: '2026-01-01',
        to: '2026-12-31',
      });
    await c.record('vat.period', 'quarterly', '2026-01-01');
    await c.sell('V-2025', '2025-11-10', '100000.00', '21000.00');
    // A laptop bought in 2025 with its VAT deducted: a capital good until 2029.
    const laptop = await c.document({
      number: 'F-LAPTOP',
      date: '2025-09-10',
      net: '10000.00',
      tax: '2100.00',
      gross: '12100.00',
    });
    await c.s.book('invoices.recognize', { documentId: laptop.id, account: '214' });
    const asset = await c.s.invoke<{ id: string }>(c.s.owner, 'assets.register', {
      number: 'MF-1',
      name: 'Laptop',
      catalogCode: '2.2.9',
      account: '214',
      depreciationAccount: '2814',
      value: '10000.00',
      lifeMonths: 36,
      fiscalLifeMonths: 36,
      commissionedOn: '2025-09-15',
      documentId: laptop.id,
      evidenceId: (await c.s.evidence('pv-laptop.pdf')).id,
    });
    await c.sell('V-2026', '2026-06-10', '50000.00', '10500.00');
    // The cancellation's decision, communicated on 20 August 2026 (art. 310 alin. (7)).
    await c.record('vat.status', 'non_vat', '2026-08-20', 'decizie-anulare-tva.pdf');

    expect(find(await c.evaluate(2026), 'vat.status')).toMatchObject({
      status: 'proposed',
      value: 'normal_vat',
      changes: [{ value: 'non_vat', effectiveFrom: '2026-08-20' }],
      recorded: { agrees: true },
    });
    // The last return: the third quarter up to 19 August, due by 25 September.
    expect(
      (await c.calendar('2026-07', '2026-09')).filter((row) => row.startsWith('D300')),
    ).toEqual(['D300 2026-Q3 2026-09-25 due']);
    const view = await c.registration(2026);
    expect(view.deregistration).toMatchObject({
      date: '2026-08-20',
      eligible: true,
      lastReturn: { period: '2026-Q3', due: '2026-09-25' },
      // 2.100 lei deducted, 2025–2029: four years left with 2026, 4/5 of it.
      capitalGoods: [
        { assetId: asset.id, documentId: laptop.id, taxPeriod: '2025-Q3', adjustment: '-1680.00' },
      ],
      total: '-1680.00',
    });

    const adjusted = await c.s.book('vat.capitalGoods', {
      event: 'deregistration',
      date: '2026-08-20',
      postingDate: '2026-08-31',
      goods: [{ assetId: asset.id, documentId: laptop.id, taxPeriod: '2025-Q3' }],
      inventoryEvidenceId: (await c.s.evidence('inventar-2026-08-20.pdf')).id,
      evidenceId: (await c.s.evidence('decizie-anulare-tva-2.pdf')).id,
    });
    expect(lines(adjusted)).toEqual(['D 635 1680.00', 'C 4426 1680.00']);
    expect(taxes(adjusted)).toEqual(['input ADJ-305 0.00 -1680.00']);
    const last = await c.prepare('D300', '2026-Q3', d300);
    expect(summary(last).rows).toMatchObject({ R31_2: -1680 });
    validated(last);
    // Its D394 holds the invoices of the days still registered, not the adjustment.
    const informative = await c.s.invoke<Artifact>(c.s.owner, 'declarations.prepare', {
      kind: 'D394',
      period: '2026-Q3',
      options: {
        caen: '6201',
        phone: '0236123456',
        representative: { name: 'Popescu Ana', role: 'Administrator', address: 'Galați' },
        preparer: {
          kind: 'company',
          cui: '14399840',
          name: 'Contabil SRL',
          capacity: 'Împuternicit',
        },
        consultation: true,
        affiliates: false,
      },
    });
    validated(informative);
  });

  test('a cancellation the law does not allow is contradicted by the computation', async () => {
    const c = await company({
      year: 2025,
      today: '2026-08-25',
      facts: {
        ...scope,
        'vat.status': ['normal_vat', '2020-01-01'],
        'vat.cash': ['no', '2020-01-01'],
        'vat.period': ['monthly', '2025-01-01'],
        income_tax: ['micro', '2025-01-01'],
      },
    });
    for (const kind of ['financial', 'fiscal'])
      await c.s.invoke(c.s.owner, 'years.create', {
        kind,
        label: '2026',
        from: '2026-01-01',
        to: '2026-12-31',
      });
    // 2025's turnover above the threshold: art. 310 alin. (7) does not allow leaving in 2026.
    await c.sell('V-2025', '2025-11-10', '400000.00', '84000.00');
    await c.record('vat.status', 'non_vat', '2026-08-20');
    expect(find(await c.evaluate(2026), 'vat.status')).toMatchObject({
      value: 'normal_vat',
      changes: [],
      recorded: { agrees: false },
    });
    expect((await c.closure('2026-09', '2026-09')).needs).toContainEqual(
      expect.objectContaining({ code: 'DETERMINATION_CONFLICT', fact: 'vat.status/2026' }),
    );
  });
});
