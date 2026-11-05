import { afterAll, describe, expect, test } from 'bun:test';
import path from 'node:path';
import { agent as module } from 'xfactura-core/ro/exempt';
import {
  AnafKits,
  DukIntegrator,
  saftKitId,
} from '../../source/engine/adapters/declaration-validator';
import type { ProposalView } from '../../source/engine/kernel/views';
import type { WorkItem } from '../../source/engine/kernel/work';
import { invoiceXml, type XmlInput } from './fixtures/invoice';
import { journal, scenario, type Scenario } from './scenario';
import type { Issued } from './fixtures/sales';

// Synthetic companies and documents; amounts computed by hand:
//   a pro-rata of 60.000 / (60.000 + 40.000) = 60%; 2.100 lei of VAT at 50% = 1.050, at 60% =
//   1.260 (210 more); a building's 105.000 lei of VAT over 20 years at a 70% use: 3.675 − 5.250 =
//   −1.575; stock of 10.000 lei at 21%: 2.100.
const open: Scenario[] = [];
afterAll(async () => {
  await Promise.all(open.map((s) => s.dispose()));
});
const dist = path.join(import.meta.dir, '../../../..', '.validators/anaf/dist');
const installed = DukIntegrator.available(dist) && Bun.which('java') !== null;
const validator = () => (installed ? new DukIntegrator(dist) : undefined);
const saftDist = path.join(
  import.meta.dir,
  '../../../..',
  '.validators/anaf-saft/duk_SAFT_an_luna/dist',
);
const saft = DukIntegrator.available(saftDist) && Bun.which('java') !== null ? test : test.skip;
type Artifact = { id: string; state: string; steps: { state: string; detail: string | null }[] };
/** ANAF's validator when installed: the return's state is then checked too, never assumed. */
const validated = (artifact: Artifact) => {
  if (installed)
    expect([artifact.state, artifact.steps.at(-1)?.detail ?? null]).toEqual([
      'validated_official',
      null,
    ]);
};
const summary = (artifact: Artifact) => JSON.parse(artifact.steps[0]!.detail ?? 'null');
const CUI = '18547290';
const declarant = { lastName: 'Popescu', firstName: 'Ana', role: 'Administrator' };
const d300 = { caen: '6820', bank: 'Banca Exemplu', account: 'RO49AAAA1B31007593840000' };
const d394 = {
  caen: '6820',
  phone: '0236123456',
  representative: { name: 'Popescu Ana', role: 'Administrator', address: 'Galați' },
  preparer: { kind: 'company', cui: '14399840', name: 'Contabil SRL', capacity: 'Împuternicit' },
  consultation: true,
  affiliates: false,
};
const scope = {
  'entity.form': ['srl', '2020-01-01'],
  'activity.goods': ['no', '2020-01-01'],
  'regime.excluded': ['none', '2020-01-01'],
  employer: ['no', '2020-01-01'],
  'vat.status': ['normal_vat', '2020-01-01'],
  'vat.cash': ['no', '2020-01-01'],
  income_tax: ['micro', '2026-01-01'],
} as Record<string, [string, string]>;

const lines = (proposal: ProposalView) =>
  proposal.effect?.lines.map((line) => `${line.side} ${line.account} ${line.amount}`);
const taxes = (proposal: ProposalView) =>
  proposal.effect?.taxEntries.map(
    (entry) => `${entry.direction} ${entry.code} ${entry.base} ${entry.amount}`,
  );
const codes = (proposal: ProposalView) => proposal.issues.map((issue) => issue.code);

/** An invoice in an exempt category with its reason in the breakdown (BT-121, else BT-120). */
const exemptXml = (input: XmlInput & { reason?: string }) => {
  const xml = invoiceXml({ category: 'E', rate: '0', tax: '0.00', gross: input.net, ...input });
  if (!input.reason) return xml;
  const element = input.reason.startsWith('VATEX-')
    ? `<cbc:TaxExemptionReasonCode>${input.reason}</cbc:TaxExemptionReasonCode>`
    : `<cbc:TaxExemptionReason>${input.reason}</cbc:TaxExemptionReason>`;
  return xml.replace(
    /(<cac:TaxSubtotal>.*?<cac:TaxCategory><cbc:ID>[EKG]<\/cbc:ID><cbc:Percent>0<\/cbc:Percent>)/,
    `$1${element}`,
  );
};

