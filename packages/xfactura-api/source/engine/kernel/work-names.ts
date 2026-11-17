import { z } from 'zod';
import type { Treatment } from 'xfactura-core/kernel';
import { yearlyAxes } from 'xfactura-core/ro/determinations';
import type { ParameterRegister } from 'xfactura-core/rules';
import type { Permission } from './commands';
import type { OperationRegistry } from './operations';

/*
 * Romanian names, structured causes, detail labels and refusal reasons for the worklist.
 * Internal identifiers (axes, document kinds, treatments, operations, returns, periods) stay in
 * `details` and `causes[].id` while every message shown to a person reads in Romanian.
 */

export const causeKinds = ['fact', 'question', 'rule'] as const;
export type CauseKind = (typeof causeKinds)[number];

export const workCauseView = z.object({
  id: z.string(),
  kind: z.enum(causeKinds),
  message: z.string(),
  subject: z.object({ kind: z.string(), id: z.string() }).optional(),
});
export type WorkCause = z.infer<typeof workCauseView>;

export const detailLabelView = z.discriminatedUnion('type', [
  z.object({ label: z.string(), type: z.enum(['text', 'date', 'period', 'count']) }),
  z.object({
    label: z.string(),
    type: z.enum(['amount', 'minor']),
    currencyKey: z.string().optional(),
    currency: z.string().optional(),
  }),
  z.object({ label: z.string(), type: z.literal('id'), kind: z.string() }),
]);
export type DetailLabel = z.infer<typeof detailLabelView>;
export type DetailLabels = Record<string, DetailLabel>;

export const stepRefusalView = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('role'),
    permission: z.enum(['read', 'write', 'review', 'manage']),
  }),
  z.object({ kind: z.literal('grant') }),
  z.object({ kind: z.literal('data') }),
  z.object({ kind: z.literal('state'), message: z.string() }),
]);
export type StepRefusal = z.infer<typeof stepRefusalView>;
export type PermissionKind = Permission;

/** Profile axes and yearly determinations in Romanian. */
export const axisNames: Record<string, string> = {
  'entity.form': 'Forma juridică',
  'books.system': 'Sistemul de contabilitate',
  'cas.status': 'Statutul privind contribuția de asigurări sociale (CAS)',
  'cas.option': 'Opțiunea pentru plata CAS',
  'cass.exception': 'Excepția de la CASS minimă',
  'vat.status': 'Regimul de TVA',
  'vat.period': 'Perioada fiscală de TVA',
  'vat.cash': 'Sistemul TVA la încasare',
  'vat.eu': 'Codul de TVA pentru operațiuni intracomunitare (art. 317)',
  'vat.prorata': 'Pro rata de TVA',
  'vat.distance': 'Locul vânzărilor la distanță în UE',
  'vat.oss': 'Regimul special UE (OSS)',
  'vat.ioss': 'Regimul special de import (IOSS)',
  'vat.threshold': 'Plafonul de scutire de TVA',
  'vat.agriculture': 'Regimul special pentru agricultori',
  'intrastat.arrivals': 'Obligația Intrastat pentru introduceri de bunuri',
  'intrastat.dispatches': 'Obligația Intrastat pentru expedieri de bunuri',
  income_tax: 'Regimul de impozitare (profit sau microîntreprindere)',
  'profit.system': 'Sistemul de declarare și plată a impozitului pe profit',
  'tax.facilities': 'Înlesnirile la plată sau insolvența',
  employer: 'Calitatea de angajator',
  'payroll.period': 'Perioada declarației 112',
  'size.category': 'Categoria de mărime a entității',
  'activity.goods': 'Activitatea cu bunuri și stocuri',
  'activity.none': 'Lipsa de activitate',
  'regime.excluded': 'Regimuri speciale excluse (accize, grup fiscal, IFRS)',
  'taxpayer.category': 'Categoria de contribuabil (ANAF)',
  'books.assurance': 'Modul de verificare a registrelor',
  'controls.segregation': 'Separarea responsabilităților',
  'policy.storno': 'Metoda de stornare (în roșu sau în negru)',
  'policy.payroll.employer_share': 'Contul pentru contribuțiile suportate de angajator',
  'policy.assets.disposal_month': 'Amortizarea în luna scoaterii din evidență',
  'policy.impairment.receivables': 'Politica de ajustare a creanțelor pentru depreciere',
  'policy.stock.valuation': 'Metoda de evaluare a ieșirilor din stoc',
  'policy.stock.inventory': 'Metoda de evidență a stocurilor',
  'policy.stock.negative': 'Regula privind stocurile negative',
  'policy.stock.retail': 'Metoda de evidență a mărfurilor (cost sau preț cu amănuntul)',
  'policy.production.cost': 'Metoda de calcul al costului de producție',
};

export function axisName(axis: string): string {
  const base = axis.split('/')[0]!;
  if (base.startsWith('policy.stock.retail.')) return 'Metoda de evidență a gestiunii';
  return axisNames[base] ?? axisNames[axis] ?? base;
}

/** The axes whose fact the law decides each year (the yearly determinations, `recordedInYear`,
 * and the provisional pro-rata, `provisionalProrata`): stated or confirmed for every year. */
