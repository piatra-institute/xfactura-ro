import type {
  AnswerRecord,
  AssetState,
  Evaluation,
  Loaded,
  OpenItemState,
  ProfileFact,
} from '../../../kernel';
import { turnoverKey } from '../../../kernel';
import { formatMoney, parseMoney } from '../../../money';
import { RuleContext, RuleGapError, type ParameterRegister } from '../../../rules';
import type { LocalDate } from '../../../time';
import { inventoryListSchema } from '../../yearend/documents';
import {
  inventoryDifferences,
  inventoryInput,
  provisionInput,
  provisionRecord,
  receivableImpairment,
  receivableImpairmentInput,
} from '../../yearend/treatments';
import type { CaseOutcome, ReviewCase, ReviewSpec } from '../types';
import { emptyLoaded, lei } from './world';

/*
 * Readings of the year-end in full (src/ro/yearend) the texts leave open: which revenue an
 * imputed shortage is booked to, whether an impairment of receivables is measured on their value
 * with VAT, and whether untaken leave computed from the payroll is a debt or a provision. Each
 * case runs the engine's treatment on fixed figures.
 */

const OMFP = 'OMFP1802/2014';
const OMF = 'OMF2861/2009';
const YEAR_END = '2026-12-31' as LocalDate;
const LIST = '00000000-0000-4000-8000-00000000f001';
const DECISION = '00000000-0000-4000-8000-00000000f002';
const EMPLOYEE = '00000000-0000-4000-8000-00000000f003';
const THIRD = '00000000-0000-4000-8000-00000000f004';
const LAPTOP = '00000000-0000-4000-8000-00000000f005';
const CUSTOMER = '00000000-0000-4000-8000-00000000f006';
const ITEM = '00000000-0000-4000-8000-00000000f007';
const ENTRY = '00000000-0000-4000-8000-00000000f008';

const bani = (text: string) => parseMoney(text, 'RON');
const withValue = (register: ParameterRegister, key: string, value: unknown) =>
  register.withVersions(
    register.versions.map((version) =>
      version.key === key ? { ...version, value: value as never } : version,
    ),
  );
const valueOf = (register: ParameterRegister, key: string) =>
  register.versions.find((version) => version.key === key)!.value as Record<string, unknown>;

/** The year 2026 of a company keeping double entry, with the facts given. */
function yearWorld(profile: ProfileFact[]): Loaded {
  const loaded = emptyLoaded(profile);
  return {
    ...loaded,
    years: [{ id: 'fy-2026', kind: 'financial', from: '2026-01-01' as LocalDate, to: YEAR_END }],
    evidence: new Map([
      [
        DECISION,
        { id: DECISION, hash: 'decision', filename: 'decizie.pdf', mediaType: 'application/pdf' },
      ],
    ]),
  };
}

/** What a treatment proposes, as the reviewer reads it: its lines, or why it is blocked. */
function outcome(
  evaluation: Evaluation,
  register: ParameterRegister,
  rules: RuleContext,
): CaseOutcome {
  const parameters = [...rules.used.keys()].map((id) => {
    const version = register.versions.find((item) => item.id === id);
    return `Parametru ${id} = ${JSON.stringify(version?.value)}`;
  });
  const issues = evaluation.issues.map(
    (issue) =>
      `${issue.severity === 'block' ? 'Blocare' : issue.severity === 'ack' ? 'De confirmat' : 'Informare'} ${issue.code}: ${issue.message}`,
  );
  if (!evaluation.effect)
    return {
      summary: `Blocat: ${[...new Set(evaluation.issues.filter((issue) => issue.severity === 'block').map((issue) => issue.code))].join(', ')}`,
      lines: [...issues, ...parameters],
    };
  const lines = evaluation.effect.lines.map(
    (line) => `${line.side} ${line.account} ${lei(line.bani)} lei`,
  );
  return { summary: `Propus: ${lines.join('; ')}`, lines: [...issues, ...parameters] };
}

function run(register: ParameterRegister, evaluate: (rules: RuleContext) => Evaluation) {
  const rules = new RuleContext(register, 'preview');
  try {
    return outcome(evaluate(rules), register, rules);
  } catch (error) {
    if (error instanceof RuleGapError)
      return { summary: 'Blocat: RULE_GAP', lines: [error.message] };
    throw error;
  }
}

