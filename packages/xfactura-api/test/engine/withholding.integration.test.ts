import { afterAll, describe, expect, test } from 'bun:test';
import path from 'node:path';
import * as withholdingAgent from 'xfactura-core/ro/withholding/agent';
import { questionKindIds } from 'xfactura-core/questions/kinds';
import { sourceXml, type XmlElement } from 'xfactura-core/xml';
import { DukIntegrator } from '../../source/engine/adapters/declaration-validator';
import { workKinds } from '../../source/engine/kernel/work';
import type { ProposalView } from '../../source/engine/kernel/views';
import { journal, scenario, type Scenario } from './scenario';

const open: Scenario[] = [];
afterAll(async () => {
  await Promise.all(open.map((s) => s.dispose()));
});

const general = path.join(import.meta.dir, '../../../..', '.validators/anaf/dist');
// ANAF's DUKIntegrator for D100, D205 and D207 (D406's SAF-T kit runs in d406.integration):
// without it or Java the official tests are skipped, never passed.
const official = DukIntegrator.available(general) && Bun.which('java') ? test : test.skip;

const cui = '18547290';
const iban = 'RO49AAAA1B31007593840000';
const declarant = { lastName: 'Popescu', firstName: 'Ana', role: 'Administrator' };

type Artifact = {
  id: string;
  state: string;
  evidenceId: string;
  steps: { state: string; detail: string | null }[];
};

/** A synthetic CNP with a valid control digit. */
const cnp = (body: string) => {
  const weights = [2, 7, 9, 1, 4, 6, 3, 5, 8, 2, 7, 9];
  const control =
    weights.reduce((sum, weight, index) => sum + weight * Number(body[index]), 0) % 11;
  return `${body}${control === 10 ? 1 : control}`;
};

const lines = (proposal: ProposalView) =>
  proposal.effect?.lines.map((line) => `${line.side} ${line.account} ${line.amount}`);
const codes = (proposal: ProposalView) => proposal.issues.map((issue) => issue.code);
/** What a posting withheld, as its explanation records it. */
const withheldOf = (proposal: ProposalView) =>
  (proposal.effect!.explanation.details as { withholding: Record<string, unknown> }).withholding;

/** A company outside VAT with 100,000 lei of retained profit, its details, a bank account, the
 * tax authority, an individual (landlord, author and shareholder) and a Romanian company. */
async function company(validator?: DukIntegrator) {
  const s = await scenario({ cui, ...(validator ? { declarationValidator: validator } : {}) });
  open.push(s);
  await s.invoke(s.owner, 'sales.seller.record', {
    details: {
      name: 'Exemplu Servicii SRL',
      vatId: `RO${cui}`,
      address: { lines: ['Str. Lungă 10'], city: 'Galați', subdivision: 'RO-GL', country: 'RO' },
    },
  });
  await s.invoke(s.owner, 'treasury.createAccount', {
    kind: 'bank',
    name: 'Cont curent',
    iban,
    currency: 'RON',
    ledgerAccount: '5121',
    openedOn: '2026-01-01',
  });
  await s.book(
    'ledger.general',
    journal(
      (await s.evidence('balanta-deschidere.pdf')).id,
      [
        { account: '5121', side: 'D', amount: '100000.00' },
        { account: '1171', side: 'C', amount: '100000.00' },
      ],
      { date: '2026-01-01', purpose: 'opening' },
    ),
  );
  const party = (kind: string, name: string, extra: Record<string, string> = {}) =>
    s.invoke<{ id: string }>(s.owner, 'parties.create', {
      kind,
      country: 'RO',
      name,
      ...extra,
    });
  const anaf = await party('ro_public_institution', 'ANAF');
  const person = await party('ro_individual', 'Popescu Ana');
  await s.invoke(s.owner, 'parties.recordCnp', { partyId: person.id, cnp: cnp('285072217002') });
  const holding = await party('ro_legal_entity', 'Holding Exemplu SRL', { taxId: '14399840' });
  const book = async (treatment: string, input: unknown, acknowledge: string[] = []) =>
    s.post(await s.approve(await s.propose(treatment, input), s.reviewer, acknowledge));
  const prepare = (
    kind: string,
    period: string,
    options: Record<string, unknown> = { declarant },
  ) => s.invoke<Artifact>(s.owner, 'declarations.prepare', { kind, period, options });
  const summary = (artifact: Artifact) =>
    JSON.parse(artifact.steps[0]!.detail!) as Record<string, unknown>;
  const fileOf = async (artifact: Artifact) => {
    const { base64 } = await s.invoke<{ base64: string }>(s.owner, 'evidence.get', {
      id: artifact.evidenceId,
    });
    return sourceXml(new Uint8Array(Buffer.from(base64, 'base64')));
  };
  return { s, anaf, person, holding, book, prepare, summary, fileOf };
}

