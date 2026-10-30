import { z, type ZodType } from 'zod';
import type { Issue, JsonValue } from '../kernel';
import { isLocalDate } from '../time';

/*
 * Questions the engine asks people. An unknown fact the books depend on (whether a car is used
 * only for the business, which months a prepaid policy covers, the month's sick leave) is never
 * guessed: a treatment that needs one reports it as an issue carrying `details.question`, an
 * agent asks it (`questions.ask`), a person answers, and the agent revises the proposal citing
 * the answer as its basis. Each kind says what it asks, in Romanian for the person and in English
 * for agents, what a valid answer is, and how long an answer holds.
 */

/**
 * How long an answer holds, when the same question is asked again:
 * - `once`: for the same subject asked with the same parameters;
 * - `perPeriod`: for the same subject and period (`period` of the parameters);
 * - `untilChanged`: for the same subject whatever the parameters, until a later answer replaces it.
 */
export const answerLifetimes = ['once', 'perPeriod', 'untilChanged'] as const;
export type AnswerLifetime = (typeof answerLifetimes)[number];

/** What a question is about: a record kind and its id (`vehicle` `B123ABC`, `deferral` …). */
export const questionSubjectSchema = z
  .object({
    kind: z.string().regex(/^[a-z][A-Za-z]{0,39}$/),
    id: z.string().trim().min(1).max(200),
  })
  .strict();
export type QuestionSubject = z.infer<typeof questionSubjectSchema>;

export interface QuestionKind<Params = Record<string, unknown>, Answer = unknown> {
  id: string;
  /** One line of English for agents. */
  summary: string;
  holds: AnswerLifetime;
  /** The subject kinds it may be asked about. */
  subjects: readonly string[];
  /**
   * A subject id in its one spelling (a registration without spaces or dashes), so that every
   * path (a treatment's issue, `questions.ask`, the worklist) names one subject alike. Ids are
   * kept as given without it.
   */
  normalize?(id: string): string;
  params: ZodType<Params>;
  /** A valid answer to it; a choice's depends on its options. */
  answer(params: Params): ZodType<Answer>;
  /** The question as the person reads it. */
  prompt(subject: QuestionSubject, params: Params): string;
  /** The files an answer cites (a vehicle log, medical certificates); they must be kept. */
  evidence(answer: Answer): string[];
  /** The period an answer holds for (`perPeriod`). */
  period?(params: Params): string;
  /**
   * The company facts an answer records, with the answer as their evidence: a kind with this
   * method is answered by an owner or a reviewer, and its facts are written in the same command.
   */
  facts?(params: Params, answer: Answer): RecordedFact[];
}

/** A dated company fact an answer records (`profile.record`'s input without the evidence). */
export interface RecordedFact {
  axis: string;
  value: string;
  effectiveFrom: string;
  supersedesId?: string;
}

const day = z.string().refine((value): boolean => isLocalDate(value), 'Dată invalidă.');
const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
const amount = z.string().regex(/^(0|[1-9]\d{0,15})(\.\d{1,2})?$/);
const text = (max: number) => z.string().trim().min(3).max(max);
const define = <Params, Answer>(kind: QuestionKind<Params, Answer>) => kind;

/**
 * The cases art. 298 does not limit whatever the vehicle's use: a vehicle over 3,500 kg or with
 * more than 9 seats, the driver's included (alin. (2)), and the uses of alin. (3) lit. b)–f),
 * where personal use counts as negligible (norme pct. 68 alin. (5)). Lit. a) (emergency,
 * security, courier) requires exclusive use, so it is answered as `business_only` with the log.
 */
export const vehicleExceptions = [
  /** Alin. (2): over 3,500 kg of maximum authorized mass, or more than 9 seats. */
  'over_3500kg_or_9_seats',
  /** Alin. (3) lit. b): used by a sales or purchasing agent (one vehicle per agent). */
  'sales_or_purchasing_agent',
  /** Lit. c): paid passenger transport, taxis included. */
  'paid_passenger_transport',
  /** Lit. d): essential to paid services, driving schools included. */
  'paid_services',
  /** Lit. e): rented out, or given in a finance or operating lease. */
  'rental_or_leasing',
  /** Lit. f): goods for resale. */
  'goods_for_resale',
] as const;

