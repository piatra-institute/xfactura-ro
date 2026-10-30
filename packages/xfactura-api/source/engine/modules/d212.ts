import { and, asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { DomainError } from 'xfactura-core/errors';
import { hashOf } from 'xfactura-core/hash';
import { profileAt, type ReadSetEntry } from 'xfactura-core/kernel';
import { formatMoney, LEDGER_CURRENCY, parseMoney } from 'xfactura-core/money';
import {
  checkD212,
  d212Format,
  writeD212,
  type D212,
  type D212Norm,
  type NormCriterion,
} from 'xfactura-core/ro/declarations/d212';
import { entityFormOf } from 'xfactura-core/ro/entity';
import { percentOf, toLeu, type CassOptionRule } from 'xfactura-core/ro/pit';
import { RuleGapError, type RuleContext } from 'xfactura-core/rules';
import type { LocalDate } from 'xfactura-core/time';
import type { Transaction } from '../db/database';
import { enterpriseMembers, incomeSources, parties, partyCnps } from '../db/schema';
import { loadState } from '../kernel/state';
import type { DeclarationKind, DeclarationProblem } from './declarations';
import { Sealer } from './payroll';
import { fiscalRegisterInput, fiscalRegister, memberStatusInput, memberYear } from './pit';

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
      previousGross: [],
    }),
    /** Chapter II: the option to pay CASS in the filing year (art. 180), after a loss (B) or a
     * zero net income (C) in the income year. */
    cassOption: z
      .object({ situation: z.enum(['B', 'C']) })
      .strict()
      .optional(),
    /** A rectifying return (with `supersedesId`): the chapters it rectifies, written in full. */
    rectifies: z.enum(['income', 'option', 'both']).optional(),
    /** A family enterprise's member (the holder): their own situation for CAS and CASS, which the
     * enterprise's profile does not hold. */
    member: memberStatusInput.optional(),
    /** A family enterprise's member: the acord de constituire as registered with the fiscal body
     * (the association contract of rd. 7), number and date. */
    association: z
      .object({ number: z.string().trim().min(1).max(50), date: z.iso.date() })
      .strict()
      .optional(),
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
  const members = await tx
    .select()
    .from(enterpriseMembers)
    .where(eq(enterpriseMembers.companyId, companyId))
    .orderBy(asc(enterpriseMembers.version), asc(enterpriseMembers.position));
  const inputs: ReadSetEntry[] = [
    ...readSet,
    { kind: 'profile', id: 'income-sources', version: hashOf(sources) },
    { kind: 'profile', id: 'enterprise-members', version: hashOf(members) },
  ];
  return inputs;
}

/** The register's issues that a return cannot leave open: the owner's status for CAS and CASS
 * decides what is due, and the register assumes it when unstated. */
const statusIssues = new Set(['CAS_STATUS_UNSTATED', 'CASS_EXCEPTION_UNSTATED']);