/** The rent of a month owed to the landlord, then paid with its tax withheld. */
async function rent(
  books: Awaited<ReturnType<typeof company>>,
  period: string,
  amount: string,
  paid: string,
) {
  const { s, anaf, person, book } = books;
  const owed = await book('payees.recognize', {
    kind: 'rent',
    partyId: person.id,
    evidenceId: (await s.evidence('contract-inchiriere.pdf')).id,
    date: `${period}-28`,
    period,
    amount,
    account: '612',
  });
  const tax = await book('payees.withhold', {
    openItem: owed.effect!.openItems[0]!.id,
    date: paid,
    gross: amount,
    authorityId: anaf.id,
  });
  return { owed, tax };
}

const children = (node: XmlElement, local: string): XmlElement[] =>
  node.children.flatMap((child) => (child.local === local ? [child] : children(child, local)));
const attribute = (node: XmlElement, name: string) => node.attributes[name];

describe('rent paid to an individual', () => {
  test('612 = 462 from the contract, 10% of the gross less 20% withheld at payment (462 = 446)', async () => {
    const books = await company();
    const { s, anaf, person, holding, book } = books;
    const proposed = await s.propose('payees.recognize', {
      kind: 'rent',
      partyId: person.id,
      evidenceId: (await s.evidence('contract-inchiriere.pdf')).id,
      date: '2026-03-31',
      period: '2026-03',
      amount: '2500.00',
      account: '612',
    });
    expect(lines(proposed)).toEqual(['D 612 2500.00', 'C 462 2500.00']);
    const owed = await s.post(await s.approve(proposed));
    const item = owed.effect!.openItems[0]!.id;
    const withheld = await s.propose('payees.withhold', {
      openItem: item,
      date: '2026-04-05',
      gross: '2500.00',
      authorityId: anaf.id,
    });
    // 2,500 − 20% = 2,000 net, 10% of it: 200 lei.
    expect(lines(withheld)).toEqual(['D 462 200.00', 'C 446 200.00']);
    expect(codes(withheld)).toEqual(['RENT_CASS']);
    expect(withheldOf(withheld)).toEqual({
      type: '628',
      taxCode: '628010',
      regime: 'domestic',
      rate: '10',
      base: '200000',
      gross: '250000',
      tax: '20000',
      annual: 'D205',
    });
    await s.post(await s.approve(withheld));
    // A company's rent is invoiced, not withheld; rent of another account is refused.
    const refused = await s.propose('payees.recognize', {
      kind: 'rent',
      partyId: holding.id,
      evidenceId: (await s.evidence('contract-2.pdf')).id,
      date: '2026-03-31',
      period: '2026-03',
      amount: '1000.00',
      account: '628',
    });
    expect(codes(refused)).toEqual(['BENEFICIARY', 'ACCOUNT']);
    // Paying more than owed is refused.
    const second = await book('payees.recognize', {
      kind: 'rent',
      partyId: person.id,
      evidenceId: (await s.evidence('contract-3.pdf')).id,
      date: '2026-04-30',
      period: '2026-04',
      amount: '1234.56',
      account: '612',
    });
    const over = await s.propose('payees.withhold', {
      openItem: second.effect!.openItems[0]!.id,
      date: '2026-05-05',
      gross: '2000.00',
      authorityId: anaf.id,
    });
    expect(codes(over)).toEqual(['AMOUNT']);
    // 1,234.56 − 246.91 = 987.65 net; 98.765 lei, withheld as 99 lei.
    const odd = await s.revise('payees.withhold', over, {
      openItem: second.effect!.openItems[0]!.id,
      date: '2026-05-05',
      gross: '1234.56',
      authorityId: anaf.id,
    });
    expect(lines(odd)).toEqual(['D 462 99.00', 'C 446 99.00']);
  });

  official(
    "the month's D100 (628) and the year's D205 (tip 29) pass ANAF's validator; the calendar lists both",
    async () => {
      const books = await company(new DukIntegrator(general));
      const { s, prepare, summary, fileOf } = books;
      await rent(books, '2026-03', '2500.00', '2026-04-05');
      await rent(books, '2026-04', '2500.00', '2026-05-05');
      const april = await prepare('D100', '2026-04');
      expect(summary(april).obligations).toEqual(['628']);
      expect(april.state).toBe('validated_official');
      const obligation = children(await fileOf(april), 'obligatie')[0]!;
      expect(
        ['cod_oblig', 'cod_bugetar', 'scadenta', 'suma_dat', 'suma_plata'].map((name) =>
          attribute(obligation, name),
        ),
      ).toEqual(['628', '5503XXXXXX', '25.05.2026', '200', '200']);
      const d205 = await prepare('D205', '2026', { declarant, paidAs: 'gross' });
      expect([d205.state, d205.steps.at(-1)?.detail ?? null]).toEqual(['validated_official', null]);
      const record = children(await fileOf(d205), 'benef')[0]!;
      expect(
        ['tip_venit1', 'tip_plata', 'Rezid', 'baza1', 'imp1', 'VB', 'GAR'].map((name) =>
          attribute(record, name),
        ),
      ).toEqual(['29', '2', '1', '4000', '400', '0', '0']);
      const calendar = await s.invoke<{
        items: { kind: string; period: string; deadline: string }[];
      }>(s.owner, 'obligations.calendar', { from: '2026-04', to: '2026-12' });
      const returns = calendar.items.map((item) => `${item.kind} ${item.period} ${item.deadline}`);
      expect(returns).toContain('D100 2026-04 D100.withholding');
      expect(returns).toContain('D100 2026-05 D100.withholding');
      expect(returns).toContain('D205 2026 D205');
    },
    180_000,
  );
});

