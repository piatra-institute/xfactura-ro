import { z } from 'zod';
import {
  profileAt,
  type Effect,
  type Issue,
  type LineSpec,
  type OpenItemSpec,
  type PayrollLineState,
  type Treatment,
} from '../../kernel';
import { divRound, formatMoney, parseScaled } from '../../money';
import { RuleGapError } from '../../rules';
import { monthEnd, monthStart, type LocalDate, type Month } from '../../time';
import { obligationDue } from '../obligations';
import { payrollPaymentPeriod, type PayrollPeriod } from '../payroll/quarterly';

const block = (code: string, message: string, path?: string): Issue => ({
  code,
  severity: 'block',
  message,
  ...(path === undefined ? {} : { path }),
});

export const payrollInput = z
  .object({
    runId: z.uuid(),
    month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
    round: z.number().int().min(1).max(99),
    /** The tax authority whose open items hold the contributions and the tax withheld. */
    authorityId: z.uuid(),
    /** A correction's posting date: the month's end, or a later day of an open month. Only for a
     * round after the first; the first is posted on the month's last day. */
    date: z.iso.date().optional(),
    /** The posted run a correction round corrects, as its run names it. */
    corrects: z.uuid().optional(),
  })
  .strict();
export type PayrollInput = z.infer<typeof payrollInput>;

/** Where the company books contributions it bears in the employee's name (the part-time
 * minimum, art. 146 alin. (5^9)): an accounting policy, recorded like `policy.storno`. */
export const employerShareAccounts = ['635', '6458'] as const;

type Run = NonNullable<ReturnType<Map<string, import('../../kernel').PayrollRunState>['get']>>;

/** What a run books, account by account, employee by employee and creditor by creditor. */
function bookingOf(run: Run) {
  const total = (pick: (line: PayrollLineState) => bigint) =>
    run.lines.reduce((sum, line) => sum + pick(line), 0n);
  return {
    salary: total((line) => line.cash - line.sickFund),
    sickFund: total((line) => line.sickFund),
    inKind: total((line) => line.inKind),
    borne: total((line) => line.casEmployer + line.cassEmployer),
    cas: total((line) => line.cas + line.casEmployer),
    cass: total((line) => line.cass + line.cassEmployer),
    tax: total((line) => line.tax),
    camBase: total((line) => line.camBase),
    net: total((line) => line.net),
    employees: new Map(
      run.lines.map((line) => [
        line.contractId,
        {
          partyId: line.partyId,
          earned: line.cash + line.inKind,
          withheld: line.cas + line.cass + line.tax,
          inKind: line.inKind,
        },
      ]),
    ),
    garnishments: run.lines.flatMap((line) =>
      line.garnishments.map((item) => ({ ...item, contractId: line.contractId })),
    ),
  };
}

/**
 * A month's payroll as the run computed it: salaries owed to each employee (641 = 421), the
 * contributions and the tax withheld from them (421 = 4315, 4316, 444), contributions the
 * company bears in their name, the work insurance contribution (646 = 436), the benefits in kind
 * (641 = 421 = 7588: income not paid in money, whose cost is already in the expenses), and what
 * garnishment orders take from the net pay (421 = 427, each owed to its creditor). Meal vouchers
 * are taxed here and booked when handed over.
 *
 * A correction of a posted month is a later round: its run is the month computed again, and it
 * books only the difference from the run it corrects, red storno where an amount fell, on the day
 * it is given; the tax and contributions keep the month's due date.
 */
