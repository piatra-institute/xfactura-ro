import { afterAll, describe, expect, test } from 'bun:test';
import * as pitAgent from 'xfactura-core/ro/pit/agent';
import type { DeclarationValidator } from '../../source/engine/adapters/declaration-validator';
import { journal, scenario, type Scenario } from './scenario';

const open: Scenario[] = [];
afterAll(async () => {
  await Promise.all(open.map((s) => s.dispose()));
});

/** A validator that must not be called: the D212 for 2025's income has no official one. */
const unused: DeclarationValidator = {
  id: 'unused',
  validate: () => Promise.reject(new Error('validated')),
  pdf: () => Promise.reject(new Error('validated')),
};

type Artifact = {
  state: string;
  xmlHash: string;
  steps: { state: string; detail: string | null }[];
};
type Register = {
  final: boolean;
  sources: {
    sourceId: string;
    name: string;
    totals?: { gross: string; deductible: string; net: string; loss: string };
    shared?: { account: string; amount: string }[];
    norm?: { from: string; to: string; activeDays: number | null; adjusted: string };
    normRegister?: { value: string }[];
  }[];
  declared: { declared: true; kind: string; amount: string }[];
  contributions: {
    cumulated: string;
    cas: { base: string; due: string; deductible: string };
    cass: { base: string; due: string; deductible: string };
    cassOther: {
      declared: true;
      cumulated: string;
      band: number;
      base: string;
      due: string;
      withheld: string;
      plus: string;
      minus: string;
    } | null;
  } | null;
  tax: { taxable: string; real: string; norma: string; total: string } | null;
  issues: { code: string; severity: string }[];
};

/** A PFA keeping single-entry books from 1 January of `year`, outside VAT, with its accounts. */
async function person(year: number, accounts: string[]) {
  const s = await scenario({ year, declarationValidator: unused });
  open.push(s);
  const { id: certificate } = await s.evidence('certificat-inregistrare.pdf');
  for (const [axis, value] of [
    ['entity.form', 'pfa'],
    ['books.system', 'single'],
    ['cas.status', 'liable'],
    ['cass.exception', 'none'],
  ])
    await s.invoke(s.owner, 'profile.record', {
      axis,
      value,
      effectiveFrom: `${year}-01-01`,
      evidenceId: certificate,
    });
  for (const code of accounts)
    await s.invoke(s.owner, 'accounts.create', {
      code,
      name: `Analitic ${code}`,
      validFrom: `${year}-01-01`,
    });
  const source = (input: Record<string, unknown>) =>
    s.invoke<{ sourceId: string }>(s.owner, 'pfa.sources.record', {
      county: 'CJ',
      liberal: false,
      evidenceId: certificate,
      ...input,
    });
  /** A bank receipt (positive) or payment (negative) booked against an account. */
  const bank = async (date: string, account: string, amount: string) => {
    const negative = amount.startsWith('-');
    const value = amount.replace('-', '');
    await s.book(
      'ledger.general',
      journal(
        (await s.evidence(`extras-${date}-${account}.pdf`)).id,
        negative
          ? [
              { account, side: 'D', amount: value },
              { account: '5121', side: 'C', amount: value },
            ]
          : [
              { account: '5121', side: 'D', amount: value },
              { account, side: 'C', amount: value },
            ],
        { date },
      ),
    );
  };
  const register = (input: Record<string, unknown>) =>
    s.invoke<Register>(s.owner, 'pfa.fiscalRegister', { year, ...input });
  const holder = await s.invoke<{ id: string }>(s.owner, 'parties.create', {
    kind: 'ro_individual',
    country: 'RO',
    name: 'Popescu Ion (titular)',
  });
  await s.invoke(s.owner, 'parties.recordCnp', { partyId: holder.id, cnp: '1781105170030' });
  const prepare = (register: Record<string, unknown>) =>
    s.invoke<Artifact>(s.owner, 'declarations.prepare', {
      kind: 'D212',
      period: String(year),
      options: {
        holderPartyId: holder.id,
        taxpayer: { lastName: 'Popescu', firstName: 'Ion', address: 'Str. Exemplu nr. 2, Cluj' },
        register,
      },
    });
  return { s, certificate, source, bank, register, prepare };
}

const xmlOf = async (s: Scenario, artifact: Artifact) =>
  new TextDecoder().decode(await s.objects.get(s.company.id, artifact.xmlHash));
