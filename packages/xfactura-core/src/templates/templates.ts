import { z } from 'zod';
import { canonical } from '../hash';
import { accountCodePattern } from '../kernel';
import { allocate, formatMoney, LEDGER_CURRENCY, parseMoney } from '../money';
import { normalizedNumber } from '../documents/schemas';
import { normalizePlate } from '../questions/kinds';
import { recognitionInput, registration } from '../ro/treatments/invoices';
import { deferralInput } from '../ro/treatments/deferrals';
import { settlementInput } from '../ro/treatments/settlement';
import { addMonths, monthOf, type LocalDate } from '../time';
import { invoiceDocumentSchema } from '../ubl/invoice-document';

/*
 * Booking templates: how a company books what recurs (a supplier's monthly invoice, the payment
 * of it, a bank's fees). A template names what it applies to (its scope) and the part of a
 * treatment's input it fixes (its mapping); `applyTemplate` makes the whole input for one
 * document or bank movement, `conforms` tells whether an input is what the template would make.
 * Both are pure: the engine reads the document or movement and the open items it may settle.
 */

/** The treatments a template can drive, and the subjects each reads. */
export const templateTreatments = ['invoices.recognize', 'deferrals.defer', 'bank.settle'] as const;
export type TemplateTreatment = (typeof templateTreatments)[number];

/** What a template applies to, by treatment: a document kind, or a movement's direction. */
export const templateDocumentKinds: Record<TemplateTreatment, readonly string[]> = {
  'invoices.recognize': ['invoice.received', 'invoice.issued'],
  'deferrals.defer': ['invoice.received', 'invoice.issued'],
  'bank.settle': ['movement.paid', 'movement.received'],
};

/** Whether a treatment's templates read documents or bank movements. */
export const subjectKindOf = (treatment: TemplateTreatment) =>
  treatment === 'bank.settle' ? ('movement' as const) : ('document' as const);

export const templateScope = z
  .object({
    treatment: z.enum(templateTreatments),
    /** The partner: the document's, or for a movement the one whose open item it settles. */
    partyId: z.uuid().optional(),
    /** `invoice.received`, `invoice.issued`; for a movement `movement.paid` or
     * `movement.received`. */
    documentKind: z.string().min(1).max(40),
    /** Words a line's description (a movement's text) must hold, case and diacritics ignored. */
    linePattern: z.string().trim().min(2).max(200).optional(),
  })
  .strict()
  .refine((scope) => templateDocumentKinds[scope.treatment].includes(scope.documentKind), {
    message: 'Tipul de document nu corespunde tratamentului.',
    path: ['documentKind'],
  });
export type TemplateScope = z.infer<typeof templateScope>;

const account = z.string().regex(accountCodePattern);
const deduction = z.enum(['full', 'none', 'limited']);

/**
 * A part's deduction, or the road vehicle it concerns (art. 298): a part naming a vehicle takes
 * the deduction the person's answer about that vehicle allows (`vehicle.use`), never one fixed in
 * the template, so the template follows the answer that holds when it is applied. Without a
 * vehicle the deduction is the template's (`full` when not given).
 */
const deducting = {
  deduction: deduction.optional(),
  vehicle: registration.optional(),
};
const vehicleOrDeduction = {
  check: (part: { deduction?: string | undefined; vehicle?: string | undefined }) =>
    part.vehicle === undefined || part.deduction === undefined,
  message:
    'Cu vehiculul numit, deducerea urmează răspunsul despre folosirea lui (vehicle.use): nu o fixați în șablon.',
};
function settled<T extends { deduction?: 'full' | 'none' | 'limited'; vehicle?: string }>({
  deduction: fixed,
  vehicle,
  ...rest
}: T) {
  return vehicle === undefined
    ? { ...rest, deduction: fixed ?? ('full' as const) }
    : { ...rest, vehicle };
}

/** `invoices.recognize`: one account, or each VAT category split over accounts by shares; each
 * with its deduction, or the vehicle whose answer decides it. */