export const yearlyProfileAxes: ReadonlySet<string> = new Set([...yearlyAxes, 'vat.prorata']);

/** How the profile's axes are grouped for people, in the order they are shown. */
export const profileGroups = [
  'firma',
  'tva',
  'impozit',
  'salariati',
  'activitate',
  'politici',
  'verificare',
] as const;
export type ProfileGroup = (typeof profileGroups)[number];

export const profileGroupNames: Record<ProfileGroup, string> = {
  firma: 'Firma',
  tva: 'TVA',
  impozit: 'Impozite și contribuții',
  salariati: 'Salariați',
  activitate: 'Activitate',
  politici: 'Politici contabile',
  verificare: 'Verificare și control',
};

/** Every profile axis with its group, in the order people read them. */
export const profileAxisGroups: readonly (readonly [string, ProfileGroup])[] = [
  ['entity.form', 'firma'],
  ['books.system', 'firma'],
  ['size.category', 'firma'],
  ['taxpayer.category', 'firma'],
  ['vat.status', 'tva'],
  ['vat.period', 'tva'],
  ['vat.cash', 'tva'],
  ['vat.threshold', 'tva'],
  ['vat.eu', 'tva'],
  ['vat.prorata', 'tva'],
  ['vat.distance', 'tva'],
  ['vat.oss', 'tva'],
  ['vat.ioss', 'tva'],
  ['vat.agriculture', 'tva'],
  ['income_tax', 'impozit'],
  ['profit.system', 'impozit'],
  ['tax.facilities', 'impozit'],
  ['cas.status', 'impozit'],
  ['cas.option', 'impozit'],
  ['cass.exception', 'impozit'],
  ['employer', 'salariati'],
  ['payroll.period', 'salariati'],
  ['activity.goods', 'activitate'],
  ['activity.none', 'activitate'],
  ['regime.excluded', 'activitate'],
  ['intrastat.arrivals', 'activitate'],
  ['intrastat.dispatches', 'activitate'],
  ['policy.storno', 'politici'],
  ['policy.payroll.employer_share', 'politici'],
  ['policy.assets.disposal_month', 'politici'],
  ['policy.impairment.receivables', 'politici'],
  ['policy.stock.valuation', 'politici'],
  ['policy.stock.inventory', 'politici'],
  ['policy.stock.negative', 'politici'],
  ['policy.stock.retail', 'politici'],
  ['policy.production.cost', 'politici'],
  ['books.assurance', 'verificare'],
  ['controls.segregation', 'verificare'],
];

const yesNo = (no: string, yes: string) => ({ no, yes });
const percents = Object.fromEntries(
  Array.from({ length: 101 }, (_, value) => [String(value), `${value}%`]),
);

/**
 * Each profile value in Romanian, short, in the Codul fiscal's terms where it has one. A warehouse's
 * own retail method (`policy.stock.retail.<id>`) reads as `policy.stock.retail`.
 */