export const payrollRecognition: Treatment<PayrollInput> = {
  id: 'payroll.recognize',
  version: 2,
  description: 'Statul de plată al lunii: salariile, contribuțiile și impozitul reținut.',
  input: payrollInput,
  agent: true,
  summary: "The month's payroll: salaries, contributions and withheld income tax.",
  toolset: 'payroll',
  dataClasses: ['books', 'payroll', 'personal'],
  subject: (input) => `payroll:${input.month}:${input.round}`,
  plan: (input) => ({
    payrollRuns: [input.runId, ...(input.corrects ? [input.corrects] : [])],
    parties: [input.authorityId],
    profile: true,
  }),
  evaluate(input, loaded, rules) {
    const issues: Issue[] = [];
    const run = loaded.payrollRuns.get(input.runId);
    const end = monthEnd(input.month as Month);
    if (!run)
      return { effect: null, issues: [block('RUN', 'Statul de plată nu există.', 'runId')] };
    if (run.month !== input.month || run.round !== input.round)
      issues.push(block('RUN', `Statul de plată este pentru ${run.month}, runda ${run.round}.`));
    if (run.state !== 'prepared')
      issues.push(block('RUN_SUPERSEDED', 'Statul de plată a fost înlocuit de un calcul nou.'));
    if (run.issues > 0)
      issues.push(block('RUN_BLOCKED', 'Statul de plată are probleme nerezolvate.'));
    if (!run.lines.length) issues.push(block('RUN_EMPTY', 'Statul de plată nu are salariați.'));
    if ((run.corrects ?? undefined) !== input.corrects)
      issues.push(
        block(
          'CORRECTION_BASE',
          run.corrects
            ? `Statul de plată corectează statul ${run.corrects}: completați-l în corrects.`
            : 'Statul de plată nu corectează alt stat.',
          'corrects',
        ),
      );
    const previous = run.corrects ? loaded.payrollRuns.get(run.corrects) : undefined;
    if (run.round > 1 && !previous)
      issues.push(
        block('CORRECTION_BASE', 'Statul de plată corectat al lunii nu este încărcat.', 'runId'),
      );
    if (run.round > 1 && !input.date)
      issues.push(
        block(
          'CORRECTION_DATE',
          'Completați data la care se înregistrează corecția (o zi a unei luni deschise, cel puțin sfârșitul lunii corectate).',
          'date',
        ),
      );
    if (input.date && (run.round === 1 ? input.date !== end : input.date < end))
      issues.push(
        block(
          'CORRECTION_DATE',
          run.round === 1
            ? 'Statul de plată se înregistrează la sfârșitul lunii.'
            : 'Corecția se înregistrează cel mai devreme la sfârșitul lunii corectate.',
          'date',
        ),
      );
    const date = (input.date as LocalDate | undefined) ?? end;
    if (profileAt(loaded, 'employer', date) !== 'yes')
      issues.push(block('EMPLOYER', 'Compania nu este înregistrată ca angajator.'));
    if (loaded.parties.get(input.authorityId)?.kind !== 'ro_public_institution')
      issues.push(
        block(
          'AUTHORITY',
          'Partenerul trebuie să fie autoritatea fiscală (instituție publică).',
          'authorityId',
        ),
      );
    if (run.lines.some((line) => line.unionDues > 0n))
      issues.push(
        block('UNION_DUES', 'Cotizația sindicală nu se înregistrează încă: lipsește sindicatul.'),
      );
    const now = bookingOf(run);
    const before = previous ? bookingOf(previous) : null;
    if (
      before &&
      JSON.stringify(before.garnishments.map((item) => [item.orderId, String(item.amount)])) !==
        JSON.stringify(now.garnishments.map((item) => [item.orderId, String(item.amount)]))
    )
      issues.push(
        block(
          'CORRECTION_GARNISHMENT',
          'Corecția schimbă reținerile din popriri ale lunii: nu este acoperită de aplicație.',
        ),
      );
    const delta = (pick: (booking: ReturnType<typeof bookingOf>) => bigint) =>
      pick(now) - (before ? pick(before) : 0n);
    const borne = delta((booking) => booking.borne);
    const shareAccount = profileAt(loaded, 'policy.payroll.employer_share', date);
    if ((now.borne > 0n || borne !== 0n) && !shareAccount)
      issues.push(
        block(
          'POLICY_MISSING',
          'Înregistrați politica contabilă pentru contribuțiile suportate de angajator în numele salariatului (policy.payroll.employer_share).',
        ),
      );
    if (issues.length) return { effect: null, issues };

    // When the tax and contributions are paid: by the 25th after the month, or after the quarter
    // for a quarterly payer (art. 80 alin. (2), art. 146 alin. (3), art. 168 alin. (3), art.
    // 220^6 alin. (1)), by the year's own `payroll.period` fact; unknown (no due date) without it.
    const year = Number(input.month.slice(0, 4));
    let period: PayrollPeriod | null = null;
    for (const fact of loaded.profile)
      if (
        fact.axis === 'payroll.period' &&
        fact.effectiveFrom >= `${year}-01-01` &&
        fact.effectiveFrom <= end
      )
        period = fact.value as PayrollPeriod;
    let dueDate: LocalDate | undefined;
    if (period) {
      const paid = payrollPaymentPeriod(input.month, period);
      const months = paid.counted.includes('Q')
        ? Number(paid.counted.slice(-1)) * 3
        : Number(input.month.slice(5, 7));
      const last = `${year}-${String(months).padStart(2, '0')}` as Month;
      const first = paid.counted.includes('Q')
        ? (`${year}-${String(months - 2).padStart(2, '0')}` as Month)
        : last;
      try {
        dueDate = obligationDue(
          paid.deadline,
          { start: monthStart(first), end: monthEnd(last) },
          rules,
        ).due;
      } catch (error) {
        if (!(error instanceof RuleGapError)) throw error;
        return { effect: null, issues: [block('RULE_GAP', error.message)] };
      }
    }
    // A correction's items may turn: an amount withheld or owed that fell is to recover.
    const correction = before !== null;
    const authority = (ref: string, account: string): OpenItemSpec => ({
      ref,
      kind: 'tax.payable',
      controlAccount: account,
      partyId: input.authorityId,
      currency: 'RON',
      normalSide: 'C',
      mayReverse: correction,
      ...(dueDate ? { dueDate } : {}),
    });
    const openItems: OpenItemSpec[] = [];
    const lines: LineSpec[] = [];
    const push = (line: LineSpec) => {
      if (line.bani !== 0n) lines.push(line);
    };
    // The sick pay the fund bears is a claim on it (4382), recovered on the employer's request
    // (OUG 158/2005 art. 38), not an expense.
    const inKind = delta((booking) => booking.inKind);
    push({ account: '641', side: 'D', bani: delta((booking) => booking.salary) + inKind });
    push({
      account: '4382',
      side: 'D',
      bani: delta((booking) => booking.sickFund),
      memo: 'Indemnizații de concediu medical de recuperat din FNUASS',
    });
    const contracts = [
      ...new Set([...now.employees.keys(), ...(before ? before.employees.keys() : [])]),
    ].sort();
    for (const contractId of contracts) {
      const current = now.employees.get(contractId);
      const earlier = before?.employees.get(contractId);
      const partyId = (current ?? earlier)!.partyId;
      const ref = `employee:${contractId}`;
      const earned = (current?.earned ?? 0n) - (earlier?.earned ?? 0n);
      const withheld = (current?.withheld ?? 0n) - (earlier?.withheld ?? 0n);
      const kind = (current?.inKind ?? 0n) - (earlier?.inKind ?? 0n);
      const garnished = now.garnishments
        .filter((item) => item.contractId === contractId && !correction)
        .reduce((sum, item) => sum + item.amount, 0n);
      if (!earned && !withheld && !kind && !garnished) continue;
      openItems.push({
        ref,
        kind: 'employee.payable',
        controlAccount: '421',
        partyId,
        currency: 'RON',
        normalSide: 'C',
        mayReverse: correction,
      });
      push({ account: '421', side: 'C', bani: earned, openItem: ref, partyId });
      push({
        account: '421',
        side: 'D',
        bani: withheld,
        openItem: ref,
        partyId,
        memo: 'CAS, CASS și impozit reținute',
      });
      push({
        account: '421',
        side: 'D',
        bani: kind,
        openItem: ref,
        partyId,
        memo: 'Avantaje în natură acordate, neplătite în bani',
      });
      push({
        account: '421',
        side: 'D',
        bani: garnished,
        openItem: ref,
        partyId,
        memo: 'Rețineri din popriri',
      });
    }
    // Each garnishment order's withholding is owed to its creditor (427), paid by bank.settle.
    if (!correction)
      for (const item of now.garnishments) {
        const ref = `garnishment:${item.orderId}`;
        openItems.push({
          ref,
          kind: 'employee.payable',
          controlAccount: '427',
          partyId: item.partyId,
          currency: 'RON',
          normalSide: 'C',
          mayReverse: false,
        });
        push({
          account: '427',
          side: 'C',
          bani: item.amount,
          openItem: ref,
          partyId: item.partyId,
          memo: 'Reținere din salariu datorată creditorului (poprire)',
        });
      }
    push({
      account: '7588',
      side: 'C',
      bani: inKind,
      memo: 'Avantaje în natură acordate salariaților',
    });
    const liability = (ref: string, account: string, bani: bigint) => {
      if (bani === 0n) return;
      openItems.push(authority(ref, account));
      lines.push({ account, side: 'C', bani, openItem: ref, partyId: input.authorityId });
    };
    if (borne !== 0n)
      lines.push({
        account: shareAccount!,
        side: 'D',
        bani: borne,
        memo: 'Contribuții suportate de angajator în numele salariaților',
      });
    liability(
      'cas',
      '4315',
      delta((booking) => booking.cas),
    );
    liability(
      'cass',
      '4316',
      delta((booking) => booking.cass),
    );
    liability(
      'tax',
      '444',
      delta((booking) => booking.tax),
    );
    // CAM is owed on the employer's total base, rounded once, as the D112 declares it.
    let cam: bigint;
    try {
      const at = monthStart(input.month as Month);
      const rate = rules.param<string>('ro.payroll.cam.rate', 'payroll_month_start', at);
      if (
        rules.param<string>('ro.payroll.amount_rounding', 'payroll_month_start', at) !==
        'leu_half_up'
      )
        throw new Error('Unknown rounding.');
      const camOf = (base: bigint) =>
        divRound(base * parseScaled(rate, 4), 100_000_000n, 'halfAwayFromZero') * 100n;
      cam = camOf(now.camBase) - (before ? camOf(before.camBase) : 0n);
    } catch (error) {
      if (!(error instanceof RuleGapError)) throw error;
      return { effect: null, issues: [block('RULE_GAP', error.message)] };
    }
    if (cam !== 0n) lines.push({ account: '646', side: 'D', bani: cam });
    liability('cam', '436', cam);
    if (correction && !lines.length)
      return {
        effect: null,
        issues: [block('CORRECTION_EMPTY', 'Calculul nou al lunii nu diferă de cel înregistrat.')],
      };

    const effect: Effect = {
      schema: 'effect@1',
      date,
      journalClass: 'general',
      journalCode: 'SALARII',
      description: `Stat de plată ${input.month}${input.round > 1 ? ` (corecție, runda ${input.round})` : ''}`,
      lines,
      openItems,
      taxEntries: [],
      schedules: [],
      explanation: {
        summary: `${run.lines.length} salariați: brut în bani ${formatMoney(
          now.salary + now.sickFund,
          'RON',
        )} lei, net ${formatMoney(now.net, 'RON')} lei, CAM ${formatMoney(cam, 'RON')} lei${
          correction ? ' (diferențe față de statul corectat)' : ''
        }.`,
        details: {
          month: input.month,
          round: input.round,
          corrects: run.corrects,
          payrollPeriod: period,
          taxDue: dueDate ?? null,
          vouchers: formatMoney(
            run.lines.reduce((sum, line) => sum + line.vouchers, 0n),
            'RON',
          ),
          inKind: formatMoney(now.inKind, 'RON'),
          garnished: formatMoney(
            now.garnishments.reduce((sum, item) => sum + item.amount, 0n),
            'RON',
          ),
        },
      },
    };
    return { effect, issues };
  },
};