/** A registration in its one spelling: capitals, without spaces or dashes (`B-123-XFA` is
 * `B123XFA`). */
export const normalizePlate = (plate: string) => plate.toUpperCase().replace(/[\s-]+/g, '');

const vehicleUse = define({
  id: 'vehicle.use',
  summary:
    'Whether a road vehicle is used only for the business, which decides whether VAT on its purchase, lease, fuel and upkeep is deducted in full or 50% (Codul fiscal art. 298); exclusive use needs the vehicle log as evidence, and a vehicle over 3,500 kg or 9 seats or in an excepted use (sales agent, taxi, paid services, rental, resale) deducts in full with its proof.',
  holds: 'untilChanged',
  subjects: ['vehicle'],
  normalize: normalizePlate,
  params: z
    .object({
      /** The purchase that raised the question. */
      documentId: z.uuid().optional(),
      /** The date the use matters on. */
      date: day.optional(),
    })
    .strict(),
  answer: () =>
    z
      .object({
        use: z.enum(['business_only', 'mixed']),
        /** Since when the vehicle is used this way. */
        from: day,
        /** The vehicle log (foaia de parcurs) showing exclusive business use. */
        logEvidenceId: z.uuid().optional(),
        /** A vehicle art. 298 does not limit whatever its use. */
        exception: z.enum(vehicleExceptions).optional(),
        /** What shows the exception: the registration certificate, the agent's contract, the
         * rental or lease contract (norme pct. 68 alin. (7)). */
        exceptionEvidenceId: z.uuid().optional(),
      })
      .strict()
      .refine((value) => value.use !== 'business_only' || value.logEvidenceId !== undefined, {
        message:
          'Folosirea exclusiv în scopul activității economice se dovedește cu foaia de parcurs.',
        path: ['logEvidenceId'],
      })
      .refine(
        (value) => (value.exception === undefined) === (value.exceptionEvidenceId === undefined),
        {
          message:
            'O excepție de la art. 298 se dovedește cu un document (certificatul de înmatriculare, contractul), care se indică doar împreună cu ea.',
          path: ['exceptionEvidenceId'],
        },
      ),
  prompt: (subject, params) =>
    `Vehiculul ${subject.id} este folosit exclusiv în scopul activității economice${params.date ? ` la ${params.date}` : ''}? Dacă da, atașați foaia de parcurs (categoria vehiculului, scopul și locul deplasării, kilometrii parcurși, norma de consum); altfel TVA aferentă cumpărării, închirierii, leasingului și cheltuielilor cu vehiculul se deduce în proporție de 50% (Codul fiscal art. 298). Limitarea nu se aplică vehiculelor de peste 3.500 kg sau cu mai mult de 9 scaune, nici celor folosite de agenți de vânzări sau de achiziții, pentru transport de persoane cu plată, pentru servicii cu plată, pentru închiriere sau leasing ori ca mărfuri: indicați excepția și documentul care o dovedește.`,
  evidence: (value) => [
    ...(value.logEvidenceId ? [value.logEvidenceId] : []),
    ...(value.exceptionEvidenceId ? [value.exceptionEvidenceId] : []),
  ],
});

/** A `vehicle.use` answer, as the kind reads it. */
export type VehicleUseAnswer = z.infer<ReturnType<typeof vehicleUse.answer>>;

const deferralSchedule = define({
  id: 'deferral.schedule',
  summary:
    'Which months a prepaid expense or a revenue billed in advance covers: its first month and how many months, to release it month by month.',
  holds: 'once',
  subjects: ['deferral', 'document', 'evidence'],
  params: z
    .object({
      account: z
        .string()
        .regex(/^\d{3,6}$/)
        .optional(),
      amount: amount.optional(),
      evidenceId: z.uuid().optional(),
      documentId: z.uuid().optional(),
      /** The day the amount was booked. */
      date: day.optional(),
    })
    .strict(),
  answer: () =>
    z
      .object({
        /** The first month covered. */
        from: month,
        months: z.number().int().min(1).max(120),
      })
      .strict(),
  prompt: (_subject, params) =>
    `Ce perioadă acoperă suma${params.amount ? ` de ${params.amount} lei` : ''}${params.account ? ` din contul ${params.account}` : ''}? Indicați prima lună și numărul de luni.`,
  evidence: () => [],
});