export const axisValueNames: Record<string, Record<string, string>> = {
  'entity.form': {
    srl: 'Societate cu răspundere limitată (SRL)',
    pfa: 'Persoană fizică autorizată (PFA)',
    ii: 'Întreprindere individuală (II)',
    if: 'Întreprindere familială (IF)',
  },
  'books.system': { double: 'Partidă dublă', single: 'Partidă simplă' },
  'cas.status': {
    liable: 'Datorează CAS',
    pensioner: 'Pensionar',
    own_system: 'Asigurat într-un sistem propriu de pensii',
  },
  'cas.option': yesNo('Fără opțiune', 'Optează pentru plata CAS'),
  // Art. 174 alin. (7)–(8): below 6 minimum wages, CASS is due on the minimum base, except for
  // those with these situations (the source register's summary of `art.174(1)-(8)`).
  'cass.exception': {
    none: 'Fără excepție de la CASS minimă',
    salary: 'Exceptat: salarii de cel puțin 6 salarii minime',
    other_income: 'Exceptat: alte venituri cu CASS la cel puțin 6 salarii minime',
    pension: 'Exceptat: venituri din pensii',
    previous_year: 'Exceptat: exceptat sau cu opțiune în anul precedent',
  },
  'vat.status': { non_vat: 'Neplătitor de TVA', normal_vat: 'Plătitor de TVA' },
  'vat.period': { monthly: 'Lunară', quarterly: 'Trimestrială' },
  'vat.cash': yesNo('Fără TVA la încasare', 'TVA la încasare'),
  'vat.eu': { none: 'Fără cod special', special: 'Cod de TVA special (art. 317)' },
  'vat.prorata': {
    ...percents,
    special: 'Pro rata specială (art. 300 alin. (16))',
    opted_out: 'Fără deducere pentru achizițiile mixte (art. 300 alin. (20))',
  },
  'vat.distance': {
    origin: 'În România',
    destination: 'În statul membru de destinație',
    option: 'În statul membru de destinație, prin opțiune',
  },
  'vat.oss': {
    none: 'Fără regim special',
    union: 'Regimul din Uniune (OSS)',
    non_union: 'Regimul din afara Uniunii',
  },
  'vat.ioss': {
    none: 'Fără regim de import',
    registered: 'Regimul de import (IOSS)',
    intermediary: 'Regimul de import, prin intermediar',
  },
  'intrastat.arrivals': { none: 'Nu este furnizor de date', provider: 'Furnizor de date' },
  'intrastat.dispatches': { none: 'Nu este furnizor de date', provider: 'Furnizor de date' },
  income_tax: {
    micro: 'Impozit pe veniturile microîntreprinderilor',
    profit: 'Impozit pe profit',
  },
  'profit.system': {
    quarterly: 'Trimestrial',
    annual: 'Anual, cu plăți anticipate trimestriale',
  },
  'tax.facilities': {
    none: 'Fără înlesniri',
    rescheduling: 'Eșalonare la plată',
    deferral: 'Amânare la plată',
    insolvency: 'Insolvență',
    restructuring: 'Prevenirea insolvenței',
    state_aid: 'Ajutor de stat de restituit',
  },
  employer: yesNo('Fără salariați', 'Angajator'),
  'payroll.period': { monthly: 'Lunară', quarterly: 'Trimestrială' },
  'size.category': {
    micro: 'Microentitate',
    small: 'Entitate mică',
    medium_large: 'Entitate mijlocie sau mare',
  },
  'vat.threshold': { under: 'Sub plafonul de scutire', exceeded: 'Plafonul de scutire depășit' },
  'activity.goods': {
    no: 'Numai servicii',
    yes: 'Bunuri și stocuri',
    margin_goods: 'Bunuri second-hand în regimul marjei (art. 312)',
  },
  'vat.agriculture': {
    none: 'Fără regim special',
    special: 'Regimul special pentru agricultori (art. 315^1)',
  },
  'activity.none': yesNo('Cu activitate', 'Fără activitate de la înființare'),
  'regime.excluded': {
    none: 'Niciunul',
    excise: 'Produse accizabile',
    fiscal_group: 'Grup fiscal',
    ifrs: 'IFRS',
  },
  'taxpayer.category': {
    large: 'Contribuabil mare',
    medium: 'Contribuabil mijlociu',
    small: 'Contribuabil mic',
  },
  'books.assurance': {
    preview: 'Previzualizare',
    shadow: 'În paralel',
    live: 'Registre oficiale',
  },
  'controls.segregation': { off: 'Fără separare', on: 'Separare', strict: 'Separare strictă' },
  'policy.storno': { red: 'Stornare în roșu', black: 'Stornare în negru' },
  'policy.payroll.employer_share': {
    '635': 'Contul 635 (alte impozite și taxe)',
    '6458': 'Contul 6458 (alte cheltuieli sociale)',
  },
  'policy.assets.disposal_month': {
    included: 'Se amortizează luna ieșirii',
    excluded: 'Nu se amortizează luna ieșirii',
  },
  'policy.impairment.receivables': {
    individual: 'Fiecare creanță, individual',
    overdue_90: 'Restante de peste 90 de zile',
    overdue_180: 'Restante de peste 180 de zile',
    overdue_270: 'Restante de peste 270 de zile',
    overdue_365: 'Restante de peste 365 de zile',
  },
  'policy.stock.valuation': {
    fifo: 'FIFO (primul intrat, primul ieșit)',
    lifo: 'LIFO (ultimul intrat, primul ieșit)',
    average: 'Cost mediu ponderat după fiecare intrare',
    periodic: 'Cost mediu ponderat lunar',
  },
  'policy.stock.inventory': {
    permanent: 'Inventar permanent',
    intermittent: 'Inventar intermitent',
  },
  'policy.stock.negative': { refuse: 'Fără stoc negativ', allow: 'Stoc negativ permis' },
  'policy.stock.retail': { cost: 'La cost de achiziție', retail: 'La preț cu amănuntul' },
  'policy.production.cost': { standard: 'Cost standard', actual: 'Cost efectiv' },
};

/** A profile value in Romanian; null for a value the axis does not take. */
export function axisValueName(axis: string, value: string): string | null {
  const base = axis.startsWith('policy.stock.retail.') ? 'policy.stock.retail' : axis;
  return axisValueNames[base]?.[value] ?? null;
}

/** Document kinds in Romanian. */
export const documentKindNames: Record<string, string> = {
  'invoice.received': 'factură primită',
  'invoice.issued': 'factură emisă',
  'creditNote.received': 'notă de credit primită',
  'creditNote.issued': 'notă de credit emisă',
  'receipt.received': 'bon fiscal primit',
  'receipt.issued': 'bon fiscal emis',
  contract: 'contract',
  'tax.decision': 'decizie fiscală',
  'tax.statement': 'fișă pe plătitor',
  'inventory.list': 'listă de inventariere',
  'customs.declaration': 'declarație vamală',
  'vies.check': 'verificare VIES',
  zreport: 'raport Z',
};

export const documentKindName = (kind: string) => documentKindNames[kind] ?? kind;

/** Document source authorities in Romanian. */
export const authorityNames: Record<string, string> = {
  efactura: 'e-Factura',
  issued: 'emis în aplicație',
  ubl_upload: 'fișier XML încărcat',
  invoicer: 'aplicația de facturare',
  amef: 'casă de marcat',
  extracted: 'date extrase din document',
};

