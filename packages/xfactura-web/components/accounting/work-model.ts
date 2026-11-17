import type { WorkItem } from '../../../xfactura-api/source/engine/kernel/work';
import { formatPeriod, formatPeriods } from './format';
import type { Section } from './navigation';
import type { Tone } from './ui';

export type { WorkItem };
export type WorkStepView = WorkItem['next'][number];
export type Family = 'proposals' | 'documents' | 'bank' | 'deadlines' | 'closing' | 'rules';

export const families: Record<Family, string> = {
  proposals: 'Propuneri',
  documents: 'Documente',
  bank: 'Bancă',
  deadlines: 'Termene',
  closing: 'Închidere',
  rules: 'Reguli',
};

/** Every engine kind belongs to a filter, including questions within their current workflow. */
export const kindFamilies: Record<WorkItem['kind'], Family> = {
  'proposal.awaitingApproval': 'proposals',
  'proposal.approved': 'proposals',
  'proposal.blocked': 'proposals',
  'proposal.stale': 'proposals',
  'question.needed': 'proposals',
  'question.open': 'proposals',
  'action.awaitingDecision': 'proposals',
  'action.approved': 'proposals',
  'obligation.due': 'deadlines',
  'closure.need': 'closing',
  'determination.missing': 'rules',
  'threshold.approaching': 'rules',
  'profit.unclassified': 'closing',
  'asset.fiscalMissing': 'closing',
  'profit.correction': 'closing',
  'annual.input': 'closing',
  'taxaccount.differs': 'bank',
  'taxaccount.undistributed': 'bank',
  'taxaccount.correction': 'deadlines',
  'vat.prorata': 'closing',
  'vat.capitalGoods': 'closing',
  'margin.travel': 'closing',
  'yearend.review': 'closing',
  'payroll.due': 'deadlines',
  'goods.proof': 'documents',
  'etransport.uit': 'deadlines',
  'efactura.due': 'deadlines',
  'retail.register': 'deadlines',
  'close.finding': 'closing',
  'period.unclosed': 'closing',
  'rule.gap': 'rules',
  'rule.expiring': 'rules',
  'document.unproposed': 'documents',
  'document.betterSource': 'documents',
  'document.originsDiffer': 'documents',
  'bank.unexplained': 'bank',
  'spv.message': 'documents',
  'evidence.unused': 'documents',
  'automation.paused': 'rules',
  'template.graduation': 'rules',
  'template.candidate': 'rules',
};

export const severities = { block: 'Blocant', warn: 'Avertisment', info: 'Informare' };

/** Who acts on an item, as the engine counts it (`company.summary`'s `work.by`): a step a person
 * may take, else one an agent may; `access` when every step is refused to the caller and
 * `waiting` when the item has no step at all (a rule to review, a year not begun). */
export type Who = 'person' | 'agent' | 'access' | 'waiting';
export const whoHeadings: Record<Who, string> = {
  person: 'De făcut de tine',
  agent: 'Așteaptă un agent',
  access: 'Necesită acces',
  waiting: 'În așteptare',
};
const whoOrder: Who[] = ['person', 'agent', 'access', 'waiting'];
export function whoActs(item: WorkItem): Who {
  if (item.next.some((step) => step.by === 'human' && step.allowed)) return 'person';
  if (item.next.some((step) => step.by === 'agent' && step.allowed)) return 'agent';
  return item.next.length ? 'access' : 'waiting';
}

/** A person's step that records a missing company fact (`profile.record { axis, effectiveFrom }`). */
export const factSteps = (item: WorkItem) =>
  item.next.filter((step) => step.by === 'human' && step.operation === 'profile.record');

/** Items a person settles by recording a company fact belong to the „Profilul firmei” card. */
export const isFactItem = (item: WorkItem) => factSteps(item).length > 0;

/** A return of the calendar as the engine names it: `<return>|<period>`. */
const returnKey = /^([A-Z][A-Za-z0-9.]*)\|(\d{4}(?:-\d{2}|-Q[1-4])?)$/;
export const isReturnKey = (value: unknown): value is string =>
  typeof value === 'string' && returnKey.test(value);

/** The returns an item names in its details (`blocks` and the like), as `<return>|<period>`. */
export function affectedReturns(item: WorkItem) {
  return Object.values(item.details ?? {}).flatMap((value) =>
    Array.isArray(value) ? value.filter(isReturnKey) : [],
  );
}