async function company(options: {
  today: string;
  facts: Record<string, [string, string]>;
  year?: number;
  saft?: boolean;
}) {
  let now = Date.parse(`${options.today}T10:00:00Z`);
  const s = await scenario({
    year: options.year ?? 2026,
    cui: CUI,
    clock: () => now,
    ...(options.saft
      ? {
          declarationValidator: new AnafKits({ saft: new DukIntegrator(saftDist, saftKitId) }),
        }
      : validator()
        ? { declarationValidator: validator() }
        : {}),
  });
  open.push(s);
  const record = async (axis: string, value: string, effectiveFrom: string) =>
    s.invoke<{ id: string }>(s.owner, 'profile.record', {
      axis,
      value,
      effectiveFrom,
      evidenceId: (await s.evidence(`${axis}-${value}-${effectiveFrom}.pdf`)).id,
    });
  for (const [axis, [value, from]] of Object.entries(options.facts))
    await record(axis, value, from);
  await s.invoke(s.owner, 'sales.seller.record', {
    details: {
      name: 'Exemplu Imobiliare SRL',
      vatId: `RO${CUI}`,
      address: { lines: ['Str. Lungă 10'], city: 'Galați', subdivision: 'RO-GL', country: 'RO' },
    },
  });
  const file = async (filename: string, text: string) =>
    (
      await s.invoke<{ id: string }>(s.owner, 'evidence.record', {
        filename,
        mediaType: 'application/xml',
        base64: Buffer.from(text).toString('base64'),
      })
    ).id;
  const importXml = async (number: string, xml: string) =>
    s.invoke<{ id: string }>(s.owner, 'invoices.import', {
      evidenceId: await file(`${number}.xml`, xml),
    });
  const document = (input: XmlInput) =>
    importXml(input.number!, invoiceXml({ company: CUI, ...input }));
  const exempt = (input: XmlInput & { reason?: string }) =>
    importXml(input.number!, exemptXml({ company: CUI, ...input }));
  /** Proposes, approves acknowledging the codes the reviewer confirms, and posts. */
  const book = async (
    treatment: string,
    input: unknown,
    acknowledge: string[] = [],
    basis?: string[],
  ) => {
    const proposal = await s.invoke<ProposalView>(s.owner, 'proposals.propose', {
      treatment,
      input,
      ...(basis ? { basis: { answers: basis } } : {}),
    });
    expect(proposal.issues.filter((issue) => issue.severity === 'block')).toEqual([]);
    return s.post(await s.approve(proposal, s.reviewer, acknowledge));
  };
  /** Revises a proposal (the input, or the answers it cites), approves and posts it. */
  const rebook = async (
    proposal: ProposalView,
    input: unknown,
    acknowledge: string[] = [],
    basis?: string[],
  ) => {
    const revised = await s.invoke<ProposalView>(s.owner, 'proposals.revise', {
      proposalId: proposal.id,
      version: proposal.version,
      input,
      ...(basis ? { basis: { answers: basis } } : {}),
    });
    expect(revised.issues.filter((issue) => issue.severity === 'block')).toEqual([]);
    return s.post(await s.approve(revised, s.reviewer, acknowledge));
  };
  const prepare = (kind: string, period: string, options: Record<string, unknown>) =>
    s.invoke<Artifact>(s.owner, 'declarations.prepare', { kind, period, options });
  return {
    s,
    record,
    document,
    exempt,
    book,
    rebook,
    prepare,
    setToday: (date: string) => (now = Date.parse(`${date}T10:00:00Z`)),
    work: async () =>
      (await s.invoke<{ items: WorkItem[] }>(s.owner, 'work.list', { limit: 200 })).items,
  };
}

