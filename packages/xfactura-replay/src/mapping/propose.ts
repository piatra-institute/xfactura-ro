import type { PartyRecord } from 'xfactura-core/kernel';
import { accountCodePattern } from 'xfactura-core/kernel';
import { controlKindOf } from 'xfactura-core/ro/chart';
import type { D406Filed, D406FiledParty } from 'xfactura-core/ro/saft/read';
import { comparePaths } from '../corpus/files';
import {
  MappingError,
  mappingSchema,
  partyKey,
  type AccountMapping,
  type Mapping,
  type PartyMapping,
  type PartyCreation,
  type PartySource,
  type UnresolvedReason,
} from './schema';
import { collectSources, distinctPartners, type SagaDump } from './sources';
import { proposePartner } from './partners';

export type MappingChartAccount = {
  code: string;
  name: string;
  postable: boolean;
  book?: string;
};
export type MappingOptions = { source?: string; saga?: SagaDump };

export function filedCompany(filed: readonly D406Filed[]): string {
  const companies = filed.map((f) =>
    f.header.company.registrationNumber?.trim().replace(/\s+/g, '').replace(/^RO/i, ''),
  );
  if (!companies.length || companies.some((c) => !c) || new Set(companies).size !== 1)
    throw new MappingError('MAPPING_COMPANY_MISMATCH');
  return companies[0]!;
}

/** Only exact SAGA account spellings, or their dot-free AccountID, establish an alias. */
function sagaAccounts(id: string, standard: string | undefined, saga?: SagaDump) {
  return (
    saga?.accounts.filter(
      (a) => a.code === standard || a.code === id || a.code.replaceAll('.', '') === id,
    ) ?? []
  );
}

function sagaRecord(partner: SagaDump['partners'][number]): D406FiledParty {
  return {
    id: partner.saftId,
    name: partner.name,
    registrationNumber: partner.taxId,
    address: partner.country ? { country: partner.country } : undefined,
  };
}