export const recognitionMapping = z.union([
  z
    .object({ account, ...deducting })
    .strict()
    .refine(vehicleOrDeduction.check, { message: vehicleOrDeduction.message, path: ['deduction'] })
    .transform(settled),
  z
    .object({
      shares: z
        .array(
          z
            .object({
              account,
              /** A whole-number weight: 60 and 40 split each category 60:40. */
              share: z.number().int().min(1).max(10_000),
              ...deducting,
            })
            .strict()
            .refine(vehicleOrDeduction.check, {
              message: vehicleOrDeduction.message,
              path: ['deduction'],
            })
            .transform(settled),
        )
        .min(2)
        .max(10),
    })
    .strict(),
]);
export type RecognitionMapping = z.infer<typeof recognitionMapping>;
/** A part of a recognition mapping: its deduction, or the vehicle whose answer decides it. */
type MappedPart = { deduction: 'full' | 'none' | 'limited' } | { vehicle: string };

/** The vehicles a mapping names, in their one spelling (`B123XFA`). */
export function mappedVehicles(treatment: TemplateTreatment, mapping: unknown): string[] {
  if (treatment !== 'invoices.recognize') return [];
  const parsed = recognitionMapping.safeParse(mapping);
  if (!parsed.success) return [];
  const parts: MappedPart[] = 'shares' in parsed.data ? parsed.data.shares : [parsed.data];
  return [
    ...new Set(parts.flatMap((part) => ('vehicle' in part ? [normalizePlate(part.vehicle)] : []))),
  ];
}
/** `deferrals.defer`: the account the amount was booked on, over how many months, starting in
 * the invoice's month or the next. */
export const deferralMapping = z
  .object({
    account: z.string().regex(/^(6\d{2,5}|70\d{1,4})$/),
    months: z.number().int().min(1).max(120),
    start: z.enum(['issue', 'next']).default('next'),
  })
  .strict();
/** `bank.settle`: the whole movement settles one open item, found by the invoice number in the
 * movement's text or by its exact amount; or the whole movement goes to one account (fees). */
export const settlementMapping = z.discriminatedUnion('settle', [
  z.object({ settle: z.literal('openItem'), match: z.enum(['number', 'amount']) }).strict(),
  z
    .object({
      settle: z.literal('account'),
      account,
      memo: z.string().trim().min(1).max(200).optional(),
    })
    .strict(),
]);
export const templateMappings = {
  'invoices.recognize': recognitionMapping,
  'deferrals.defer': deferralMapping,
  'bank.settle': settlementMapping,
} as const;

/** A template as it is applied: its scope and its mapping, checked against its treatment. */
export type TemplateDefinition = {
  scope: TemplateScope;
  mapping: unknown;
};

/** Parses a mapping for the scope's treatment. */
export function parseMapping(treatment: TemplateTreatment, mapping: unknown) {
  return templateMappings[treatment].parse(mapping);
}

/** A document a template may read, as the engine loads it. */
export type DocumentSubject = {
  kind: 'document';
  document: {
    id: string;
    kind: string;
    partyId: string | null;
    evidenceId: string | null;
    body: unknown;
  };
  /** For a mapping that names vehicles: the deduction the answer that holds about each allows
   * (`vehicleDeduction`), by the vehicle's one spelling; a vehicle without one is missing. */
  vehicles?: Readonly<Record<string, 'full' | 'limited'>>;
};
/** A bank movement, with the open items it might settle: in its currency, with what is still
 * outstanding on each, positive in the item's own direction. */
export type MovementSubject = {
  kind: 'movement';
  movement: {
    id: string;
    amountMinor: bigint;
    currency: string;
    text: string;
  };
  openItems: {
    id: string;
    kind: string;
    partyId: string;
    currency: string;
    outstandingMinor: bigint;
    documentNumber: string | null;
  }[];
};
export type TemplateSubject = DocumentSubject | MovementSubject;

export type Applied = { ok: true; input: unknown } | { ok: false; reason: string };

/** Lower case, without diacritics, whitespace runs as one space. */
export const folded = (text: string) =>
  text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();
const holds = (text: string, pattern: string) =>
  folded(pattern)
    .split(' ')
    .every((word) => folded(text).includes(word));

/** The open item kinds a movement settles: a payment pays a payable, a receipt collects a
 * receivable. */
const settledKind = (amountMinor: bigint) => (amountMinor < 0n ? 'payable' : 'receivable');

