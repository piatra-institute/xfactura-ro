import { createHash, createHmac, hkdfSync } from 'node:crypto';
import type { Client } from '@libsql/client';
import { isValidCnp } from 'xfactura-core/ro/identifiers';

/*
 * How an individual is a party's identifier. A CNP is never stored as one, nor an unkeyed hash of
 * it: with a birth date known, the hash of a CNP is found in milliseconds. The identifier is an
 * HMAC of the CNP's SHA-256 under a key derived from the installation's secret for the company,
 * as the Sealer derives its keys: deterministic, so the same person is one party (an employee
 * who buys from the company), and worthless without the secret.
 */

/** The prefix of an individual's keyed identifier (`acc_parties.tax_id`). */
export const keyedCnpPrefix = 'cnp:k1:';
/** An identifier of the earlier, unkeyed form: `cnp:` and the CNP's SHA-256. */
const legacyCnp = /^cnp:[0-9a-f]{64}$/;

const digest = (cnp: string) => createHash('sha256').update(cnp, 'utf8').digest('hex');

export class PartyIdentities {
  private readonly key: Buffer;

  constructor(secret: string) {
    this.key = Buffer.from(hkdfSync('sha256', secret, 'xfactura', 'party identity v1', 32));
  }

  /** The identifier of a digest (the CNP's SHA-256, hex) for a company. */
  private keyed(companyId: string, hex: string) {
    const companyKey = createHmac('sha256', this.key).update(companyId, 'utf8').digest();
    return `${keyedCnpPrefix}${createHmac('sha256', companyKey).update(hex, 'utf8').digest('hex')}`;
  }

  /** An individual's identifier, from their CNP. */
  ofCnp(companyId: string, cnp: string) {
    return this.keyed(companyId, digest(cnp.trim()));
  }

  /** The identifier an earlier one becomes: from `cnp:<sha256>`, or from a CNP kept as such. */
  rekeyed(companyId: string, taxId: string): string | null {
    if (legacyCnp.test(taxId)) return this.keyed(companyId, taxId.slice(4));
    if (isValidCnp(taxId)) return this.ofCnp(companyId, taxId);
    return null;
  }
}

/**
 * The data step of migration 0031 (`personal_data`): every individual's identifier of the
 * earlier forms (an unkeyed `cnp:<sha256>`, or a CNP an individual was created with) is replaced
 * by its keyed form. A Romanian partner of another kind known by a CNP (the seller of a received
 * e-Factura invoice, recorded as a company under the CNP in clear, before 5 November 2026) becomes
 * the individual it is; when the company already knows that individual, the copy keeps no
 * identifier rather than the CNP. Run after the migrations, before the invariants are installed
 * again: the append-only guard of `acc_parties` is dropped in the same transaction and restored by
 * `ensureInvariants`. Idempotent; a database holding such identifiers needs the secret.
 */
export async function rekeyIndividuals(client: Client, secret: string | undefined) {
  const rows = (
    await client.execute(
      `SELECT company_id, id, kind, tax_id FROM acc_parties
       WHERE tax_id IS NOT NULL AND tax_id NOT LIKE '${keyedCnpPrefix}%'
         AND (tax_id GLOB 'cnp:*' OR (kind = 'ro_individual' AND length(tax_id) = 13)
           OR (country = 'RO' AND length(tax_id) IN (13, 15)))`,
    )
  ).rows
    .map((row) => ({
      companyId: String(row.company_id),
      id: String(row.id),
      kind: String(row.kind),
      taxId: String(row.tax_id).replace(/^RO/i, ''),
    }))
    .filter((row) => legacyCnp.test(row.taxId) || isValidCnp(row.taxId));
  if (!rows.length) return 0;
  if (!secret)
    throw new Error(
      "Individual partners have unkeyed identifiers: run the migration with the installation's ACCOUNTING_AUTH_SECRET.",
    );
  const identities = new PartyIdentities(secret);
  const transaction = await client.transaction('write');
  try {
    await transaction.execute('DROP TRIGGER IF EXISTS inv_acc_parties_no_update');
    // Individuals first, so that a company copy of one of them finds it keyed.
    const assigned = new Set<string>();
    for (const row of rows.sort(
      (a, b) => Number(b.kind === 'ro_individual') - Number(a.kind === 'ro_individual'),
    )) {
      const keyed = identities.rekeyed(row.companyId, row.taxId);
      const known =
        row.kind !== 'ro_individual' &&
        (assigned.has(`${row.companyId}/${keyed}`) ||
          (
            await transaction.execute({
              sql: `SELECT 1 FROM acc_parties WHERE company_id = ? AND country = 'RO' AND tax_id = ?`,
              args: [row.companyId, keyed],
            })
          ).rows.length > 0);
      if (!known) assigned.add(`${row.companyId}/${keyed}`);
      await transaction.execute({
        sql: `UPDATE acc_parties SET kind = 'ro_individual', tax_id = ? WHERE company_id = ? AND id = ?`,
        args: [known ? null : keyed, row.companyId, row.id],
      });
    }
    await transaction.commit();
    return rows.length;
  } catch (error) {
    await transaction.rollback();
    throw error;
  } finally {
    transaction.close();
  }
}