describe('exempt purchases', () => {
  test('an insurance invoice: no VAT, D300 rd. 29, not in D394, with its reason', async () => {
    const c = await company({
      today: '2026-11-20',
      facts: { ...scope, 'vat.period': ['monthly', '2026-01-01'] },
    });
    // The insurer is registered for VAT: its exempt invoice is not listed in D394.
    const policy = await c.exempt({
      number: 'POL-1',
      date: '2026-10-05',
      net: '1200.00',
      counterparty: 'RO14399840',
      reason: 'VATEX-EU-135-1',
    });
    const insured = await c.book('invoices.recognize', { documentId: policy.id, account: '613' });
    expect(lines(insured)).toEqual(['D 613 1200.00', 'C 401 1200.00']);
    expect(taxes(insured)).toEqual(['input EX-IN 1200.00 0.00']);
    expect(insured.effect!.taxEntries[0]!.attributes).toMatchObject({
      category: 'E',
      reason: 'VATEX-EU-135-1',
    });
    // A taxable purchase beside it.
    const service = await c.document({
      number: 'F-1',
      date: '2026-10-12',
      net: '1000.00',
      tax: '210.00',
      gross: '1210.00',
      counterparty: 'RO14399840',
    });
    await c.book('invoices.recognize', { documentId: service.id, account: '628' });
    const vat = await c.prepare('D300', '2026-10', { declarant, ...d300 });
    expect(summary(vat).rows).toMatchObject({ R26_1: 1200, R22_1: 1000, R22_2: 210, R28_2: 210 });
    validated(vat);
    const informative = await c.prepare('D394', '2026-10', d394);
    expect(informative.state).not.toBe('blocked');
    validated(informative);

    // From a supplier not registered for VAT (its CUI without RO): an acquisition of type N
    // (OPANAF nr. 3.769/2015 anexa nr. 2 secțiunea a 2-a pct. 2), by invoice, without VAT.
    const unregistered = await c.exempt({
      number: 'MED-1',
      date: '2026-11-03',
      net: '300.00',
      counterparty: '10376500',
      reason: 'Scutit conform art. 292 alin. (1) lit. a) din Codul fiscal',
    });
    await c.book('invoices.recognize', { documentId: unregistered.id, account: '628' });
    // Outside the scope of VAT (O), from a company outside VAT: D300 rd. 29 and N as well.
    const small = await c.document({
      number: 'MIC-1',
      date: '2026-11-06',
      category: 'O',
      rate: '0',
      net: '450.00',
      tax: '0.00',
      gross: '450.00',
      counterparty: '6859662',
    });
    const outside = await c.book('invoices.recognize', { documentId: small.id, account: '628' });
    expect(taxes(outside)).toEqual(['input O 450.00 0.00']);
    // An individual's invoice (a CNP): N with the nature of what was bought, which is asked.
    const individual = await c.exempt({
      number: 'IND-1',
      date: '2026-11-07',
      net: '150.40',
      counterparty: '1900101400012',
      reason: 'Scutit conform art. 292 alin. (2) lit. e) din Codul fiscal',
    });
    await c.book('invoices.recognize', { documentId: individual.id, account: '612' });
    // Rent owed to an individual under a contract (no invoice): N, a contract, services.
    const landlord = await c.s.invoke<{ id: string }>(c.s.owner, 'parties.create', {
      kind: 'ro_individual',
      country: 'RO',
      name: 'Popescu Ana',
    });
    await c.book('payees.recognize', {
      kind: 'rent',
      partyId: landlord.id,
      evidenceId: (await c.s.evidence('contract-inchiriere.pdf')).id,
      date: '2026-11-30',
      period: '2026-11',
      amount: '2500.00',
      account: '612',
    });

    // A credit note on the insurance keeps its exempt code: rd. 29 goes down by its base.
    const refund = await c.exempt({
      number: 'POL-1-ST',
      date: '2026-10-25',
      net: '200.00',
      credit: true,
      originalNumber: 'POL-1',
      counterparty: 'RO14399840',
      reason: 'VATEX-EU-135-1',
    });
    const credited = await c.book('invoices.credit', {
      documentId: refund.id,
      originalDocumentId: policy.id,
      account: '613',
    });
    expect(taxes(credited)).toEqual(['input EX-IN -200.00 0.00']);
    const november = await c.prepare('D300', '2026-11', { declarant, ...d300 });
    // 300 + 450 + 150,40: exempt and outside the scope of VAT, base only.
    expect(summary(november).rows).toMatchObject({ R26_1: 900 });
    validated(november);
    // Without the individual's nature and the landlord's CNP, D394 asks for them.
    const refused = await c.s.refused(c.prepare('D394', '2026-11', d394));
    expect(JSON.stringify(refused)).toContain('D394_NATURE');
    expect(JSON.stringify(refused)).toContain('D394_CNP');
    await c.s.invoke(c.s.owner, 'parties.recordCnp', {
      partyId: landlord.id,
      cnp: '2900101400022',
    });
    const statement = await c.prepare('D394', '2026-11', {
      ...d394,
      natures: { [individual.id]: '35' },
    });
    expect(summary(statement).operations).toEqual([
      { type: 'N', rate: '0', partner: 'Companie 10376500', invoices: 1, base: 300, vat: 0 },
      { type: 'N', rate: '0', partner: 'Companie 6859662', invoices: 1, base: 450, vat: 0 },
      { type: 'N', rate: '0', partner: 'Companie 1900101400012', invoices: 1, base: 150, vat: 0 },
      { type: 'N', rate: '0', partner: 'Popescu Ana', invoices: 1, base: 2500, vat: 0 },
    ]);
    validated(statement);
  });

  test('a K invoice received is an intra-community acquisition of goods: refused', async () => {
    const c = await company({
      today: '2026-11-20',
      facts: { ...scope, 'vat.period': ['monthly', '2026-01-01'] },
    });
    const goods = await c.exempt({
      number: 'DE-1',
      date: '2026-10-05',
      net: '800.00',
      category: 'K',
      country: 'DE',
      counterparty: 'DE123456788',
      reason: 'VATEX-EU-IC',
    });
    const proposal = await c.s.propose('invoices.recognize', {
      documentId: goods.id,
      account: '628',
    });
    expect(codes(proposal)).toContain('INTRA_EU_GOODS');
  });
});

