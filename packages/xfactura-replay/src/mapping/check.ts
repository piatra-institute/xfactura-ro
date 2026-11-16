import { controlKindOf } from 'xfactura-core/ro/chart';
import type { D406Filed } from 'xfactura-core/ro/saft/read';
import { mappingSchema, partyKey, type Mapping, type PartySource } from './schema';
import { collectSources, distinctPartners } from './sources';
import { filedCompany } from './propose';
import { normalizeFiscalCode } from './partners';

export type MappingProblem = { code: string; path: string };

/** A blocker never contains a source value; it is safe to print with a schema path. */
export function checkMapping(mapping: Mapping, filed: readonly D406Filed[]): MappingProblem[] {
  const problems: MappingProblem[] = [];
  const push = (code: string, path: string) => problems.push({ code, path });
  const parsed = mappingSchema.safeParse(mapping);
  if (!parsed.success)
    return parsed.error.issues.map((issue) => ({
      code: 'MAPPING_SCHEMA',
      path: issue.path.join('.'),
    }));
  try {
    if (filedCompany(filed) !== mapping.company) push('MAPPING_COMPANY_MISMATCH', 'company');
  } catch {
    push('MAPPING_COMPANY_MISMATCH', 'company');
  }
  const sources = collectSources(filed);
  for (const path of sources.missingIds) push('SOURCE_ID_MISSING', path);
  const accountById = new Map<string, Mapping['accounts'][number]>();
  const partnerByKey = new Map<string, Mapping['partners'][number]>();
  const placeholderByKey = new Map<string, Mapping['placeholders'][number]>();
  const engineKinds = new Map<string, string | null>();
  const creationByKey = new Map<
    string,
    { kind: string; country: string; taxId: string | null; name: string }
  >();
  const creationByFiscal = new Map<string, string>();
  const checkCreation = (party: Mapping['placeholders'][number]['party'], path: string) => {
    const previous = creationByKey.get(party.key);
    const { kind, country, taxId, name } = party;
    if (previous && JSON.stringify(previous) !== JSON.stringify({ kind, country, taxId, name }))
      push('PARTY_CREATION_CONFLICT', path);
    creationByKey.set(party.key, { kind, country, taxId, name });
    if (taxId) {
      const identity = JSON.stringify([country, normalizeFiscalCode(taxId, country)]);
      const key = creationByFiscal.get(identity);
      if (key && key !== party.key) push('PARTY_CREATION_DUPLICATE', path);
      creationByFiscal.set(identity, party.key);
    }
  };
  mapping.partners.forEach((partner, i) => {
    const path = `partners.${i}`;
    const key = partyKey(partner.source);
    if (partnerByKey.has(key)) push('PARTNER_MAPPED_TWICE', path);
    partnerByKey.set(key, partner);
    if (partner.target.status === 'unresolved') push(partner.target.reason, `${path}.target`);
    else if (partner.target.party.action === 'create')
      checkCreation(partner.target.party, `${path}.target.party`);
    if (partner.decidedBy === 'person' && !partner.confirmedByPerson)
      push('PERSON_DECISION_UNCONFIRMED', path);
  });
  const resolvedPartner = (source: PartySource, path: string) => {
    const partner = partnerByKey.get(partyKey(source));
    if (!partner) push('PARTNER_UNMAPPED', path);
    else if (partner.target.status === 'unresolved') push('PARTNER_UNRESOLVED', path);
  };
  mapping.placeholders.forEach((placeholder, i) => {
    const path = `placeholders.${i}`;
    if (placeholderByKey.has(placeholder.party.key)) push('PLACEHOLDER_MAPPED_TWICE', path);
    placeholderByKey.set(placeholder.party.key, placeholder);
    if (
      mapping.placeholders.some(
        (p, j) => j < i && p.sourceAccountId === placeholder.sourceAccountId,
      )
    )
      push('PLACEHOLDER_ACCOUNT_DUPLICATE', path);
    if (!placeholder.confirmedByPerson) push('PLACEHOLDER_UNCONFIRMED', path);
    if (placeholder.party.taxId !== null) push('PLACEHOLDER_HAS_FISCAL_CODE', path);
    checkCreation(placeholder.party, `${path}.party`);
  });
  mapping.accounts.forEach((account, i) => {
    const path = `accounts.${i}`;
    if (accountById.has(account.sourceId)) push('ACCOUNT_MAPPED_TWICE', path);
    accountById.set(account.sourceId, account);
    if (account.decidedBy === 'person' && !account.confirmedByPerson)
      push('PERSON_DECISION_UNCONFIRMED', path);
    if (account.target.status === 'unresolved') {
      push(account.target.reason, `${path}.target`);
      return;
    }
    const target = account.target;
    const standards =
      sources.accounts
        .get(account.sourceId)
        ?.records.map((a) => a.standard)
        .filter((s): s is string => !!s) ?? [];
    const knownKinds = new Set(standards.map(controlKindOf));
    const expected = standards.length ? controlKindOf(standards[0]!) : account.controlKind;
    if (knownKinds.size > 1 || expected !== account.controlKind)
      push('SOURCE_CONTROL_KIND_CHANGED', path);
    if (account.standardId && standards.some((s) => s !== account.standardId))
      push('SOURCE_ACCOUNT_CHANGED', `${path}.standardId`);
    if (engineKinds.has(target.account.code) && engineKinds.get(target.account.code) !== expected)
      push('ACCOUNT_CONTROL_KIND_COLLISION', `${path}.target.account`);
    engineKinds.set(target.account.code, expected);
    if (controlKindOf(target.account.code) !== expected)
      push('ACCOUNT_CONTROL_KIND_MISMATCH', `${path}.target.account`);
    if ((target.account.kind === 'synthetic') === target.account.code.includes('.'))
      push('ACCOUNT_TARGET_KIND_MISMATCH', `${path}.target.account`);
    if (expected && target.account.kind === 'analytic')
      push('CONTROL_ANALYTIC_FORBIDDEN', `${path}.target.account`);
    if (target.requiresOpenItem !== (expected !== null && expected !== 'tax'))
      push('ACCOUNT_OPEN_ITEM_REQUIREMENT', `${path}.target.requiresOpenItem`);
    if (expected && !target.party) push('CONTROL_PARTNER_MISSING', `${path}.target.party`);
    if (target.party?.kind === 'source')
      resolvedPartner(target.party.source, `${path}.target.party`);
    if (target.party?.kind === 'placeholder') {
      const placeholder = placeholderByKey.get(target.party.key);
      if (!placeholder || placeholder.sourceAccountId !== account.sourceId)
        push('PLACEHOLDER_ACCOUNT_MISMATCH', `${path}.target.party`);
    }
  });
  for (const [id, input] of sources.accounts)
    if (!accountById.has(id)) push('ACCOUNT_UNMAPPED', input.paths[0]!);
  for (const partner of sources.partners.values())
    if (!partnerByKey.has(partyKey(partner.source))) push('PARTNER_UNMAPPED', partner.paths[0]!);
  for (const reference of sources.references) {
    if (reference.kind === 'account') {
      const account = reference.id !== undefined ? accountById.get(reference.id) : undefined;
      if (!account) push('ACCOUNT_UNMAPPED', reference.path);
      else if (account.target.status === 'unresolved') push('ACCOUNT_UNRESOLVED', reference.path);
    } else resolvedPartner(reference.source, reference.path);
  }
  for (const use of sources.uses) {
    const account = use.id !== undefined ? accountById.get(use.id) : undefined;
    if (!account?.controlKind) continue;
    const binding = account.target.status === 'mapped' ? account.target.party : undefined;
    const explicit = distinctPartners(use.partners, mapping.partners);
    if (explicit.length > 1) push('LINE_PARTNER_AMBIGUOUS', use.path);
    else if (!explicit.length && binding?.kind === 'line') push('LINE_PARTNER_MISSING', use.path);
  }
  return [...new Map(problems.map((p) => [`${p.code}:${p.path}`, p])).values()];
}