/** Returns grouped by kind, their periods collapsed: `D112 · ian–dec 2026`. */
export function returnChips(keys: readonly string[]) {
  const periods = new Map<string, string[]>();
  for (const key of keys) {
    const match = returnKey.exec(key);
    if (!match) continue;
    periods.set(match[1]!, [...(periods.get(match[1]!) ?? []), match[2]!]);
  }
  return [...periods].map(([kind, list]) => `${kind} · ${formatPeriods(list)}`);
}

/** The tone of a return's status: late or refused returns warn most, blocked ones next. */
export const returnTones: Record<string, Tone> = {
  overdue: 'danger',
  rejected: 'danger',
  blocked: 'warning',
  prepared: 'accent',
  authorized: 'accent',
};

/** The statuses of a return, as the calendar names them. */
export const returnStatuses: Record<string, string> = {
  due: 'De pregătit',
  overdue: 'Termen depășit',
  prepared: 'Pregătită',
  authorized: 'Autorizată',
  rejected: 'Respinsă',
  blocked: 'Blocată',
  filed: 'Depusă',
  accepted: 'Acceptată',
};

/**
 * A row's title. A return reads as itself and its period (`D300 · octombrie 2026`), its status a
 * chip beside it; every other item reads as the engine's message, which states the need alone.
 */
export function itemTitle(item: WorkItem) {
  if (item.kind === 'obligation.due') {
    const [kind, period] = item.subject.id.split('|');
    return `${kind} · ${formatPeriod(period ?? item.period ?? '')}`;
  }
  return item.message;
}

/** A cause, as the worklist's items name it (`causes[]`). */
export type WorkCause = NonNullable<WorkItem['causes']>[number];

/** One row of the worklist: an item, or a cause several items share, collapsed. */
export type WorkRowModel =
  | { kind: 'item'; key: string; who: Who; item: WorkItem; fact: string | null }
  | {
      kind: 'cause';
      key: string;
      who: Who;
      cause: WorkCause;
      items: WorkItem[];
      fact: string | null;
    }
  | {
      kind: 'return';
      key: string;
      who: Who;
      /** The return's code (`D300`) and the status its periods share (`overdue`). */
      form: string;
      status: string;
      items: WorkItem[];
      fact: null;
    };

/** A return item's code and status, and the steps that move it on: periods of the same return
 * that share all three are one row. */
function returnGroup(item: WorkItem) {
  if (item.kind !== 'obligation.due') return null;
  const form = item.subject.id.split('|')[0] ?? '';
  const status = String(item.details?.status ?? '');
  const steps = item.next.map((step) => `${step.operation}:${step.by}:${step.allowed}`).join(',');
  return { form, status, key: `${form}|${status}|${whoActs(item)}|${steps}` };
}

/**
 * The worklist's rows under who acts. Items whose first cause is the same (`causes[0].id`, the
 * engine's order) collapse into one row for that cause. `facts` maps a cause id to the card row
 * that records it: causes a person settles by recording the same fact are one row, which waits on
 * that person.
 */
export function arrangeWork(items: readonly WorkItem[], facts: ReadonlyMap<string, string>) {
  const rows: WorkRowModel[] = [];
  const byCause = new Map<string, { cause: WorkCause; items: WorkItem[]; at: number }>();
  for (const item of items) {
    const cause = item.causes?.[0];
    if (!cause) {
      rows.push({ kind: 'item', key: item.id, who: whoActs(item), item, fact: null });
      continue;
    }
    const fact = facts.get(cause.id);
    const key = fact ? `fact:${fact}` : cause.id;
    const known = byCause.get(key);
    if (known) known.items.push(item);
    else {
      byCause.set(key, { cause, items: [item], at: rows.length });
      rows.push({ kind: 'item', key: item.id, who: whoActs(item), item, fact: null });
    }
  }
  for (const { cause: first, items: members, at } of byCause.values()) {
    // The item that owns the cause (the open question, the need) states it for people; the items
    // it blocks repeat it inside their own issues.
    const owner = members.find((item) => causeOwners.has(item.kind));
    const cause = owner?.causes?.[0] ?? first;
    const fact = facts.get(first.id) ?? null;
    const best = whoOrder.find((who) => members.some((item) => whoActs(item) === who))!;
    const who = fact ? 'person' : best;
    rows[at] =
      members.length > 1
        ? { kind: 'cause', key: `cause:${first.id}`, who, cause, items: members, fact }
        : { kind: 'item', key: members[0]!.id, who, item: members[0]!, fact };
  }
  // Returns that wait on nothing else: the periods of one return in one state, moved on by the
  // same steps, are one row (`D300`, its months), opened to each period.
  const merged: WorkRowModel[] = [];
  const byReturn = new Map<
    string,
    { at: number; form: string; status: string; items: WorkItem[] }
  >();
  for (const row of rows) {
    const group = row.kind === 'item' && !row.fact ? returnGroup(row.item) : null;
    if (group && row.kind === 'item') {
      const known = byReturn.get(group.key);
      if (known) {
        known.items.push(row.item);
        continue;
      }
      byReturn.set(group.key, { at: merged.length, ...group, items: [row.item] });
    }
    merged.push(row);
  }
  for (const [key, { at, form, status, items: members }] of byReturn)
    if (members.length > 1)
      merged[at] = {
        kind: 'return',
        key: `return:${key}`,
        who: merged[at]!.who,
        form,
        status,
        items: members,
        fact: null,
      };
  return whoOrder
    .map((who) => ({
      who,
      heading: whoHeadings[who],
      rows: merged.filter((row) => row.who === who),
    }))
    .filter((group) => group.rows.length);
}