describe('exempt rent and the pro-rata', () => {
  test('provisional through the year, the definitive adjusted in December', async () => {
    const c = await company({
      today: '2026-10-31',
      facts: {
        ...scope,
        'vat.period': ['monthly', '2026-01-01'],
        'vat.prorata': ['50', '2026-01-01'],
      },
    });
    const sale = await c.document({
      number: 'V-1',
      date: '2026-10-10',
      direction: 'sale',
      net: '60000.00',
      tax: '12600.00',
      gross: '72600.00',
      counterparty: 'RO14399840',
    });
    await c.book('invoices.recognize', { documentId: sale.id, account: '704' });
    // A rent without the option to tax: exempt, its basis named.
    const rent = await c.exempt({
      number: 'V-2',
      date: '2026-10-01',
      direction: 'sale',
      net: '40000.00',
      counterparty: 'RO14399840',
      reason: 'VATEX-EU-135-1',
    });
    const missing = await c.s.propose('invoices.recognize', {
      documentId: rent.id,
      account: '706',
    });
    expect(codes(missing)).toContain('EXEMPTION_BASIS');
    const rented = await c.rebook(missing, {
      documentId: rent.id,
      account: '706',
      exemption: 'art.292(2)(e)',
    });
    expect(taxes(rented)).toEqual(['output EX-292 40000.00 0.00']);
    // An overhead for both kinds of operations: half its VAT at the provisional pro-rata.
    const overhead = await c.document({
      number: 'F-2',
      date: '2026-10-15',
      net: '10000.00',
      tax: '2100.00',
      gross: '12100.00',
      counterparty: 'RO14399840',
    });
    const mixed = await c.book('invoices.recognize', {
      documentId: overhead.id,
      account: '628',
      deduction: 'prorata',
    });
    expect(lines(mixed)).toEqual(['D 628 11050.00', 'D 4426 1050.00', 'C 401 12100.00']);
    expect(mixed.effect!.taxEntries[0]!.attributes).toMatchObject({
      prorata: '50',
      prorataTax: '210000',
      prorataDeducted: '105000',
    });
    // A purchase for the taxable services only: deducted in full, confirmed by the reviewer.
    const direct = await c.document({
      number: 'F-3',
      date: '2026-10-20',
      net: '1000.00',
      tax: '210.00',
      gross: '1210.00',
      counterparty: 'RO14399840',
    });
    const proposal = await c.s.propose('invoices.recognize', {
      documentId: direct.id,
      account: '628',
    });
    expect(codes(proposal)).toContain('PRORATA_DIRECT');
    await c.s.post(await c.s.approve(proposal, c.s.reviewer, ['PRORATA_DIRECT']));

    const october = await c.prepare('D300', '2026-10', { declarant, ...d300 });
    expect(summary(october).rows).toMatchObject({
      R9_1: 60000,
      R9_2: 12600,
      R15_1: 40000,
      R22_1: 11000,
      R22_2: 2310,
      R28_2: 1260,
    });
    validated(october);
    // Both sales were invoiced outside the engine's series; the exempt rent is not listed.
    const informative = await c.prepare('D394', '2026-10', {
      ...d394,
      outsideSeries: {
        allocated: [{ series: 'V', first: '1', last: '2' }],
        issued: [{ series: 'V', first: '1', last: '2' }],
        invoices: 2,
      },
    });
    validated(informative);

    // December: the definitive pro-rata and its adjustment.
    c.setToday('2026-12-15');
    expect((await c.work()).filter((item) => item.kind === 'vat.prorata')).toMatchObject([
      { subject: { kind: 'prorata', id: '2026/definitive' }, severity: 'warn' },
    ]);
    const computed = await c.s.invoke<{
      definitive: { percent: number } | null;
      adjustment: string | null;
      provisional: { percent: number | null };
    }>(c.s.owner, 'vat.proRata.compute', { year: 2026 });
    expect(computed).toMatchObject({
      definitive: { percent: 60 },
      adjustment: '210.00',
      provisional: { percent: 50 },
    });
    const adjusted = await c.book('vat.proRata', {
      year: 2026,
      date: '2026-12-31',
      evidenceId: (await c.s.evidence('calcul-pro-rata-2026.pdf')).id,
    });
    expect(lines(adjusted)).toEqual(['D 4426 210.00', 'C 7588 210.00']);
    expect(taxes(adjusted)).toEqual(['input ADJ-300 0.00 210.00']);
    expect((await c.work()).filter((item) => item.kind === 'vat.prorata')).toEqual([]);
    const december = await c.prepare('D300', '2026-12', { declarant, ...d300 });
    expect(summary(december).rows).toMatchObject({ R31_2: 210 });
    expect(summary(december).proRata).toBe('60');
    expect(december.state).not.toBe('blocked');
    validated(december);

    // The adjustment reversed in December: its definitive pro-rata goes with it. The return's
    // header is the provisional again, rd. 34 nets to nothing, and the year waits on its
    // adjustment once more.
    const storno = await c.s.propose('ledger.reverse', {
      entryId: adjusted.entry!.id,
      date: '2026-12-31',
      reason: 'Calculul pro rata se reface',
      evidenceId: (await c.s.evidence('storno-pro-rata.pdf')).id,
      method: 'red',
    });
    await c.s.post(await c.s.approve(storno));
    const again = await c.prepare('D300', '2026-12', { declarant, ...d300 });
    expect(summary(again).proRata).toBe('50');
    expect(summary(again).rows.R31_2 ?? 0).toBe(0);
    expect((await c.work()).filter((item) => item.kind === 'vat.prorata')).toMatchObject([
      { subject: { kind: 'prorata', id: '2026/definitive' }, severity: 'warn' },
    ]);
    expect(
      (await c.s.invoke<{ posted: unknown }>(c.s.owner, 'vat.proRata.compute', { year: 2026 }))
        .posted,
    ).toBeNull();
  });

  test('without a provisional pro-rata: the purchase asks, the closure needs it', async () => {
    const c = await company({
      today: '2026-10-31',
      facts: { ...scope, 'vat.period': ['monthly', '2026-01-01'] },
    });
    const rent = await c.exempt({
      number: 'V-9',
      date: '2026-10-01',
      direction: 'sale',
      net: '5000.00',
      counterparty: 'RO14399840',
      reason: 'VATEX-EU-135-1',
    });
    await c.book('invoices.recognize', {
      documentId: rent.id,
      account: '706',
      exemption: 'art.292(2)(e)',
    });
    const overhead = await c.document({
      number: 'F-9',
      date: '2026-10-15',
      net: '100.00',
      tax: '21.00',
      gross: '121.00',
      counterparty: 'RO14399840',
    });
    const proposal = await c.s.propose('invoices.recognize', {
      documentId: overhead.id,
      account: '628',
      deduction: 'prorata',
    });
    expect(codes(proposal)).toContain('PRORATA_MISSING');
    const closure = await c.s.invoke<{ status: string; needs: { fact: string }[] }>(
      c.s.owner,
      'closure.evaluate',
      { from: '2026-10', to: '2026-10' },
    );
    expect(closure.needs.map((need) => need.fact)).toContain('vat.prorata/2026');
    expect((await c.work()).find((item) => item.kind === 'vat.prorata')).toMatchObject({
      severity: 'block',
    });
    expect(module.detectors.map((item) => item.kind)).toContain('vat.prorata');
  });
});

