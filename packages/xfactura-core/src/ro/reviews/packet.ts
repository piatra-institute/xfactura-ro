import { canonical, hashOf, sha256Hex } from '../../hash';
import type { ParameterRegister, ParameterVersion } from '../../rules';
import { roRegister } from '../register';
import {
  clause as registeredClause,
  legalSources,
  type Clause,
  type LegalSource,
} from '../sources';
import { clauseAnchors } from './anchors';
import {
  keyAnnotations,
  reviewProfiles,
  type KeyAnnotation,
  type ReviewProfile,
} from './catalogue';
import { reviewSpecs } from './specs';
import {
  PACKET_FORMAT,
  type Anchor,
  type PacketItem,
  type ReviewPacket,
  type ReviewSpec,
} from './types';

/** Everything a packet is built from. The binding check rebuilds packets from the same. */
export interface ReviewContext {
  register: ParameterRegister;
  specs: ReadonlyMap<string, ReviewSpec>;
  annotations: Readonly<Record<string, KeyAnnotation>>;
  profiles: readonly ReviewProfile[];
  anchors: Readonly<Record<string, readonly Anchor[]>>;
  clause(id: string): Clause | undefined;
  source(id: string): LegalSource | undefined;
}

export function reviewContext(overrides: Partial<ReviewContext> = {}): ReviewContext {
  return {
    register: roRegister(),
    specs: new Map(reviewSpecs.map((spec) => [spec.key, spec])),
    annotations: keyAnnotations,
    profiles: reviewProfiles,
    anchors: clauseAnchors,
    clause: registeredClause,
    source: (id) => legalSources.find((source) => source.id === id),
    ...overrides,
  };
}

export class ReviewSpecMissing extends Error {
  constructor(readonly key: string) {
    super(`No review spec for ${key}: write its readings and cases in src/ro/reviews/specs.`);
  }
}

/** The versions of a key a new packet reviews: every one not withdrawn, by scope and date. */
export function versionsOf(register: ParameterRegister, key: string) {
  return register.versions
    .filter((version) => version.key === key && !version.withdrawn)
    .sort(
      (a, b) =>
        canonical(a.scope).localeCompare(canonical(b.scope)) || a.from.localeCompare(b.from),
    );
}

const versionEntry = (version: ParameterVersion) => ({
  id: version.id,
  scope: { ...version.scope },
  value: version.value,
  from: version.from,
  to: version.to,
  reviewedThrough: version.reviewedThrough,
  knowledgeDate: version.knowledgeDate,
  clauses: [...version.clauses],
});

/**
 * One parameter's part of a packet. `versionIds` rebuilds the versions a record reviewed (the
 * binding check); without it, every current version of the key. Throws ReviewSpecMissing.
 */
export function buildItem(
  context: ReviewContext,
  key: string,
  versionIds?: readonly string[],
): PacketItem {
  const spec = context.specs.get(key);
  if (!spec) throw new ReviewSpecMissing(key);
  const definition = context.register.definition(key);
  const versions = versionIds
    ? versionIds.flatMap((id) => {
        const version = context.register.versions.find(
          (item) => item.id === id && item.key === key && !item.withdrawn,
        );
        return version ? [version] : [];
      })
    : versionsOf(context.register, key);
  if (!versions.length) throw new Error(`${key} has no version to review.`);
  if (spec.cases.length < 3 || spec.cases.length > 5)
    throw new Error(`${key}: a review spec has three to five cases.`);

  const cited = [...new Set(versions.flatMap((version) => version.clauses))];
  const extra = spec.context.filter((id) => !cited.includes(id));
  const sources = [
    ...cited.map((id) => ({ id, role: 'cited' as const })),
    ...extra.map((id) => ({ id, role: 'context' as const })),
  ].map(({ id, role }) => {
    const item = context.clause(id);
    if (!item) throw new Error(`${key}: unknown clause ${id}.`);
    const source = context.source(item.source);
    if (!source) throw new Error(`${id}: unknown source ${item.source}.`);
    const anchors = context.anchors[id];
    return {
      clause: id,
      role,
      source: source.id,
      title: source.title,
      locator: item.locator,
      status: item.status,
      summary: item.summary,
      snapshots: source.snapshots.map((snapshot) => ({
        url: snapshot.url,
        sha256: snapshot.sha256,
      })),
      anchors: anchors ? anchors.map((anchor) => ({ ...anchor })) : null,
    };
  });

  const annotation = context.annotations[key];
  const profiles = (annotation?.reach?.profiles ?? []).map((id) => {
    const profile = context.profiles.find((item) => item.id === id);
    if (!profile) throw new Error(`${key}: unknown profile ${id}.`);
    return { id: profile.id, title: profile.title };
  });
  const gaps = [
    ...spec.gaps,
    ...sources
      .filter((item) => item.status === 'pending')
      .map(
        (item) =>
          `Clauza ${item.clause} (${item.locator}) nu a fost citită: sursa ${item.source} nu are text înregistrat.`,
      ),
    ...(profiles.length
      ? []
      : ['Profilurile afectate nu sunt adnotate în catalogul revizuirilor.']),
    ...(annotation?.obligations?.length
      ? []
      : ['Declarațiile care folosesc parametrul nu sunt adnotate în catalogul revizuirilor.']),
  ];

  return {
    key,
    description: definition.description,
    axis: definition.axis,
    versions: versions.map(versionEntry),
    sources,
    readings: { engine: spec.readings.engine, alternative: spec.readings.alternative },
    cases: spec.cases.map((item) => {
      const outcome = item.run(context.register);
      return {
        title: item.title,
        facts: item.facts,
        engine: outcome.engine,
        alternative: outcome.alternative,
      };
    }),
    question: {
      text: spec.question,
      options: {
        A: spec.readings.engine,
        B: spec.readings.alternative,
        C: 'Altă lectură: scrieți-o în câmpul de text de sub întrebare.',
      },
    },
    scope: { profiles, obligations: [...(annotation?.obligations ?? [])] },
    gaps,
  };
}

/** A packet's id names its content: the same items always make the same packet. */
export const packetIdOf = (items: readonly PacketItem[]) =>
  `RP-${sha256Hex(canonical(items)).slice(0, 12)}`;

export function packetOf(items: PacketItem[]): ReviewPacket {
  return { format: PACKET_FORMAT, id: packetIdOf(items), items };
}

/** A packet over the keys, in their order. */
export function buildPacket(context: ReviewContext, keys: readonly string[]): ReviewPacket {
  if (!keys.length) throw new Error('A packet reviews at least one parameter.');
  if (new Set(keys).size !== keys.length) throw new Error('A key appears twice in the packet.');
  return packetOf(keys.map((key) => buildItem(context, key)));
}

/** The packet's bytes as attached to the PDF (`packet.json`): its canonical JSON. */
export const packetJson = (packet: ReviewPacket) => canonical(packet);

/** The packet hash: SHA-256 of the canonical JSON, so the PDF around it may be regenerated. */
export const packetHash = (packet: ReviewPacket) => hashOf(packet);