// ---------------------------------------------------------------------------------------------
// The imputed shortage's revenue (OMF nr. 2.861/2009 pct. 40; the functions of 461, 428, 758)

const laptop: AssetState = {
  id: LAPTOP,
  number: 'MF-7',
  name: 'Laptop',
  catalogCode: '2.2.9',
  account: '2141',
  depreciationAccount: '2814',
  expenseAccount: '6811',
  value: bani('6000.00'),
  lifeMonths: 36,
  commissionedOn: '2025-12-15' as LocalDate,
  disposedOn: YEAR_END,
  depreciated: 0n,
  fiscal: null,
};

function inventoryCase(
  title: string,
  facts: string,
  world: {
    cash: string;
    counted: string;
    laptopFound: boolean;
    imputations: { kind: 'asset' | 'cash'; ref: string; employee: boolean; amount: string }[];
  },
): ReviewCase {
  const evaluate = (register: ParameterRegister) =>
    run(register, (rules) => {
      const loaded = yearWorld([
        { axis: 'income_tax', value: 'micro', effectiveFrom: '2026-01-01' as LocalDate },
      ]);
      const body = inventoryListSchema.parse({
        parserVersion: 'extracted-inventory-list-1',
        title: 'Lista de inventariere la 31.12.2026',
        company: { name: 'Companie exemplu SRL', taxId: '100' },
        date: YEAR_END,
        commission: { decision: '12', decisionDate: '2026-12-01', members: ['Ion Pop'] },
        assets: [
          { number: 'MF-7', name: 'Laptop', found: world.laptopFound, value: null, note: null },
        ],
        cash: [{ account: '5311', currency: 'RON', counted: world.counted }],
        bank: null,
        partners: null,
        stock: null,
      });
      const cashQuery = { prefixes: ['531'], from: '1900-01-01' as LocalDate, to: YEAR_END };
      const stockQuery = { prefixes: ['3'], from: '1900-01-01' as LocalDate, to: YEAR_END };
      const world_: Loaded = {
        ...loaded,
        documents: new Map([
          [
            LIST,
            {
              id: LIST,
              kind: 'inventory.list',
              schema: 'extracted-inventory-list-1',
              body,
              bodyHash: 'list',
              docDate: YEAR_END,
              partyId: null,
              currency: null,
              number: null,
              evidenceId: null,
            },
          ],
        ]),
        assets: new Map([[LAPTOP, laptop]]),
        turnover: new Map([
          [turnoverKey(cashQuery), [{ account: '5311', debit: bani(world.cash), credit: 0n }]],
          [turnoverKey(stockQuery), []],
        ]),
        parties: new Map([
          [
            EMPLOYEE,
            { id: EMPLOYEE, kind: 'ro_individual', country: 'RO', taxId: null, name: 'Casier' },
          ],
          [
            THIRD,
            {
              id: THIRD,
              kind: 'ro_legal_entity',
              country: 'RO',
              taxId: '200',
              name: 'Transportator SRL',
            },
          ],
        ]),
      };
      return inventoryDifferences.evaluate(
        inventoryInput.parse({
          date: YEAR_END,
          documentIds: [LIST],
          evidenceId: DECISION,
          imputations: world.imputations.map((item) => ({
            ...item,
            partyId: item.employee ? EMPLOYEE : THIRD,
          })),
        }),
        world_,
        rules,
      );
    });
  return {
    title,
    facts,
    run: (register) => ({
      engine: evaluate(register),
      alternative: evaluate(
        withValue(register, 'ro.inventory.accounts', {
          ...valueOf(register, 'ro.inventory.accounts'),
          imputation: { employee: '4282', third: '461', revenue: '7588' },
        }),
      ),
    }),
  };
}

