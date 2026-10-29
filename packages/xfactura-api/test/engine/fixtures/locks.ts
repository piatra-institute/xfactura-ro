import { randomUUID } from 'node:crypto';
import type { Database } from '../../../source/engine/db/database';
import {
  artifactEvents,
  artifacts,
  evidence,
  taxPeriodEvents,
} from '../../../source/engine/db/schema';

/** A declaration of `tax` for `period` taken to authorized, as a filing would. */
export async function authorizedDeclaration(
  db: Database,
  companyId: string,
  userId: string,
  tax: string,
  period: string,
) {
  const evidenceId = randomUUID();
  const artifactId = randomUUID();
  const hash = randomUUID().replace(/-/g, '').padEnd(64, '0');
  await db.write(async (tx) => {
    await tx.insert(evidence).values({
      id: evidenceId,
      companyId,
      hash,
      filename: `D300-${period}.xml`,
      mediaType: 'application/xml',
      size: 1,
      createdBy: userId,
    });
    await tx.insert(artifacts).values({
      id: artifactId,
      companyId,
      kind: 'D300',
      period,
      tax,
      format: 'test',
      inputHash: 'test',
      evidenceId,
      xmlHash: hash,
      createdBy: userId,
    });
    await tx.insert(artifactEvents).values(
      (['prepared', 'validated_official', 'authorized'] as const).map((state, index) => ({
        companyId,
        artifactId,
        seq: index + 1,
        state,
        createdBy: userId,
      })),
    );
  });
  return artifactId;
}

/** Locks a tax period the only way the database allows: in the name of an authorized return. */
export async function lockTaxPeriod(
  db: Database,
  companyId: string,
  userId: string,
  tax: string,
  period: string,
) {
  const artifactId = await authorizedDeclaration(db, companyId, userId, tax, period);
  await db.write((tx) =>
    tx.insert(taxPeriodEvents).values({
      companyId,
      tax,
      period,
      seq: 1,
      kind: 'lock',
      reference: artifactId,
      createdBy: userId,
    }),
  );
  return artifactId;
}
