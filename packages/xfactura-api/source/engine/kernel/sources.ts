import { and, asc, eq, inArray, ne, or } from 'drizzle-orm';
import { hashOf } from 'xfactura-core/hash';
import type { Issue, ReadSetEntry } from 'xfactura-core/kernel';
import type { DocumentCheck } from 'xfactura-core/documents/checks';
import type { Transaction } from '../db/database';
import { documentLinks, documents } from '../db/schema';

/*
 * Where documents come from, and which are copies of one another. The same invoice may arrive as
 * a PDF an agent read and later from e-Factura: the copies form a group whose root is the
 * earliest recorded, and a proposal recognizing any of them takes the root as its subject, so
 * that the invoice is booked once (and the database refuses otherwise: `identity_taken`).
 */

/** Links that make a document a member of a group: the engine's, between documents of the same
 * identity, and a person's, between near matches (`documents.link`). */
export const groupLinkKinds = ['same_as', 'same_as_confirmed'] as const;

/** The root of a document's group: the document it joined, or itself. */
export async function rootOf(tx: Transaction, companyId: string, documentId: string) {
  const [link] = await tx
    .select({ toId: documentLinks.toId })
    .from(documentLinks)
    .where(
      and(
        eq(documentLinks.companyId, companyId),
        eq(documentLinks.fromId, documentId),
        inArray(documentLinks.kind, [...groupLinkKinds]),
      ),
    );
  return link?.toId ?? documentId;
}

/**
 * Joins a newly recorded document to the group of the earliest document with its identity, by a
 * `same_as` link to that group's root. Returns the root, or null when the document has no
 * identity or is the first of it.
 */
export async function joinIdentityGroup(
  tx: Transaction,
  actor: { companyId: string; actorId: string },
  document: { id: string; identityKey: string | null },
) {
  if (!document.identityKey) return null;
  const [earliest] = await tx
    .select({ id: documents.id })
    .from(documents)
    .where(
      and(
        eq(documents.companyId, actor.companyId),
        eq(documents.identityKey, document.identityKey),
        ne(documents.id, document.id),
      ),
    )
    .orderBy(asc(documents.createdAt), asc(documents.id))
    .limit(1);
  if (!earliest) return null;
  const root = await rootOf(tx, actor.companyId, earliest.id);
  await tx.insert(documentLinks).values({
    companyId: actor.companyId,
    fromId: document.id,
    toId: root,
    kind: 'same_as',
    createdBy: actor.actorId,
  });
  return root;
}

/** A document's place among its copies: its group's root and members, and what superseded it. */
export interface DocumentPlace {
  id: string;
  /** The group's root (itself when it has members); null outside any group. */
  rootId: string | null;
  members: { id: string; authority: string | null; link: string }[];
  supersededBy: string | null;
  supersedes: string | null;
}

/** Above this many documents, `placesOf` reads the company's links whole rather than by id. */
const placesById = 200;

/** The places of the given documents, from the company's group and supersede links. */
export async function placesOf(
  tx: Transaction,
  companyId: string,
  ids: string[],
): Promise<Map<string, DocumentPlace>> {
  const places = new Map<string, DocumentPlace>();
  if (!ids.length) return places;
  const few = ids.length <= placesById;
  const groupKinds = [...groupLinkKinds] as string[];
  const ofGroups = and(
    eq(documentLinks.companyId, companyId),
    inArray(documentLinks.kind, groupKinds),
  );
  const direct = await tx
    .select()
    .from(documentLinks)
    .where(
      and(
        eq(documentLinks.companyId, companyId),
        inArray(documentLinks.kind, [...groupKinds, 'supersedes']),
        few ? or(inArray(documentLinks.fromId, ids), inArray(documentLinks.toId, ids)) : undefined,
      ),
    );
  const joined = new Map<string, string>();
  const leading = new Set<string>();
  const supersededBy = new Map<string, string>();
  const supersedes = new Map<string, string>();
  for (const link of direct)
    if (groupKinds.includes(link.kind)) {
      joined.set(link.fromId, link.toId);
      leading.add(link.toId);
    } else {
      supersededBy.set(link.toId, link.fromId);
      supersedes.set(link.fromId, link.toId);
    }
  const roots = new Map<string, string>();
  for (const id of ids) {
    const rootId = joined.get(id) ?? (leading.has(id) ? id : undefined);
    if (rootId) roots.set(id, rootId);
  }
  const rootIds = [...new Set(roots.values())];
  // The members of those groups: read by root for a few documents, already read otherwise.
  const memberLinks = !rootIds.length
    ? []
    : few
      ? await tx
          .select()
          .from(documentLinks)
          .where(and(ofGroups, inArray(documentLinks.toId, rootIds)))
      : direct.filter((link) => groupKinds.includes(link.kind));
  const membersOf = new Map<string, typeof memberLinks>();
  for (const link of memberLinks)
    membersOf.set(link.toId, [...(membersOf.get(link.toId) ?? []), link]);
  const memberIds = [...new Set([...rootIds, ...memberLinks.map((link) => link.fromId)])];
  const authorities = new Map(
    (!memberIds.length
      ? []
      : await tx
          .select({ id: documents.id, authority: documents.authority })
          .from(documents)
          .where(
            and(
              eq(documents.companyId, companyId),
              memberIds.length <= placesById
                ? inArray(documents.id, memberIds)
                : or(
                    inArray(
                      documents.id,
                      tx.select({ id: documentLinks.fromId }).from(documentLinks).where(ofGroups),
                    ),
                    inArray(
                      documents.id,
                      tx.select({ id: documentLinks.toId }).from(documentLinks).where(ofGroups),
                    ),
                  ),
            ),
          )
    ).map((row) => [row.id, row.authority]),
  );
  for (const id of ids) {
    const rootId = roots.get(id) ?? null;
    places.set(id, {
      id,
      rootId,
      members: rootId
        ? [
            { id: rootId, authority: authorities.get(rootId) ?? null, link: 'root' },
            ...(membersOf.get(rootId) ?? [])
              .map((link) => ({
                id: link.fromId,
                authority: authorities.get(link.fromId) ?? null,
                link: link.kind,
              }))
              .sort((a, b) => (a.id < b.id ? -1 : 1)),
          ]
        : [],
      supersededBy: supersededBy.get(id) ?? null,
      supersedes: supersedes.get(id) ?? null,
    });
  }
  return places;
}