describe('intellectual property paid to an individual', () => {
  test('10% of the gross less 40%, declared in D112: the facts of the contract are asked, and the closure lists D112 as unsupported', async () => {
    const { s, anaf, person, book, prepare } = await company();
    const owed = await book('payees.recognize', {
      kind: 'royalties',
      partyId: person.id,
      evidenceId: (await s.evidence('contract-cesiune.pdf')).id,
      date: '2026-04-30',
      period: '2026-04',
      amount: '10000.00',
      account: '628',
    });
    expect(lines(owed)).toEqual(['D 628 10000.00', 'C 462 10000.00']);
    const item = owed.effect!.openItems[0]!.id;
    const input = { openItem: item, date: '2026-05-10', gross: '10000.00', authorityId: anaf.id };
    const asked = await s.propose('payees.withhold', input);
    expect(codes(asked)).toEqual(['IP_FACTS']);
    const contributions = await s.revise('payees.withhold', asked, {
      ...input,
      royalties: { contributionsByContract: true, realSystem: false, collectiveShare: false },
    });
    expect(codes(contributions)).toEqual(['IP_CONTRIBUTIONS']);
    const withheld = await s.revise('payees.withhold', contributions, {
      ...input,
      royalties: { contributionsByContract: false, realSystem: false, collectiveShare: false },
    });
    // 10,000 − 40% = 6,000 net, 10%: 600 lei.
    expect(lines(withheld)).toEqual(['D 462 600.00', 'C 446 600.00']);
    expect(codes(withheld)).toEqual(['IP_D112']);
    await s.post(await s.approve(withheld));
    // Not in D100 nor D205: the month has nothing for D100.
    expect(JSON.stringify(await s.refused(prepare('D100', '2026-05')))).toContain('D100_NOTHING');
    const closure = await s.invoke<{
      status: string;
      unsupported: { trigger: string; missingCapabilities: string[] }[];
    }>(s.owner, 'closure.evaluate', { from: '2026-05', to: '2026-05' });
    expect(closure.status).toBe('UNSUPPORTED');
    expect(closure.unsupported.map((item) => item.trigger)).toContain('D112_INTELLECTUAL_PROPERTY');
  });
});