export const authorityName = (authority: string) => authorityNames[authority] ?? authority;

/** Question kinds in Romanian. */
export const questionKindNames: Record<string, string> = {
  'vehicle.use': 'utilizarea vehiculului',
  'deferral.schedule': 'perioada cheltuielii sau venitului în avans',
  'payroll.absences': 'absențele din lună',
  'payroll.benefits': 'avantajele în natură',
  'evidence.missing': 'documentul justificativ lipsă',
  choice: 'alegerea tratamentului',
  'profile.fact': 'datele companiei',
  'determination.confirm': 'confirmarea încadrării fiscale',
  'year.figures': 'indicatorii anuali din situațiile depuse',
  'micro.conditions': 'condițiile pentru impozitul microîntreprinderilor',
  'profit.account': 'clasificarea contului pentru impozitul pe profit',
  'profit.losses': 'pierderile fiscale de recuperat',
  'obligation.filed': 'recipisa declarației depuse în afara aplicației',
  'vat.refund': 'opțiunea de rambursare sau reportare a TVA',
  'capitalGood.use': 'utilizarea bunului de capital',
  'farmer.register': 'înscrierea în Registrul agricultorilor',
  'nonresident.payee': 'natura venitului plătit nerezidentului',
  'nonresident.certificate': 'certificatul de rezidență fiscală',
  'annual.informative': 'datele informative pentru situațiile anuale',
  'annual.disclosures': 'notele explicative la situațiile anuale',
  'annual.document': 'documentele însoțitoare ale situațiilor anuale',
  'receivable.collectibility': 'gradul de încasare a creanțelor',
  'leave.untaken': 'concediile de odihnă neefectuate',
  'provisions.review': 'analiza obligațiilor pentru provizioane',
  'stock.item': 'încadrarea articolului din stoc',
  'goods.proof': 'dovada transportului sau ieșirii din UE',
  'etransport.uit': 'codul UIT RO e-Transport',
  'retail.goods': 'bunurile vândute pe raportul Z',
  'production.excess': 'încadrarea pierderilor de producție',
};

export const questionKindName = (kind: string) => questionKindNames[kind] ?? kind;

/** Subject kinds in Romanian. */
export const subjectKindNames: Record<string, string> = {
  vehicle: 'vehiculul',
  deferral: 'cheltuiala sau venitul în avans',
  company: 'companie',
  employee: 'salariatul',
  profile: 'profilul companiei',
  year: 'anul',
  account: 'contul',
  obligation: 'declarația',
  vatPeriod: 'perioada de TVA',
  party: 'partenerul',
  asset: 'mijlocul fix',
  document: 'documentul',
  action: 'acțiunea',
  proposal: 'propunerea',
  question: 'întrebarea',
  need: 'cerința',
  determination: 'încadrarea fiscală',
  threshold: 'plafonul',
  entry: 'nota contabilă',
  annual: 'situațiile anuale',
  declaration: 'declarația',
  prorata: 'pro rata de TVA',
  yearend: 'închiderea exercițiului',
  contract: 'contractul',
  finding: 'constatarea de închidere',
  month: 'luna',
  parameter: 'parametrul',
  movement: 'mișcarea bancară',
  spvMessage: 'mesajul SPV',
  evidence: 'documentul justificativ',
  policy: 'politica de contabilizare',
  template: 'șablonul',
  recurring: 'operațiunea recurentă',
  cashRegister: 'casa de marcat',
};

export const subjectKindName = (kind: string) => subjectKindNames[kind] ?? kind;

/** Returns and declarations in Romanian. */
export const returnNames: Record<string, string> = {
  D300: 'Decontul de TVA (D300)',
  D394: 'Declarația informativă privind livrările și achizițiile (D394)',
  D390: 'Declarația recapitulativă privind operațiunile intracomunitare (D390)',
  D398: 'Decontul special de TVA pentru regimul UE (D398)',
  D301: 'Decontul special de TVA (D301)',
  D112: 'Declarația privind contribuțiile și impozitul pe salarii (D112)',
  D100: 'Declarația privind obligațiile de plată la bugetul de stat (D100)',
  D101: 'Declarația privind impozitul pe profit (D101)',
  D204: 'Declarația anuală de venit pentru asocieri (D204)',
  D205: 'Declarația informativă privind impozitul reținut la sursă (D205)',
  D207: 'Declarația informativă privind impozitul reținut nerezidenților (D207)',
  D212: 'Declarația unică (D212)',
  D406: 'Declarația informativă SAF-T (D406)',
  D700: 'Declarația de mențiuni (D700)',
  D710: 'Declarația rectificativă (D710)',
  S1005: 'Situațiile financiare anuale pentru microentități (S1005)',
  S1003: 'Situațiile financiare anuale pentru entități mici (S1003)',
  S1046: 'Declarația de inactivitate (S1046)',
  'SF.halfyear': 'Raportarea contabilă semestrială (30 iunie)',
  'SF.large': 'Situațiile financiare anuale pentru entități mijlocii și mari',
  'Intrastat.arrivals': 'Declarația Intrastat pentru introduceri de bunuri',
  'Intrastat.dispatches': 'Declarația Intrastat pentru expedieri de bunuri',
};