const absence = z
  .object({
    employeeId: z.uuid(),
    kind: z.enum(['medical', 'unpaid', 'other']),
    from: day,
    to: day,
    /** The medical certificate's code of indemnity (cod indemnizație), for sick leave. */
    code: z
      .string()
      .regex(/^\d{2}$/)
      .optional(),
    /** The medical certificate (certificat de concediu medical). */
    certificateEvidenceId: z.uuid().optional(),
  })
  .strict()
  .refine((value) => value.from <= value.to, {
    message: 'Absența se încheie înainte să înceapă.',
    path: ['to'],
  })
  .refine((value) => value.kind !== 'medical' || value.certificateEvidenceId !== undefined, {
    message: 'Concediul medical se dovedește cu certificatul medical.',
    path: ['certificateEvidenceId'],
  });

const payrollAbsences = define({
  id: 'payroll.absences',
  summary:
    "A month's absences of the employees before its payroll is prepared: sick leave with each medical certificate as evidence, unpaid and other leave; none is an empty list.",
  holds: 'perPeriod',
  subjects: ['company', 'employee'],
  params: z.object({ month }).strict(),
  answer: () => z.object({ absences: z.array(absence).max(500) }).strict(),
  prompt: (subject, params) =>
    `Ce absențe au avut ${subject.kind === 'employee' ? 'salariatul' : 'salariații'} în luna ${params.month} (concedii medicale, cu certificatele, concedii fără plată și altele)? Dacă nu au fost, răspundeți cu o listă goală.`,
  evidence: (value) =>
    value.absences.flatMap((item) =>
      item.certificateEvidenceId ? [item.certificateEvidenceId] : [],
    ),
  period: (params) => params.month,
});

const evidenceMissing = define({
  id: 'evidence.missing',
  summary:
    'Asks a person for a missing supporting document (an invoice, a contract, a statement) as a kept file, or why there is none.',
  holds: 'once',
  subjects: ['document', 'movement', 'proposal', 'evidence', 'party', 'deferral', 'company'],
  params: z.object({ what: text(500) }).strict(),
  answer: () =>
    z.union([
      z.object({ evidenceId: z.uuid() }).strict(),
      z.object({ unavailable: z.literal(true), reason: text(1000) }).strict(),
    ]),
  prompt: (_subject, params) =>
    `Lipsește documentul justificativ: ${params.what}. Încărcați-l sau explicați de ce nu există.`,
  evidence: (value) => ('evidenceId' in value ? [value.evidenceId] : []),
});

const option = z
  .object({ value: z.string().trim().min(1).max(100), label: z.string().trim().min(1).max(200) })
  .strict();
const choice = define({
  id: 'choice',
  summary:
    'A question with fixed options, worded in Romanian by the agent, for a decision no other kind covers.',
  holds: 'once',
  subjects: ['document', 'movement', 'proposal', 'evidence', 'party', 'company'],
  params: z
    .object({
      question: text(500),
      options: z
        .array(option)
        .min(2)
        .max(20)
        .refine((items) => new Set(items.map((item) => item.value)).size === items.length, {
          message: 'Variantele trebuie să fie distincte.',
        }),
    })
    .strict(),
  answer: (params) =>
    z
      .object({
        value: z.string().refine((value) => params.options.some((item) => item.value === value), {
          message: 'Alegeți una dintre variante.',
        }),
      })
      .strict(),
  prompt: (_subject, params) =>
    `${params.question} (${params.options.map((item) => item.label).join(' / ')})`,
  evidence: () => [],
});