/** Whether a document or movement is one the template applies to: its kind, partner and text. */
export function inScope(template: TemplateDefinition, subject: TemplateSubject): boolean {
  const { scope } = template;
  if (subject.kind === 'document') {
    if (subjectKindOf(scope.treatment) !== 'document') return false;
    const { document } = subject;
    if (document.kind !== scope.documentKind) return false;
    if (scope.partyId && document.partyId !== scope.partyId) return false;
    if (!scope.linePattern) return true;
    const body = invoiceDocumentSchema.safeParse(document.body);
    return (
      body.success && body.data.lines.some((line) => holds(line.description, scope.linePattern!))
    );
  }
  if (subjectKindOf(scope.treatment) !== 'movement') return false;
  const paid = subject.movement.amountMinor < 0n;
  if ((scope.documentKind === 'movement.paid') !== paid) return false;
  return !scope.linePattern || holds(subject.movement.text, scope.linePattern);
}

const ronMonth = (date: string) => monthOf(date as LocalDate);

/**
 * The treatment input a template makes of a document or movement, as the treatment parses it;
 * a refusal says why it does not apply (out of scope, no single open item, …).
 */
export function applyTemplate(template: TemplateDefinition, subject: TemplateSubject): Applied {
  if (!inScope(template, subject)) return { ok: false, reason: 'scope' };
  const { scope } = template;
  switch (scope.treatment) {
    case 'invoices.recognize': {
      const { document, vehicles } = subject as DocumentSubject;
      const mapping = recognitionMapping.parse(template.mapping);
      // A part naming a vehicle deducts what the answer that holds about it allows; without one
      // the template cannot say, and a person is asked through the proposal instead.
      const deducts = (part: MappedPart) =>
        'vehicle' in part
          ? (() => {
              const allowed = vehicles?.[normalizePlate(part.vehicle)];
              return allowed ? { vehicle: part.vehicle, deduction: allowed } : null;
            })()
          : { deduction: part.deduction };
      if ('account' in mapping) {
        const part = deducts(mapping);
        if (!part) return { ok: false, reason: 'vehicle' };
        return {
          ok: true,
          input: recognitionInput.parse({
            documentId: document.id,
            account: mapping.account,
            ...part,
          }),
        };
      }
      const body = invoiceDocumentSchema.safeParse(document.body);
      if (!body.success) return { ok: false, reason: 'document' };
      const shares = mapping.shares.map((share) => ({ share, part: deducts(share) }));
      if (shares.some((item) => !item.part)) return { ok: false, reason: 'vehicle' };
      // Each VAT category's taxable amount, split by the shares in the document's currency.
      const allocations = body.data.taxes.flatMap((tax) => {
        const key = tax.category === 'S' ? `S-${tax.rate}` : tax.category;
        const parts = allocate(
          parseMoney(tax.base, body.data.currency),
          shares.map((item) => BigInt(item.share.share)),
        );
        return shares.map((item, index) => ({
          account: item.share.account,
          vat: key,
          amount: formatMoney(parts[index]!, body.data.currency),
          ...item.part!,
        }));
      });
      const parsed = recognitionInput.safeParse({ documentId: document.id, allocations });
      return parsed.success ? { ok: true, input: parsed.data } : { ok: false, reason: 'document' };
    }
    case 'deferrals.defer': {
      const { document } = subject as DocumentSubject;
      const mapping = deferralMapping.parse(template.mapping);
      const body = invoiceDocumentSchema.safeParse(document.body);
      if (!body.success || body.data.currency !== LEDGER_CURRENCY)
        return { ok: false, reason: 'document' };
      if (!document.partyId || !document.evidenceId) return { ok: false, reason: 'document' };
      const month = ronMonth(body.data.issueDate);
      return {
        ok: true,
        input: deferralInput.parse({
          date: body.data.issueDate,
          account: mapping.account,
          amount: body.data.totals.net,
          from: mapping.start === 'issue' ? month : addMonths(month, 1),
          months: mapping.months,
          partyId: document.partyId,
          documentId: document.id,
          evidenceId: document.evidenceId,
        }),
      };
    }
    case 'bank.settle': {
      const { movement, openItems } = subject as MovementSubject;
      const mapping = settlementMapping.parse(template.mapping);
      const amount = movement.amountMinor < 0n ? -movement.amountMinor : movement.amountMinor;
      const text = formatMoney(amount, movement.currency);
      if (mapping.settle === 'account')
        return {
          ok: true,
          input: settlementInput.parse({
            movementId: movement.id,
            lines: [
              {
                account: mapping.account,
                amount: text,
                ...(mapping.memo ? { memo: mapping.memo } : {}),
              },
            ],
          }),
        };
      const remittance = normalizedNumber(movement.text);
      const candidates = openItems.filter(
        (item) =>
          item.kind === settledKind(movement.amountMinor) &&
          item.currency === movement.currency &&
          (!scope.partyId || item.partyId === scope.partyId) &&
          item.outstandingMinor === amount &&
          (mapping.match === 'amount' ||
            (item.documentNumber !== null &&
              remittance.includes(normalizedNumber(item.documentNumber)))),
      );
      if (candidates.length !== 1)
        return { ok: false, reason: candidates.length ? 'ambiguous' : 'unmatched' };
      return {
        ok: true,
        input: settlementInput.parse({
          movementId: movement.id,
          allocations: [{ openItem: candidates[0]!.id, amount: text }],
        }),
      };
    }
  }
}