describe('a capital good', () => {
  test('changing use: a building leased 30% exempt adjusts a twentieth in the month', async () => {
    const c = await company({
      today: '2026-07-31',
      facts: {
        ...scope,
        'vat.period': ['monthly', '2026-01-01'],
        'vat.prorata': ['100', '2026-01-01'],
      },
    });
    const invoice = await c.document({
      number: 'C-1',
      date: '2026-02-10',
      net: '500000.00',
      tax: '105000.00',
      gross: '605000.00',
      counterparty: 'RO14399840',
    });
    await c.book('invoices.recognize', { documentId: invoice.id, account: '212' }, [
      'PRORATA_DIRECT',
    ]);
    const building = await c.s.invoke<{ id: string }>(c.s.owner, 'assets.register', {
      number: 'C-1',
      name: 'Clădire birouri',
      catalogCode: '1.6.2',
      account: '212',
      depreciationAccount: '2812',
      value: '500000.00',
      lifeMonths: 480,
      fiscalLifeMonths: 480,
      commissionedOn: '2026-02-15',
      documentId: invoice.id,
      evidenceId: (await c.s.evidence('pv-cladire.pdf')).id,
    });
    const input = {
      event: 'use',
      date: '2026-07-01',
      postingDate: '2026-07-31',
      goods: [{ assetId: building.id, documentId: invoice.id, taxPeriod: '2026-02' }],
      evidenceId: (await c.s.evidence('contract-inchiriere.pdf')).id,
    };
    // Without the use stated, the adjustment asks for it.
    const asking = await c.s.propose('vat.capitalGoods', input);
    expect(codes(asking)).toContain('CAPITAL_GOOD_USE');
    const asked = await c.s.invoke<{ id: string }>(c.s.owner, 'questions.ask', {
      kind: 'capitalGood.use',
      subject: { kind: 'asset', id: building.id },
      params: { date: '2026-07-01' },
    });
    await c.s.invoke(c.s.owner, 'questions.answer', {
      questionId: asked.id,
      value: {
        share: '70',
        from: '2026-07-01',
        evidenceId: (await c.s.evidence('contract-chirie-30.pdf')).id,
      },
    });
    const adjusted = await c.rebook(asking, input, [], [asked.id]);
    expect(lines(adjusted)).toEqual(['D 635 1575.00', 'C 4426 1575.00']);
    expect(taxes(adjusted)).toEqual(['input ADJ-305 0.00 -1575.00']);
    // The part leased exempt, invoiced in July: D300 rd. 15, not listed in D394.
    const lease = await c.exempt({
      number: 'V-30',
      date: '2026-07-01',
      direction: 'sale',
      net: '3000.00',
      counterparty: 'RO14399840',
      reason: 'VATEX-EU-135-1',
    });
    await c.book('invoices.recognize', {
      documentId: lease.id,
      account: '706',
      exemption: 'art.292(2)(e)',
    });
    // The rest leased with the option to tax (art. 292 alin. (3)), its notification the evidence.
    const taxedRent = await c.document({
      number: 'V-31',
      date: '2026-07-01',
      direction: 'sale',
      net: '7000.00',
      tax: '1470.00',
      gross: '8470.00',
      counterparty: 'RO14399840',
    });
    const optioned = await c.book('invoices.recognize', {
      documentId: taxedRent.id,
      account: '706',
      optionEvidenceId: (await c.s.evidence('notificare-optiune-taxare.pdf')).id,
    });
    expect(optioned.effect!.taxEntries[0]!.attributes).toMatchObject({ option: 'art.292(3)' });
    const july = await c.prepare('D300', '2026-07', { declarant, ...d300 });
    expect(summary(july).rows).toMatchObject({
      R9_1: 7000,
      R9_2: 1470,
      R15_1: 3000,
      R31_2: -1575,
    });
    validated(july);
    validated(
      await c.prepare('D394', '2026-07', {
        ...d394,
        outsideSeries: {
          allocated: [{ series: 'V', first: '30', last: '31' }],
          issued: [{ series: 'V', first: '30', last: '31' }],
          invoices: 2,
        },
      }),
    );

    const register = await c.s.invoke<{
      goods: {
        number: string;
        state: string;
        use: { share: string } | null;
        adjustments: { year: string; amount: string }[];
      }[];
    }>(c.s.owner, 'vat.capitalGoods.register', {});
    expect(register.goods).toMatchObject([
      {
        number: 'C-1',
        state: 'adjusting',
        use: { share: '70' },
        adjustments: [{ year: '2026', amount: '-1575.00' }],
      },
    ]);
    // The year was adjusted at the event: neither the worklist nor the year's adjustment repeats it.
    c.setToday('2026-12-15');
    expect((await c.work()).filter((item) => item.kind === 'vat.capitalGoods')).toEqual([]);
    const again = await c.s.invoke<ProposalView>(c.s.owner, 'proposals.propose', {
      treatment: 'vat.capitalGoods',
      input: { ...input, event: 'year', date: '2026-12-31', postingDate: '2026-12-31' },
      basis: { answers: [asked.id] },
    });
    expect(codes(again)).toContain('NOTHING');

    // Sold exempt (an old building, art. 292 alin. (2) lit. f)) in December: once for the period
    // left, 2026 to 2045, less what 2026 already adjusted: 105.000 × 20 / 20 → −105.000 + 1.575.
    const sale = await c.exempt({
      number: 'V-40',
      date: '2026-12-10',
      direction: 'sale',
      net: '450000.00',
      counterparty: 'RO14399840',
      reason: 'VATEX-EU-135-1',
    });
    const supplied = await c.book('vat.capitalGoods', {
      event: 'supply',
      date: '2026-12-10',
      postingDate: '2026-12-10',
      goods: [{ assetId: building.id, documentId: invoice.id, taxPeriod: '2026-02' }],
      evidenceId: (await c.s.evidence('contract-vanzare.pdf')).id,
      saleDocumentId: sale.id,
    });
    expect(lines(supplied)).toEqual(['D 635 103425.00', 'C 4426 103425.00']);
  });
});