describe('interim dividends', () => {
  test('463 = 456 within the distributable profit, taxed when paid, regularized 457 = 463 against the annual dividends', async () => {
    const { s, anaf, person, holding, book } = await company();
    await book(
      'ledger.general',
      journal(
        (await s.evidence('incasari.pdf')).id,
        [
          { account: '5121', side: 'D', amount: '30000.00' },
          { account: '704', side: 'C', amount: '30000.00' },
        ],
        { date: '2026-05-15' },
      ),
    );
    const interim = (amounts: [string, string]) =>
      s.invoke<{ id: string }>(s.owner, 'evidence.record', {
        filename: 'situatii-interimare.pdf',
        mediaType: 'application/pdf',
        base64: Buffer.from(`interim ${amounts.join(' ')}`).toString('base64'),
      });
    const input = async (amounts: [string, string]) => ({
      date: '2026-08-10',
      evidenceId: (await s.evidence('hotarare-aga-interimar.pdf')).id,
      statementsEvidenceId: (await interim(amounts)).id,
      quarterEnd: '2026-06-30',
      reserves: '1500.00',
      fromReserves: '0.00',
      shareholders: [
        { partyId: person.id, amount: amounts[0] },
        { partyId: holding.id, amount: amounts[1] },
      ],
    });
    // 30,000 profit + 100,000 retained − 1,500 reserves = 128,500 distributable.
    const tooMuch = await s.propose('dividends.interim', await input(['120000.00', '10000.00']));
    expect(codes(tooMuch)).toEqual(['DISTRIBUTABLE']);
    const proposed = await s.propose('dividends.interim', await input(['20000.00', '10000.00']));
    expect(lines(proposed)).toEqual([
      'D 463 20000.00',
      'C 456 20000.00',
      'D 463 10000.00',
      'C 456 10000.00',
    ]);
    expect(codes(proposed)).toEqual(['INTERIM_STATEMENTS']);
    const distributed = await s.post(await s.approve(proposed, s.reviewer, ['INTERIM_STATEMENTS']));
    const owedTo = (partyId: string) =>
      distributed.effect!.openItems.find(
        (item) => item.partyId === partyId && item.controlAccount === '456',
      )!.id;
    // Paid on 20 August: 16% withheld from the individual at the interim decision's rate.
    const paid = await s.propose('dividends.withhold', {
      distributionEntryId: distributed.entry!.id,
      openItem: owedTo(person.id),
      date: '2026-08-20',
      gross: '20000.00',
      authorityId: anaf.id,
    });
    expect(lines(paid)).toEqual(['D 456 3200.00', 'C 446 3200.00']);
    expect(paid.effect!.explanation.details).toMatchObject({ interim: true, rate: '16' });
    await s.post(await s.approve(paid));

    // The year's statements are approved in 2027: the annual dividends regularize the interim.
    for (const kind of ['financial', 'fiscal'])
      await s.invoke(s.owner, 'years.create', {
        kind,
        label: '2027',
        from: '2027-01-01',
        to: '2027-12-31',
      });
    const annual = async (amounts: [string, string]) =>
      book('dividends.distribute', {
        date: '2027-05-10',
        evidenceId: (await s.evidence(`hotarare-aga-2027-${amounts[0]}.pdf`)).id,
        shareholders: [
          { partyId: person.id, amount: amounts[0] },
          { partyId: holding.id, amount: amounts[1] },
        ],
      });
    const small = await annual(['15000.00', '10000.00']);
    const excess = await s.propose('dividends.regularize', {
      distributionEntryId: small.entry!.id,
      interimEntryIds: [distributed.entry!.id],
      date: '2027-05-10',
    });
    expect(codes(excess)).toEqual(['INTERIM_EXCESS']);
    const full = await annual(['25000.00', '10000.00']);
    const regularized = await s.propose('dividends.regularize', {
      distributionEntryId: full.entry!.id,
      interimEntryIds: [distributed.entry!.id],
      date: '2027-05-10',
    });
    expect(lines(regularized)).toEqual([
      'D 457 20000.00',
      'C 463 20000.00',
      'D 457 10000.00',
      'C 463 10000.00',
    ]);
    await s.post(await s.approve(regularized));
    // 463 is settled by the interim dividends; what the annual dividends add (5,000 lei to the
    // individual) is paid from 457 with its tax, the interim ones still owed from 456.
  });
});

