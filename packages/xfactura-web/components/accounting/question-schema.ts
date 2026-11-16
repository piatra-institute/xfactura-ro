import { questionKind } from 'xfactura-core/questions/kinds';

type Schema = {
  type?: string;
  properties?: Record<string, Schema>;
  required?: string[];
  anyOf?: Schema[];
  enum?: unknown[];
  const?: unknown;
  items?: Schema;
  format?: string;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  minItems?: number;
};
export type AnswerField = {
  name: string;
  label: string;
  required: boolean;
  type:
    | 'text'
    | 'date'
    | 'month'
    | 'integer'
    | 'boolean'
    | 'select'
    | 'evidence'
    | 'evidenceIds'
    | 'fact'
    | 'item';
  options?: { value: string; label: string }[];
  minLength?: number;
  maxLength?: number;
  min?: number;
  max?: number;
  decimal: boolean;
  condition?: string;
};
export type AnswerVariant = { label: string; fields: AnswerField[] };

export const questionLabels: Record<string, string> = {
  'vehicle.use': 'Folosirea vehiculului',
  'deferral.schedule': 'Perioada acoperită',
  'payroll.absences': 'Absențe',
  'payroll.benefits': 'Avantaje în natură',
  'evidence.missing': 'Document lipsă',
  choice: 'Alegere',
  'profile.fact': 'Situația companiei',
  'determination.confirm': 'Confirmarea încadrării',
  'year.figures': 'Cifre din anii anteriori',
  'micro.conditions': 'Condiții pentru microîntreprindere',
  'profit.account': 'Încadrarea contului',
  'profit.losses': 'Pierderi fiscale',
  'obligation.filed': 'Declarație depusă în afara aplicației',
  'vat.refund': 'Rambursare TVA',
  'capitalGood.use': 'Folosirea bunului de capital',
  'farmer.register': 'Registrul agricultorilor',
  'nonresident.payee': 'Plata către nerezident',
  'nonresident.certificate': 'Rezidență fiscală',
  'annual.informative': 'Date informative',
  'annual.disclosures': 'Note explicative',
  'annual.document': 'Document semnat al situațiilor financiare',
  'receivable.collectibility': 'Încasarea creanței',
  'leave.untaken': 'Concedii neefectuate',
  'provisions.review': 'Obligații pentru provizioane',
  'stock.item': 'Articolul furnizorului',
  'goods.proof': 'Dovada transportului',
  'etransport.uit': 'Cod UIT',
  'retail.goods': 'Mărfurile din raportul Z',
  'production.excess': 'Consum peste normă',
};

