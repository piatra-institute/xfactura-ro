import type { D406Filed, D406FiledAccount, D406FiledParty } from 'xfactura-core/ro/saft/read';
import { partyKey, type PartyMapping, type PartySource } from './schema';

export type SagaDump = {
  accounts: { code: string; name?: string }[];
  partners: {
    source: PartySource;
    account?: string;
    saftId?: string;
    name?: string;
    country?: string;
    taxId?: string;
  }[];
};

export type Reference = {
  path: string;
} & ({ kind: 'account'; id?: string } | { kind: 'partner'; source: PartySource });
export type AccountUse = { path: string; id?: string; partners: PartySource[] };
export type SourceAccount = { records: D406FiledAccount[]; paths: string[] };
export type SourcePartner = { source: PartySource; records: D406FiledParty[]; paths: string[] };

/** Paths contain only schema properties and indices, never source identifiers. */
export function collectSources(filed: readonly D406Filed[]) {
  const accounts = new Map<string, SourceAccount>();
  const partners = new Map<string, SourcePartner>();
  const references: Reference[] = [];
  const uses: AccountUse[] = [];
  const missingIds: string[] = [];
  const accountRef = (id: string | undefined, path: string) => {
    references.push({ kind: 'account', id, path });
    if (id !== undefined && !accounts.has(id)) accounts.set(id, { records: [], paths: [path] });
  };
  const partnerRef = (
    role: PartySource['role'],
    id: string | undefined,
    path: string,
    required = false,
  ) => {
    if (id === undefined || (required && id === '0')) {
      missingIds.push(path);
      return undefined;
    }
    // SAF-T's 0 sentinel means that no partner is supplied; it is not an identity.
    if (id === '0') return undefined;
    const source: PartySource = { origin: 'd406', role, id };
    references.push({ kind: 'partner', source, path });
    if (!partners.has(partyKey(source)))
      partners.set(partyKey(source), { source, records: [], paths: [path] });
    return source;
  };
  const optionalPartners = (
    object: { customer?: string; supplier?: string },
    path: string,
    ownMarker: string | undefined,
  ): PartySource[] => {
    const result: PartySource[] = [];
    for (const role of ['customer', 'supplier'] as const) {
      if (object[role] === undefined || object[role] === ownMarker) continue;
      const source = partnerRef(role, object[role], `${path}.${role}`);
      if (source) result.push(source);
    }
    return result;
  };
  const use = (id: string | undefined, path: string, parties: PartySource[]) => {
    accountRef(id, `${path}.account`);
    uses.push({ id, path, partners: parties });
  };

  filed.forEach((file, f) => {
    const base = `filed.${f}`;
    const registration = file.header.company.registrationNumber
      ?.replace(/\s+/g, '')
      .replace(/^RO/i, '');
    const ownMarker = registration ? `00${registration}` : undefined;
    file.masterFiles.accounts.forEach((record, a) => {
      const path = `${base}.masterFiles.accounts.${a}`;
      if (!record.id) {
        missingIds.push(`${path}.id`);
        return;
      }
      const entry = accounts.get(record.id) ?? { records: [], paths: [] };
      entry.records.push(record);
      entry.paths.push(path);
      accounts.set(record.id, entry);
    });
    for (const role of ['customer', 'supplier'] as const) {
      file.masterFiles[`${role}s`].forEach((record, p) => {
        const path = `${base}.masterFiles.${role}s.${p}`;
        const source = partnerRef(role, record.id, `${path}.id`, true);
        if (source) partners.get(partyKey(source))!.records.push(record);
        if (record.account !== undefined) accountRef(record.account, `${path}.account`);
      });
    }
    file.generalLedgerEntries.journals.forEach((journal, j) =>
      journal.transactions.forEach((transaction, t) => {
        const path = `${base}.generalLedgerEntries.journals.${j}.transactions.${t}`;
        const parent = optionalPartners(transaction, path, ownMarker);
        transaction.lines.forEach((line, l) => {
          const lp = `${path}.lines.${l}`;
          const explicit = optionalPartners(line, lp, ownMarker);
          const declaresAbsence =
            (line.customer === '0' && line.supplier === '0') ||
            (ownMarker !== undefined &&
              (line.customer === ownMarker || line.supplier === ownMarker));
          // A real line identity wins across roles. SAGA's own marker describes no
          // counterparty on this line and must not inherit a transaction counterparty.
          use(line.account, lp, explicit.length || declaresAbsence ? explicit : parent);
        });
      }),
    );
    for (const section of ['salesInvoices', 'purchaseInvoices'] as const) {
      const role = section === 'salesInvoices' ? 'customer' : 'supplier';
      file.sourceDocuments[section]?.invoices.forEach((invoice, i) => {
        const path = `${base}.sourceDocuments.${section}.invoices.${i}`;
        const source = partnerRef(role, invoice.party?.id, `${path}.party.id`, true);
        const parties = source ? [source] : [];
        if (invoice.account !== undefined) use(invoice.account, path, parties);
        invoice.lines.forEach((line, l) => use(line.account, `${path}.lines.${l}`, parties));
      });
    }
    file.sourceDocuments.payments?.payments.forEach((payment, p) =>
      payment.lines.forEach((line, l) => {
        const path = `${base}.sourceDocuments.payments.payments.${p}.lines.${l}`;
        use(line.account, path, optionalPartners(line, path, ownMarker));
      }),
    );
    file.sourceDocuments.movementOfGoods?.movements.forEach((movement, m) =>
      movement.lines.forEach((line, l) => {
        const path = `${base}.sourceDocuments.movementOfGoods.movements.${m}.lines.${l}`;
        use(line.account, path, optionalPartners(line, path, ownMarker));
      }),
    );
    file.masterFiles.assets?.forEach((asset, a) => {
      const path = `${base}.masterFiles.assets.${a}`;
      if (asset.account !== undefined) accountRef(asset.account, `${path}.account`);
      if (asset.supplier?.id !== undefined)
        partnerRef('supplier', asset.supplier.id, `${path}.supplier.id`);
    });
    file.sourceDocuments.assetTransactions?.transactions.forEach((asset, a) => {
      if (asset.supplier?.id !== undefined)
        partnerRef(
          'supplier',
          asset.supplier.id,
          `${base}.sourceDocuments.assetTransactions.transactions.${a}.supplier.id`,
        );
    });
  });
  return { accounts, partners, references, uses, missingIds };
}

/** Two source roles can refer to one decided party; unresolved sources remain distinct. */
export function distinctPartners(
  partners: PartySource[],
  mappings: readonly PartyMapping[],
): PartySource[] {
  const bySource = new Map(mappings.map((p) => [partyKey(p.source), p]));
  const identities = new Map<string, PartySource>();
  for (const source of partners) {
    const target = bySource.get(partyKey(source))?.target;
    const identity =
      target?.status === 'mapped'
        ? target.party.action === 'existing'
          ? `existing:${target.party.id}`
          : `create:${target.party.key}`
        : `source:${partyKey(source)}`;
    if (!identities.has(identity)) identities.set(identity, source);
  }
  return [...identities.values()];
}