export const returnName = (kind: string) => returnNames[kind] ?? kind;

/** Obligation statuses in Romanian. */
export const obligationStatusNames: Record<string, string> = {
  due: 'de pregătit',
  overdue: 'cu termen depășit',
  prepared: 'pregătită',
  authorized: 'autorizată',
  rejected: 'respinsă',
  blocked: 'blocată',
  filed: 'depusă',
  accepted: 'acceptată',
};

export const obligationStatusName = (status: string) => obligationStatusNames[status] ?? status;

const monthsRo = [
  'ianuarie',
  'februarie',
  'martie',
  'aprilie',
  'mai',
  'iunie',
  'iulie',
  'august',
  'septembrie',
  'octombrie',
  'noiembrie',
  'decembrie',
] as const;
const quartersRo = ['I', 'II', 'III', 'IV'] as const;

/** Formats `2026-03` as `martie 2026`, `2026-Q1` as `trimestrul I 2026`, `2026` as `anul 2026`. */
export function periodName(period: string): string {
  const month = /^(\d{4})-(\d{2})$/.exec(period);
  if (month) {
    const index = Number(month[2]) - 1;
    const name = monthsRo[index];
    if (name) return `${name} ${month[1]}`;
  }
  const quarter = /^(\d{4})-Q([1-4])$/.exec(period);
  if (quarter) return `trimestrul ${quartersRo[Number(quarter[2]) - 1]} ${quarter[1]}`;
  if (/^\d{4}$/.test(period)) return `anul ${period}`;
  return period;
}

/** Formats `<return>|<period>` as Romanian prose. */
export function formatObligationKey(key: string): string {
  const split = key.indexOf('|');
  if (split <= 0) return key;
  return `${returnName(key.slice(0, split))} pentru ${periodName(key.slice(split + 1))}`;
}

/** Rule gap reasons in Romanian. */
export const ruleGapReasonNames: Record<string, string> = {
  BEYOND_HORIZON: 'regula nu este verificată pentru această perioadă',
  NOT_FOUND: 'lipsește regula în registru',
  UNREVIEWED: 'regula nu este aprobată de expertul contabil',
  CONFLICT: 'există o neconcordanță între texte',
};

export const ruleGapReasonName = (reason: string) => ruleGapReasonNames[reason] ?? reason;

/** Comparable document fields in Romanian. */
export const comparableFieldNames: Record<string, string> = {
  partyId: 'partener',
  currency: 'monedă',
  date: 'dată',
  number: 'număr',
  net: 'valoare fără TVA',
  tax: 'TVA',
  gross: 'total cu TVA',
};

export const comparableFieldName = (field: string) => comparableFieldNames[field] ?? field;

/** Trade flows in Romanian. */
export const flowNames: Record<string, string> = {
  acquisition: 'achiziție intracomunitară',
  supply: 'livrare intracomunitară',
  import: 'import',
  export: 'export',
};

export const flowName = (flow: string) => flowNames[flow] ?? flow;

/** Concise treatment names in Romanian, falling back to the treatment's own `description`. */
export const treatmentShortNames: Record<string, string> = {
  'ledger.general': 'Notă contabilă',
  'ledger.reverse': 'Stornare',
  'invoices.recognize': 'Factură',
  'invoices.credit': 'Notă de credit',
  'invoices.crossBorder': 'Factură externă',
  'invoices.euConsumer': 'Vânzare către consumator din UE',
  'invoices.reverseCharge': 'Factură cu taxare inversă',
  'receipts.recognize': 'Bon fiscal',
  'retail.zReport': 'Raport Z',
  'retail.receiptInvoice': 'Factură pentru bonuri fiscale',
  'retail.discharge': 'Descărcare gestiune la preț cu amănuntul',
  'retail.count': 'Inventar la preț de vânzare',
  'goods.import': 'Import de bunuri',
  'goods.euAcquisition': 'Achiziție intracomunitară de bunuri',
  'goods.euSupply': 'Livrare intracomunitară de bunuri',
  'goods.export': 'Export de bunuri',
  'tax.decision': 'Decizie fiscală',
  'tax.pay': 'Plată fiscală',
  'tax.distribute': 'Distribuirea plății fiscale',
  'tax.profit': 'Impozit pe profit',
  'tax.micro': 'Impozit microîntreprindere',
  'vat.settle': 'Regularizare TVA',
  'vat.proRata': 'Ajustare pro-rata TVA',
  'vat.capitalGoods': 'Ajustare bunuri de capital',
  'margin.sale': 'Vânzare în regimul marjei',
  'margin.purchase': 'Achiziție în regimul marjei',
  'margin.travel': 'Marja agenției de turism',
  'deferrals.defer': 'Cheltuieli sau venituri în avans',
  'deferrals.release': 'Reluarea cheltuielilor și veniturilor în avans',
  'loans.accrue': 'Dobândă la împrumut',
  'inventory.differences': 'Diferențe de inventar',
  'inventory.stock': 'Inventarul stocurilor',
  'impairment.assets': 'Deprecierea activelor',
  'impairment.receivables': 'Deprecierea creanțelor',
  'provisions.record': 'Provizioane',
  'accruals.settle': 'Regularizarea estimărilor',
  'year.closeResult': 'Închiderea rezultatului',
  'production.wipReverse': 'Reluarea producției în curs',
  'production.cost': 'Costul producției',
  'production.differences': 'Diferențe de producție',
};