/** Rules only propose decisions. A rerun retains every prior mapped or person-owned entry. */
export function proposeMapping(
  filed: readonly D406Filed[],
  chart: readonly MappingChartAccount[],
  parties: readonly PartyRecord[],
  previous?: Mapping,
  options: MappingOptions = {},
): Mapping {
  const company = filedCompany(filed);
  const source = options.source ?? previous?.source ?? 'd406';
  if (previous && !mappingSchema.safeParse(previous).success)
    throw new MappingError('MAPPING_SCHEMA');
  if (previous && (previous.company !== company || previous.source !== source))
    throw new MappingError('MAPPING_SOURCE_MISMATCH');
  const mapping: Mapping = previous
    ? structuredClone(previous)
    : {
        schemaVersion: 1,
        company,
        source,
        accounts: [],
        partners: [],
        placeholders: [],
      };
  const sources = collectSources(filed);
  const chartByCode = new Map(chart.map((account) => [account.code, account]));
  if (chartByCode.size !== chart.length) throw new MappingError('MAPPING_CHART_DUPLICATE');
  const priorAccount = new Map(mapping.accounts.map((a, i) => [a.sourceId, i]));
  const priorPartner = new Map(mapping.partners.map((p, i) => [partyKey(p.source), i]));
  const protectedPartners = new Set(
    mapping.partners
      .filter(
        (p) => p.target.status === 'mapped' || p.decidedBy === 'person' || p.confirmedByPerson,
      )
      .map((p) => partyKey(p.source)),
  );
  if (
    priorAccount.size !== mapping.accounts.length ||
    priorPartner.size !== mapping.partners.length
  )
    throw new MappingError('MAPPING_DUPLICATE');
  const preserve = (entry: AccountMapping | PartyMapping) =>
    entry.target.status === 'mapped' || entry.decidedBy === 'person' || entry.confirmedByPerson;

  for (const [key, partner] of [...sources.partners].sort(([a], [b]) => comparePaths(a, b))) {
    const fallback =
      options.saga?.partners.filter(
        (p) => p.source.role === partner.source.role && p.saftId === partner.source.id,
      ) ?? [];
    const records = partner.records.length ? partner.records : fallback.map(sagaRecord);
    const index = priorPartner.get(key);
    if (index !== undefined && preserve(mapping.partners[index]!)) continue;
    const proposed = proposePartner(partner.source, records, parties);
    if (index !== undefined) mapping.partners[index] = proposed;
    else {
      priorPartner.set(key, mapping.partners.length);
      mapping.partners.push(proposed);
    }
  }

  const addSagaPartner = (partner: SagaDump['partners'][number]): PartySource => {
    const d406Source: PartySource = {
      origin: 'd406',
      role: partner.source.role,
      id: partner.saftId ?? '',
    };
    const sagaRecords = (
      options.saga?.partners.filter((p) => partyKey(p.source) === partyKey(partner.source)) ?? [
        partner,
      ]
    ).map(sagaRecord);
    const linked = sources.partners.get(partyKey(d406Source));
    // C_SAFT is an alias, not authority to discard COD_FISCAL. Validate both identities
    // before reusing the D406 source, even when its master record is already mapped.
    const proposed = proposePartner(
      partner.source,
      [...(linked?.records ?? []), ...sagaRecords],
      parties,
    );
    if (linked && proposed.target.status === 'mapped') return d406Source;
    const key = partyKey(partner.source);
    const index = priorPartner.get(key);
    if (index === undefined || !preserve(mapping.partners[index]!)) {
      if (index !== undefined) mapping.partners[index] = proposed;
      else {
        priorPartner.set(key, mapping.partners.length);
        mapping.partners.push(proposed);
      }
    }
    return partner.source;
  };

  for (const [id, input] of [...sources.accounts].sort(([a], [b]) => comparePaths(a, b))) {
    const index = priorAccount.get(id);
    if (index !== undefined && preserve(mapping.accounts[index]!)) continue;
    const standards = [
      ...new Set(input.records.map((a) => a.standard).filter((s): s is string => !!s)),
    ];
    const fallback = sagaAccounts(id, standards[0], options.saga);
    const standard = standards.length
      ? standards[0]
      : fallback.length === 1
        ? fallback[0]!.code
        : undefined;
    const controlKind = standard ? controlKindOf(standard) : null;
    const base = {
      sourceId: id,
      standardId: standard ?? null,
      controlKind,
      confirmedByPerson: false,
    };
    const unresolved = (reason: UnresolvedReason): AccountMapping => ({
      ...base,
      decidedBy: 'rule:unresolved',
      target: { status: 'unresolved', reason },
    });
    const decide = (): AccountMapping => {
      if (standards.length > 1) return unresolved('ACCOUNT_STANDARD_CONFLICT');
      if (!standard) return unresolved('ACCOUNT_STANDARD_MISSING');
      if (!accountCodePattern.test(standard)) return unresolved('ACCOUNT_CODE_INVALID');
      const syntheticCode = standard.split('.')[0]!;
      const synthetic = chartByCode.get(syntheticCode);
      if (!synthetic) return unresolved('ACCOUNT_SYNTHETIC_UNKNOWN');
      if (!synthetic.postable) return unresolved('ACCOUNT_NOT_POSTABLE');
      const name =
        input.records
          .map((a) => a.description?.trim())
          .filter((s): s is string => !!s)
          .sort(comparePaths)[0] ?? fallback[0]?.name;
      if (!controlKind) {
        const existing = chartByCode.get(standard);
        if (
          standard !== syntheticCode &&
          !existing &&
          synthetic.book !== undefined &&
          synthetic.book !== 'general'
        )
          return unresolved('ACCOUNT_ANALYTIC_UNSUPPORTED');
        const account: Extract<AccountMapping['target'], { status: 'mapped' }>['account'] =
          standard === syntheticCode
            ? { kind: 'synthetic', code: syntheticCode, name: synthetic.name }
            : {
                kind: 'analytic',
                action: existing ? 'existing' : 'create',
                code: standard,
                name: existing?.name ?? name ?? '',
              };
        if (existing && !existing.postable) return unresolved('ACCOUNT_NOT_POSTABLE');
        if (account.kind === 'analytic' && (account.name.length < 2 || account.name.length > 300))
          return unresolved('ACCOUNT_NAME_MISSING');
        // Each ancestor has to exist before accounts.create accepts a nested analytic.
        if (
          account.kind === 'analytic' &&
          standard.split('.').length > 2 &&
          !chartByCode.has(standard.slice(0, standard.lastIndexOf('.')))
        )
          return unresolved('ACCOUNT_SYNTHETIC_UNKNOWN');
        return {
          ...base,
          decidedBy:
            account.kind === 'synthetic' ? 'rule:account-synthetic' : 'rule:account-analytic',
          target: { status: 'mapped', account, party: null, requiresOpenItem: false },
        };
      }
      const uses = sources.uses.filter((use) => use.id === id);
      const lineParties = uses.map((use) => distinctPartners(use.partners, mapping.partners));
      if (lineParties.some((partners) => partners.length > 1))
        return unresolved('ACCOUNT_PARTNER_AMBIGUOUS');
      if (uses.length > 0 && lineParties.every((partners) => partners.length === 1))
        return {
          ...base,
          decidedBy: 'rule:control-line-party',
          target: {
            status: 'mapped',
            account: { kind: 'synthetic', code: syntheticCode, name: synthetic.name },
            party: { kind: 'line' },
            requiresOpenItem: controlKind !== 'tax',
          },
        };
      let candidates = [...sources.partners.values()]
        .filter((p) => p.records.some((record) => record.account === id))
        .map((p) => p.source);
      let rule: AccountMapping['decidedBy'] = 'rule:control-master-party';
      if (!candidates.length) {
        candidates = (
          options.saga?.partners.filter(
            (p) =>
              p.account === standard || p.account === id || p.account?.replaceAll('.', '') === id,
          ) ?? []
        ).map(addSagaPartner);
        rule = 'rule:control-saga-party';
      }
      candidates = distinctPartners(candidates, mapping.partners);
      let party: Extract<AccountMapping['target'], { status: 'mapped' }>['party'];
      if (candidates.length === 1) party = { kind: 'source', source: candidates[0]! };
      else if (candidates.length > 1) return unresolved('ACCOUNT_PARTNER_AMBIGUOUS');
      else {
        const key = `placeholder:${JSON.stringify([company, id])}`;
        party = { kind: 'placeholder', key };
        rule = 'rule:control-placeholder';
        if (!mapping.placeholders.some((p) => p.party.key === key))
          mapping.placeholders.push({
            decidedBy: rule,
            confirmedByPerson: false,
            placeholder: true,
            sourceAccountId: id,
            party: {
              action: 'create',
              key,
              kind: controlKind === 'employee.payable' ? 'ro_individual' : 'ro_legal_entity',
              country: 'RO',
              taxId: null,
              name: 'Partener neidentificat',
            },
          });
      }
      return {
        ...base,
        decidedBy: rule,
        target: {
          status: 'mapped',
          account: { kind: 'synthetic', code: syntheticCode, name: synthetic.name },
          party,
          requiresOpenItem: controlKind !== 'tax',
        },
      };
    };
    const proposed = decide();
    if (index === undefined) mapping.accounts.push(proposed);
    else mapping.accounts[index] = proposed;
  }
  // One creation key denotes one party even when it appears as both customer and supplier.
  const creations = new Map<string, PartyCreation>();
  for (const partner of mapping.partners)
    if (
      protectedPartners.has(partyKey(partner.source)) &&
      partner.target.status === 'mapped' &&
      partner.target.party.action === 'create'
    )
      creations.set(partner.target.party.key, partner.target.party);
  for (const partner of mapping.partners) {
    if (partner.target.status !== 'mapped' || partner.target.party.action !== 'create') continue;
    const target = partner.target.party;
    const existing = creations.get(target.key);
    if (
      existing &&
      !protectedPartners.has(partyKey(partner.source)) &&
      partner.decidedBy !== 'person' &&
      !partner.confirmedByPerson
    ) {
      if (
        existing.kind !== target.kind ||
        existing.country !== target.country ||
        existing.taxId !== target.taxId
      ) {
        partner.decidedBy = 'rule:unresolved';
        partner.target = { status: 'unresolved', reason: 'PARTNER_IDENTITY_CONFLICT' };
      } else partner.target.party = structuredClone(existing);
    } else creations.set(target.key, target);
  }
  return mappingSchema.parse(mapping);
}
