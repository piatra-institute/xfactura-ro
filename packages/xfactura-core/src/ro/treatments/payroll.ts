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
import { monthEnd, monthStart, type Month } from '../../time';

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
  })
  .strict();
export type PayrollInput = z.infer<typeof payrollInput>;

/** Where the company books contributions it bears in the employee's name (the part-time
 * minimum, art. 146 alin. (5^9)): an accounting policy, recorded like `policy.storno`. */
export const employerShareAccounts = ['635', '6458'] as const;

/**
 * A month's payroll as the run computed it: salaries owed to each employee (641 = 421), the
 * contributions and the tax withheld from them (421 = 4315, 4316, 444), contributions the
 * company bears in their name, and the work insurance contribution (646 = 436). One posting per
 * month and round; meal vouchers are taxed here and booked when handed over.
 */
export const payrollRecognition: Treatment<PayrollInput> = {
  id: 'payroll.recognize',
  version: 1,
  description: 'Statul de plată al lunii: salariile, contribuțiile și impozitul reținut.',
  input: payrollInput,
  agent: true,
  subject: (input) => `payroll:${input.month}:${input.round}`,
  plan: (input) => ({ payrollRuns: [input.runId], parties: [input.authorityId], profile: true }),
  evaluate(input, loaded, rules) {
    const issues: Issue[] = [];
    const run = loaded.payrollRuns.get(input.runId);
    const date = monthEnd(input.month as Month);
    if (!run)
      return { effect: null, issues: [block('RUN', 'Statul de plată nu există.', 'runId')] };
    if (run.month !== input.month || run.round !== input.round)
      issues.push(block('RUN', `Statul de plată este pentru ${run.month}, runda ${run.round}.`));
    if (run.state !== 'prepared')
      issues.push(block('RUN_SUPERSEDED', 'Statul de plată a fost înlocuit de un calcul nou.'));
    if (run.issues > 0)
      issues.push(block('RUN_BLOCKED', 'Statul de plată are probleme nerezolvate.'));
    if (!run.lines.length) issues.push(block('RUN_EMPTY', 'Statul de plată nu are salariați.'));
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
    const { lines: runLines } = run;
    const total = (pick: (line: PayrollLineState) => bigint) =>
      runLines.reduce((sum, line) => sum + pick(line), 0n);
    const borne = total((line) => line.casEmployer + line.cassEmployer);
    const shareAccount = profileAt(loaded, 'policy.payroll.employer_share', date);
    if (borne > 0n && !shareAccount)
      issues.push(
        block(
          'POLICY_MISSING',
          'Înregistrați politica contabilă pentru contribuțiile suportate de angajator în numele salariatului (policy.payroll.employer_share).',
        ),
      );
    if (issues.length) return { effect: null, issues };

    const authority = (ref: string, account: string): OpenItemSpec => ({
      ref,
      kind: 'tax.payable',
      controlAccount: account,
      partyId: input.authorityId,
      currency: 'RON',
      normalSide: 'C',
      mayReverse: false,
    });
    const openItems: OpenItemSpec[] = [];
    const lines: LineSpec[] = [{ account: '641', side: 'D', bani: total((line) => line.cash) }];
    for (const line of run.lines) {
      const ref = `employee:${line.contractId}`;
      openItems.push({
        ref,
        kind: 'employee.payable',
        controlAccount: '421',
        partyId: line.partyId,
        currency: 'RON',
        normalSide: 'C',
        mayReverse: false,
      });
      lines.push({
        account: '421',
        side: 'C',
        bani: line.cash,
        openItem: ref,
        partyId: line.partyId,
      });
      const withheld = line.cas + line.cass + line.tax;
      if (withheld)
        lines.push({
          account: '421',
          side: 'D',
          bani: withheld,
          openItem: ref,
          partyId: line.partyId,
          memo: 'CAS, CASS și impozit reținute',
        });
    }
    const liability = (ref: string, account: string, bani: bigint) => {
      if (bani === 0n) return;
      openItems.push(authority(ref, account));
      lines.push({ account, side: 'C', bani, openItem: ref, partyId: input.authorityId });
    };
    if (borne > 0n)
      lines.push({
        account: shareAccount!,
        side: 'D',
        bani: borne,
        memo: 'Contribuții suportate de angajator în numele salariaților',
      });
    liability(
      'cas',
      '4315',
      total((line) => line.cas + line.casEmployer),
    );
    liability(
      'cass',
      '4316',
      total((line) => line.cass + line.cassEmployer),
    );
    liability(
      'tax',
      '444',
      total((line) => line.tax),
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
      cam =
        divRound(
          total((line) => line.camBase) * parseScaled(rate, 4),
          100_000_000n,
          'halfAwayFromZero',
        ) * 100n;
    } catch (error) {
      if (!(error instanceof RuleGapError)) throw error;
      return { effect: null, issues: [block('RULE_GAP', error.message)] };
    }
    if (cam > 0n) lines.push({ account: '646', side: 'D', bani: cam });
    liability('cam', '436', cam);

    const effect: Effect = {
      schema: 'effect@1',
      date,
      journalClass: 'general',
      journalCode: 'SALARII',
      description: `Stat de plată ${input.month}${input.round > 1 ? ` (runda ${input.round})` : ''}`,
      lines,
      openItems,
      taxEntries: [],
      schedules: [],
      explanation: {
        summary: `${run.lines.length} salariați: brut în bani ${formatMoney(
          total((line) => line.cash),
          'RON',
        )} lei, net ${formatMoney(
          total((line) => line.net),
          'RON',
        )} lei, CAM ${formatMoney(cam, 'RON')} lei.`,
        details: {
          month: input.month,
          round: input.round,
          vouchers: formatMoney(
            total((line) => line.vouchers),
            'RON',
          ),
        },
      },
    };
    return { effect, issues };
  },
};