describe('exempt sales with the right of deduction', () => {
  test('an intra-community supply (rd. 1, D390 L) and an export (rd. 14)', async () => {
    const c = await company({
      today: '2026-11-20',
      facts: { ...scope, 'vat.period': ['monthly', '2026-01-01'] },
    });
    const supply = await c.exempt({
      number: 'X-1',
      date: '2026-10-08',
      direction: 'sale',
      net: '2000.00',
      category: 'K',
      country: 'DE',
      counterparty: 'DE123456788',
      reason: 'VATEX-EU-IC',
    });
    const supplied = await c.book(
      'invoices.recognize',
      { documentId: supply.id, account: '707', exemption: 'art.294(2)(a)' },
      ['EXEMPTION_PROOF'],
    );
    expect(taxes(supplied)).toEqual(['output EX-IC 2000.00 0.00']);
    const exported = await c.exempt({
      number: 'X-2',
      date: '2026-10-09',
      direction: 'sale',
      net: '3000.00',
      category: 'G',
      country: 'US',
      counterparty: 'US-5550001',
      reason: 'VATEX-EU-G',
    });
    // The basis must fit the category: an export is not an intra-community supply.
    const wrong = await c.s.propose('invoices.recognize', {
      documentId: exported.id,
      account: '707',
      exemption: 'art.294(2)(a)',
    });
    expect(codes(wrong)).toContain('EXEMPTION_CATEGORY');
    const booked = await c.rebook(
      wrong,
      { documentId: exported.id, account: '707', exemption: 'art.294(1)(a)-(b)' },
      ['EXEMPTION_PROOF'],
    );
    expect(taxes(booked)).toEqual(['output EX-EXPORT 3000.00 0.00']);
    const vat = await c.prepare('D300', '2026-10', { declarant, ...d300 });
    expect(summary(vat).rows).toMatchObject({ R1_1: 2000, R14_1: 3000 });
    validated(vat);
    const recapitulative = await c.prepare('D390', '2026-10', { declarant });
    expect(summary(recapitulative)).toMatchObject({
      operations: [expect.objectContaining({ type: 'L', country: 'DE' })],
    });
    validated(recapitulative);
  });
});