export const inventoryAccountsSpec: ReviewSpec = {
  key: 'ro.inventory.accounts',
  kind: 'interpretation',
  act: OMFP,
  minutes: 15,
  readings: {
    engine:
      'Lipsa imputată se înregistrează pe 4282 (salariat) sau 461 (terț) la valoarea de înlocuire, în contrapartidă cu 7581 „Venituri din despăgubiri, amenzi și penalități”, fără TVA colectată (normele art. 304 pct. 78 alin. (6)); lipsa de casă imputată trece direct din 5311 pe 4282, cea neimputabilă pe 6588, iar plusul de casă pe 7588.',
    alternative:
      'Venitul din imputare se înregistrează pe 7588 „Alte venituri din exploatare”, funcțiunea contului 758 nedistingând analiticul.',
  },
  question:
    'Pe ce cont de venituri se înregistrează valoarea de înlocuire a unui bun lipsă imputat unui salariat sau unui terț (OMF nr. 2.861/2009 pct. 40 alin. (2), funcțiunile conturilor 428, 461 și 758), și ce conturi primesc lipsurile și plusurile de casă?',
  context: [`${OMF}:pct.42-43`, `${OMF}:pct.37-38`],
  cases: [
    inventoryCase(
      'Lipsă de casă imputată casierului',
      'La 31.12.2026 registrul de casă arată 2.150,00 lei, monetarul 2.000,00 lei; administratorul impută cei 150,00 lei casierei.',
      {
        cash: '2150.00',
        counted: '2000.00',
        laptopFound: true,
        imputations: [{ kind: 'cash', ref: '5311', employee: true, amount: '150.00' }],
      },
    ),
    inventoryCase(
      'Laptop lipsă imputat salariatului',
      'Laptopul MF-7 (6.000,00 lei, scos din funcțiune la 31.12.2026) lipsește; se impută salariatului la valoarea de înlocuire de 3.570,00 lei, TVA inclusă.',
      {
        cash: '500.00',
        counted: '500.00',
        laptopFound: false,
        imputations: [{ kind: 'asset', ref: 'MF-7', employee: true, amount: '3570.00' }],
      },
    ),
    inventoryCase(
      'Laptop lipsă imputat transportatorului',
      'Laptopul MF-7 s-a pierdut la transport; se impută transportatorului la 3.570,00 lei.',
      {
        cash: '500.00',
        counted: '500.00',
        laptopFound: false,
        imputations: [{ kind: 'asset', ref: 'MF-7', employee: false, amount: '3570.00' }],
      },
    ),
    inventoryCase('Plus de casă', 'Registrul de casă arată 1.000,00 lei, monetarul 1.040,00 lei.', {
      cash: '1000.00',
      counted: '1040.00',
      laptopFound: true,
      imputations: [],
    }),
  ],
  gaps: [
    'OMF nr. 2.861/2009 este citit în textul inițial publicat de ANAF; modificările ulterioare nu au fost verificate (portalul legislativ refuză accesul automat).',
    'Pct. 46 alin. (3), care cere evaluarea lipsurilor la valoarea contabilă și urmărirea pe debitori, se află în punctul despre instituțiile publice; aplicarea lui entităților economice este citirea motorului.',
    'Recuperarea imputării din salariu (reținerea pe statul de plată, 421 = 4282) nu este construită.',
  ],
};

// ---------------------------------------------------------------------------------------------
// The impairment of receivables (OMFP nr. 1.802/2014 pct. 89, 332, 353)