/**
 * The Declarația unică (D212) for an income year of a PFA's or an II's holder, or of a family
 * enterprise's member, from the fiscal register (pfa.fiscalRegister) and the profile; what the
 * books do not hold (the holder's identity, domicile and account, the CASS option, a member's own
 * situation for CAS and CASS and the registered association contract) comes from the options. One
 * source of independent income: in the real system (cap11), or on a norm (cap12, the place's norm
 * and coefficients as the preparer gave them with the DGRFP's publication). A member declares the
 * net income or loss the enterprise distributed to them (art. 122 alin. (4)), with their own losses
 * carried and their own CAS and CASS. Refused, never guessed: several sources, income outside these
 * books, a change of form in the year, and an enterprise's members on a norm (each member's own
 * norm is not modelled). The CNP is opened from its seal for the XML only.
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

      // Who files: a PFA's or an II's holder, or a family enterprise's member, the same form all
      // year.
      const { loaded } = await loadState(tx, companyId, { profile: true });
      const form = entityFormOf(loaded.profile, end);
      if (form !== 'pfa' && form !== 'ii' && form !== 'if')
        problems.push({
          code: 'D212_FORM',
          message:
            'Declarația unică se pregătește pentru titularul unei PFA sau II, ori pentru un membru al unei întreprinderi familiale (entity.form).',
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
      const member = form === 'if' ? options.member : undefined;
      if (form === 'if' && !options.member)
        problems.push({
          code: 'D212_MEMBER',
          message:
            'Indicați situația membrului față de CAS și CASS (member): profilul întreprinderii familiale nu o cuprinde, fiecare membru o are pe a sa.',
        });
      if (form === 'if' && !options.association)
        problems.push({
          code: 'D212_ASSOCIATION',
          message:
            'Indicați numărul și data sub care acordul de constituire (contractul de asociere) a fost înregistrat la organul fiscal (rd. 7).',
        });
      if (problems.length) return fail();

      // The year's fiscal register, and for a member their share of it: the figures declared.
      const registerInput = { ...options.register, year: income };
      let register: Awaited<ReturnType<typeof fiscalRegister>>;
      let share: Awaited<ReturnType<typeof memberYear>>['share'] = null;
      let issues: Awaited<ReturnType<typeof fiscalRegister>>['issues'];
      try {
        const context = await rules(tx, companyId);
        if (member) {
          const result = await memberYear(
            tx,
            companyId,
            registerInput,
            context,
            options.holderPartyId,
            member,
          );
          ({ register, share, issues } = result);
        } else {
          register = await fiscalRegister(tx, companyId, registerInput, context);
          issues = register.issues;
        }
      } catch (error) {
        if (!(error instanceof DomainError)) throw error;
        problems.push({ code: error.code, message: error.message });
        return fail();
      }
      for (const issue of issues)
        if (issue.severity === 'block' || statusIssues.has(issue.code))
          problems.push({ code: issue.code, message: issue.message });
      const [source] = register.sources;
      if (register.sources.length !== 1 || !source)
        problems.push({
          code: 'D212_SOURCE',
          message:
            'D212 se pregătește pentru o singură sursă de venit din activități independente.',
        });
      else if (source.method === 'norma' && member)
        problems.push({
          code: 'D212_IF_NORMA',
          message:
            'Membrii unei întreprinderi familiale impuse pe bază de normă declară fiecare norma proprie, cu coeficienții săi (art. 69 alin. (3)); norma pe membru nu este încă disponibilă.',
        });
      const contributions = share ? share.contributions : register.contributions;
      const tax = share ? share.tax : register.tax;
      if (problems.length || !source || !contributions || !tax) return fail();
      const normData = source.method === 'norma' ? source.norm : undefined;
      if (source.method === 'norma' && !normData) return fail();
      if (source.method === 'sistem_real' && !(share ? true : source.totals && source.losses))
        return fail();

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

      // The declared net income and loss: the register's, the member's share, or the norm's.
      const declared = share
        ? {
            net: formatMoney(share.net, LEDGER_CURRENCY),
            loss: formatMoney(share.loss, LEDGER_CURRENCY),
          }
        : normData
          ? { net: normData.adjusted, loss: '0.00' }
          : { net: source.totals!.net, loss: source.totals!.loss };

      // Chapter II: the CASS of the option, on the filing year's minimum wage.
      let cassOption: D212['cassOption'];
      if (options.cassOption) {
        const net = lei(declared.net, 'Venitul net');
        const loss = lei(declared.loss, 'Pierderea');
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

      // The norm's place (Subsection 2): its coefficients need their criteria.
      let norm: D212Norm | undefined;
      if (normData) {
        const coefficient = (
          percent: string | null,
          criterion: NormCriterion | null,
          label: string,
        ) => {
          if (percent === null) return undefined;
          if (criterion === null) {
            problems.push({
              code: 'D212_NORMA_CRITERION',
              message: `Indicați criteriul (01–13) din care vine coeficientul de ${label} (increaseCriterion, reductionCriterion).`,
            });
            return undefined;
          }
          return { percent, criterion };
        };
        const increase = coefficient(
          normData.increasePercent,
          normData.increaseCriterion,
          'majorare',
        );
        const reduction = coefficient(
          normData.reductionPercent,
          normData.reductionCriterion,
          'reducere',
        );
        norm = {
          association: false,
          caen: activity.caen,
          seat: activity.place,
          authorization: {
            number: activity.authorizationNumber ?? '',
            date: activity.authorizationDate ?? '',
          },
          ...(activity.startedOn >= start ? { startedOn: activity.startedOn } : {}),
          ...(activity.endedOn && activity.endedOn <= end ? { endedOn: activity.endedOn } : {}),
          ...(activity.suspendedFrom &&
          activity.suspendedFrom >= start &&
          activity.suspendedFrom <= end
            ? { suspendedOn: activity.suspendedFrom }
            : {}),
          ...(normData.activeDays !== null ? { activeDays: normData.activeDays } : {}),
          ...(normData.interruptedDays !== null
            ? { interruptedDays: normData.interruptedDays }
            : {}),
          norm: lei(normData.norm, 'Norma de venit'),
          ...(increase ? { increase } : {}),
          ...(reduction ? { reduction } : {}),
          adjusted: lei(normData.yearly, 'Norma ajustată'),
          net: lei(normData.adjusted, 'Venitul net anual din normă'),
          tax: lei(tax.norma, 'Impozitul pe normă'),
        };
      }
      if (problems.length) return fail();

      const casDue = lei(contributions.cas.due, 'CAS datorată');
      const cassDue = lei(contributions.cass.due, 'CASS datorată');
      const dates = {
        ...(activity.startedOn >= start ? { startedOn: activity.startedOn } : {}),
        ...(activity.endedOn && activity.endedOn <= end ? { endedOn: activity.endedOn } : {}),
        ...(activity.suspendedFrom &&
        activity.suspendedFrom >= start &&
        activity.suspendedFrom <= end
          ? { suspendedOn: activity.suspendedFrom }
          : {}),
      };
      const place = {
        caen: activity.caen,
        seat: activity.place,
        authorization: {
          number: activity.authorizationNumber!,
          date: activity.authorizationDate!,
        },
        ...dates,
      };
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
        ...(norm
          ? { norm }
          : share
            ? {
                activity: {
                  ...place,
                  association: {
                    number: options.association!.number,
                    date: options.association!.date,
                    net: lei(declared.net, 'Venitul net distribuit'),
                    loss: lei(declared.loss, 'Pierderea distribuită'),
                  },
                  carriedLosses: lei(share.losses.available, 'Pierderile reportate'),
                  offsetLoss: lei(share.losses.offset, 'Pierderea compensată'),
                },
              }
            : {
                activity: {
                  ...place,
                  gross: lei(source.totals!.gross, 'Venitul brut'),
                  deductible: lei(source.totals!.deductible, 'Cheltuielile deductibile'),
                  carriedLosses: lei(source.losses!.available, 'Pierderile reportate'),
                  offsetLoss: lei(source.losses!.offset, 'Pierderea compensată'),
                },
              }),
        casStatus: contributions.cas.status,
        cas: casDue > 0 ? { base: lei(contributions.cas.base, 'Baza CAS'), due: casDue } : null,
        cassException: member
          ? member.cassException !== 'none'
          : (profileAt(loaded, 'cass.exception', end) ?? 'none') !== 'none',
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
          method: source.method,
          member: share ? { partyId: share.partyId, quota: share.quota } : null,
          net: declared.net,
          loss: declared.loss,
          cas: contributions.cas.due,
          cass: contributions.cass.due,
          tax: tax.total,
          cassOption: cassOption ? String(cassOption.due) : null,
          warnings: checks
            .filter((check) => check.severity === 'warning')
            .map(({ code, message }) => ({ code, message })),
          notes: issues
            .filter((issue) => issue.severity !== 'block' && !statusIssues.has(issue.code))
            .map(({ code, message }) => ({ code, message })),
        },
      };
    },
  };
}