describe('SAF-T', () => {
  saft(
    'an exempt purchase, an exempt rent issued by the engine, a taxable sale, a purchase under the pro-rata and one outside the scope of VAT pass D406',
    async () => {
      const c = await company({
        today: '2026-11-20',
        facts: {
          ...scope,
          'vat.period': ['monthly', '2026-01-01'],
          'vat.prorata': ['60', '2026-01-01'],
        },
        saft: true,
      });
      const s = c.s;
      await s.invoke(s.owner, 'treasury.createAccount', {
        kind: 'bank',
        name: 'Cont curent',
        iban: d300.account,
        currency: 'RON',
        ledgerAccount: '5121',
        openedOn: '2026-01-01',
      });
      await s.book(
        'ledger.general',
        journal(
          (await s.evidence('balanta-deschidere.pdf')).id,
          [
            { account: '5121', side: 'D', amount: '20000.00' },
            { account: '1012', side: 'C', amount: '20000.00' },
          ],
          { date: '2026-01-01', purpose: 'opening' },
        ),
      );
      const tenant = await s.party('Chiriaș SRL', '14399840');
      await s.invoke(s.owner, 'parties.recordDetails', {
        partyId: tenant.id,
        details: {
          name: 'Chiriaș SRL',
          vatId: 'RO14399840',
          address: { lines: ['Bd. Unirii 5'], city: 'Brașov', subdivision: 'RO-BV', country: 'RO' },
        },
      });
      const series = await s.invoke<{ id: string }>(s.owner, 'sales.series.create', {
        code: 'XF',
        prefix: 'XF',
        width: 4,
        revenueAccount: '706',
      });
      const line = (price: string, vat: Record<string, string>) => ({
        name: 'Chirie spațiu birou, octombrie 2026',
        quantity: '1',
        unitCode: 'C62',
        price,
        vat,
      });
      // An exempt rent issued without its basis is refused; with it, its recognition is proposed.
      const issue = (lines: unknown[], extra: Record<string, unknown> = {}) =>
        s.invoke<Issued>(s.owner, 'sales.issue', {
          seriesId: series.id,
          buyerId: tenant.id,
          issueDate: '2026-10-01',
          lines,
          ...extra,
        });
      expect(
        JSON.stringify(
          await s.refused(
            issue([line('4000', { category: 'E', exemptionCode: 'VATEX-EU-135-1' })]),
          ),
        ),
      ).toContain('EXEMPTION_BASIS');
      const rent = await issue([line('4000', { category: 'E', exemptionCode: 'VATEX-EU-135-1' })], {
        exemption: 'art.292(2)(e)',
      });
      const proposal = await s.invoke<ProposalView>(s.owner, 'proposals.get', {
        id: rent.recognition.proposalId,
      });
      const posted = await s.post(await s.approve(proposal));
      expect(taxes(posted)).toEqual(['output EX-292 4000.00 0.00']);
      const taxable = await issue([line('1000', { category: 'S', rate: '21' })]);
      await s.post(
        await s.approve(
          await s.invoke<ProposalView>(s.owner, 'proposals.get', {
            id: taxable.recognition.proposalId,
          }),
        ),
      );
      const policy = await c.exempt({
        number: 'POL-7',
        date: '2026-10-05',
        net: '1200.00',
        counterparty: 'RO31552803',
        reason: 'VATEX-EU-135-1',
      });
      const supplier = (
        await s.invoke<{ partyId: string }>(s.owner, 'documents.get', { id: policy.id })
      ).partyId;
      await s.invoke(s.owner, 'parties.recordDetails', {
        partyId: supplier,
        details: {
          name: 'Asigurări Exemplu SA',
          vatId: 'RO31552803',
          address: {
            lines: ['Str. Mare 1'],
            city: 'Cluj-Napoca',
            subdivision: 'RO-CJ',
            country: 'RO',
          },
        },
      });
      await c.book('invoices.recognize', { documentId: policy.id, account: '613' });
      const details = async (documentId: string, name: string, id: string) => {
        const { partyId } = await s.invoke<{ partyId: string }>(s.owner, 'documents.get', {
          id: documentId,
        });
        await s.invoke(s.owner, 'parties.recordDetails', {
          partyId,
          details: {
            name,
            ...(id.startsWith('RO') ? { vatId: id } : { legalId: id }),
            address: {
              lines: ['Str. Mică 2'],
              city: 'Galați',
              subdivision: 'RO-GL',
              country: 'RO',
            },
          },
        });
      };
      // For both kinds of operations, at the provisional pro-rata of 60%: Achizitii baserate.
      const overhead = await c.document({
        number: 'F-9',
        date: '2026-10-15',
        net: '1000.00',
        tax: '210.00',
        gross: '1210.00',
        counterparty: 'RO13548146',
      });
      await details(overhead.id, 'Servicii Comune SRL', 'RO13548146');
      const mixed = await c.book('invoices.recognize', {
        documentId: overhead.id,
        account: '628',
        deduction: 'prorata',
      });
      expect(lines(mixed)).toEqual(['D 628 1084.00', 'D 4426 126.00', 'C 401 1210.00']);
      // Outside the scope of VAT (O), from a company outside VAT: rd. 29's code, 308302.
      const small = await c.document({
        number: 'MIC-9',
        date: '2026-10-16',
        category: 'O',
        rate: '0',
        net: '450.00',
        tax: '0.00',
        gross: '450.00',
        counterparty: '6859662',
      });
      await details(small.id, 'Mică Întreprindere SRL', '6859662');
      await c.book('invoices.recognize', { documentId: small.id, account: '628' });
      const file = await c.prepare('D406', '2026-10', {
        contact: { firstName: 'Ana', lastName: 'Popescu', phone: '0236000000' },
      });
      expect([file.state, file.steps.at(-1)?.detail ?? null]).toEqual(['validated_official', null]);
      const { base64 } = await s.invoke<{ base64: string }>(s.owner, 'evidence.get', {
        id: (file as Artifact & { evidenceId: string }).evidenceId,
      });
      const xml = Buffer.from(base64, 'base64').toString();
      const details406 = [
        ...xml.matchAll(/<nsSAFT:TaxCodeDetails>(.*?)<\/nsSAFT:TaxCodeDetails>/gs),
      ]
        .map((match) => match[1]!.replace(/\s+/g, ''))
        .map((text) => [
          /<nsSAFT:TaxCode>(\d+)</.exec(text)![1],
          [...text.matchAll(/<nsSAFT:BaseRate>([^<]+)</g)].map((rate) => rate[1]).join(','),
        ]);
      expect(details406).toContainEqual(['361104', '0.6000']);
      expect(details406).toContainEqual(['308302', '1']);
      expect(details406.filter(([, rate]) => rate !== '1')).toEqual([['361104', '0.6000']]);
    },
  );
});

describe('a cancellation of the registration with stock', () => {
  test('the stock’s VAT is adjusted in the last return (art. 304)', async () => {
    const c = await company({
      today: '2026-08-25',
      facts: { ...scope, 'vat.period': ['quarterly', '2026-01-01'] },
    });
    await c.s.book(
      'ledger.general',
      journal(
        (await c.s.evidence('inventar-deschidere.pdf')).id,
        [
          { account: '371', side: 'D', amount: '10000.00' },
          { account: '1012', side: 'C', amount: '10000.00' },
        ],
        { date: '2026-01-01', purpose: 'opening' },
      ),
    );
    const sale = await c.document({
      number: 'V-7',
      date: '2026-07-10',
      direction: 'sale',
      net: '5000.00',
      tax: '1050.00',
      gross: '6050.00',
      counterparty: 'RO14399840',
    });
    await c.book('invoices.recognize', { documentId: sale.id, account: '707' });
    await c.record('vat.status', 'non_vat', '2026-08-20');
    const input = {
      event: 'deregistration',
      date: '2026-08-20',
      postingDate: '2026-08-31',
      goods: [],
      inventoryEvidenceId: (await c.s.evidence('inventar-2026-08-20.pdf')).id,
      evidenceId: (await c.s.evidence('decizie-anulare.pdf')).id,
    };
    // The stock not listed: refused.
    const unlisted = await c.s.propose('vat.capitalGoods', input);
    expect(codes(unlisted)).toContain('STOCK_UNLISTED');
    const adjusted = await c.rebook(
      unlisted,
      { ...input, stock: [{ account: '371', value: '10000.00', rate: '21' }] },
      ['STOCK_RATE'],
    );
    expect(lines(adjusted)).toEqual(['D 635 2100.00', 'C 4426 2100.00']);
    expect(taxes(adjusted)).toEqual(['input ADJ-304 0.00 -2100.00']);
    const last = await c.prepare('D300', '2026-Q3', { declarant, ...d300 });
    expect(summary(last).rows).toMatchObject({ R9_1: 5000, R9_2: 1050, R31_2: -2100 });
    validated(last);
    const informative = await c.prepare('D394', '2026-Q3', {
      ...d394,
      outsideSeries: {
        allocated: [{ series: 'V', first: '7', last: '7' }],
        issued: [{ series: 'V', first: '7', last: '7' }],
        invoices: 1,
      },
    });
    validated(informative);
  });
});

