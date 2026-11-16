import type { ControlKind } from 'xfactura-core/kernel';
import { controlKindOf } from 'xfactura-core/ro/chart';
import type { D406FiledTransaction, D406FiledTransactionLine } from 'xfactura-core/ro/saft/read';
import {
  partyKey,
  type Mapping,
  type PartyCreation,
  type PartySource,
  type AccountMapping as MappingEntry,
} from '../mapping/schema';
import type { AppliedAssumption } from './assumptions';

type Mapped = Extract<MappingEntry['target'], { status: 'mapped' }>;
export type PartyBinding = Mapped['party'];

/** A source account as the run posts it. */
export type AccountTarget = {
  sourceId: string;
  code: string;
  controlKind: ControlKind | null;
  party: PartyBinding;
  /** The analytic `accounts.create` makes before posting, if any. */
  create?: { code: string; name: string };
};

/** A party the run creates, under the key the mapping gives it. */
export type PartyToCreate = { key: string; party: PartyCreation };

export class ResolutionError extends Error {
  constructor(readonly code: string) {
    super(`${code}: Linia nu poate fi atribuită unui partener.`);
  }
}

/**
 * The effective mapping as the driver reads it: each source account's engine account and
 * partner binding, each source partner's party key, the parties to create, and which lab
 * assumption each account or party rests on. Party keys are `create:<key>` for a party the run
 * creates; the mapping proposer never names an existing party of a fresh replay engine.
 */
export class ReplayMapping {
  readonly source: string;
  readonly company: string;
  /** SAGA's own-company identifier on lines that name no counterparty. */
  readonly ownMarker: string;
  readonly parties: PartyToCreate[] = [];
  private readonly accounts = new Map<string, AccountTarget>();
  private readonly partners = new Map<string, string>();
  private readonly placeholderKeys = new Map<string, string>();
  private readonly bySourceAccount = new Map<string, string[]>();
  private readonly byEngineAccount = new Map<string, string[]>();
  private readonly byParty = new Map<string, string[]>();
  /** Placeholder acceptances by the engine account of the source account bound to them. */
  private readonly byPlaceholderAccount = new Map<string, string[]>();
  /** Assumptions about an account's mapping (accepted or targeted), not about a party. */
  private readonly accountAssumptionIds = new Set<string>();

  constructor(mapping: Mapping, applied: readonly AppliedAssumption[] = []) {
    this.source = mapping.source;
    this.company = mapping.company;
    this.ownMarker = `00${mapping.company}`;
    const created = new Set<string>();
    const create = (party: PartyCreation) => {
      if (created.has(party.key)) return;
      created.add(party.key);
      this.parties.push({ key: `create:${party.key}`, party });
    };
    for (const partner of mapping.partners) {
      if (partner.target.status !== 'mapped') continue;
      const target = partner.target.party;
      if (target.action === 'existing') continue;
      create(target);
      this.partners.set(partyKey(partner.source), `create:${target.key}`);
    }
    for (const placeholder of mapping.placeholders) {
      create(placeholder.party);
      this.placeholderKeys.set(placeholder.party.key, `create:${placeholder.party.key}`);
    }
    for (const entry of mapping.accounts) {
      if (entry.target.status !== 'mapped') continue;
      const account = entry.target.account;
      this.accounts.set(entry.sourceId, {
        sourceId: entry.sourceId,
        code: account.code,
        controlKind: controlKindOf(account.code),
        party: entry.target.party,
        ...(account.kind === 'analytic' && account.action === 'create'
          ? { create: { code: account.code, name: account.name } }
          : {}),
      });
    }
    const add = (map: Map<string, string[]>, key: string, id: string) =>
      map.set(key, [...(map.get(key) ?? []), id]);
    for (const assumption of applied) {
      if (assumption.kind === 'accept-partner') {
        const key = this.partners.get(partyKey(assumption.partner!));
        if (key) add(this.byParty, key, assumption.id);
        continue;
      }
      const sourceId = assumption.sourceAccountId!;
      if (assumption.kind === 'accept-placeholder') {
        const placeholder = mapping.placeholders.find((p) => p.sourceAccountId === sourceId);
        if (placeholder) add(this.byParty, `create:${placeholder.party.key}`, assumption.id);
        const bound = this.accounts.get(sourceId);
        if (bound) add(this.byPlaceholderAccount, bound.code, assumption.id);
        continue;
      }
      this.accountAssumptionIds.add(assumption.id);
      add(this.bySourceAccount, sourceId, assumption.id);
      const target = this.accounts.get(sourceId);
      if (target) add(this.byEngineAccount, target.code, assumption.id);
    }
  }

