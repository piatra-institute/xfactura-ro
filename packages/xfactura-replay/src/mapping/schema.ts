import { z } from 'zod';
import { accountCodePattern, openItemKinds } from 'xfactura-core/kernel';

export const partyKinds = [
  'ro_legal_entity',
  'ro_individual_enterprise',
  'ro_individual',
  'ro_public_institution',
  'eu_taxable',
  'non_eu',
] as const;

export const partySourceSchema = z.strictObject({
  origin: z.enum(['d406', 'saga']),
  role: z.enum(['customer', 'supplier']),
  id: z.string().min(1),
});
export type PartySource = z.infer<typeof partySourceSchema>;
export const partyKey = (source: PartySource): string =>
  JSON.stringify([source.origin, source.role, source.id]);

export const decisionNames = [
  'person',
  'rule:unresolved',
  'rule:account-synthetic',
  'rule:account-analytic',
  'rule:control-master-party',
  'rule:control-saga-party',
  'rule:control-line-party',
  'rule:control-placeholder',
  'rule:partner-fiscal-match',
  'rule:partner-fiscal-create',
  'rule:partner-source-id',
] as const;
const decision = {
  decidedBy: z.enum(decisionNames),
  confirmedByPerson: z.boolean(),
};

export const unresolvedReasons = [
  'ACCOUNT_STANDARD_MISSING',
  'ACCOUNT_STANDARD_CONFLICT',
  'ACCOUNT_CODE_INVALID',
  'ACCOUNT_SYNTHETIC_UNKNOWN',
  'ACCOUNT_NOT_POSTABLE',
  'ACCOUNT_ANALYTIC_UNSUPPORTED',
  'ACCOUNT_NAME_MISSING',
  'ACCOUNT_PARTNER_AMBIGUOUS',
  'PARTNER_MASTER_MISSING',
  'PARTNER_IDENTITY_CONFLICT',
  'PARTNER_COUNTRY_MISSING',
  'PARTNER_KIND_UNSUPPORTED',
  'PARTNER_NAME_MISSING',
  'PARTNER_FISCAL_CODE_AMBIGUOUS',
  'PARTNER_FISCAL_CODE_OPAQUE',
  'PARTNER_PARTIES_CREATE_REQUIRES_CNP',
] as const;

const unresolved = z.strictObject({
  status: z.literal('unresolved'),
  reason: z.enum(unresolvedReasons),
});
const accountCode = z.string().regex(accountCodePattern);
const account = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('synthetic'),
    code: accountCode.regex(/^[1-9]\d{1,3}$/),
    name: z.string().min(1),
  }),
  z.strictObject({
    kind: z.literal('analytic'),
    action: z.enum(['existing', 'create']),
    code: accountCode.includes('.'),
    name: z.string().trim().min(2).max(300),
  }),
]);
const partyBinding = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('source'), source: partySourceSchema }),
  z.strictObject({ kind: z.literal('line'), role: z.enum(['customer', 'supplier']).optional() }),
  z.strictObject({ kind: z.literal('placeholder'), key: z.string().min(1) }),
]);

export const accountMappingSchema = z.strictObject({
  sourceId: z.string().min(1),
  standardId: z.string().nullable(),
  controlKind: z.enum([...openItemKinds, 'tax', 'retail']).nullable(),
  ...decision,
  target: z.discriminatedUnion('status', [
    unresolved,
    z.strictObject({
      status: z.literal('mapped'),
      account,
      party: partyBinding.nullable(),
      requiresOpenItem: z.boolean(),
    }),
  ]),
});
export type AccountMapping = z.infer<typeof accountMappingSchema>;

export const partyCreateSchema = z.strictObject({
  action: z.literal('create'),
  key: z.string().min(1),
  kind: z.enum(partyKinds),
  country: z.string().regex(/^[A-Z]{2}$/),
  taxId: z.string().trim().min(1).max(40).nullable(),
  name: z.string().trim().min(1).max(300),
});
export const partyMappingSchema = z.strictObject({
  source: partySourceSchema,
  ...decision,
  target: z.discriminatedUnion('status', [
    unresolved,
    z.strictObject({
      status: z.literal('mapped'),
      party: z.discriminatedUnion('action', [
        z.strictObject({ action: z.literal('existing'), id: z.string().min(1) }),
        partyCreateSchema,
      ]),
    }),
  ]),
});
export type PartyMapping = z.infer<typeof partyMappingSchema>;

export const mappingSchema = z.strictObject({
  schemaVersion: z.literal(1),
  company: z.string().min(1),
  source: z.string().min(1),
  accounts: z.array(accountMappingSchema),
  partners: z.array(partyMappingSchema),
  placeholders: z.array(
    z.strictObject({
      ...decision,
      placeholder: z.literal(true),
      sourceAccountId: z.string().min(1),
      party: partyCreateSchema,
    }),
  ),
});
export type Mapping = z.infer<typeof mappingSchema>;
export type UnresolvedReason = (typeof unresolvedReasons)[number];
export type PartyCreation = z.infer<typeof partyCreateSchema>;

export class MappingError extends Error {
  constructor(public readonly code: string) {
    super(`${code}: Maparea nu a putut fi procesată.`);
  }
}

export const mappingJsonSchema = z.toJSONSchema(mappingSchema, {
  target: 'draft-2020-12',
});
