import { z, type ZodType } from 'zod';
import type { Issue, JsonValue } from '../kernel';
import { annualDisclosures, annualDocument, annualInformative } from '../ro/annual/questions';
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
    /** Art. 52 alin. (4): the day the company started an activity art. 47 alin. (3) excludes
     * during the year, if it did. */
    excludedActivityFrom: day.nullable().optional(),
    /** Art. 52 alin. (7): the day a shareholder holding over 25% came to hold over 25% of other
     * micro-enterprises during the year and the shareholders chose this one to leave, if they
     * did. */
    shareholdersExitFrom: day.nullable().optional(),
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
    `Pentru impozitul pe veniturile microîntreprinderilor în ${params.year} (Codul fiscal art. 47–48 și 52): capitalul este deținut de stat sau de o unitate administrativ-teritorială? Societatea este în dizolvare? Desfășoară o activitate exclusă (bănci, asigurări, piața de capital, jocuri de noroc, petrol și gaze)? Asociații cu peste 25% dețin și alte microîntreprinderi și au stabilit-o pe aceasta? Situațiile financiare au fost depuse în termen? Are un contract de administrare sau mandat plătit cel puțin cu salariul minim? Ce întreprinderi legate are (peste 25%) și ce venituri au? A început în cursul anului o activitate exclusă, sau au stabilit asociații ieșirea ei din sistem pentru că dețin și alte microîntreprinderi (art. 52 alin. (4), (7)), și de la ce dată? Atașați certificatul constatator și registrul asociaților.`,
  evidence: (answer) => answer.evidenceIds,
  period: (params) => String(params.year),
});

/** An account of classes 6 or 7, analytic or synthetic, as the chart spells it. */
const accountCode = z.string().regex(/^[67]\d{1,3}(\.[A-Z0-9_-]{1,24})*$/);
/** The natures of `profit/accounts.ts`, repeated here so the questions stay free of the tax
 * module; a core test checks the two lists agree. */
export const profitNatures = [
  'protocol',
  'advertising',
  'social',
  'fine',
  'contract_penalty',
  'sponsorship',
  'vehicle',
  'deductible',
  'nondeductible',
  'dividend_ro',
  'nontaxable',
  'taxable',
] as const;
/** The clauses a person may give for a non-deductible expense or a non-taxable revenue: the
 * letters of art. 25 alin. (4) and art. 23 the bridge knows. */
export const profitClassificationClauses = [
  'art.25(4)(c)',
  'art.25(4)(d)',
  'art.25(4)(e)',
  'art.25(4)(f)',
  'art.25(4)(g)',
  'art.25(4)(h)',
  'art.25(4)(j)',
  'art.25(4)(k)',
  'art.23(c)',
  'art.23(d)',
  'art.23(g)',
  'art.23(o)',
  'art.23(s)',
] as const;

/**
 * What an expense or revenue account is for the profit tax, when its deductibility depends on
 * facts the books do not hold (protocol or advertising on 623, a fine or a contractual penalty
 * on 6581, a sponsorship or another donation on 6582, a vehicle's costs): the person who knows
 * says it once per account, and every computation reads the same answer until it changes.
 */
const profitAccount = define({
  id: 'profit.account',
  summary:
    "What an expense or revenue account is for the profit tax when the law treats it by facts the books do not hold (protocol or advertising, a fine or a contractual penalty, a sponsorship, a vehicle's costs, dividends from a Romanian company): the classification holds for every quarter until it changes; a sponsorship cites its contract and the beneficiary's entry in ANAF's register.",
  holds: 'untilChanged',
  subjects: ['account'],
  params: z.object({ account: accountCode }).strict(),
  answer: () =>
    z
      .object({
        nature: z.enum(profitNatures),
        /** The road vehicle whose costs the account holds (its registration). */
        vehicle: z.string().trim().min(4).max(16).optional(),
        /** For a non-deductible expense or a non-taxable revenue: the letter of the law. */
        clause: z.enum(profitClassificationClauses).optional(),
        /** Contracts, decisions, ANAF's register of beneficiaries. */
        evidenceIds: z.array(z.uuid()).max(20).default([]),
      })
      .strict()
      .refine((value) => (value.nature === 'vehicle') === (value.vehicle !== undefined), {
        message: 'Vehiculul se indică doar pentru cheltuielile cu vehicule, și acolo obligatoriu.',
        path: ['vehicle'],
      })
      .refine(
        (value) =>
          (value.nature === 'nondeductible' || value.nature === 'nontaxable') ===
          (value.clause !== undefined),
        {
          message:
            'O cheltuială nedeductibilă sau un venit neimpozabil se încadrează la o literă a legii (clause), și doar ele.',
          path: ['clause'],
        },
      )
      .refine((value) => value.nature !== 'sponsorship' || value.evidenceIds.length > 0, {
        message:
          'Sponsorizarea se scade din impozit doar cu contractul de sponsorizare și, pentru o entitate nonprofit, înscrierea ei în Registrul entităților pentru care se acordă deduceri fiscale.',
        path: ['evidenceIds'],
      }),
  prompt: (subject) =>
    `Ce reprezintă pentru impozitul pe profit cheltuielile sau veniturile din contul ${subject.id}? De exemplu: protocol sau reclamă (623), amenzi și penalități datorate autorităților sau penalități contractuale (6581), sponsorizare potrivit Legii nr. 32/1994 sau altă donație (6582), cheltuieli cu un vehicul (indicați numărul de înmatriculare), dividende de la o persoană juridică română (761). Răspunsul se aplică tuturor calculelor până îl schimbați.`,
  evidence: (value) => value.evidenceIds,
});
export type ProfitAccountAnswer = z.infer<ReturnType<typeof profitAccount.answer>>;