describe('the pro-rata after a storno', () => {
  const cui = '18547290';
  // prorataYear sums `attributes.prorataTax` / `prorataDeducted`, which a storno negates.
  test('a mixed purchase reversed in the year leaves no pro-rata adjustment', async () => {
    let now = Date.parse('2026-10-31T10:00:00Z');
    const s = await scenario({ cui, clock: () => now });
    open.push(s);
    for (const [axis, value, from] of [
      ['entity.form', 'srl', '2020-01-01'],
      ['activity.goods', 'no', '2020-01-01'],
      ['regime.excluded', 'none', '2020-01-01'],
      ['employer', 'no', '2020-01-01'],
      ['vat.status', 'normal_vat', '2020-01-01'],
      ['vat.cash', 'no', '2020-01-01'],
      ['income_tax', 'micro', '2026-01-01'],
      ['vat.period', 'monthly', '2026-01-01'],
      ['vat.prorata', '50', '2026-01-01'],
    ] as const)
      await s.invoke(s.owner, 'profile.record', {
        axis,
        value,
        effectiveFrom: from,
        evidenceId: (await s.evidence(`${axis}-${value}.pdf`)).id,
      });
    await s.invoke(s.owner, 'sales.seller.record', {
      details: {
        name: 'Exemplu Imobiliare SRL',
        vatId: `RO${cui}`,
        address: { lines: ['Str. Lungă 10'], city: 'Galați', subdivision: 'RO-GL', country: 'RO' },
      },
    });
    const importXml = async (number: string, xml: string) =>
      s.invoke<{ id: string }>(s.owner, 'invoices.import', {
        evidenceId: (
          await s.invoke<{ id: string }>(s.owner, 'evidence.record', {
            filename: `${number}.xml`,
            mediaType: 'application/xml',
            base64: Buffer.from(xml).toString('base64'),
          })
        ).id,
      });
    const book = async (treatment: string, input: unknown, acknowledge: string[] = []) => {
      const proposal = await s.invoke<ProposalView>(s.owner, 'proposals.propose', {
        treatment,
        input,
      });
      expect(proposal.issues.filter((issue) => issue.severity === 'block')).toEqual([]);
      return s.post(await s.approve(proposal, s.reviewer, acknowledge));
    };
    const sale = await importXml(
      'V-1',
      invoiceXml({
        company: cui,
        number: 'V-1',
        date: '2026-10-10',
        direction: 'sale',
        net: '60000.00',
        tax: '12600.00',
        gross: '72600.00',
        counterparty: 'RO14399840',
      }),
    );
    await book('invoices.recognize', { documentId: sale.id, account: '704' });
    const rent = await importXml(
      'V-2',
      invoiceXml({
        company: cui,
        number: 'V-2',
        date: '2026-10-01',
        direction: 'sale',
        category: 'E',
        rate: '0',
        tax: '0.00',
        net: '40000.00',
        gross: '40000.00',
        counterparty: 'RO14399840',
      }).replace(
        /(<cac:TaxSubtotal>.*?<cac:TaxCategory><cbc:ID>[EKG]<\/cbc:ID><cbc:Percent>0<\/cbc:Percent>)/,
        `$1<cbc:TaxExemptionReasonCode>VATEX-EU-135-1</cbc:TaxExemptionReasonCode>`,
      ),
    );
    await book('invoices.recognize', {
      documentId: rent.id,
      account: '706',
      exemption: 'art.292(2)(e)',
    });
    const overhead = await importXml(
      'F-2',
      invoiceXml({
        company: cui,
        number: 'F-2',
        date: '2026-10-15',
        net: '10000.00',
        tax: '2100.00',
        gross: '12100.00',
        counterparty: 'RO14399840',
      }),
    );
    const mixed = await book('invoices.recognize', {
      documentId: overhead.id,
      account: '628',
      deduction: 'prorata',
    });
    // The mixed purchase is reversed in the same month (booked by mistake).
    const reversal = await s.propose('ledger.reverse', {
      entryId: mixed.entry!.id,
      date: '2026-10-25',
      reason: 'Factura înregistrată din greșeală',
      evidenceId: (await s.evidence('storno.pdf')).id,
      method: 'black',
    });
    expect(reversal.issues.filter((issue) => issue.severity === 'block')).toEqual([]);
    await s.post(await s.approve(reversal, s.reviewer));

    now = Date.parse('2026-12-15T10:00:00Z');
    const computed = await s.invoke<{ adjustment: string | null; definitive: unknown }>(
      s.owner,
      'vat.proRata.compute',
      { year: 2026 },
    );
    // No mixed purchase stands in 2026: nothing to adjust.
    expect(computed.adjustment ?? '0.00').toBe('0.00');
  });
});