const profileFact = define({
  id: 'profile.fact',
  summary:
    "A dated company fact the books depend on (VAT status and period, income tax, employer, …); a reviewer's answer is recorded as the fact itself, with the answer as its evidence.",
  holds: 'untilChanged',
  subjects: ['profile'],
  params: z.object({ axis: z.string().min(1).max(60), from: day.optional() }).strict(),
  answer: () =>
    z
      .object({
        value: z.string().trim().min(1).max(100),
        effectiveFrom: day,
        /** The fact this one replaces, when it corrects one. */
        supersedesId: z.uuid().optional(),
      })
      .strict(),
  prompt: (subject, params) =>
    `Care este situația companiei pentru „${subject.id}"${params.from ? ` la ${params.from}` : ''}, și de la ce dată? Răspunsul se înregistrează ca fapt al companiei.`,
  evidence: () => [],
  facts: (params, answer) => [
    {
      axis: params.axis,
      value: answer.value,
      effectiveFrom: answer.effectiveFrom,
      ...(answer.supersedesId ? { supersedesId: answer.supersedesId } : {}),
    },
  ],
});

const year = z.number().int().min(2000).max(2100);
const fingerprint = z.string().regex(/^[a-f0-9]{64}$/);
const factValue = z.string().trim().min(1).max(100);

/**
 * A yearly determination the engine computed from the books and the answers (micro or profit
 * tax, the VAT period, the D112 period, the size category, the small-enterprise threshold, VAT on
 * collection), shown with its computation for a person to confirm or correct. Its parameters are
 * the engine's (`determinations.propose`), so the answer, kept as evidence, holds what was shown.
 */
const determinationConfirm = define({
  id: 'determination.confirm',
  summary:
    'A yearly determination the engine computed (micro or profit tax, VAT period, D112 period, size category, VAT thresholds), with its computation: a person confirms it or corrects it with the document that supports another value; the answer records the dated fact.',
  holds: 'once',
  subjects: ['profile'],
  params: z
    .object({
      axis: z.string().min(1).max(60),
      year,
      value: factValue,
      effectiveFrom: day,
      /** Changes within the year, each from its date (an exit from micro, from VAT on
       * collection, a threshold crossed). */
      changes: z
        .array(z.object({ value: factValue, effectiveFrom: day, reason: text(1000) }).strict())
        .max(8)
        .default([]),
      /** The computation, as the engine wrote it. */
      summary: z.string().trim().min(3).max(2000),
      lines: z.array(z.string().max(2000)).max(80),
      clauses: z.array(z.string().max(200)).max(40),
      /** What the person confirms: a hash of the determination and its inputs. */
      fingerprint,
    })
    .strict(),
  answer: () =>
    z.union([
      z.object({ confirm: z.literal(true) }).strict(),
      z
        .object({
          value: factValue,
          effectiveFrom: day,
          /** Why the computation does not hold (an option filed, a registration decision). */
          reason: text(1000),
          /** The document that supports the other value. */
          evidenceId: z.uuid(),
        })
        .strict(),
    ]),
  prompt: (_subject, params) =>
    `${params.summary} Confirmați ${params.axis} = „${params.value}” de la ${params.effectiveFrom}${params.changes.map((change) => `, „${change.value}” de la ${change.effectiveFrom} (${change.reason})`).join('')}, sau indicați altă valoare cu documentul care o susține.`,
  evidence: (answer) => ('evidenceId' in answer ? [answer.evidenceId] : []),
  facts: (params, answer) =>
    'confirm' in answer
      ? [
          { axis: params.axis, value: params.value, effectiveFrom: params.effectiveFrom },
          ...params.changes.map((change) => ({
            axis: params.axis,
            value: change.value,
            effectiveFrom: change.effectiveFrom,
          })),
        ]
      : [{ axis: params.axis, value: answer.value, effectiveFrom: answer.effectiveFrom }],
});

