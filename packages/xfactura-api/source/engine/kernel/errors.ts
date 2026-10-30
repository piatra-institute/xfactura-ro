import { ZodError } from 'zod';
import { DomainError } from 'xfactura-core/errors';
import { RuleGapError } from 'xfactura-core/rules';

export type WireError = {
  status: number;
  error: { code: string; message: string; details?: unknown };
};

// Database invariant codes (`inv:<code>`) that callers can act on, with their public form.
// Others surface as ACCOUNTING_INVARIANT with the code in the details.
const invariants: Record<string, [code: string, message: string]> = {
  closed_period: ['PERIOD_CLOSED', 'Perioada este închisă.'],
  tax_period_locked: ['TAX_PERIOD_LOCKED', 'Perioada fiscală a fost declarată și este blocată.'],
  binding: ['APPROVAL_REQUIRED', 'Aprobați versiunea exactă înainte de contabilizare.'],
  stale_version: ['STALE', 'Propunerea s-a schimbat. Reîncărcați datele.'],
  stale_approval: ['STALE', 'Versiunea aprobată nu mai este actuală.'],
  stale_read: ['STALE', 'Pozițiile citite de propunere s-au schimbat. Reîncărcați datele.'],
  already_posted: ['ALREADY_POSTED', 'Propunerea este deja contabilizată.'],
  withdrawn: ['WITHDRAWN', 'Propunerea a fost retrasă.'],
  open_item_balance: ['OPEN_ITEM_BALANCE', 'Operațiunea depășește soldul poziției deschise.'],
  immutable_record: ['IMMUTABLE', 'Înregistrarea nu mai poate fi modificată.'],
  approver: ['FORBIDDEN', 'Aprobarea cere un proprietar sau un revizor activ.'],
  decider: [
    'APPROVER_INACTIVE',
    'Persoana care a aprobat acțiunea nu mai este proprietar sau revizor activ.',
  ],
  segregation: ['SEGREGATION', 'Separarea atribuțiilor cere aprobarea altei persoane.'],
  year_overlap: ['YEAR_OVERLAP', 'Exercițiul se suprapune cu unul existent.'],
  identity_taken: [
    'DOCUMENT_BOOKED',
    'Același document, din altă sursă, are deja o propunere deschisă sau contabilizată.',
  ],
  supersede: [
    'DOCUMENT_POSTED',
    'Documentul nu mai poate fi înlocuit: corectați prin stornare și o propunere nouă.',
  ],
  statement_overlap: [
    'BANK_STATEMENT_OVERLAP',
    'Zilele extrasului sunt deja acoperite de alt extras al aceluiași cont.',
  ],
  question_open: [
    'QUESTION_OPEN',
    'Aceeași întrebare despre același obiect așteaptă deja un răspuns.',
  ],
  question_answered: ['QUESTION_ANSWERED', 'Întrebarea are deja un răspuns.'],
  question_withdrawn: ['QUESTION_WITHDRAWN', 'Întrebarea a fost retrasă.'],
  answer_person: ['AGENT_SCOPE', 'Răspunsul aparține unei persoane.'],
  answerer: ['FORBIDDEN', 'Răspunsul cere un proprietar sau un revizor activ.'],
  disposition_person: ['AGENT_SCOPE', 'Această decizie aparține unei persoane.'],
};

function causes(error: unknown) {
  const chain: unknown[] = [];
  for (let cause = error, depth = 0; cause && depth < 8; depth++) {
    chain.push(cause);
    cause = (cause as { cause?: unknown }).cause;
  }
  return chain;
}

/** The bounded, credential-free error both REST and MCP return. */
export function wireError(error: unknown): WireError {
  if (error instanceof DomainError)
    return {
      status: error.status,
      error: {
        code: error.code,
        message: error.message,
        ...(error.details === undefined ? {} : { details: error.details }),
      },
    };
  if (error instanceof RuleGapError)
    return { status: 422, error: { code: 'RULE_GAP', message: error.message, details: error.gap } };
  if (error instanceof ZodError)
    return {
      status: 422,
      error: {
        code: 'VALIDATION',
        message: 'Datele nu sunt valide.',
        details: error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      },
    };
  if (error instanceof SyntaxError)
    return { status: 400, error: { code: 'JSON', message: 'Conținut JSON invalid.' } };
  const chain = causes(error);
  for (const cause of chain) {
    const invariant = /inv:([a-z_]+)/.exec(String((cause as Error).message ?? ''))?.[1];
    if (!invariant) continue;
    const [code, message] = invariants[invariant] ?? [
      'ACCOUNTING_INVARIANT',
      'Operațiunea încalcă o regulă de integritate contabilă.',
    ];
    return { status: 409, error: { code, message, details: { invariant } } };
  }
  const sqlite = chain
    .map((cause) => (cause as { code?: unknown }).code)
    .find((code): code is string => typeof code === 'string');
  if (sqlite === 'SQLITE_CONSTRAINT_UNIQUE' || sqlite === 'SQLITE_CONSTRAINT_PRIMARYKEY')
    return {
      status: 409,
      error: { code: 'DUPLICATE', message: 'Înregistrarea există deja. Reîncărcați datele.' },
    };
  if (sqlite?.startsWith('SQLITE_CONSTRAINT'))
    return {
      status: 409,
      error: { code: 'CONSTRAINT', message: 'Datele nu respectă o constrângere a registrelor.' },
    };
  if (sqlite === 'SQLITE_BUSY' || sqlite === 'SQLITE_BUSY_SNAPSHOT')
    return {
      status: 503,
      error: { code: 'BUSY', message: 'Baza de date este ocupată. Reîncercați cu aceeași cheie.' },
    };
  console.error('Accounting request failed', { code: sqlite ?? 'internal' });
  return {
    status: 500,
    error: {
      code: 'INTERNAL',
      message: 'Operațiunea nu a putut fi finalizată. Puteți reîncerca folosind aceeași cerere.',
    },
  };
}