/** The item due first: the earliest deadline, then the earliest listed (the engine lists returns
 * by deadline and period). */
export const firstDue = (items: readonly WorkItem[]) =>
  items.reduce((first, item) => (item.due && (!first.due || item.due < first.due) ? item : first));

/** How many periods, by their length: `9 luni`, `3 trimestre`, `2 ani`, else `5 perioade`. */
export function periodCount(periods: readonly string[]) {
  const n = periods.length;
  const de = n % 100 >= 20 || (n > 0 && n % 100 === 0) ? ' de' : '';
  const [one, many] = periods.every((period) => /^\d{4}-\d{2}$/.test(period))
    ? ['lună', 'luni']
    : periods.every((period) => /^\d{4}-Q[1-4]$/.test(period))
      ? ['trimestru', 'trimestre']
      : periods.every((period) => /^\d{4}$/.test(period))
        ? ['an', 'ani']
        : ['perioadă', 'perioade'];
  return n === 1 ? `1 ${one}` : `${n}${de} ${many}`;
}

/** The kinds whose item is a cause itself: an open question, a need of the obligations. */
const causeOwners: ReadonlySet<string> = new Set(['question.open', 'closure.need']);

/** What a row's button does: open the row, follow a link, or reach the fact's control. */
export type RowAction =
  | { kind: 'expand'; label: string }
  | { kind: 'link'; label: string; section: Section; filters: Record<string, string | null> }
  | { kind: 'fact'; label: string; fact: string };

/** The one action at the right of a row: the step a person takes next, else „Verifică”. */
export function rowAction(row: WorkRowModel): RowAction {
  if (row.fact) return { kind: 'fact', label: 'Completează', fact: row.fact };
  // A return's periods open in Declarații at the first of them, the earliest due.
  if (row.kind === 'return')
    return {
      kind: 'link',
      label: 'Deschide',
      section: 'deadlines',
      filters: { return: firstDue(row.items).subject.id, month: null, declarationStatus: null },
    };
  if (row.kind === 'cause') {
    // A question its items wait on is answered from the row; anything else opens it.
    const answer = row.items
      .map((item) => rowAction({ ...row, kind: 'item', key: item.id, item }))
      .find((action) => action.kind === 'link' && action.section === 'questions');
    return answer ?? { kind: 'expand', label: 'Verifică' };
  }
  const item = row.item;
  const mine = item.next.filter((step) => step.by === 'human' && step.allowed);
  if (item.kind === 'obligation.due')
    return {
      kind: 'link',
      label: 'Deschide',
      section: 'deadlines',
      filters: { return: item.subject.id, month: null, declarationStatus: null },
    };
  const question =
    item.subject.kind === 'question'
      ? item.subject.id
      : mine
          .map((step) => step.inputHint.questionId)
          .find((id): id is string => typeof id === 'string' && id !== '');
  if (question && mine.some((step) => step.operation === 'questions.answer'))
    return {
      kind: 'link',
      label: 'Răspunde',
      section: 'questions',
      filters: { question, questionStatus: null, questionKind: null },
    };
  if (mine.some((step) => ['proposals.approve', 'actions.approve'].includes(step.operation)))
    return { kind: 'expand', label: 'Aprobă' };
  const collected = mine.find((step) => hasCollector(step) && stepSection(step));
  if (collected)
    return {
      kind: 'link',
      label: 'Completează',
      section: stepSection(collected)!,
      filters: stepFilters(collected),
    };
  return { kind: 'expand', label: 'Verifică' };
}

const permissionNames: Record<string, string> = {
  read: 'citire',
  write: 'înregistrare',
  review: 'verificare',
  manage: 'administrare',
};

const dataClasses: Record<string, string> = {
  books: 'registre contabile',
  evidence: 'documente justificative',
  personal: 'date personale',
  payroll: 'date salariale',
  health: 'date de sănătate',
  tax: 'date fiscale',
  credentials: 'date de acces și conectare',
};