/** The figures of a year the books do not hold, as the filed returns and statements give them. */
export const yearFigureNames = [
  /** Turnover (70x net of 709): the micro-enterprise limit (art. 54 alin. (1)). */
  'turnover',
  /** Net turnover (F20 rd. 01): the size criteria. */
  'netTurnover',
  /** Total revenues (class 7): the quarterly D112 (art. 147 alin. (7)). */
  'totalRevenue',
  /** Taxable, exempt with deduction and abroad with deduction: the VAT period (art. 322). */
  'vatTurnover',
  /** Supplies with the place in Romania: the small-enterprise threshold (art. 310). */
  'exemptionTurnover',
  /** Total assets at the year's end (balance sheet A–C). */
  'totalAssets',
  /** Average number of employees in the year. */
  'averageEmployees',
  /** Whether goods were acquired from other EU states (`yes` or `no`). */
  'euGoodsAcquisitions',
] as const;
export type YearFigureName = (typeof yearFigureNames)[number];
const figureValue: Record<YearFigureName, z.ZodType<string>> = {
  turnover: amount,
  netTurnover: amount,
  totalRevenue: amount,
  vatTurnover: amount,
  exemptionTurnover: amount,
  totalAssets: amount,
  averageEmployees: z.string().regex(/^(0|[1-9]\d{0,5})(\.\d{1,2})?$/),
  euGoodsAcquisitions: z.enum(['yes', 'no']),
};

const yearFigures = define({
  id: 'year.figures',
  summary:
    'Figures of a year the engine does not keep the books of (turnover, revenues, VAT turnover, total assets, average employees, EU goods acquisitions), as the filed statements and returns give them, with those documents as evidence.',
  holds: 'once',
  subjects: ['year'],
  params: z
    .object({
      year,
      figures: z
        .array(z.enum(yearFigureNames))
        .min(1)
        .max(yearFigureNames.length)
        .refine((items) => new Set(items).size === items.length, {
          message: 'Fiecare cifră se cere o singură dată.',
        }),
    })
    .strict(),
  answer: (params) =>
    z
      .object({
        values: z
          .object(Object.fromEntries(params.figures.map((name) => [name, figureValue[name]])))
          .strict(),
        /** The filed statements, returns or registers the figures come from. */
        evidenceIds: z.array(z.uuid()).min(1).max(20),
      })
      .strict(),
  prompt: (_subject, params) =>
    `Registrele nu cuprind anul ${params.year}. Indicați din situațiile financiare și declarațiile depuse pentru ${params.year}: ${params.figures.join(', ')}, și atașați documentele.`,
  evidence: (answer) => answer.evidenceIds,
});

const lei = amount;
/** The conditions of art. 47 only the owner knows, for a year; the books give the rest. */
export const microConditionsAnswer = z
  .object({
    /** Lit. d): the capital is held by the state or a local authority. */
    stateOwned: z.boolean(),
    /** Lit. e): in dissolution followed by liquidation. */
    dissolution: z.boolean(),
    /** Alin. (3): banking, insurance or capital markets, gambling, oil and gas, a guarantee fund
     * or a transparent entity. */
    excludedActivity: z.boolean(),
    /** Lit. h) and alin. (4): no shareholder holds more than 25%; or those who do hold no other
     * micro-enterprise; or they designated this one by 31 March; or they did not. */
    shareholders: z.enum(['no_holder_over_25', 'only_micro', 'designated', 'not_designated']),
    /** Lit. i): the annual statements due in the previous year were filed on time. */
    statementsOnTime: z.enum(['yes', 'no', 'not_required']),
    /** Art. 51 alin. (4) lit. b): an administration or mandate contract paid at least the
     * minimum wage. */
    mandate: z.boolean(),
    /** Art. 48 alin. (3): the day a company registered in the year was registered. */
    established: day.nullable(),
    /** Art. 52 alin. (2): the day the previous year's statements became late, if they did. */
    lateStatementsFrom: day.nullable(),
    /** Art. 47 alin. (1^1): the linked enterprises, with their revenues. */
    linked: z
      .array(
        z
          .object({
            name: text(300),
            taxId: z.string().trim().min(2).max(20).optional(),
            /** The relation of art. 47 alin. (1^1): a) it holds, b) it is held, c) a common
             * holder, d) a shareholder's individual enterprise. */
            relation: z.enum(['a', 'b', 'c', 'd']),
            /** Turnover, or the yearly income norm of an individual enterprise on a norm. */
            basis: z.enum(['turnover', 'norma']),
            /** The previous year's turnover, or its norm. */
            previousYear: lei,
            /** The year's turnover through a quarter, or the year's norm. */
            currentYear: z
              .object({ throughQuarter: z.number().int().min(1).max(4), amount: lei })
              .strict()
              .optional(),
          })
          .strict(),
      )
      .max(50),
    /** The trade register's certificate, the shareholders' register, the designation. */
    evidenceIds: z.array(z.uuid()).min(1).max(20),
  })
  .strict();
