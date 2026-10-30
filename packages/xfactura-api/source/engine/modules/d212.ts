import { and, asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { DomainError } from 'xfactura-core/errors';
import { hashOf } from 'xfactura-core/hash';
import { profileAt, type ReadSetEntry } from 'xfactura-core/kernel';
import { formatMoney, LEDGER_CURRENCY, parseMoney } from 'xfactura-core/money';
import { checkD212, d212Format, writeD212, type D212 } from 'xfactura-core/ro/declarations/d212';
import { entityFormOf } from 'xfactura-core/ro/entity';
import { percentOf, toLeu, type CassOptionRule } from 'xfactura-core/ro/pit';
import { RuleGapError, type RuleContext } from 'xfactura-core/rules';
import type { LocalDate } from 'xfactura-core/time';
import type { Transaction } from '../db/database';
import { incomeSources, parties, partyCnps } from '../db/schema';
import { loadState } from '../kernel/state';
import type { DeclarationKind, DeclarationProblem } from './declarations';
import { Sealer } from './payroll';
import { fiscalRegisterInput, fiscalRegister } from './pit';

const always = '1900-01-01';

export const d212Options = z
  .object({
    /** The holder of the PFA or II: an individual partner whose CNP is recorded, sealed
     * (parties.recordCnp). */
    holderPartyId: z.uuid(),
    taxpayer: z
      .object({
        lastName: z.string().trim().min(1).max(100),
        /** The initial of the father's first name, when the holder uses one. */
        initial: z.string().trim().min(1).max(3).optional(),
        firstName: z.string().trim().min(1).max(100),
        /** The fiscal domicile (adresa_c): the holder's, not the activity's seat. */
        address: z.string().trim().min(3).max(200),
        phone: z.string().trim().min(1).max(15).optional(),
        email: z.string().trim().min(1).max(200).optional(),
      })
      .strict(),
    /** The account for refunds (cont_bancar). */
    iban: z.string().trim().min(15).max(34).optional(),
    /** What the fiscal register needs besides the books (pfa.fiscalRegister, without the year). */
    register: fiscalRegisterInput.omit({ year: true }).default({
      openingLosses: [],
      adjustments: [],
      norms: [],
    }),
    /** Chapter II: the option to pay CASS in the filing year (art. 180), after a loss (B) or a
     * zero net income (C) in the income year. */
    cassOption: z
      .object({ situation: z.enum(['B', 'C']) })
      .strict()
      .optional(),
    /** A rectifying return (with `supersedesId`): the chapters it rectifies, written in full. */
    rectifies: z.enum(['income', 'option', 'both']).optional(),
  })
  .strict();
export type D212Options = z.infer<typeof d212Options>;

/** The income sources, every version: a new or changed source makes a prepared return stale. */
async function sourceRows(tx: Transaction, companyId: string) {
  return tx
    .select()
    .from(incomeSources)
    .where(eq(incomeSources.companyId, companyId))
    .orderBy(asc(incomeSources.sourceId), asc(incomeSources.seq));
}

async function inputsOf(tx: Transaction, companyId: string, year: string) {
  // Every line up to the year's end (losses come from the earlier years), the profile, the
  // asset register for fiscal depreciation, and the income sources.
  const { readSet } = await loadState(tx, companyId, {
    profile: true,
    assets: true,
    turnover: [
      {
        prefixes: ['1', '2', '3', '4', '5', '6', '7', '8', '9'],
        from: always as LocalDate,
        to: `${year}-12-31` as LocalDate,
      },
    ],
  });
  const sources = await sourceRows(tx, companyId);
  const inputs: ReadSetEntry[] = [
    ...readSet,
    { kind: 'profile', id: 'income-sources', version: hashOf(sources) },
  ];
  return inputs;
}

/** The register's issues that a return cannot leave open: the owner's status for CAS and CASS
 * decides what is due, and the register assumes it when unstated. */
const statusIssues = new Set(['CAS_STATUS_UNSTATED', 'CASS_EXCEPTION_UNSTATED']);

/**
 * The Declarația unică (D212) of a PFA or an II for an income year, from its fiscal register
 * (pfa.fiscalRegister) and profile; what the books do not hold (the holder's identity, domicile
 * and account, the CASS option) comes from the options. One source of independent income in the
 * real system only: norms, several sources, an IF's members, income outside these books and a
 * change of form in the year are refused, never guessed. The CNP is opened from its seal for the
 * XML only.
 *
 * The income of 2024 is written in ANAF's structure D212_A1.0.3 and validated by DUKIntegrator
 * (J13.0.1); the income of 2025 in the web form's structure, for which ANAF publishes no
 * validator (`officialValidation` false): such a return stops at `prepared`.
 */
export function d212Declaration(
  secret: string,
  rules: (tx: Transaction, companyId: string) => Promise<RuleContext>,
): DeclarationKind {
  const sealer = new Sealer(secret);
  return {
    kind: 'D212',
    description:
      'Declarație unică privind impozitul pe venit și contribuțiile sociale datorate de persoanele fizice (D212)',
    tax: null,
    period: z.string().regex(/^\d{4}$/),
    format(year) {
      const format = d212Format(Number(year));
      return format ? `D212 ${format.namespace} an_r ${format.anR} (${format.structure})` : null;
    },
    officialValidation: (year) => d212Format(Number(year))?.validator !== null,
    options: d212Options,
    inputs: (tx, companyId, year) => inputsOf(tx, companyId, year),
    async prepare(tx, companyId, year, raw) {
      const options = d212Options.parse(raw);
      const income = Number(year);
      const format = d212Format(income)!;
      const problems: DeclarationProblem[] = [];
      const inputs = await inputsOf(tx, companyId, year);
      const fail = () => ({ xml: '', inputs, problems, summary: null });
      /** A register amount in whole lei: the declaration has no bani. */
      const lei = (amount: string, what: string) => {
        const bani = parseMoney(amount, LEDGER_CURRENCY);
        if (bani % 100n !== 0n)
          problems.push({
            code: 'D212_BANI',
            message: `${what} (${amount} lei) are subdiviziuni de leu: declarația are sume în lei întregi.`,
          });
        return Number(bani / 100n);
      };
      const start = `${year}-01-01` as LocalDate;
      const end = `${year}-12-31` as LocalDate;

      // Who files: a PFA or an II, the same all year.
      const { loaded } = await loadState(tx, companyId, { profile: true });
      const form = entityFormOf(loaded.profile, end);
      if (form === 'if')
        problems.push({
          code: 'D212_IF',
          message:
            'Membrii unei întreprinderi familiale depun fiecare D212 pentru venitul distribuit (art. 122 alin. (4)); distribuirea pe membri nu este încă disponibilă.',
        });
      else if (form !== 'pfa' && form !== 'ii')
        problems.push({
          code: 'D212_FORM',
          message: 'Declarația unică se pregătește pentru o PFA sau o II (entity.form).',
        });
      if (
        loaded.profile.some(
          (fact) =>
            fact.axis === 'entity.form' && fact.effectiveFrom > start && fact.effectiveFrom <= end,
        )
      )
        problems.push({
          code: 'D212_FORM_CHANGE',
          message: `Forma de exercitare s-a schimbat în ${year}: venitul net se stabilește pe perioade (instrucțiuni pct. 3.5.14), ceea ce nu este încă disponibil.`,
        });
      if (options.register.otherIncome)
        problems.push({
          code: 'D212_OTHER_INCOME',
          message:
            'Veniturile din afara acestor registre se declară în aceeași declarație, cu sursele lor; D212 se pregătește aici numai pentru venitul din registre.',
        });
      if (options.register.norms.length)
        problems.push({
          code: 'D212_NORMA',
          message:
            'Venitul stabilit pe bază de normă nu este încă declarat de xFactura în D212 (coeficienții pe criterii ai formularului lipsesc din registru).',
        });
      if (problems.length) return fail();

      // The year's fiscal register: the figures the return declares.
      let register: Awaited<ReturnType<typeof fiscalRegister>>;
      try {
        register = await fiscalRegister(
          tx,
          companyId,
          { ...options.register, year: income },
          await rules(tx, companyId),
        );
      } catch (error) {
        if (!(error instanceof DomainError)) throw error;
        problems.push({ code: error.code, message: error.message });
        return fail();
      }
      for (const issue of register.issues)
        if (issue.severity === 'block' || statusIssues.has(issue.code))
          problems.push({ code: issue.code, message: issue.message });
      const [source] = register.sources;
      if (register.sources.length !== 1 || source?.method !== 'sistem_real' || !source.totals)
        problems.push({
          code: 'D212_SOURCE',
          message:
            'D212 se pregătește pentru o singură sursă de venit din activități independente, în sistem real.',
        });
      if (problems.length || !source?.totals || !source.losses) return fail();

      // The source's activity data in force at the year's end.
      const versions = (await sourceRows(tx, companyId)).filter(
        (row) => row.sourceId === source.sourceId && row.effectiveFrom <= end,
      );
      const activity = versions.at(-1)!;
      if (!activity.authorizationNumber || !activity.authorizationDate)
        problems.push({
          code: 'D212_AUTHORIZATION',
          message: `${activity.name}: înregistrați numărul și data documentului de autorizare (pfa.sources.record).`,
        });

      // The holder's CNP, opened from its seal.
      const [holder] = await tx
        .select()
        .from(parties)
        .where(and(eq(parties.companyId, companyId), eq(parties.id, options.holderPartyId)));
      const [seal] = holder
        ? await tx
            .select({ cnpSealed: partyCnps.cnpSealed })
            .from(partyCnps)
            .where(and(eq(partyCnps.companyId, companyId), eq(partyCnps.partyId, holder.id)))
        : [];
      if (holder?.kind !== 'ro_individual' || !seal)
        problems.push({
          code: 'D212_CNP',
          message:
            'Indicați titularul ca partener persoană fizică, cu CNP-ul înregistrat (parties.recordCnp).',
        });

      // Chapter II: the CASS of the option, on the filing year's minimum wage.
      let cassOption: D212['cassOption'];
      if (options.cassOption) {
        const net = lei(source.totals.net, 'Venitul net');
        const loss = lei(source.totals.loss, 'Pierderea');
        const situation = options.cassOption.situation;
        if (situation === 'B' ? loss === 0 : net !== 0 || loss !== 0)
          problems.push({
            code: 'D212_CASS_OPTION',
            message:
              situation === 'B'
                ? `Situația B (pierdere fiscală în anul anterior) cere o pierdere în ${year}.`
                : `Situația C (venit net anual zero în anul anterior) cere un venit net zero în ${year}.`,
          });
        // Art. 180 alin. (2): the option's wages at the minimum wage of 1 January of the year
        // opted for, the filing year.
        try {
          const context = await rules(tx, companyId);
          const at = `${format.anR}-01-01` as LocalDate;
          const wage = context.param<string>('ro.min_wage.contributions', 'fiscal_year_start', at);
          const rule = context.param<CassOptionRule>('ro.cass.option', 'fiscal_year_start', at);
          const rate = context.param<string>('ro.cass.rate', 'fiscal_year_start', at);
          const base = parseMoney(wage, LEDGER_CURRENCY) * BigInt(rule.baseWages);
          cassOption = {
            situation,
            base: lei(formatMoney(base, LEDGER_CURRENCY), 'Baza CASS a opțiunii'),
            due: lei(
              formatMoney(toLeu(percentOf(base, rate)), LEDGER_CURRENCY),
              'CASS datorată prin opțiune',
            ),
          };
        } catch (error) {
          if (!(error instanceof RuleGapError)) throw error;
          problems.push({ code: 'RULE_GAP', message: error.message });
        }
      }
      if (problems.length) return fail();

      const { contributions, tax } = register;
      const casDue = lei(contributions.cas.due, 'CAS datorată');
      const cassDue = lei(contributions.cass.due, 'CASS datorată');
      const model: D212 = {
        year: income,
        rectifies: {
          income: options.rectifies === 'income' || options.rectifies === 'both',
          option: options.rectifies === 'option' || options.rectifies === 'both',
        },
        taxpayer: {
          cnp: sealer.open(companyId, seal!.cnpSealed),
          lastName: options.taxpayer.lastName,
          ...(options.taxpayer.initial ? { initial: options.taxpayer.initial } : {}),
          firstName: options.taxpayer.firstName,
          address: options.taxpayer.address,
          ...(options.taxpayer.phone ? { phone: options.taxpayer.phone } : {}),
          ...(options.taxpayer.email ? { email: options.taxpayer.email } : {}),
          ...(options.iban ? { iban: options.iban } : {}),
        },
        activity: {
          caen: activity.caen,
          seat: activity.place,
          authorization: {
            number: activity.authorizationNumber!,
            date: activity.authorizationDate!,
          },
          ...(activity.startedOn >= start ? { startedOn: activity.startedOn } : {}),
          ...(activity.endedOn && activity.endedOn <= end ? { endedOn: activity.endedOn } : {}),
          ...(activity.suspendedFrom &&
          activity.suspendedFrom >= start &&
          activity.suspendedFrom <= end
            ? { suspendedOn: activity.suspendedFrom }
            : {}),
          gross: lei(source.totals.gross, 'Venitul brut'),
          deductible: lei(source.totals.deductible, 'Cheltuielile deductibile'),
          carriedLosses: lei(source.losses.available, 'Pierderile reportate'),
          offsetLoss: lei(source.losses.offset, 'Pierderea compensată'),
        },
        casStatus: contributions.cas.status,
        cas: casDue > 0 ? { base: lei(contributions.cas.base, 'Baza CAS'), due: casDue } : null,
        cassException: (profileAt(loaded, 'cass.exception', end) ?? 'none') !== 'none',
        cass:
          cassDue > 0
            ? {
                base: lei(contributions.cass.base, 'Baza CASS'),
                due: cassDue,
                minimumDifference: lei(
                  contributions.cass.minimumDifference,
                  'Diferența până la CASS minimă',
                ),
              }
            : null,
        tax: {
          deductibleCas: lei(contributions.cas.deductible, 'CAS deductibilă'),
          deductibleCass: lei(contributions.cass.deductible, 'CASS deductibilă'),
          due: lei(tax.real, 'Impozitul'),
        },
        ...(cassOption ? { cassOption } : {}),
      };
      if (problems.length) return fail();
      const checks = checkD212(model);
      problems.push(
        ...checks
          .filter((check) => check.severity === 'error')
          .map(({ code, message }) => ({ code, message })),
      );
      return {
        xml: problems.length ? '' : writeD212(model),
        inputs,
        problems,
        summary: {
          year,
          anR: format.anR,
          structure: format.structure,
          validator: format.validator,
          net: source.totals.net,
          loss: source.totals.loss,
          cas: contributions.cas.due,
          cass: contributions.cass.due,
          tax: tax.real,
          cassOption: cassOption ? String(cassOption.due) : null,
          warnings: checks
            .filter((check) => check.severity === 'warning')
            .map(({ code, message }) => ({ code, message })),
          notes: register.issues
            .filter((issue) => issue.severity !== 'block' && !statusIssues.has(issue.code))
            .map(({ code, message }) => ({ code, message })),
        },
      };
    },
  };
}