const operationLabels: Record<string, string> = {
  'proposals.propose': 'Pregătește propunerea',
  'proposals.revise': 'Revizuiește propunerea',
  'proposals.get': 'Reverifică propunerea',
  'proposals.approve': 'Aprobă această versiune',
  'proposals.withdraw': 'Retrage propunerea',
  'ledger.post': 'Contabilizează',
  'actions.approve': 'Aprobă această previzualizare',
  'actions.reject': 'Respinge acțiunea',
  'actions.execute': 'Execută acțiunea aprobată',
  'questions.ask': 'Cere informațiile lipsă',
  'questions.answer': 'Răspunde la întrebare',
  'questions.withdraw': 'Retrage întrebarea',
  'profile.record': 'Înregistrează faptul despre firmă',
  'work.dispose': 'Închide cu motiv',
  'documents.get': 'Verifică documentul',
  'documents.record': 'Înregistrează documentul',
  'documents.supersede': 'Corectează documentul extras',
  'evidence.read': 'Citește documentul justificativ',
  'invoices.import': 'Importă factura',
  'bank.import': 'Importă extrasul bancar',
  'bank.importCsv': 'Importă extrasul CSV',
  'spv.sync': 'Preia mesajele din SPV',
  'spv.submit': 'Trimite factura în SPV',
  'periods.close.request': 'Verifică luna pentru închidere',
  'years.close.request': 'Verifică exercițiul pentru închidere',
  'years.opening': 'Pregătește deschiderea exercițiului',
  'declarations.prepare': 'Pregătește declarația',
  'declarations.validate': 'Validează declarația',
  'declarations.pdf': 'Generează PDF-ul declarației',
  'declarations.importSigned': 'Importă declarația semnată',
  'declarations.authorize.request': 'Cere autorizarea declarației',
  'declarations.recordSubmission': 'Înregistrează depunerea declarației',
  'determinations.propose': 'Verifică încadrarea fiscală',
  'automation.resume': 'Reia automatizarea',
  'policies.revoke': 'Revocă politica',
  'templates.revoke': 'Revocă șablonul',
  'policies.request': 'Cere o politică de contabilizare',
  'templates.request': 'Pregătește șablonul',
  'assets.dispose': 'Înregistrează ieșirea activului',
  'assets.recordFiscal': 'Înregistrează baza fiscală a activului',
  'annual.ask': 'Cere datele situațiilor anuale',
  'payroll.reges.record': 'Înregistrează transmiterea în REGES-ONLINE',
  'retail.registers.event': 'Înregistrează evenimentul casei de marcat',
  'taxaccount.reconcile': 'Verifică fișa fiscală',
  'vat.proRata.compute': 'Calculează pro-rata',
  'vat.proRata.propose': 'Pregătește ajustarea pro-rata',
  'vat.capitalGoods.register': 'Verifică registrul bunurilor de capital',
  'vat.capitalGoods.propose': 'Pregătește ajustarea bunurilor de capital',
  'parties.checkStatus': 'Verifică situația partenerilor',
  'bank.recordStatement': 'Înregistrează extrasul transcris',
  'spv.refresh': 'Verifică răspunsurile din SPV',
  'work.list': 'Verifică lista de lucru',
  'inventory.compare': 'Compară inventarul cu registrele',
  'inventory.lists': 'Verifică listele de inventariere',
  'yearend.profitDeterminations': 'Verifică încadrarea rezultatului anual',
  'periods.close': 'Închide luna',
  'periods.reopen': 'Redeschide luna',
  'years.close': 'Închide exercițiul',
  'years.reopen': 'Redeschide exercițiul',
  'proposals.batch': 'Verifică lotul de propuneri',
  'declarations.authorize': 'Autorizează declarația',
};