const parsers: Record<TemplateTreatment, z.ZodType> = {
  'invoices.recognize': recognitionInput,
  'deferrals.defer': deferralInput,
  'bank.settle': settlementInput,
};

/** What a mapping fixes of an input, compared without reading the document or movement. */
function fixedFields(treatment: TemplateTreatment, mapping: unknown, input: unknown): boolean {
  const parsed = parsers[treatment].safeParse(input);
  if (!parsed.success) return false;
  const value = parsed.data as Record<string, unknown>;
  switch (treatment) {
    case 'invoices.recognize': {
      const fixed = recognitionMapping.parse(mapping);
      // A part naming a vehicle fixes the vehicle; its deduction is the answer's.
      const same = (
        part: { account: string; deduction: string; vehicle?: string | undefined },
        share: MappedPart & { account: string },
      ) =>
        share.account === part.account &&
        ('vehicle' in share
          ? part.vehicle !== undefined &&
            normalizePlate(part.vehicle) === normalizePlate(share.vehicle)
          : part.vehicle === undefined && part.deduction === share.deduction);
      if ('account' in fixed)
        return same(
          value as { account: string; deduction: string; vehicle?: string | undefined },
          fixed,
        );
      const parts = (value.allocations ?? []) as {
        account: string;
        deduction: string;
        vehicle?: string;
      }[];
      return (
        parts.length > 0 && parts.every((part) => fixed.shares.some((share) => same(part, share)))
      );
    }
    case 'deferrals.defer': {
      const fixed = deferralMapping.parse(mapping);
      return value.account === fixed.account && value.months === fixed.months;
    }
    case 'bank.settle': {
      const fixed = settlementMapping.parse(mapping);
      const allocations = value.allocations as unknown[];
      const lines = value.lines as { account: string }[];
      const opens = value.opens as unknown[];
      return fixed.settle === 'account'
        ? allocations.length === 0 &&
            opens.length === 0 &&
            lines.length === 1 &&
            lines[0]!.account === fixed.account
        : allocations.length === 1 && lines.length === 0 && opens.length === 0;
    }
  }
}

/**
 * Whether an input is what the template makes: given the document or movement, exactly the
 * input `applyTemplate` makes of it (as its treatment parses it); without one, the fields the
 * mapping fixes (accounts, deduction, months, the shape of a settlement).
 */
export function conforms(
  template: TemplateDefinition,
  input: unknown,
  subject?: TemplateSubject,
): boolean {
  const { treatment } = template.scope;
  if (!fixedFields(treatment, template.mapping, input)) return false;
  if (!subject) return true;
  const applied = applyTemplate(template, subject);
  const parsed = parsers[treatment].safeParse(input);
  return (
    applied.ok &&
    parsed.success &&
    canonical(spelled(applied.input)) === canonical(spelled(parsed.data))
  );
}

/** An input with every vehicle in its one spelling: `B-123-XFA` and `B123XFA` are one car. */
function spelled(input: unknown): unknown {
  if (typeof input !== 'object' || input === null) return input;
  const value = input as { vehicle?: unknown; allocations?: unknown };
  const plate = (part: Record<string, unknown>) =>
    typeof part.vehicle === 'string' ? { ...part, vehicle: normalizePlate(part.vehicle) } : part;
  return {
    ...plate(value as Record<string, unknown>),
    ...(Array.isArray(value.allocations)
      ? { allocations: (value.allocations as Record<string, unknown>[]).map(plate) }
      : {}),
  };
}