function impairmentCase(
  title: string,
  facts: string,
  world: {
    gross: string;
    vat: string;
    dueDate: string;
    policy: string;
    answer: { status: string; recoverable: string; guaranteed?: boolean } | null;
  },
): ReviewCase {
  const evaluate = (register: ParameterRegister, net: boolean) =>
    run(register, (rules) => {
      const loaded = yearWorld([
        {
          axis: 'policy.impairment.receivables',
          value: world.policy,
          effectiveFrom: '2026-01-01' as LocalDate,
        },
      ]);
      const balance = bani(world.gross) - (net ? bani(world.vat) : 0n);
      const item: OpenItemState = {
        id: ITEM,
        kind: 'receivable',
        controlAccount: '4111',
        partyId: CUSTOMER,
        currency: 'RON',
        normalSide: 'D',
        mayReverse: false,
        balanceBani: balance,
        balanceMinor: balance,
        documentId: null,
        dueDate: world.dueDate as LocalDate,
        originEntryId: ENTRY,
        movements: 1,
        history: [ENTRY],
        origin: {
          treatmentId: 'invoices.recognize',
          subject: 'document:x',
          date: '2025-11-10' as LocalDate,
          tag: null,
        },
      };
      const answers = new Map<string, AnswerRecord>();
      if (world.answer)
        answers.set('q-1', {
          questionId: 'q-1',
          answerId: 'a-1',
          kind: 'receivable.collectibility',
          subject: { kind: 'party', id: CUSTOMER },
          params: { yearEnd: YEAR_END },
          value: {
            status: world.answer.status,
            recoverable: world.answer.recoverable,
            guaranteed: world.answer.guaranteed ?? false,
            affiliated: false,
            evidenceIds: world.answer.status === 'collectible' ? [] : [DECISION],
          },
          evidenceId: DECISION,
          answeredAt: '2027-01-20T08:00:00.000Z',
        });
      return receivableImpairment.evaluate(
        receivableImpairmentInput.parse({ yearEnd: YEAR_END, evidenceId: DECISION }),
        {
          ...loaded,
          openItems: new Map([[ITEM, item]]),
          parties: new Map([
            [
              CUSTOMER,
              {
                id: CUSTOMER,
                kind: 'ro_legal_entity',
                country: 'RO',
                taxId: '300',
                name: 'Client SRL',
              },
            ],
          ]),
          answers,
        },
        rules,
      );
    });
  return {
    title,
    facts,
    run: (register) => ({
      engine: evaluate(register, false),
      alternative: evaluate(register, true),
    }),
  };
}

export const impairmentAccountsSpec: ReviewSpec = {
  key: 'ro.impairment.accounts',
  kind: 'interpretation',
  act: OMFP,
  minutes: 15,
  readings: {
    engine:
      'Ajustarea creanței unui client se calculează asupra soldului din 4111, cu TVA, pentru partea pe care persoana nu se așteaptă să o încaseze (pct. 332 alin. (2)), se înregistrează pe 491 pe seama 6814 și se reia pe 7814; clienții se testează după politica firmei (peste un număr de zile de întârziere) și după faptele declarate.',
    alternative:
      'Ajustarea se calculează asupra creanței fără TVA colectată, taxa urmând să fie ajustată separat la falimentul clientului (Codul fiscal art. 287 lit. d)).',
  },
  question:
    'Pe ce valoare se constituie ajustarea pentru deprecierea creanței unui client incert sau în insolvență la sfârșitul exercițiului: soldul contului 4111, cu TVA, sau creanța fără TVA colectată?',
  context: [],
  cases: [
    impairmentCase(
      'Client în faliment',
      'Client SRL datorează 12.100,00 lei (din care TVA 2.100,00 lei) dintr-o factură scadentă la 10.12.2025; la 31.12.2026 tribunalul a declarat falimentul; nu se așteaptă nicio încasare.',
      {
        gross: '12100.00',
        vat: '2100.00',
        dueDate: '2025-12-10',
        policy: 'overdue_180',
        answer: { status: 'bankruptcy', recoverable: '0' },
      },
    ),
    impairmentCase(
      'Client în litigiu, jumătate recuperabilă',
      'Client SRL datorează 12.100,00 lei, scadenți la 10.03.2026 (296 de zile); litigiu, cu o încasare estimată de 50%.',
      {
        gross: '12100.00',
        vat: '2100.00',
        dueDate: '2026-03-10',
        policy: 'overdue_180',
        answer: { status: 'litigation', recoverable: '50' },
      },
    ),
    impairmentCase(
      'Client cu întârziere, fără răspuns',
      'Client SRL datorează 12.100,00 lei scadenți la 10.03.2026; politica testează creanțele de peste 180 de zile, dar nimeni nu a spus cât sunt de încasabile.',
      {
        gross: '12100.00',
        vat: '2100.00',
        dueDate: '2026-03-10',
        policy: 'overdue_180',
        answer: null,
      },
    ),
    impairmentCase(
      'Client încasabil',
      'Client SRL datorează 12.100,00 lei scadenți la 10.03.2026; persoana confirmă că se vor încasa integral.',
      {
        gross: '12100.00',
        vat: '2100.00',
        dueDate: '2026-03-10',
        policy: 'overdue_180',
        answer: { status: 'collectible', recoverable: '100' },
      },
    ),
  ],
  gaps: [
    'OMFP nr. 1.802/2014 este citit în textul din 2014; modificările ulterioare nu au fost verificate.',
    'Trecerea creanțelor incerte în 4118 (pct. 331) nu se face: 4118 nu este ținut pe parteneri în planul de conturi al aplicației, iar mutarea ar pierde partenerul; creanța rămâne pe 4111, cu ajustarea pe client.',
    'Scoaterea din evidență a creanțelor irecuperabile (654) și ajustarea TVA la falimentul clientului (art. 287 lit. d)) nu sunt construite.',
  ],
};

