import type { WorkItem } from '../../../xfactura-api/source/engine/kernel/work';
import type { Section } from './navigation';

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
export const groups = ['Așteaptă decizia ta', 'Așteaptă un agent', 'Necesită alt acces sau ajutor'];
export function priority(item: WorkItem) {
  if (item.next.some((step) => step.by === 'human' && step.allowed)) return 0;
  if (item.next.some((step) => step.by === 'agent' && step.allowed)) return 1;
  return 2;
}

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
  'ledger.general': 'review',
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

export function deniedReason(step: WorkStepView) {
  return step.needs?.length
    ? `Lipsește accesul la: ${step.needs.map((kind) => dataClasses[kind] ?? kind).join(', ')}.`
    : `Lipsește permisiunea pentru „${stepLabel(step)}”.`;
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

/** A context link must not promise a form for an operation the current screens do not collect. */
export function hasCollector(step: WorkStepView) {
  if (step.operation === 'proposals.propose') return !!collectors[String(step.inputHint.treatment)];
  return operations[step.operation]?.collector === true;
}