const fieldLabels: Record<string, string> = {
  use: 'Folosirea vehiculului',
  from: 'De la',
  until: 'Până la',
  logEvidenceId: 'Foaie de parcurs',
  exception: 'Excepția aplicabilă',
  exceptionEvidenceId: 'Documentul excepției',
  months: 'Număr de luni',
  evidenceId: 'Document justificativ',
  evidenceIds: 'Documente justificative',
  unavailable: 'Document indisponibil',
  reason: 'Motiv',
  value: 'Valoare',
  effectiveFrom: 'Data de la care se aplică',
  supersedesId: 'Faptul înlocuit',
  confirm: 'Confirmarea încadrării prezentate',
  registrationNumber: 'Număr de înregistrare',
  submittedOn: 'Data depunerii',
  choice: 'Alegerea persoanei',
  income: 'Natura venitului',
  beneficiary: 'Beneficiar',
  contractEvidenceId: 'Contract',
  certificateEvidenceId: 'Certificat de rezidență fiscală',
  state: 'Stat de rezidență (cod de două litere)',
  year: 'An',
  presentedOn: 'Data prezentării',
  treatyEvidenceId: 'Textul convenției',
  article: 'Articolul convenției',
  rate: 'Cotă (%)',
  share: 'Proporția cu drept de deducere (%)',
  registered: 'Înscris în registrul agricultorilor',
  itemId: 'Articol din nomenclator',
  factor: 'Unități ale articolului pe unitatea facturată',
  treatment: 'Tratamentul consumului',
  nature: 'Natura cheltuielii sau venitului',
  vehicle: 'Număr de înmatriculare',
  clause: 'Litera legii',
  status: 'Starea creanței',
  recoverable: 'Partea recuperabilă (%)',
  guaranteed: 'Garantată de altă persoană',
  affiliated: 'Client afiliat',
  note: 'Explicație',
  days: 'Zile de concediu neefectuate',
  amount: 'Indemnizație (lei)',
  contributions: 'Contribuții (lei)',
  measured: 'Sumă calculată pe statele de salarii',
  uit: 'Cod UIT',
  declaredOn: 'Data declarării',
  start: 'Data începerii transportului',
  required: 'Cod UIT necesar',
};
const enumLabels: Record<string, string> = {
  business_only: 'Exclusiv pentru activitatea economică',
  mixed: 'Activitate economică și uz personal',
  over_3500kg_or_9_seats: 'Peste 3.500 kg sau mai mult de 9 scaune',
  sales_or_purchasing_agent: 'Agent de vânzări sau achiziții',
  paid_passenger_transport: 'Transport de persoane cu plată',
  paid_services: 'Servicii cu plată',
  rental_or_leasing: 'Închiriere sau leasing',
  goods_for_resale: 'Marfă pentru revânzare',
  refund: 'Solicit rambursarea',
  carry_forward: 'Reportez în perioada următoare',
  dividends: 'Dividende',
  interest: 'Dobânzi',
  royalties: 'Redevențe',
  commissions: 'Comisioane',
  services: 'Servicii',
  not_taxable: 'Venit neimpozabil în România',
  company: 'Persoană juridică',
  individual: 'Persoană fizică',
  abnormal: 'Pierdere peste limitele normal admise',
  normal: 'Consum normal',
  protocol: 'Protocol',
  advertising: 'Reclamă',
  social: 'Cheltuieli sociale',
  fine: 'Amendă datorată autorităților',
  contract_penalty: 'Penalitate contractuală',
  sponsorship: 'Sponsorizare',
  vehicle: 'Cheltuieli cu vehicule',
  deductible: 'Cheltuială deductibilă',
  nondeductible: 'Cheltuială nedeductibilă',
  dividend_ro: 'Dividende de la o persoană juridică română',
  nontaxable: 'Venit neimpozabil',
  taxable: 'Venit impozabil',
  collectible: 'Încasabilă',
  doubtful: 'Incertă',
  litigation: 'În litigiu',
  insolvency: 'Insolvență',
  bankruptcy: 'Faliment declarat',
};
const variantLabels: Record<string, string[]> = {
  'evidence.missing': ['Atașez documentul', 'Explic de ce lipsește'],
  'determination.confirm': ['Confirm încadrarea', 'Indic altă încadrare'],
  'etransport.uit': ['Înregistrez codul UIT', 'Explic de ce nu este necesar'],
};
const fieldConditions: Record<string, Record<string, string>> = {
  'vehicle.use': {
    logEvidenceId: 'necesară dacă vehiculul este folosit exclusiv pentru activitatea economică',
    exception: 'necesară dacă indici documentul excepției',
    exceptionEvidenceId: 'necesar dacă indici o excepție',
  },
  'profit.account': {
    vehicle: 'necesar pentru cheltuieli cu un vehicul',
    clause: 'necesară pentru cheltuieli nedeductibile sau venituri neimpozabile',
    evidenceIds: 'necesare pentru sponsorizare',
  },
  'receivable.collectibility': {
    evidenceIds: 'necesare dacă starea nu este «Încasabilă»',
  },
};
const dates = new Set([
  'from',
  'until',
  'effectiveFrom',
  'submittedOn',
  'presentedOn',
  'declaredOn',
  'start',
]);
const decimals = new Set(['amount', 'contributions', 'rate', 'share', 'recoverable', 'factor']);