/** A tax loss as the returns filed before the engine's books declared it (D101 rd. 40^1). */
const lossVintage = z
  .object({
    year: year,
    /** The loss the year's return declared, in lei. */
    amount,
    /** What was still to recover at the start of the books, in lei. */
    remaining: amount,
  })
  .strict();

/**
 * The tax losses carried into the engine's first year from the returns filed before it (Codul
 * fiscal art. 31): each year's loss and what remained to recover, with the D101 returns as
 * evidence; or that there are none. A loss the engine's own annual computation declares is read
 * from the books, never asked.
 */
const profitLosses = define({
  id: 'profit.losses',
  summary:
    "The tax losses carried into the books' first year from the annual profit tax returns (D101) filed before it, each year's loss and what was left to recover, with those returns as evidence; or that there are none.",
  holds: 'untilChanged',
  subjects: ['company'],
  params: z.object({ asOf: day }).strict(),
  answer: () =>
    z
      .object({
        vintages: z
          .array(lossVintage)
          .max(10)
          .refine((items) => new Set(items.map((item) => item.year)).size === items.length, {
            message: 'Fiecare an se indică o singură dată.',
          }),
        /** The D101 returns of those years, or the statement that there were none. */
        evidenceIds: z.array(z.uuid()).min(1).max(20),
      })
      .strict(),
  prompt: (_subject, params) =>
    `Ce pierderi fiscale de recuperat avea compania la ${params.asOf}, din declarațiile 101 depuse pentru anii anteriori? Pentru fiecare an: pierderea declarată (rd. 40^1) și cât mai rămăsese de recuperat. Atașați declarațiile, sau precizați că nu există pierderi.`,
  evidence: (value) => value.evidenceIds,
});
export type ProfitLossesAnswer = z.infer<ReturnType<typeof profitLosses.answer>>;

/**
 * A return the engine does not prepare (D700, the declaration of the fiscal vector's changes),
 * filed by the company through ANAF's portal: the person records its registration number and the
 * receipt, and the calendar shows it filed.
 */
const obligationFiled = define({
  id: 'obligation.filed',
  summary:
    "A return the engine does not prepare (D700) filed by the company through ANAF's portal: the registration number, the date and the receipt, which mark it filed on the calendar.",
  holds: 'once',
  subjects: ['obligation'],
  params: z
    .object({
      kind: z.string().regex(/^D\d{3}$/),
      period: z.string().regex(/^\d{4}(-(0[1-9]|1[0-2]|Q[1-4]))?$/),
    })
    .strict(),
  answer: () =>
    z
      .object({
        registrationNumber: z.string().trim().min(1).max(60),
        submittedOn: day,
        /** ANAF's receipt (recipisa) or the filed form. */
        evidenceId: z.uuid(),
      })
      .strict(),
  prompt: (_subject, params) =>
    `Declarația ${params.kind} pentru ${params.period} se depune în afara aplicației (portalul ANAF). Indicați numărul de înregistrare, data depunerii și atașați recipisa.`,
  evidence: (value) => [value.evidenceId],
});
export type ObligationFiledAnswer = z.infer<ReturnType<typeof obligationFiled.answer>>;