export function treatmentName(id: string, treatments?: ReadonlyMap<string, Treatment>): string {
  const listed = treatmentShortNames[id];
  if (listed) return listed;
  const description = treatments?.get(id)?.description;
  if (description) return description.split(':')[0]!.replace(/\.$/, '').trim();
  return id;
}

/** Concise operation names in Romanian, falling back to the registry's `description`. */
export const operationShortNames: Record<string, string> = {
  'periods.close': 'închiderea lunii',
  'periods.reopen': 'redeschiderea lunii',
  'years.close': 'închiderea exercițiului financiar',
  'years.reopen': 'redeschiderea exercițiului financiar',
  'proposals.batch': 'contabilizarea lotului de propuneri',
  'declarations.authorize': 'autorizarea declarației',
  'templates.request': 'crearea șablonului de contabilizare',
  'policies.request': 'acordarea politicii de contabilizare automată',
};

export function operationName(id: string, operations?: OperationRegistry): string {
  const listed = operationShortNames[id];
  if (listed) return listed;
  const description = operations?.find(id)?.description;
  if (description) return description.split(':')[0]!.replace(/\.$/, '').trim();
  return id;
}

export function parameterName(key: string, register?: ParameterRegister): string {
  try {
    const def = register?.definition(key);
    if (def?.description) {
      const head = def.description.split(':')[0] ?? def.description;
      return head
        .replace(/\s*\([^)]*`[^)]*\)/g, '')
        .replace(/`[^`]+`/g, '')
        .replace(/\.$/, '')
        .replace(/\s{2,}/g, ' ')
        .trim();
    }
  } catch {
    // Parameter absent from register: fall back below.
  }
  return key;
}

/** Replaces any lingering internal identifiers in upstream prose so people never see raw keys. */
export function cleanIdentifierText(text: string): string {
  let result = text.trim();
  // Strip parenthetical identifier echoes such as `(activity.goods)`, `(entity.form)`, `(vat.status)`.
  for (const axis of Object.keys(axisNames)) {
    result = result.replaceAll(`(${axis})`, '');
    result = result.replaceAll(`${axis}: `, '');
  }
  result = result.replace(/\s*\(policy\.stock\.retail\.[^)]+\)/g, '');
  result = result.replace(/\bpolicy\.stock\.retail\.[^\s),]+/g, 'politica gestiunii');
  result = result
    .replace(/\(\s*\)/g, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([.,;:])/g, '$1');

  // Replace remaining known dotted or snake_case identifiers with Romanian names.
  for (const [key, name] of Object.entries(axisNames))
    result = result.replace(new RegExp(`\\b${escapeRegex(key)}\\b`, 'g'), name);
  for (const [key, name] of Object.entries(questionKindNames))
    result = result.replace(new RegExp(`\\b${escapeRegex(key)}\\b`, 'g'), name);
  for (const [key, name] of Object.entries(treatmentShortNames))
    result = result.replace(new RegExp(`\\b${escapeRegex(key)}\\b`, 'g'), name);
  for (const [key, name] of Object.entries(documentKindNames))
    result = result.replace(new RegExp(`\\b${escapeRegex(key)}\\b`, 'g'), name);
  for (const [key, name] of Object.entries(authorityNames))
    result = result.replace(new RegExp(`\\b${escapeRegex(key)}\\b`, 'g'), name);
  for (const [key, name] of Object.entries(returnNames))
    if (key.includes('.'))
      result = result.replace(new RegExp(`\\b${escapeRegex(key)}\\b`, 'g'), name);

  result = result
    .replace(/\bdocuments\.record\b/g, 'înregistrarea documentului')
    .replace(/\bdocuments\.supersede\b/g, 'corectarea documentului')
    .replace(/\bparties\.checkStatus\b/g, 'verificarea stării partenerilor')
    .replace(/\btaxaccount\.reconcile\b/g, 'reconcilierea fișei pe plătitor')
    .replace(/\byearend\.review\b/g, 'verificarea de sfârșit de exercițiu')
    .replace(/\byears\.close\b/g, 'închiderea exercițiului')
    .replace(/\bretail\.registers\.record\b/g, 'înregistrarea casei de marcat')
    .replace(/\bretail\.importZ\b/g, 'importul raportului Z')
    .replace(/\bwork\.dispose\b/g, 'închiderea cu motiv')
    .replace(/\bstock\.opening\b/g, 'preluarea soldului inițial în gestiune')
    .replace(/\bstock\.periodCost\b/g, 'calculul costului mediu ponderat')
    .replace(/\bro\.[a-z0-9._]+\b/g, 'regula fiscală')
    .replace(/\bUNSUPPORTED:\s*/g, 'Caz neacoperit: ');

  result = result.replace(
    /(Perioada fiscală de TVA|Forma juridică|Calitatea de angajator|Categoria de mărime a entității|Activitatea cu bunuri și stocuri)([^.\n]*)\bnu este (stabilit|înregistrat)\b/g,
    '$1$2nu este $3ă',
  );
  return result.trim();
}

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Ensures a sentence ends with a single period and starts cleanly. */
export function asSentence(text: string): string {
  const cleaned = cleanIdentifierText(text).replace(/\.+$/, '').trim();
  return cleaned ? `${cleaned}.` : '';
}