/** A non-resident's royalty owed for a software licence (Dr 628 / Cr 401), and the answers and
 * evidence a person gives about it. */
async function licence(
  books: Awaited<ReturnType<typeof company>>,
  amount: string,
  date: string,
  taxId = 'DE123456789',
) {
  const { s } = books;
  const supplier = await s.invoke<{ id: string }>(s.owner, 'parties.create', {
    kind: 'eu_taxable',
    country: 'DE',
    taxId,
    name: `Software GmbH ${taxId.slice(-3)}`,
  });
  const owed = await books.book(
    'ledger.general',
    journal(
      (await s.evidence('factura-licenta.pdf')).id,
      [
        { account: '628', side: 'D', amount },
        { account: '401', side: 'C', amount, newItem: 'licenta' },
      ],
      { date, newItems: [{ ref: 'licenta', partyId: supplier.id }] },
    ),
  );
  return { supplier, item: owed.effect!.openItems[0]!.id };
}

async function answer(s: Scenario, kind: string, partyId: string, params: unknown, value: unknown) {
  const asked = await s.invoke<{ id: string }>(s.owner, 'questions.ask', {
    kind,
    subject: { kind: 'party', id: partyId },
    params,
  });
  await s.invoke(s.owner, 'questions.answer', { questionId: asked.id, value });
  return asked.id;
}