/** Render only shapes whose fields and choices have a Romanian label. Refinements stay with
 * the engine; JSON Schema is used to select native controls, never to parse the answer. */
export function answerVariants(
  kindId: string,
  params: Record<string, unknown>,
): AnswerVariant[] | null {
  try {
    const kind = questionKind(kindId);
    if (!kind) return null;
    const schema = kind.answer(kind.params.parse(params)).toJSONSchema({ io: 'input' }) as Schema;
    const schemas = schema.anyOf ?? [schema];
    if (schemas.length > 1 && variantLabels[kindId]?.length !== schemas.length) return null;
    const variants: AnswerVariant[] = [];
    for (const [index, object] of schemas.entries()) {
      if (object.type !== 'object' || !object.properties) return null;
      const fields: AnswerField[] = [];
      for (const [name, field] of Object.entries(object.properties)) {
        const label =
          kindId === 'deferral.schedule' && name === 'from' ? 'Prima lună' : fieldLabels[name];
        if (!label) return null;
        const required = object.required?.includes(name) ?? false;
        let type: AnswerField['type'];
        let options: AnswerField['options'];
        if (field.type === 'array' && name === 'evidenceIds' && field.items?.format === 'uuid')
          type = 'evidenceIds';
        else if (field.type === 'string' && field.format === 'uuid') {
          if (name.endsWith('EvidenceId') || name === 'evidenceId') type = 'evidence';
          else if (name === 'supersedesId') type = 'fact';
          else if (name === 'itemId') type = 'item';
          else return null;
        } else if (kindId === 'choice' && name === 'value') {
          if (!Array.isArray(params.options)) return null;
          options = params.options as { value: string; label: string }[];
          type = 'select';
        } else if (field.enum || field.const !== undefined) {
          const values = field.enum ?? [field.const];
          options = [];
          for (const value of values) {
            const label =
              typeof value === 'boolean'
                ? value
                  ? 'Da'
                  : 'Nu'
                : (enumLabels[String(value)] ?? (name === 'clause' ? String(value) : undefined));
            if (!label) return null;
            options.push({ value: String(value), label });
          }
          type = field.type === 'boolean' ? 'boolean' : 'select';
        } else if (field.type === 'boolean') {
          type = 'boolean';
          options = [
            { value: 'true', label: 'Da' },
            { value: 'false', label: 'Nu' },
          ];
        } else if (field.type === 'integer') type = 'integer';
        else if (field.type === 'string')
          type =
            kindId === 'deferral.schedule' && name === 'from'
              ? 'month'
              : dates.has(name)
                ? 'date'
                : 'text';
        else return null;
        fields.push({
          name,
          label,
          type,
          options,
          required: type === 'evidenceIds' ? (field.minItems ?? 0) > 0 : required,
          minLength: field.minLength,
          maxLength: field.maxLength,
          min: field.minimum,
          max: field.maximum,
          decimal: decimals.has(name),
          condition: fieldConditions[kindId]?.[name],
        });
      }
      variants.push({ label: variantLabels[kindId]?.[index] ?? 'Răspuns', fields });
    }
    return variants;
  } catch {
    return null;
  }
}

/** Strings, including decimal money and whitespace, reach the engine verbatim. Only schema
 * integers and explicit boolean choices need conversion to their JSON types. */
export function enteredAnswer(fields: AnswerField[], data: FormData) {
  const answer: Record<string, unknown> = {};
  for (const field of fields) {
    if (field.type === 'evidenceIds') {
      answer[field.name] = data.getAll(field.name);
      continue;
    }
    const value = String(data.get(field.name) ?? '');
    if (!field.required && value === '') continue;
    answer[field.name] =
      field.type === 'integer'
        ? Number(value)
        : field.type === 'boolean'
          ? value === 'true'
          : value;
  }
  return answer;
}