export function dedupeCauses(causes: readonly WorkCause[]): WorkCause[] {
  const seen = new Set<string>();
  const result: WorkCause[] = [];
  for (const cause of causes) {
    if (seen.has(cause.id)) continue;
    seen.add(cause.id);
    result.push(cause);
  }
  return result;
}

export function causeFromQuestion(
  question: { kind: string; subject: { kind: string; id: string } },
  message: string,
): WorkCause {
  const clean = asSentence(message);
  if (question.kind === 'profile.fact' || question.kind === 'determination.confirm')
    return {
      id: `fact:${question.subject.id}`,
      kind: 'fact',
      message: clean,
      subject: { kind: 'profile', id: question.subject.id },
    };
  return {
    id: `question:${question.kind}|${question.subject.kind}:${question.subject.id}`,
    kind: 'question',
    message: clean,
    subject: question.subject,
  };
}

export function causeFromFact(axis: string, message: string): WorkCause {
  return {
    id: `fact:${axis}`,
    kind: 'fact',
    message: asSentence(message),
    subject: { kind: 'profile', id: axis },
  };
}

export function causeFromRule(key: string, reason: string, message: string): WorkCause {
  return {
    id: `rule:${key}|${reason}`,
    kind: 'rule',
    message: asSentence(message),
    subject: { kind: 'parameter', id: key },
  };
}

export const textLabel = (label: string): DetailLabel => ({ label, type: 'text' });
export const dateLabel = (label: string): DetailLabel => ({ label, type: 'date' });
export const periodLabel = (label: string): DetailLabel => ({ label, type: 'period' });
export const countLabel = (label: string): DetailLabel => ({ label, type: 'count' });
export type CurrencyLabelSource =
  { currencyKey: string; currency?: never } | { currency: string; currencyKey?: never };
export const amountLabel = (label: string, currency: CurrencyLabelSource): DetailLabel => {
  if (!currency.currency && !currency.currencyKey)
    throw new Error('amountLabel requires a currency code or currencyKey');
  return { label, type: 'amount', ...currency };
};
export const minorLabel = (label: string, currency: CurrencyLabelSource): DetailLabel => {
  if (!currency.currency && !currency.currencyKey)
    throw new Error('minorLabel requires a currency code or currencyKey');
  return { label, type: 'minor', ...currency };
};
export const idLabel = (label: string, kind: string): DetailLabel => ({ label, type: 'id', kind });

/** Generic Romanian label used only in production when a detector omits a key's label. */
export const genericDetailLabel: DetailLabel = { label: 'Detaliu', type: 'text' };