describe('a software licence from a non-resident', () => {
  test('asks what it is, withholds 16% without a certificate and asks for it, the treaty rate with one', async () => {
    const books = await company();
    const { s, anaf } = books;
    const { supplier, item } = await licence(books, '4000.00', '2026-03-05');
    const input = {
      openItem: item,
      date: '2026-03-20',
      gross: '4000.00',
      authorityId: anaf.id,
      noExchangeOfInformation: false,
      borneBy: 'beneficiary',
    };
    // What the licence is: never guessed.
    const unknown = await s.propose('nonresidents.withhold', input);
    expect(codes(unknown)).toEqual(['NONRESIDENT_PAYEE']);
    expect(unknown.issues[0]!.details).toMatchObject({
      question: { kind: 'nonresident.payee', subject: { kind: 'party', id: supplier.id } },
    });
    const work = await s.invoke<{ items: { kind: string; details: Record<string, unknown> }[] }>(
      s.owner,
      'work.list',
      {},
    );
    expect(work.items.map((entry) => entry.kind)).toContain('question.needed');
    const payee = await answer(
      s,
      'nonresident.payee',
      supplier.id,
      {},
      {
        income: 'royalties',
        beneficiary: 'company',
        contractEvidenceId: (await s.evidence('contract-licenta.pdf')).id,
        reason:
          'Licența acordă dreptul de a reproduce și distribui programul (art. 3 din contract).',
      },
    );
    const propose = (basis: string[], overrides: Record<string, unknown> = {}) =>
      s.invoke<ProposalView>(s.owner, 'proposals.propose', {
        treatment: 'nonresidents.withhold',
        input: { ...input, ...overrides },
        basis: { answers: basis },
      });
    // Without a certificate: the domestic 16%, and the certificate is asked for.
    const domestic = await s.invoke<ProposalView>(s.owner, 'proposals.revise', {
      proposalId: unknown.id,
      version: unknown.version,
      input,
      basis: { answers: [payee] },
    });
    expect(lines(domestic)).toEqual(['D 401 640.00', 'C 446 640.00']);
    expect(codes(domestic)).toEqual(['WHT_CERTIFICATE', 'WHT_DIRECTIVE_INTEREST']);
    expect(withheldOf(domestic)).toMatchObject({
      type: '633',
      taxCode: '633010',
      regime: 'domestic',
      rate: '16',
      annual: 'D207',
      d207: { incomeType: '03', act: '1', state: 'DE', foreignId: 'DE123456789' },
    });
    // Borne by the payer, or paid to a state without exchange of information: not covered.
    expect(
      codes(await propose([payee], { date: '2026-03-21', gross: '1.00', borneBy: 'payer' })),
    ).toEqual(['WHT_BORNE_BY_PAYER']);
    expect(
      codes(
        await propose([payee], {
          date: '2026-03-22',
          gross: '1.00',
          noExchangeOfInformation: true,
        }),
      ),
    ).toEqual(['WHT_50']);
    await s.post(
      await s.approve(domestic, s.reviewer, ['WHT_CERTIFICATE', 'WHT_DIRECTIVE_INTEREST']),
    );

    // A second licence, paid after the certificate and the treaty's article were presented.
    const second = await licence(books, '2000.00', '2026-04-05', 'DE987654321');
    const certificate = await answer(
      s,
      'nonresident.certificate',
      second.supplier.id,
      { income: 'royalties' },
      {
        certificateEvidenceId: (await s.evidence('certificat-rezidenta.pdf')).id,
        state: 'DE',
        year: 2026,
        presentedOn: '2026-04-10',
        income: 'royalties',
        treatyEvidenceId: (await s.evidence('conventie-ro-de.pdf')).id,
        article: 'art. 12 alin. (2)',
        rate: '5',
      },
    );
    const payee2 = await answer(
      s,
      'nonresident.payee',
      second.supplier.id,
      {},
      {
        income: 'royalties',
        beneficiary: 'company',
        contractEvidenceId: (await s.evidence('contract-licenta-2.pdf')).id,
        reason: 'Aceeași licență de reproducere și distribuire.',
      },
    );
    const treaty = await s.invoke<ProposalView>(s.owner, 'proposals.propose', {
      treatment: 'nonresidents.withhold',
      input: { ...input, openItem: second.item, date: '2026-04-20', gross: '2000.00' },
      basis: { answers: [payee2, certificate] },
    });
    expect(lines(treaty)).toEqual(['D 401 100.00', 'C 446 100.00']);
    expect(codes(treaty)).toEqual(['WHT_DIRECTIVE_INTEREST']);
    expect(withheldOf(treaty)).toMatchObject({
      taxCode: '633050',
      regime: 'treaty',
      rate: '5',
      d207: { incomeType: '24', act: '2' },
    });
    // A payment before the certificate was presented takes the domestic rate.
    const early = await s.invoke<ProposalView>(s.owner, 'proposals.propose', {
      treatment: 'nonresidents.withhold',
      input: { ...input, openItem: second.item, date: '2026-04-08', gross: '1000.00' },
      basis: { answers: [payee2, certificate] },
    });
    expect(lines(early)).toEqual(['D 401 160.00', 'C 446 160.00']);
    expect(codes(early)).toContain('WHT_CERTIFICATE');
  });

  official(
    "D100 (633) and D207 pass ANAF's validator, with the treaty's rate under Act_N 2",
    async () => {
      const books = await company(new DukIntegrator(general));
      const { s, anaf, prepare, summary, fileOf } = books;
      const pay = async (
        amount: string,
        owedOn: string,
        date: string,
        withCertificate: boolean,
        taxId: string,
      ) => {
        const { supplier, item } = await licence(books, amount, owedOn, taxId);
        const answers = [
          await answer(
            s,
            'nonresident.payee',
            supplier.id,
            {},
            {
              income: 'royalties',
              beneficiary: 'company',
              contractEvidenceId: (await s.evidence('contract.pdf')).id,
              reason: 'Licența acordă dreptul de a reproduce programul.',
            },
          ),
          ...(withCertificate
            ? [
                await answer(
                  s,
                  'nonresident.certificate',
                  supplier.id,
                  { income: 'royalties' },
                  {
                    certificateEvidenceId: (await s.evidence('certificat.pdf')).id,
                    state: 'DE',
                    year: 2026,
                    presentedOn: owedOn,
                    income: 'royalties',
                    treatyEvidenceId: (await s.evidence('conventie.pdf')).id,
                    article: 'art. 12 alin. (2)',
                    rate: '5',
                  },
                ),
              ]
            : []),
        ];
        const proposal = await s.invoke<ProposalView>(s.owner, 'proposals.propose', {
          treatment: 'nonresidents.withhold',
          input: {
            openItem: item,
            date,
            gross: amount,
            authorityId: anaf.id,
            noExchangeOfInformation: false,
            borneBy: 'beneficiary',
          },
          basis: { answers },
        });
        await s.post(await s.approve(proposal, s.reviewer, codes(proposal)));
      };
      await pay('4000.00', '2026-03-05', '2026-03-20', false, 'DE123456789');
      await pay('2000.00', '2026-03-06', '2026-03-25', true, 'DE987654321');
      const march = await prepare('D100', '2026-03');
      expect(summary(march).obligations).toEqual(['633']);
      expect(march.state).toBe('validated_official');
      expect(attribute(children(await fileOf(march), 'obligatie')[0]!, 'suma_dat')).toBe('740');
      const d207 = await prepare('D207', '2026');
      expect([d207.state, d207.steps.at(-1)?.detail ?? null]).toEqual(['validated_official', null]);
      const records = children(await fileOf(d207), 'benef').map((record) =>
        ['tip_venit1', 'Stat_R', 'baza1', 'imp1', 'Act_N'].map((name) => attribute(record, name)),
      );
      expect(records).toEqual([
        ['03', 'DE', '4000', '640', '1'],
        ['24', 'DE', '2000', '100', '2'],
      ]);
      const calendar = await s.invoke<{ items: { kind: string; period: string }[] }>(
        s.owner,
        'obligations.calendar',
        { from: '2026-03', to: '2026-12' },
      );
      expect(calendar.items.map((item) => `${item.kind} ${item.period}`)).toEqual(
        expect.arrayContaining(['D100 2026-03', 'D207 2026']),
      );
    },
    180_000,
  );
});

describe('the withholding module for agents', () => {
  test('agent.ts names kinds the engine knows', () => {
    for (const detector of withholdingAgent.detectors)
      expect(workKinds as readonly string[]).toContain(detector.kind);
    for (const question of withholdingAgent.questions)
      expect(questionKindIds as readonly string[]).toContain(question.kind);
    expect(withholdingAgent.templates).toEqual([]);
  });
});
