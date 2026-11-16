import type { PartyRecord } from 'xfactura-core/kernel';
import type { D406FiledParty } from 'xfactura-core/ro/saft/read';
import { euVatPrefixes } from 'xfactura-core/ro/geo';
import { isValidCnp } from 'xfactura-core/ro/identifiers';
import { comparePaths } from '../corpus/files';
import {
  partyKey,
  type PartyCreation,
  type PartyMapping,
  type PartySource,
  type UnresolvedReason,
} from './schema';

/** Country scopes the identifier; VAT prefixes and whitespace do not change its identity. */
export function normalizeFiscalCode(code: string, country: string): string {
  const compact = code.replace(/\s+/g, '').toUpperCase();
  const prefix = euVatPrefixes[country];
  return prefix && compact.startsWith(prefix) ? compact.slice(prefix.length) : compact;
}

type Identity = Pick<PartyCreation, 'kind' | 'country' | 'taxId'>;

function identity(record: D406FiledParty): Identity | UnresolvedReason {
  const id = record.id ?? '';
  const prefix = id.slice(0, 2);
  const encoded = /^(00|01|02|03|04|05|06|08|09)/.test(id);
  const sourceCountry =
    record.address?.country?.trim().toUpperCase() ||
    (['01', '02', '05', '06'].includes(prefix)
      ? id.slice(2, 4)
      : ['00', '04', '08'].includes(prefix)
        ? 'RO'
        : undefined);
  const country = sourceCountry === 'EL' ? 'GR' : sourceCountry;
  if (!country || !/^[A-Z]{2}$/.test(country)) return 'PARTNER_COUNTRY_MISSING';
  const encodedCountry = ['01', '02', '05', '06'].includes(prefix)
    ? id.slice(2, 4)
    : prefix === '00'
      ? 'RO'
      : undefined;
  if (encodedCountry && encodedCountry !== (country === 'GR' ? 'EL' : country))
    return 'PARTNER_IDENTITY_CONFLICT';
  let code = record.registrationNumber?.trim();
  if (!code && ['00', '01', '02', '03', '09'].includes(prefix)) code = id;
  // A filed RegistrationNumber can itself be SAF-T's coded identity, including an internal
  // code for a partner declaring no fiscal identifier. Internal codes are never tax IDs.
  if (code === id && encoded) {
    code = ['00', '03', '09'].includes(prefix)
      ? id.slice(2)
      : ['01', '02'].includes(prefix)
        ? id.slice(4)
        : undefined;
  }
  const taxId = code ? normalizeFiscalCode(code, country) : null;
  const declaredCode = ['00', '03', '09'].includes(prefix)
    ? id.slice(2)
    : ['01', '02'].includes(prefix)
      ? id.slice(4)
      : undefined;
  if (declaredCode && taxId !== normalizeFiscalCode(declaredCode, country))
    return 'PARTNER_IDENTITY_CONFLICT';
  if (['03', '09'].includes(prefix) && taxId !== null && !isValidCnp(taxId))
    return 'PARTNER_PARTIES_CREATE_REQUIRES_CNP';
  const kind =
    ['03', '04', '08', '09'].includes(prefix) && country === 'RO'
      ? 'ro_individual'
      : prefix === '01'
        ? 'eu_taxable'
        : ['02', '06'].includes(prefix)
          ? 'non_eu'
          : country === 'RO' && taxId && /^\d{2,10}$/.test(taxId)
            ? 'ro_legal_entity'
            : undefined;
  // In particular, the engine's eu_taxable kind cannot stand for a SAF-T 05 non-VAT entity.
  if (!kind || (!taxId && code !== undefined)) return 'PARTNER_KIND_UNSUPPORTED';
  if (kind === 'ro_individual' && taxId !== null && !isValidCnp(taxId))
    return 'PARTNER_PARTIES_CREATE_REQUIRES_CNP';
  return { kind, country, taxId };
}

export function proposePartner(
  source: PartySource,
  records: D406FiledParty[],
  parties: readonly PartyRecord[],
): PartyMapping {
  const base = { source, confirmedByPerson: false };
  const unresolved = (reason: UnresolvedReason): PartyMapping => ({
    ...base,
    decidedBy: 'rule:unresolved',
    target: { status: 'unresolved', reason },
  });
  if (!records.length) return unresolved('PARTNER_MASTER_MISSING');
  const identities = records.map(identity);
  const gaps = identities.filter((value): value is UnresolvedReason => typeof value === 'string');
  if (gaps.length) return unresolved(gaps.sort(comparePaths)[0]!);
  const known = identities as Identity[];
  if (new Set(known.map((value) => JSON.stringify(value))).size !== 1)
    return unresolved('PARTNER_IDENTITY_CONFLICT');
  const value = known[0]!;
  if (value.taxId) {
    const matches = parties.filter(
      (party) =>
        party.country.toUpperCase() === value.country &&
        party.taxId !== null &&
        normalizeFiscalCode(party.taxId, value.country) === value.taxId,
    );
    const ids = [...new Set(matches.map((p) => p.id))];
    if (ids.length > 1) return unresolved('PARTNER_FISCAL_CODE_AMBIGUOUS');
    if (ids.length === 1)
      return {
        ...base,
        decidedBy: 'rule:partner-fiscal-match',
        target: { status: 'mapped', party: { action: 'existing', id: ids[0]! } },
      };
    if (
      value.kind === 'ro_individual' &&
      parties.some(
        (party) =>
          party.kind === 'ro_individual' &&
          party.country === value.country &&
          party.taxId !== null &&
          /^(cnp:|\*+$)/i.test(party.taxId),
      )
    )
      return unresolved('PARTNER_FISCAL_CODE_OPAQUE');
  }
  const name = records
    .map((r) => r.name?.trim())
    .filter((s): s is string => !!s)
    .sort(comparePaths)[0];
  if (!name || name.length > 300) return unresolved('PARTNER_NAME_MISSING');
  return {
    ...base,
    decidedBy: value.taxId ? 'rule:partner-fiscal-create' : 'rule:partner-source-id',
    target: {
      status: 'mapped',
      party: {
        action: 'create',
        key: value.taxId ? `fiscal:${value.country}:${value.taxId}` : `source:${partyKey(source)}`,
        ...value,
        name,
      },
    },
  };
}