/** Sources outranking an extraction, an upload or the invoicer's copy of the same invoice. */
const authoritative = ['efactura'];

/**
 * What a proposal must know about the sources of the documents it reads, as issues, and the
 * read-set entries that make it stale when they change:
 * - an extracted document: `SOURCE_EXTRACTED`, to acknowledge, naming its failed and unverified
 *   checks; `SOURCE_INCONSISTENT`, blocking, when its amounts do not add up;
 * - a superseded document: `DOCUMENT_SUPERSEDED`, blocking: revise onto its correction;
 * - a group holding an e-Factura copy the proposal does not read: `BETTER_SOURCE`, to
 *   acknowledge, suggesting a revision onto it.
 */
export async function sourceReview(
  tx: Transaction,
  companyId: string,
  ids: string[],
): Promise<{ issues: Issue[]; readSet: ReadSetEntry[] }> {
  const issues: Issue[] = [];
  const readSet: ReadSetEntry[] = [];
  if (!ids.length) return { issues, readSet };
  const rows = await tx
    .select({
      id: documents.id,
      number: documents.number,
      authority: documents.authority,
      checks: documents.checks,
    })
    .from(documents)
    .where(and(eq(documents.companyId, companyId), inArray(documents.id, ids)))
    .orderBy(asc(documents.id));
  const places = await placesOf(tx, companyId, ids);
  for (const row of rows) {
    const place = places.get(row.id)!;
    const extracted = row.authority === 'extracted';
    const named = row.number ? `${row.number}` : row.id;
    if (place.supersededBy)
      issues.push({
        code: 'DOCUMENT_SUPERSEDED',
        severity: 'block',
        message: `Documentul ${named} a fost înlocuit de o extragere corectată: revizuiți propunerea pe documentul ${place.supersededBy}.`,
        details: { documentId: row.id, supersededBy: place.supersededBy },
      });
    if (extracted) {
      const checks = (row.checks ? JSON.parse(row.checks) : []) as DocumentCheck[];
      const inconsistent = checks.filter((check) => check.blocking && check.status === 'failed');
      if (inconsistent.length)
        issues.push({
          code: 'SOURCE_INCONSISTENT',
          severity: 'block',
          message: `Sumele documentului extras ${named} nu se reconciliază (${inconsistent.map((check) => check.code).join(', ')}): înlocuiți-l cu o extragere corectă (documents.supersede).`,
          details: { documentId: row.id, failed: inconsistent.map((check) => check.code) },
        });
      const failed = checks.filter((check) => check.status === 'failed').map((check) => check.code);
      const unverified = checks
        .filter((check) => check.status === 'unverified')
        .map((check) => check.code);
      issues.push({
        code: 'SOURCE_EXTRACTED',
        severity: 'ack',
        message: [
          `Documentul ${named} a fost citit de un agent dintr-un PDF sau o fotografie: confirmați câmpurile față de original.`,
          failed.length ? `Verificări nereușite: ${failed.join(', ')}.` : '',
          unverified.length ? `Verificări nefăcute: ${unverified.join(', ')}.` : '',
        ]
          .filter(Boolean)
          .join(' '),
        details: { documentId: row.id, failed, unverified },
      });
    }
    const better = place.members.find(
      (member) =>
        member.id !== row.id &&
        authoritative.includes(member.authority ?? '') &&
        !authoritative.includes(row.authority ?? '') &&
        row.authority !== 'issued',
    );
    if (better)
      issues.push({
        code: 'BETTER_SOURCE',
        severity: 'ack',
        message: `Documentul ${named} există și din e-Factura (${better.id}): revizuiți propunerea pe documentul e-Factura.`,
        details: { documentId: row.id, better: better.id, authority: better.authority },
      });
    if (extracted || place.rootId || place.supersededBy)
      readSet.push({
        kind: 'documentSource',
        id: row.id,
        version: hashOf({
          authority: row.authority,
          rootId: place.rootId,
          members: place.members.map((member) => [member.id, member.authority]),
          supersededBy: place.supersededBy,
        }),
      });
  }
  return { issues, readSet };
}