  account(sourceId: string | undefined): AccountTarget | undefined {
    return sourceId === undefined ? undefined : this.accounts.get(sourceId);
  }

  /** The comparators' view: a source account's engine account. */
  readonly engineAccount = (sourceId: string): string | undefined =>
    this.accounts.get(sourceId)?.code;

  /** Analytic accounts to create, each once, in mapping order. */
  analytics(): { code: string; name: string }[] {
    const seen = new Map<string, { code: string; name: string }>();
    for (const target of this.accounts.values())
      if (target.create && !seen.has(target.create.code))
        seen.set(target.create.code, target.create);
    return [...seen.values()];
  }

  partyOf(source: PartySource): string | undefined {
    return this.partners.get(partyKey(source));
  }

  placeholderParty(key: string): string | undefined {
    return this.placeholderKeys.get(key);
  }

  /** Whether a party key is one of the mapping's artificial placeholder parties. */
  isPlaceholderParty(key: string): boolean {
    return [...this.placeholderKeys.values()].includes(key);
  }

  /** The partners a line or transaction names, without SAF-T's 0 and the company's own mark. */
  private named(object: { customer?: string; supplier?: string }): PartySource[] {
    const result: PartySource[] = [];
    for (const role of ['customer', 'supplier'] as const) {
      const id = object[role];
      if (id === undefined || id === '0' || id === this.ownMarker) continue;
      result.push({ origin: 'd406', role, id });
    }
    return result;
  }

  /**
   * A control line's party: the line's own partner first (the transaction's when the line
   * names neither a partner nor the absence of one, as the mapping reads lines), then the
   * account's binding to a source partner or to its placeholder party.
   */
  lineParty(
    transaction: D406FiledTransaction,
    line: D406FiledTransactionLine,
    target: AccountTarget,
  ): string {
    const explicit = this.named(line);
    const absent =
      (line.customer === '0' && line.supplier === '0') ||
      line.customer === this.ownMarker ||
      line.supplier === this.ownMarker;
    const sources = explicit.length || absent ? explicit : this.named(transaction);
    const keys = new Set<string>();
    for (const source of sources) {
      const key = this.partyOf(source);
      if (!key) throw new ResolutionError('PARTNER_UNMAPPED');
      keys.add(key);
    }
    if (keys.size > 1) throw new ResolutionError('LINE_PARTNER_AMBIGUOUS');
    if (keys.size === 1) return [...keys][0]!;
    const binding = target.party;
    if (binding?.kind === 'source') {
      const key = this.partyOf(binding.source);
      if (key) return key;
      throw new ResolutionError('PARTNER_UNMAPPED');
    }
    if (binding?.kind === 'placeholder') {
      const key = this.placeholderParty(binding.key);
      if (key) return key;
    }
    throw new ResolutionError('LINE_PARTNER_MISSING');
  }

  /** Assumptions behind a source account's mapping. */
  sourceAccountAssumptions(sourceId: string): string[] {
    return this.bySourceAccount.get(sourceId) ?? [];
  }

  /** Assumptions behind an engine account's mapping. */
  engineAccountAssumptions(code: string): string[] {
    return this.byEngineAccount.get(code) ?? [];
  }

  /** Placeholder acceptances behind the party of an engine account's items. */
  placeholderAccountAssumptions(code: string): string[] {
    return this.byPlaceholderAccount.get(code) ?? [];
  }

  /** Whether an assumption concerns an account's mapping rather than a party. */
  isAccountAssumption(id: string): boolean {
    return this.accountAssumptionIds.has(id);
  }

  /** Assumptions behind a party key. */
  partyAssumptions(key: string): string[] {
    return this.byParty.get(key) ?? [];
  }
}