/** Known detail keys across modules, used as a backstop so no detail key is ever unlabelled. */
export const fallbackLabels: DetailLabels = {
  treatment: textLabel('Tratament'),
  version: countLabel('Versiune'),
  effectHash: textLabel('Amprenta efectului'),
  previewHash: textLabel('Amprenta previzualizării'),
  operation: textLabel('Operațiune'),
  input: textLabel('Date de intrare'),
  questions: textLabel('Întrebări'),
  blocking: countLabel('Blocaje'),
  changed: textLabel('Modificări'),
  issues: textLabel('Probleme'),
  acknowledge: textLabel('Avertismente de confirmat'),
  redacted: textLabel('Date cu acces restricționat'),
  kind: textLabel('Tip'),
  subject: textLabel('Obiect'),
  params: textLabel('Parametri'),
  deadline: textLabel('Regula termenului'),
  period: periodLabel('Perioadă'),
  due: dateLabel('Termen'),
  status: textLabel('Stare'),
  artifactId: idLabel('Declarație', 'artifact'),
  gap: textLabel('Ce lipsește'),
  question: textLabel('Întrebare'),
  waiting: periodLabel('An așteptat'),
  code: textLabel('Cod'),
  fact: textLabel('Fapt'),
  blocks: textLabel('Declarații afectate'),
  axis: textLabel('Încadrare'),
  year: periodLabel('An'),
  value: textLabel('Valoare'),
  conflict: textLabel('Conflict cu registrele'),
  fingerprint: textLabel('Amprentă'),
  key: textLabel('Parametru'),
  limit: amountLabel('Limită', { currency: 'RON' }),
  level: countLabel('Prag atins (%)'),
  account: textLabel('Cont'),
  nature: textLabel('Natură'),
  vehicle: textLabel('Vehicul'),
  assetId: idLabel('Mijloc fix', 'asset'),
  number: textLabel('Număr'),
  commissionedOn: dateLabel('Data punerii în funcțiune'),
  change: amountLabel('Diferență', { currency: 'RON' }),
  inBooks: textLabel('An în registre'),
  wanted: textLabel('Răspunsuri necesare'),
  format: textLabel('Format publicat'),
  asOf: dateLabel('Data situației'),
  differences: textLabel('Diferențe'),
  authorityId: idLabel('Autoritate fiscală', 'party'),
  undistributed: amountLabel('Sumă nedistribuită', { currency: 'RON' }),
  rule: textLabel('Regulă'),
  documents: textLabel('Documente'),
  total: amountLabel('Total', { currency: 'RON' }),
  check: textLabel('Verificare'),
  openings: textLabel('Note de deschidere'),
  date: dateLabel('Dată'),
  currency: textLabel('Monedă'),
  book: amountLabel('Sold în registre', { currencyKey: 'currency' }),
  found: amountLabel('Sold constatat', { currencyKey: 'currency' }),
  confirmed: amountLabel('Sold confirmat', { currencyKey: 'currency' }),
  partyId: idLabel('Partener', 'party'),
  name: textLabel('Denumire'),
  partners: textLabel('Parteneri'),
  yearEnd: dateLabel('Sfârșitul exercițiului'),
  overdue: countLabel('Creanțe restante'),
  policy: textLabel('Politică'),
  target: amountLabel('Valoare stabilită', { currency: 'RON' }),
  held: amountLabel('Valoare în registre', { currency: 'RON' }),
  item: textLabel('Element'),
  tag: textLabel('Provizion'),
  items: textLabel('Elemente'),
  accounts: textLabel('Conturi'),
  count: countLabel('Număr'),
  financialYearId: idLabel('Exercițiu financiar', 'financialYear'),
  contractId: idLabel('Contract', 'contract'),
  termsSeq: countLabel('Versiune contract'),
  event: textLabel('Eveniment'),
  rules: textLabel('Reguli'),
  month: periodLabel('Lună'),
  runId: idLabel('Stat de plată', 'payrollRun'),
  reasons: textLabel('Motive'),
  from: dateLabel('De la'),
  to: dateLabel('Până la'),
  proposals: textLabel('Propuneri'),
  versionId: idLabel('Versiune parametru', 'parameterVersion'),
  scope: textLabel('Domeniu'),
  reviewedThrough: dateLabel('Verificat până la'),
  totals: textLabel('Totaluri'),
  authority: textLabel('Sursă'),
  evidenceId: idLabel('Document justificativ', 'evidence'),
  members: textLabel('Copii ale documentului'),
  documentId: idLabel('Document', 'document'),
  better: idLabel('Document e-Factura', 'document'),
  rootId: idLabel('Document principal', 'document'),
  treasuryAccountId: idLabel('Cont de trezorerie', 'treasuryAccount'),
  bookingDate: dateLabel('Data operațiunii'),
  amountMinor: minorLabel('Sumă', { currencyKey: 'currency' }),
  reference: textLabel('Referință'),
  counterparty: textLabel('Partener'),
  outcome: textLabel('Rezultat'),
  uploadId: idLabel('Încărcare SPV', 'spvUpload'),
  detail: textLabel('Detaliu'),
  filename: textLabel('Fișier'),
  mediaType: textLabel('Tip fișier'),
  size: countLabel('Dimensiune (octeți)'),
  hash: textLabel('Amprentă fișier'),
  seq: countLabel('Poziție'),
  reason: textLabel('Motiv'),
  trigger: textLabel('Cauză'),
  system: textLabel('Oprit de sistem'),
  by: textLabel('Autor'),
  details: textLabel('Detalii suplimentare'),
  correct: countLabel('Înregistrări corecte'),
  months: textLabel('Luni'),
  rulesHash: textLabel('Amprenta regulilor'),
  documentKind: textLabel('Tip document'),
  posted: countLabel('Înregistrări contabilizate'),
  flow: textLabel('Flux'),
  declarant: textLabel('Declarant'),
  start: dateLabel('Data începerii'),
  declareFrom: dateLabel('Declarare de la'),
  declareBy: dateLabel('Termen declarare'),
  validUntil: dateLabel('Valabil până la'),
  uit: textLabel('Cod UIT'),
  basis: textLabel('Temei'),
  supplied: dateLabel('Data livrării'),
  issueDate: dateLabel('Data emiterii'),
  b2c: textLabel('Client persoană fizică'),
  registerId: idLabel('Casă de marcat', 'cashRegister'),
  pending: textLabel('Obligații neînregistrate'),
};

/** Ensures every key in `details` has an entry in `labels`. */
export function completeLabels(
  details: Record<string, unknown>,
  explicit?: DetailLabels,
): DetailLabels {
  const result: DetailLabels = { ...(explicit ?? {}) };
  for (const key of Object.keys(details)) {
    if (Object.hasOwn(result, key) && result[key]) continue;
    if (Object.hasOwn(fallbackLabels, key)) {
      result[key] = fallbackLabels[key]!;
      continue;
    }
    if (process.env.NODE_ENV === 'production') {
      result[key] = genericDetailLabel;
      continue;
    }
    throw new Error(`Missing detail label for key "${key}"`);
  }
  return result;
}