/**
 * A VAT period's negative balance of at least 5,000 lei: refunded, on the D300's request (the
 * return is the refund request, Codul fiscal art. 303 alin. (7)), or carried forward to the next
 * period. The company's choice, a person's to make; the D300 is prepared with it.
 */
const vatRefund = define({
  id: 'vat.refund',
  summary:
    "Whether a VAT period's negative balance of at least 5,000 lei is claimed back on its D300 (a refund request, which ANAF settles, usually with a later inspection: Codul fiscal art. 303 alin. (7)) or carried forward to the next period.",
  holds: 'once',
  subjects: ['vatPeriod'],
  params: z
    .object({
      /** The negative balance the return shows (rd. 45), in lei. */
      balance: amount,
    })
    .strict(),
  answer: () => z.object({ choice: z.enum(['refund', 'carry_forward']) }).strict(),
  prompt: (subject, params) =>
    `Decontul de TVA pentru ${subject.id} are un sold negativ de ${params.balance} lei. Solicitați rambursarea lui prin decont (ANAF o soluționează, de regulă cu inspecție fiscală ulterioară) sau îl reportați în decontul perioadei următoare (Codul fiscal art. 303 alin. (7))?`,
  evidence: () => [],
});
export type VatRefundAnswer = z.infer<ReturnType<typeof vatRefund.answer>>;

/**
 * What a non-resident is paid for, and who receives it: a per-supplier determination, kept until a
 * later answer replaces it. A software licence is a royalty when the rights go beyond those needed
 * to use the program (Codul fiscal art. 7 pct. 36, norme art. 223 pct. 2); a service is taxed in
 * Romania only as management or consulting, performed in Romania or as a profession there (art.
 * 223 alin. (1) lit. i), k), l)). The contract is the evidence; the engine never infers it.
 */
const nonresidentPayee = define({
  id: 'nonresident.payee',
  summary:
    'What a non-resident supplier, lender or shareholder is paid for (dividends, interest, royalties as Codul fiscal art. 7 pct. 36 defines them, a software licence included when it grants more than the right to use the program, commissions, services taxable in Romania under art. 223 alin. (1) lit. i), k), l), or income not taxable in Romania) and whether the beneficiary is a company or an individual, with the contract as evidence: a per-supplier determination the withholding at payment reads.',
  holds: 'untilChanged',
  subjects: ['party'],
  params: z
    .object({
      /** The invoice or item that raised the question. */
      documentId: z.uuid().optional(),
    })
    .strict(),
  answer: () =>
    z
      .object({
        income: z.enum([
          'dividends',
          'interest',
          'royalties',
          'commissions',
          'services',
          'not_taxable',
        ]),
        beneficiary: z.enum(['company', 'individual']),
        /** The contract (licence, loan, service agreement) the determination reads. */
        contractEvidenceId: z.uuid(),
        /** Why: the contract's clause (the rights granted, where the service is performed). */
        reason: text(1000),
      })
      .strict(),
  prompt: (subject) =>
    `Ce plătește compania nerezidentului ${subject.id} și cine este beneficiarul (persoană juridică sau fizică)? Încadrați plata: dividende, dobânzi, redevențe (Codul fiscal art. 7 pct. 36: o licență de software este redevență când dă mai mult decât dreptul de a folosi programul, de exemplu dreptul de a-l reproduce, distribui sau modifica), comisioane, servicii impozabile în România (management sau consultanță, servicii prestate în România, profesii independente în România, art. 223 alin. (1) lit. i), k), l)) sau venit neimpozabil în România. Atașați contractul și indicați clauza.`,
  evidence: (value) => [value.contractEvidenceId],
});
export type NonresidentPayeeAnswer = z.infer<ReturnType<typeof nonresidentPayee.answer>>;

/**
 * A non-resident's certificate of tax residence, and the treaty rate it allows: presented at
 * payment, valid in the year presented and the first days of the next (Codul fiscal art. 230 alin.
 * (2)); the rate comes from the treaty's article, kept as evidence, never assumed.
 */