// ---------------------------------------------------------------------------------------------
// Untaken leave (OMFP nr. 1.802/2014 pct. 338 alin. (2))

function leaveCase(
  title: string,
  facts: string,
  answer: { days: number; amount: string; contributions: string; measured: boolean },
): ReviewCase {
  const evaluate = (register: ParameterRegister) =>
    run(register, (rules) => {
      const loaded = yearWorld([]);
      return provisionRecord.evaluate(
        provisionInput.parse({
          date: YEAR_END,
          kind: 'leave',
          reference: 'concedii-2026',
          amount: formatMoney(bani(answer.amount) + bani(answer.contributions), 'RON'),
          evidenceId: DECISION,
        }),
        {
          ...loaded,
          answers: new Map([
            [
              'q-leave',
              {
                questionId: 'q-leave',
                answerId: 'a-leave',
                kind: 'leave.untaken',
                subject: { kind: 'company', id: 'company' },
                params: { year: 2026 },
                value: { ...answer, evidenceId: DECISION },
                evidenceId: DECISION,
                answeredAt: '2027-01-20T08:00:00.000Z',
              },
            ],
          ]),
        },
        rules,
      );
    });
  return {
    title,
    facts,
    run: (register) => ({
      engine: evaluate(register),
      alternative: evaluate(
        withValue(register, 'ro.provisions.accounts', {
          ...valueOf(register, 'ro.provisions.accounts'),
          measured: { account: '4281', expense: '641', kinds: ['bonus'] },
        }),
      ),
    }),
  };
}

export const provisionAccountsSpec: ReviewSpec = {
  key: 'ro.provisions.accounts',
  kind: 'interpretation',
  act: OMFP,
  minutes: 20,
  readings: {
    engine:
      'Concediile de odihnă neefectuate calculate pe baza statelor de salarii (zilele neefectuate la media zilnică a fiecărui contract, cu contribuția asiguratorie pentru muncă) sunt o datorie față de personal (641 = 4281); fără un astfel de calcul, un provizion (6812 = 1518); celelalte provizioane, pe feluri, pe 151x.',
    alternative:
      'Concediile neefectuate rămân un provizion (6812 = 1518) chiar calculate pe statele de salarii, fiindcă data și efectuarea lor sunt incerte la data bilanțului.',
  },
  question:
    'Concediile de odihnă neefectuate la 31 decembrie, calculate din evidența concediilor și media zilnică din statele de salarii, se înregistrează ca datorie față de personal (641 = 4281) sau ca provizion (6812 = 1518), potrivit OMFP nr. 1.802/2014 pct. 338 alin. (2)? Contribuția angajatorului se cuprinde în aceeași sumă?',
  context: [],
  cases: [
    leaveCase(
      'Concedii calculate pe statele de salarii',
      '12 zile neefectuate la o medie zilnică de 300,00 lei: 3.600,00 lei și CAM 81,00 lei, calculate pe statele de salarii.',
      { days: 12, amount: '3600.00', contributions: '81.00', measured: true },
    ),
    leaveCase(
      'Concedii estimate fără state de salarii',
      'Aceleași 12 zile estimate fără calcul pe statele de salarii: 3.681,00 lei.',
      { days: 12, amount: '3600.00', contributions: '81.00', measured: false },
    ),
    leaveCase(
      'Toate concediile efectuate',
      'Toți salariații și-au efectuat concediul până la 31.12.2026.',
      { days: 0, amount: '0', contributions: '0', measured: true },
    ),
  ],
  gaps: [
    'Codul muncii art. 150 (media zilnică a indemnizației) nu este încă stocat; calculul pe salariați este al persoanei, atașat răspunsului.',
    'Contribuțiile angajatorului cuprinse în datorie sau provizion, și reluarea lor la plata concediului în anul următor, sunt de confirmat de expert.',
  ],
};
