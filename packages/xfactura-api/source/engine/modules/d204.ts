import { and, asc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { DomainError } from 'xfactura-core/errors';
import { hashOf } from 'xfactura-core/hash';
import type { ReadSetEntry } from 'xfactura-core/kernel';
import { LEDGER_CURRENCY, parseMoney } from 'xfactura-core/money';
import { checkD204, d204Format, writeD204, type D204 } from 'xfactura-core/ro/declarations/d204';
import { entityFormOf } from 'xfactura-core/ro/entity';
import type { RuleContext } from 'xfactura-core/rules';
import type { LocalDate } from 'xfactura-core/time';
import type { Transaction } from '../db/database';
import { companies, enterpriseMembers, incomeSources, partyCnps } from '../db/schema';
import { loadState } from '../kernel/state';
import type { DeclarationKind, DeclarationProblem } from './declarations';
import { Sealer } from './payroll';
import { fiscalRegister, fiscalRegisterInput } from './pit';

const always = '1900-01-01';
const contact = {
  phone: z.string().trim().min(1).max(15).optional(),
  email: z.string().trim().min(3).max(200).optional(),
};

export const d204Options = z
  .object({
    /** Section I: the enterprise's address (its fiscal domicile) and contacts. */
    address: z.string().trim().min(3).max(200),
    ...contact,
    /** Section IV: the representative's domicile and contacts; the name and CNP are the member's. */
    representative: z.object({ address: z.string().trim().min(3).max(200), ...contact }).strict(),
    /** The acord de constituire as registered with the fiscal body (nr_contr, data_contr; art. 125
     * alin. (2)). */
    contract: z.object({ number: z.string().trim().min(1).max(15), date: z.iso.date() }).strict(),
    /** The seat's locality, and its sector in Bucharest. */
    locality: z.string().trim().min(1).max(50).optional(),
    sector: z.number().int().min(1).max(6).optional(),
    /** The members' domiciles (dom_d), by party, when they are to be written. */
    domiciles: z.record(z.uuid(), z.string().trim().min(3).max(200)).default({}),
    /** What the fiscal register needs besides the books (pfa.fiscalRegister, without the year). */
    register: fiscalRegisterInput.omit({ year: true }).default({
      openingLosses: [],
      adjustments: [],
      norms: [],
      previousGross: [],
    }),
    /** A rectifying return (with `supersedesId`). */
    rectifies: z.boolean().optional(),
  })
  .strict();

async function inputsOf(tx: Transaction, companyId: string, year: string) {
  // The year's lines (the register), the profile, the asset register (fiscal depreciation), the
  // income sources and the agreements.
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
  const sources = await tx
    .select()
    .from(incomeSources)
    .where(eq(incomeSources.companyId, companyId))
    .orderBy(asc(incomeSources.sourceId), asc(incomeSources.seq));
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

/**
 * The annual return of a family enterprise in the real system (D204, Codul fiscal art. 125 alin.
 * (4)): the fiscal register's gross income, deductible expenses and net income or loss, and their
 * distribution to the members by the quotas of the agreement in force all year (art. 125 alin.
 * (5)), filed by the representative. An enterprise on a norm files none (art. 125 alin. (1) lit.
 * c), (10)); other associations and a change of the agreement in the year (norme pct. 41 alin.
 * (6)) are refused. The members' CNPs are opened from their seals for the XML only. Treating a
 * family enterprise as an association under art. 125 is a reading the expert contabil confirms:
 * neither the Code nor the form's instructions name it.
 */
export function d204Declaration(
  secret: string,
  rules: (tx: Transaction, companyId: string) => Promise<RuleContext>,
): DeclarationKind {
  const sealer = new Sealer(secret);
  return {
    kind: 'D204',
    description:
      'Declarație anuală de venit pentru asocieri fără personalitate juridică (D204): întreprinderea familială',
    tax: null,
    period: z.string().regex(/^\d{4}$/),
    format(year) {
      const format = d204Format(Number(year));
      return format ? `D204 ${format.namespace} an ${format.year} (${format.structure})` : null;
    },
    officialValidation: (year) => d204Format(Number(year)) !== null,
    options: d204Options,
    inputs: (tx, companyId, year) => inputsOf(tx, companyId, year),
    async prepare(tx, companyId, year, raw) {
      const options = d204Options.parse(raw);
      const income = Number(year);
      const problems: DeclarationProblem[] = [];
      const inputs = await inputsOf(tx, companyId, year);
      const fail = () => ({ xml: '', inputs, problems, summary: null });
      const start = `${year}-01-01` as LocalDate;
      const end = `${year}-12-31` as LocalDate;
      /** A register amount in whole lei. */
      const lei = (amount: string, what: string) => {
        const bani = parseMoney(amount, LEDGER_CURRENCY);
        if (bani % 100n !== 0n)
          problems.push({
            code: 'D204_BANI',
            message: `${what} (${amount} lei) are subdiviziuni de leu: declarația are sume în lei întregi.`,
          });
        return Number(bani / 100n);
      };

      const { loaded } = await loadState(tx, companyId, { profile: true });
      if (entityFormOf(loaded.profile, end) !== 'if')
        problems.push({
          code: 'D204_FORM',
          message:
            'Declarația 204 se pregătește aici pentru o întreprindere familială (entity.form if); alte asocieri nu sunt încă disponibile.',
        });
      if (
        loaded.profile.some(
          (fact) =>
            fact.axis === 'entity.form' && fact.effectiveFrom > start && fact.effectiveFrom <= end,
        )
      )
        problems.push({
          code: 'D204_FORM_CHANGE',
          message: `Forma de exercitare s-a schimbat în ${year}: venitul net se stabilește pe perioade, ceea ce nu este încă disponibil.`,
        });
      // An enterprise on a norm distributes nothing and files no D204.
      const sources = await tx
        .select()
        .from(incomeSources)
        .where(eq(incomeSources.companyId, companyId))
        .orderBy(asc(incomeSources.sourceId), asc(incomeSources.seq));
      const onNorm = [...Map.groupBy(sources, (row) => row.sourceId).values()].some((versions) => {
        const current = versions.filter((row) => row.effectiveFrom <= end).at(-1);
        return (
          current?.method === 'norma' &&
          current.startedOn <= end &&
          (!current.endedOn || current.endedOn >= start)
        );
      });
      if (onNorm)
        problems.push({
          code: 'D204_NORMA',
          message:
            'Întreprinderea familială impusă pe bază de normă nu depune D204: venitul nu se distribuie, fiecare membru declară norma sa (art. 125 alin. (1) lit. c) și alin. (10) din Codul fiscal; OPANAF nr. 470/2021, anexa nr. 2 pct. 2).',
        });
      if (problems.length) return fail();

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
      const [source] = register.sources;
      for (const issue of register.issues)
        if (issue.severity === 'block') problems.push({ code: issue.code, message: issue.message });
      if (register.sources.length !== 1)
        problems.push({
          code: 'D204_SOURCE',
          message:
            'D204 se pregătește pentru o singură sursă de venit din activități independente, în sistem real.',
        });
      const enterprise = register.enterprise;
      if (problems.length || !source?.totals || !enterprise) return fail();

      // The source's activity in force at the year's end, the enterprise and its members.
      const activity = (
        await tx
          .select()
          .from(incomeSources)
          .where(
            and(
              eq(incomeSources.companyId, companyId),
              eq(incomeSources.sourceId, source.sourceId),
            ),
          )
          .orderBy(asc(incomeSources.seq))
      )
        .filter((row) => row.effectiveFrom <= end)
        .at(-1)!;
      const [company] = await tx.select().from(companies).where(eq(companies.id, companyId));
      const seals = new Map(
        (
          await tx
            .select({ partyId: partyCnps.partyId, sealed: partyCnps.cnpSealed })
            .from(partyCnps)
            .where(
              and(
                eq(partyCnps.companyId, companyId),
                inArray(
                  partyCnps.partyId,
                  enterprise.members.map((member) => member.partyId),
                ),
              ),
            )
        ).map((row) => [row.partyId, row.sealed]),
      );
      const representative = enterprise.members.find((member) => member.representative)!;
      const members = enterprise.members.map((member) => ({
        name: member.name,
        cnp: sealer.open(companyId, seals.get(member.partyId)!),
        ...(options.domiciles[member.partyId]
          ? { domicile: options.domiciles[member.partyId] }
          : {}),
        quotaBp: Math.round(Number(member.quota) * 100),
        net: lei(member.net!, `Venitul net distribuit lui ${member.name}`),
        loss: lei(member.loss!, `Pierderea distribuită lui ${member.name}`),
      }));
      const model: D204 = {
        year: income,
        ...(options.rectifies ? { rectifies: true } : {}),
        association: {
          name: company!.name,
          cif: company!.cui,
          address: options.address,
          ...(options.phone ? { phone: options.phone } : {}),
          ...(options.email ? { email: options.email } : {}),
        },
        representative: {
          name: representative.name,
          cnp: members[enterprise.members.indexOf(representative)]!.cnp,
          address: options.representative.address,
          ...(options.representative.phone ? { phone: options.representative.phone } : {}),
          ...(options.representative.email ? { email: options.representative.email } : {}),
        },
        activity: {
          caen: activity.caen,
          county: activity.county,
          ...(options.locality ? { locality: options.locality } : {}),
          ...(options.sector ? { sector: options.sector } : {}),
          seat: activity.place,
          contract: options.contract,
          ...(activity.authorizationNumber && activity.authorizationDate
            ? {
                authorization: {
                  number: activity.authorizationNumber,
                  date: activity.authorizationDate,
                },
              }
            : {}),
          ...(activity.startedOn >= start ? { startedOn: activity.startedOn } : {}),
          ...(activity.endedOn && activity.endedOn <= end ? { endedOn: activity.endedOn } : {}),
          gross: lei(source.totals.gross, 'Venitul brut'),
          deductible: lei(source.totals.deductible, 'Cheltuielile deductibile'),
          net: lei(source.totals.net, 'Venitul net'),
          loss: lei(source.totals.loss, 'Pierderea'),
        },
        members,
      };
      if (problems.length) return fail();
      const checks = checkD204(model);
      problems.push(
        ...checks
          .filter((check) => check.severity === 'error')
          .map(({ code, message }) => ({ code, message })),
      );
      return {
        xml: problems.length ? '' : writeD204(model),
        inputs,
        problems,
        summary: {
          year,
          structure: d204Format(income)!.structure,
          validator: d204Format(income)!.validator,
          gross: source.totals.gross,
          deductible: source.totals.deductible,
          net: source.totals.net,
          loss: source.totals.loss,
          agreement: enterprise.version,
          members: enterprise.members.map((member) => ({
            partyId: member.partyId,
            quota: member.quota,
            net: member.net,
            loss: member.loss,
          })),
          warnings: checks
            .filter((check) => check.severity === 'warning')
            .map(({ code, message }) => ({ code, message })),
          notes: register.issues
            .filter((issue) => issue.severity !== 'block')
            .map(({ code, message }) => ({ code, message })),
        },
      };
    },
  };
}