const nonresidentCertificate = define({
  id: 'nonresident.certificate',
  summary:
    "A non-resident's certificate of tax residence (original or legalized copy with an authorized translation, or the electronic original) presented at payment, the state and year it attests, and the rate the double tax treaty's article allows for the income, with the treaty's text as evidence (Codul fiscal art. 230 alin. (1)–(2)): without it the domestic rate applies.",
  holds: 'untilChanged',
  subjects: ['party'],
  params: z
    .object({
      income: z.enum(['dividends', 'interest', 'royalties', 'commissions', 'services']),
      /** The payment it is asked for. */
      date: day.optional(),
    })
    .strict(),
  answer: () =>
    z
      .object({
        certificateEvidenceId: z.uuid(),
        /** The state of residence it attests: ISO 3166-1 alpha-2. */
        state: z.string().regex(/^[A-Z]{2}$/),
        /** The year whose residence it attests. */
        year: z.number().int().min(2000).max(2100),
        /** When it was presented to the company. */
        presentedOn: day,
        /** The income the treaty's article and rate are for. */
        income: z.enum(['dividends', 'interest', 'royalties', 'commissions', 'services']),
        /** The treaty as published (Monitorul Oficial or the ratifying law). */
        treatyEvidenceId: z.uuid(),
        /** The treaty's article for the income, as it reads (`art. 12 alin. (2)`). */
        article: text(100),
        /** The rate the article allows, in percent. */
        rate: z.string().regex(/^(0|[1-9]\d?)(\.\d{1,2})?$/),
      })
      .strict(),
  prompt: (subject, params) =>
    `Nerezidentul ${subject.id} a prezentat certificatul de rezidență fiscală${params.date ? ` pentru plata din ${params.date}` : ''}? Atașați certificatul (original sau copie legalizată, cu traducere autorizată; cel electronic este original), indicați statul și anul atestat, data prezentării, apoi articolul convenției de evitare a dublei impuneri pentru ${params.income} și cota lui, cu textul convenției (Codul fiscal art. 230). Fără certificat se aplică cota din Codul fiscal.`,
  evidence: (value) => [value.certificateEvidenceId, value.treatyEvidenceId],
});
export type NonresidentCertificateAnswer = z.infer<
  ReturnType<typeof nonresidentCertificate.answer>
>;

/**
 * How a capital good is used for operations with the right of deduction, from a date (Codul
 * fiscal art. 305 alin. (4) lit. a) and c)): part of a building leased out exempt, a good moved to
 * an exempt or a non-business use, or back. The share decides each year's fifth (twentieth) of its
 * VAT the adjustment keeps (norme pct. 79 alin. (1), (15)), until a later answer replaces it.
 */
const capitalGoodUse = define({
  id: 'capitalGood.use',
  summary:
    'From when, and in what share (percent of its use), a capital good of the asset register is used for operations with the right of deduction (taxable, or exempt with deduction); the rest is exempt without deduction or outside the business. It decides the adjustment of its VAT for each year of its adjustment period (Codul fiscal art. 305).',
  holds: 'untilChanged',
  subjects: ['asset'],
  params: z
    .object({
      /** The date the use matters on (an event, a year's end). */
      date: day.optional(),
    })
    .strict(),
  answer: () =>
    z
      .object({
        /** The share of its use with the right of deduction, in percent with up to two
         * decimals: 100 all taxable, 0 all exempt or outside the business. */
        share: z.string().regex(/^(0|[1-9]\d?|100)(\.\d{1,2})?$/),
        from: day,
        /** What shows the use: a lease of the part used exempt, the option to tax notified, a
         * decision allocating the good. */
        evidenceId: z.uuid(),
      })
      .strict()
      .refine((value) => Number(value.share) <= 100, {
        message: 'Proporția este cel mult 100%.',
        path: ['share'],
      }),
  prompt: (subject, params) =>
    `În ce proporție este folosit bunul de capital ${subject.id}${params.date ? ` la ${params.date}` : ''} pentru operațiuni cu drept de deducere (taxabile, sau scutite cu drept de deducere), și de la ce dată? Restul este folosit pentru operațiuni scutite fără drept de deducere (de exemplu o închiriere scutită, art. 292 alin. (2) lit. e)) sau în afara activității economice. Atașați documentul care o arată (contractul de închiriere, notificarea opțiunii de taxare, decizia de alocare): ajustarea taxei deduse se calculează pe an, pentru o cincime sau o douăzecime din ea (Codul fiscal art. 305).`,
  evidence: (value) => [value.evidenceId],
});
export type CapitalGoodUseAnswer = z.infer<ReturnType<typeof capitalGoodUse.answer>>;

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
  'profit.account': profitAccount,
  'profit.losses': profitLosses,
  'obligation.filed': obligationFiled,
  'vat.refund': vatRefund,
  'capitalGood.use': capitalGoodUse,
  'nonresident.payee': nonresidentPayee,
  'nonresident.certificate': nonresidentCertificate,
  'annual.informative': annualInformative,
  'annual.disclosures': annualDisclosures,
  'annual.document': annualDocument,
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