export type MicroConditionsAnswer = z.infer<typeof microConditionsAnswer>;

const microConditions = define({
  id: 'micro.conditions',
  summary:
    "The micro-enterprise conditions only the owner knows for a year (state ownership, dissolution, excluded activities, shareholders' designation, statements filed on time, a mandate contract, linked enterprises and their revenues), with the trade register's certificate and the shareholders' register as evidence.",
  holds: 'perPeriod',
  subjects: ['year'],
  params: z.object({ year }).strict(),
  answer: () => microConditionsAnswer,
  prompt: (_subject, params) =>
    `Pentru impozitul pe veniturile microîntreprinderilor în ${params.year} (Codul fiscal art. 47–48 și 52): capitalul este deținut de stat sau de o unitate administrativ-teritorială? Societatea este în dizolvare? Desfășoară o activitate exclusă (bănci, asigurări, piața de capital, jocuri de noroc, petrol și gaze)? Asociații cu peste 25% dețin și alte microîntreprinderi și au stabilit-o pe aceasta? Situațiile financiare au fost depuse în termen? Are un contract de administrare sau mandat plătit cel puțin cu salariul minim? Ce întreprinderi legate are (peste 25%) și ce venituri au? Atașați certificatul constatator și registrul asociaților.`,
  evidence: (answer) => answer.evidenceIds,
  period: (params) => String(params.year),
});

/** Every kind of question, by id. */
export const questionKinds = {
  'vehicle.use': vehicleUse,
  'deferral.schedule': deferralSchedule,
  'payroll.absences': payrollAbsences,
  'evidence.missing': evidenceMissing,
  choice,
  'profile.fact': profileFact,
  'determination.confirm': determinationConfirm,
  'year.figures': yearFigures,
  'micro.conditions': microConditions,
} as const;
export type QuestionKindId = keyof typeof questionKinds;
export const questionKindIds = Object.keys(questionKinds) as [QuestionKindId, ...QuestionKindId[]];

/** A kind erased to what the engine handles generically. */
export function questionKind(id: string): QuestionKind | undefined {
  return (questionKinds as Record<string, QuestionKind<unknown, unknown>>)[id] as
    QuestionKind | undefined;
}

/** A subject as the kind spells it (`normalize`); unchanged for a kind without one, or an
 * unknown kind. */
export function normalizeSubject(kindId: string, subject: QuestionSubject): QuestionSubject {
  const normalize = questionKind(kindId)?.normalize;
  return normalize ? { kind: subject.kind, id: normalize(subject.id) } : subject;
}

/** What a treatment needs asked: a kind, its subject and parameters. */
export interface QuestionRequest {
  kind: QuestionKindId;
  subject: QuestionSubject;
  params: { [key: string]: JsonValue };
}

export const questionRequestSchema = z
  .object({
    kind: z.enum(questionKindIds),
    subject: questionSubjectSchema,
    params: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();

/**
 * An issue reporting a fact the treatment cannot know: the engine lists it as a question to ask
 * (`question.needed` in the worklist), and the proposal is revised once a person answered.
 */
export function questionIssue(
  code: string,
  message: string,
  question: QuestionRequest,
  severity: Issue['severity'] = 'block',
  path?: string,
): Issue {
  return {
    code,
    severity,
    message,
    ...(path === undefined ? {} : { path }),
    details: {
      question: {
        kind: question.kind,
        subject: normalizeSubject(question.kind, question.subject),
        params: question.params,
      },
    },
  };
}

/** The question an issue carries, if it follows the convention and names a known kind; its
 * subject as the kind spells it. */
export function questionOf(issue: Pick<Issue, 'details'>): QuestionRequest | null {
  const details = issue.details;
  if (typeof details !== 'object' || details === null || Array.isArray(details)) return null;
  const parsed = questionRequestSchema.safeParse(details.question);
  if (!parsed.success) return null;
  const request = parsed.data as QuestionRequest;
  return { ...request, subject: normalizeSubject(request.kind, request.subject) };
}