export const treatmentLabels: Record<string, string> = {
  'ledger.general': 'Notă contabilă',
  'ledger.reverse': 'Stornare',
  'invoices.recognize': 'Factură',
  'invoices.credit': 'Notă de credit',
  'bank.settle': 'Mișcare bancară',
  'fx.revalue': 'Reevaluare valutară',
  'invoices.crossBorder': 'Factură externă',
  'invoices.euConsumer': 'Vânzare către un consumator din UE',
  'invoices.reverseCharge': 'Factură cu taxare inversă',
  'receipts.recognize': 'Bon fiscal',
  'retail.zReport': 'Raport Z',
  'retail.receiptInvoice': 'Factură pentru bonuri fiscale',
  'goods.import': 'Import de bunuri',
  'goods.acquire': 'Achiziție de bunuri',
  'goods.supply': 'Livrare de bunuri',
  'goods.export': 'Export de bunuri',
  'tax.decision': 'Decizie fiscală',
  'tax.pay': 'Plată fiscală',
  'tax.distribute': 'Distribuirea plății fiscale',
  'tax.profit': 'Impozit pe profit',
  'margin.sale': 'Vânzare în regimul marjei',
  'margin.purchase': 'Achiziție în regimul marjei',
  'margin.travel': 'Marja agenției de turism',
  'deferrals.release': 'Reluarea cheltuielilor în avans',
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

type StepDefinition = {
  label: string;
  section?: Section;
  collector?: boolean;
  required?: readonly string[];
};
/** Only these existing screens collect the operation's actual input. Revision has no form. */
const collectors: Record<string, Section> = {
  'invoices.recognize': 'documents',
  'invoices.credit': 'documents',
  'bank.settle': 'bank',
  'ledger.general': 'registers',
};
/** Where in its section a collector's form opens: the journal entry in Registrul jurnal. */
const collectorFilters: Record<string, Record<string, string>> = {
  'ledger.general': { register: 'jurnal', entry: 'new' },
};
const operations: Record<string, StepDefinition> = Object.fromEntries([
  ...Object.entries(operationLabels).map(([id, label]) => [id, { label }]),
  ...Object.entries(treatmentLabels).flatMap(([id, label]) => [
    [
      `${id}.propose`,
      { label: `Pregătește: ${label}`, section: collectors[id], collector: !!collectors[id] },
    ],
    [`${id}.revise`, { label: `Revizuiește: ${label}` }],
  ]),
]);
Object.assign(operations, {
  'invoices.import': {
    label: operationLabels['invoices.import'],
    section: 'documents',
    collector: true,
  },
  'bank.import': { label: operationLabels['bank.import'], section: 'documents', collector: true },
  'fx.importBnr': { label: 'Importă cursurile BNR', section: 'documents', collector: true },
  'documents.get': { label: operationLabels['documents.get'], section: 'documents' },
  'evidence.read': { label: operationLabels['evidence.read'], section: 'documents' },
  'periods.close.request': {
    label: operationLabels['periods.close.request'],
    section: 'periods',
    collector: true,
  },
  'actions.approve': { label: operationLabels['actions.approve'], required: ['id', 'previewHash'] },
  'declarations.authorize.request': {
    label: operationLabels['declarations.authorize.request'],
    required: ['artifactId'],
  },
  'spv.submit': { label: operationLabels['spv.submit'], required: ['documentId'] },
} satisfies Record<string, StepDefinition>);

export const operationLabel = (operation: string) => operations[operation]?.label;
export const stepLabel = (step: WorkStepView) =>
  operationLabel(step.operation) ?? 'Verifică pasul următor';

/** Why a step is refused to the caller, in one line, from the engine's `reason`. */
export function refusal(step: WorkStepView) {
  const reason = step.reason;
  if (reason?.kind === 'state') return reason.message;
  if (step.needs?.length)
    return `Lipsește accesul la: ${step.needs.map((kind) => dataClasses[kind] ?? kind).join(', ')}.`;
  if (reason?.kind === 'role')
    return `Rolul tău nu are dreptul de ${permissionNames[reason.permission] ?? reason.permission}.`;
  if (reason?.kind === 'grant') return 'Pasul este al unei persoane.';
  return `Lipsește permisiunea pentru „${stepLabel(step)}”.`;
}

/** These human steps have complete hints in today's detectors. Approval stays in review.tsx. */
export function directStep(step: WorkStepView) {
  return (
    step.by === 'human' &&
    step.allowed &&
    operations[step.operation]?.required?.every(
      (key) => typeof step.inputHint[key] === 'string' && step.inputHint[key] !== '',
    ) === true
  );
}

/** Manual collectors that already exist; no invented defaults complete an input hint. */
export function stepSection(step: WorkStepView): Section | null {
  if (step.operation === 'proposals.propose')
    return collectors[String(step.inputHint.treatment)] ?? null;
  return operations[step.operation]?.section ?? null;
}

/** The address filters that open a step's form inside its section, when it has one. */
export function stepFilters(step: WorkStepView): Record<string, string> {
  return step.operation === 'proposals.propose'
    ? (collectorFilters[String(step.inputHint.treatment)] ?? {})
    : {};
}

/** A context link must not promise a form for an operation the current screens do not collect. */
export function hasCollector(step: WorkStepView) {
  if (step.operation === 'proposals.propose') return !!collectors[String(step.inputHint.treatment)];
  return operations[step.operation]?.collector === true;
}