const attributes = (xml: string, name: string) =>
  [...xml.matchAll(new RegExp(`<${name} ([^>]*?)/?>`, 'g'))].map((match) =>
    Object.fromEntries([...match[1]!.matchAll(/([\w:-]+)="([^"]*)"/g)].map((m) => [m[1], m[2]])),
  );
const codes = (register: Register) => register.issues.map((issue) => issue.code);

describe('several sources in a year (OMFP nr. 3.254/2017 art. 3–5)', () => {
  /**
   * 2025: software (6201) and consulting (7022), both in the real system. Receipts 60,000 on
   * 704.SW and 40,000 on 704.CONS; 10,000 paid on 628.SW; a 5,000 phone bill on 626 serving both.
   * Computed by hand: by gross income the phone splits 3,000 / 2,000, so 47,000 + 38,000 =
   * 85,000 lei net; CAS on 12 wages (48,600) 12,150; CASS 8,500; both deductible in full (no
   * norm); 85,000 − 20,650 = 64,350 taxable, tax 6,435.
   */
  async function twoSources() {
    const context = await person(2025, ['704.SW', '704.CONS', '628.SW']);
    const software = await context.source({
      effectiveFrom: '2025-01-01',
      name: 'Dezvoltare software',
      caen: '6201',
      place: 'Str. Exemplu nr. 1, Cluj-Napoca',
      authorization: { number: 'F12/1/2025', date: '2024-12-20' },
      startedOn: '2025-01-01',
      method: 'sistem_real',
      realBasis: 'required',
    });
    const consulting = await context.source({
      effectiveFrom: '2025-01-01',
      name: 'Consultanță în afaceri',
      caen: '7022',
      place: 'Str. Exemplu nr. 1, Cluj-Napoca',
      authorization: { number: 'F12/2/2025', date: '2024-12-20' },
      startedOn: '2025-01-01',
      method: 'sistem_real',
      realBasis: 'required',
    });
    await context.bank('2025-03-10', '704.SW', '60000.00');
    await context.bank('2025-04-10', '704.CONS', '40000.00');
    await context.bank('2025-05-10', '628.SW', '-10000.00');
    await context.bank('2025-06-10', '626', '-5000.00');
    const { id: note } = await context.s.evidence('nota-repartizare-surse.pdf');
    const attribution = (key: Record<string, unknown>) => ({
      accounts: [
        { match: '704.SW', sourceId: software.sourceId },
        { match: '628.SW', sourceId: software.sourceId },
        { match: '704.CONS', sourceId: consulting.sourceId },
      ],
      shared: [{ match: '626', key, evidenceId: note }],
      evidenceId: note,
    });
    return { ...context, software, consulting, attribution };
  }

  test('without the attribution nothing is final; with it, one register per source', async () => {
    const { s, register, prepare, attribution, software, consulting } = await twoSources();
    const blind = await register({});
    expect(blind.final).toBe(false);
    expect(codes(blind)).toContain('PIT_SOURCE_UNATTRIBUTED');
    expect(JSON.stringify(await s.refused(prepare({})))).toContain('PIT_SOURCE_UNATTRIBUTED');

    const byGross = await register({ attribution: attribution({ kind: 'gross' }) });
    expect(byGross.final).toBe(true);
    expect(
      byGross.sources.map((source) => [source.sourceId, source.totals, source.shared]),
    ).toEqual([
      // By start, then name: consulting, then software.
      [
        consulting.sourceId,
        { gross: '40000.00', deductible: '2000.00', net: '38000.00', loss: '0.00' },
        [{ account: '626', amount: '-2000.00' }],
      ],
      [
        software.sourceId,
        { gross: '60000.00', deductible: '13000.00', net: '47000.00', loss: '0.00' },
        [{ account: '626', amount: '-3000.00' }],
      ],
    ]);
    expect(byGross.contributions).toMatchObject({
      cumulated: '85000.00',
      cas: { base: '48600.00', due: '12150.00', deductible: '12150.00' },
      cass: { base: '85000.00', due: '8500.00', deductible: '8500.00' },
    });
    expect(byGross.tax).toMatchObject({ taxable: '64350.00', real: '6435.00' });
    // The key is the person's, never a default: shares they state are used as stated.
    expect(codes(byGross)).toContain('PIT_SHARED_EXPENSE');
    const fixed = await register({
      attribution: attribution({
        kind: 'fixed',
        shares: [
          { sourceId: software.sourceId, percent: '50' },
          { sourceId: consulting.sourceId, percent: '50' },
        ],
      }),
    });
    expect(fixed.sources.map((source) => source.totals?.net)).toEqual(['37500.00', '47500.00']);
    const wrong = await register({
      attribution: attribution({
        kind: 'fixed',
        shares: [
          { sourceId: software.sourceId, percent: '50' },
          { sourceId: consulting.sourceId, percent: '40' },
        ],
      }),
    });
    expect(codes(wrong)).toContain('PIT_SHARED_KEY');
  });

  test('D212 for 2025: one cap11 per source, contributions and Section 4 on their sum', async () => {
    const { s, prepare, attribution } = await twoSources();
    // The attribution is the person's note (module.documentTypes).
    expect(pitAgent.documentTypes.map((item) => item.id)).toContain('pfa.attribution');
    const prepared = await prepare({ attribution: attribution({ kind: 'gross' }) });
    expect(prepared.state).toBe('prepared');
    const xml = await xmlOf(s, prepared);
    expect(
      attributes(xml, 'cap11').map((cap) => [
        cap.caen,
        cap.venit_brut,
        cap.chelt_deduc,
        cap.venit_net_anual,
      ]),
    ).toEqual([
      ['7022', '40000', '2000', '38000'],
      ['6201', '60000', '13000', '47000'],
    ]);
    expect(attributes(xml, 'oblig_realizat')[0]).toMatchObject({
      cas_total_ven: '85000',
      cas_baza: '48600',
      cas_datorat: '12150',
      cass_total_ven_ai: '85000',
      cass_datorat_ai: '8500',
      real_venit_net_recalculat_ai: '85000',
      real_venit_net_impozabil_ai: '64350',
      real_impozit_datorat_ai: '6435',
      dif_de_plata: '27085',
    });
  });

  test('income declared from outside the books: CASS of Section 3.2.2, marked declared', async () => {
    const { s, register, prepare, attribution, certificate } = await twoSources();
    const { id: statement } = await s.evidence('extras-dividende-2025.pdf');
    const dividends = {
      kind: 'dividends',
      amount: '30000.00',
      cassWithheld: '0',
      taxSettled: true,
      description: 'Dividende SRL Exemplu, impozit reținut la sursă',
      evidenceId: statement,
    };
    const withDividends = await register({
      attribution: attribution({ kind: 'gross' }),
      declaredIncome: [dividends],
    });
    // 30,000 lei reach 6 minimum wages (24,300), not 12: CASS on 24,300, 2,430 lei.
    expect(withDividends.contributions?.cassOther).toEqual({
      declared: true,
      cumulated: '30000.00',
      band: 1,
      base: '24300.00',
      due: '2430.00',
      withheld: '0.00',
      plus: '2430.00',
      minus: '0.00',
    });
    expect(withDividends.declared).toEqual([
      expect.objectContaining({ declared: true, kind: 'dividends' }),
    ]);
    // It changes neither CAS nor the business's CASS or tax.
    expect(withDividends.tax).toMatchObject({ real: '6435.00' });
    const prepared = await prepare({
      attribution: attribution({ kind: 'gross' }),
      declaredIncome: [dividends],
    });
    expect(prepared.state).toBe('prepared');
    expect(attributes(await xmlOf(s, prepared), 'oblig_realizat')[0]).toMatchObject({
      cass_ven_inv: '30000',
      cass_baza: '24300',
      cass_datorat: '2430',
      bifa_cass_real: '1',
      bifa_cass_datorat_dpi: '1',
      cass_plus: '10930',
      dif_de_plata: '29515',
    });
    expect(JSON.parse(prepared.steps[0]!.detail!).declared).toEqual([
      expect.objectContaining({ declared: true, kind: 'dividends', taxSettled: true }),
    ]);
    // Rent from an individual is taxed in its own subsection, which is not written: refused.
    const rent = {
      ...dividends,
      kind: 'rent',
      amount: '12000.00',
      taxSettled: false,
      description: 'Chirie apartament, contract înregistrat',
      evidenceId: certificate,
    };
    const refused = await s.refused(
      prepare({ attribution: attribution({ kind: 'gross' }), declaredIncome: [rent] }),
    );
    expect(JSON.stringify(refused)).toContain('D212_DECLARED_TAX');
  });
});

describe('a change of method within the year, and 2026', () => {
  test('a norm until a non-nomenclator activity starts, then the real system (norme pct. 8 alin. (13))', async () => {
    const { s, source, bank, register, prepare } = await person(2026, [
      '704.CR',
      '628.CR',
      '704.REP',
    ]);
    const tailoring = await source({
      effectiveFrom: '2026-01-01',
      name: 'Croitorie',
      caen: '1413',
      place: 'Str. Exemplu nr. 2, Cluj-Napoca',
      authorization: { number: 'F12/3/2025', date: '2025-11-25' },
      startedOn: '2026-01-01',
      method: 'norma',
    });
    const repairs = await source({
      effectiveFrom: '2026-07-01',
      name: 'Reparații electronice',
      caen: '9521',
      place: 'Str. Exemplu nr. 2, Cluj-Napoca',
      authorization: { number: 'F12/4/2026', date: '2026-06-20' },
      startedOn: '2026-07-01',
      method: 'sistem_real',
      realBasis: 'required',
    });
    const { id: certificate } = await s.evidence('certificat-mentiuni.pdf');
    // From the day the other activity starts, the whole activity is in the real system.
    await s.invoke(s.owner, 'pfa.sources.record', {
      sourceId: tailoring.sourceId,
      effectiveFrom: '2026-07-01',
      name: 'Croitorie',
      caen: '1413',
      place: 'Str. Exemplu nr. 2, Cluj-Napoca',
      county: 'CJ',
      authorization: { number: 'F12/3/2025', date: '2025-11-25' },
      startedOn: '2026-01-01',
      liberal: false,
      method: 'sistem_real',
      realBasis: 'required',
      evidenceId: certificate,
    });
    await bank('2026-03-10', '704.CR', '20000.00');
    await bank('2026-08-10', '704.REP', '10000.00');
    await bank('2026-09-10', '704.CR', '30000.00');
    await bank('2026-09-20', '628.CR', '-5000.00');
    const { id: publication } = await s.evidence('norme-venit-dgrfp-cluj.pdf');
    const { id: note } = await s.evidence('nota-surse.pdf');
    const input = {
      norms: [{ sourceId: tailoring.sourceId, norm: '50000', evidenceId: publication }],
      attribution: {
        accounts: [
          { match: '704.CR', sourceId: tailoring.sourceId },
          { match: '628.CR', sourceId: tailoring.sourceId },
          { match: '704.REP', sourceId: repairs.sourceId },
        ],
        shared: [],
        evidenceId: note,
      },
    };
    const result = await register(input);
    expect(result.final).toBe(true);
    // The norm for 1 January–30 June (181 days): 50,000 × 181 / 365 = 24,794.52, 24,795 lei;
    // March's 20,000 lei are the norm's income part; from July, 30,000 − 5,000 = 25,000 lei and
    // the repairs' 10,000.
    const [own, other] = result.sources;
    expect(own).toMatchObject({
      sourceId: tailoring.sourceId,
      totals: { gross: '30000.00', deductible: '5000.00', net: '25000.00' },
      norm: { from: '2026-01-01', to: '2026-06-30', activeDays: 181, adjusted: '24795.00' },
      normRegister: [{ value: '20000.00' }],
    });
    expect(other).toMatchObject({ sourceId: repairs.sourceId, totals: { net: '10000.00' } });
    expect(codes(result)).toContain('PIT_METHOD_CHANGE');
    // 35,000 + 24,795 = 59,795 cumulated: CAS 12,150; CASS 5,979 (5,979.50, art. 66). The real
    // system's 35,000 / 59,795 of each: 7,112 and 3,500; 24,388 taxable, 2,439; the norm 2,479.
    expect(result.contributions).toMatchObject({
      cumulated: '59795.00',
      cas: { due: '12150.00', deductible: '7112.00' },
      cass: { due: '5979.00', deductible: '3500.00' },
    });
    expect(result.tax).toMatchObject({
      taxable: '24388.00',
      real: '2439.00',
      norma: '2479.00',
      total: '4918.00',
    });
    // The D212 for 2026 income has no structure yet: ANAF has published none.
    expect((await s.refused(prepare(input)))?.code).toBe('FORMAT_GAP');
  });

  test('2026: CASS on independent income capped at 72 minimum wages (Legea nr. 239/2025)', async () => {
    const { s, source, bank, register } = await person(2026, []);
    await source({
      effectiveFrom: '2026-01-01',
      name: 'Dezvoltare software',
      caen: '6201',
      place: 'Str. Exemplu nr. 1, Cluj-Napoca',
      authorization: { number: 'F12/5/2025', date: '2025-12-20' },
      startedOn: '2026-01-01',
      method: 'sistem_real',
      realBasis: 'required',
    });
    await bank('2026-05-10', '704', '400000.00');
    const result = await register({});
    // The worklist raises the year's D212, due by 25 May 2027 (module.detectors).
    const work = await s.list<{ kind: string; subject: { id: string } }>(s.owner, 'work.list', {});
    expect(work.find((item) => item.subject.id === 'D212|2026')?.kind).toBe('obligation.due');
    expect(pitAgent.detectors.map((item) => `${item.kind} ${item.code}`)).toContain(
      'obligation.due D212',
    );
    // 72 × 4,050 = 291,600 lei: CASS 29,160; CAS on 24 wages, 97,200: 24,300.
    expect(result.contributions).toMatchObject({
      cas: { base: '97200.00', due: '24300.00' },
      cass: { base: '291600.00', due: '29160.00' },
    });
  });
});
