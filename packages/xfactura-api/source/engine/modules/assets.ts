import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { requireCondition } from 'xfactura-core/errors';
import { formatMoney, parseMoney } from 'xfactura-core/money';
import { invoiceKinds } from 'xfactura-core/ro/treatments/invoices';
import { assetEvents, assets, documents, evidence, ledgerAccounts } from '../db/schema';
import { appendAudit, type Actor, type Commands } from '../kernel/commands';
import { loadState } from '../kernel/state';

export const disposalInput = z
  .object({
    assetId: z.uuid(),
    date: z.iso.date(),
    /** The disposal record (proces-verbal de scoatere din funcțiune, casare or sale). */
    evidenceId: z.uuid(),
  })
  .strict();

export const assetInput = z
  .object({
    /** Inventory number. */
    number: z.string().trim().min(1).max(40),
    name: z.string().trim().min(1).max(200),
    /** Classification code of the fixed-asset catalogue (HG 2139/2004), e.g. 2.2.9. */
    catalogCode: z.string().regex(/^\d+(\.\d+){1,4}$/),
    account: z.string().regex(/^2[01]\d{1,2}(\.[A-Z0-9_-]{1,24})*$/),
    depreciationAccount: z.string().regex(/^28\d{1,2}(\.[A-Z0-9_-]{1,24})*$/),
    expenseAccount: z
      .string()
      .regex(/^68\d{1,2}(\.[A-Z0-9_-]{1,24})*$/)
      .default('6811'),
    /** Entry value, in lei. */
    value: z.string().regex(/^(0|[1-9]\d{0,15})(\.\d{1,2})?$/),
    /** Accounting useful life, by the company's policies, in months. */
    lifeMonths: z.number().int().min(1).max(1200),
    /** Useful life for tax purposes, in months, within the catalogue's range for its code. */
    fiscalLifeMonths: z.number().int().min(1).max(1200),
    commissionedOn: z.iso.date(),
    /** The purchase invoice, when the asset was bought. */
    documentId: z.uuid().optional(),
    /** The commissioning record (proces-verbal de punere în funcțiune). */
    evidenceId: z.uuid(),
  })
  .strict();

/**
 * The fixed-asset register: each asset's card, kept as recorded. Its value and depreciation are
 * in the ledger; depreciation is booked month by month by `assets.depreciate`.
 */
export class Assets {
  constructor(private readonly commands: Commands) {}

  register(actor: Actor, key: string, input: z.infer<typeof assetInput>) {
    return this.commands.run(actor, key, 'assets.register', input, 'write', async (tx) => {
      const codes = [input.account, input.depreciationAccount, input.expenseAccount];
      const accounts = await tx
        .select({ code: ledgerAccounts.code, postable: ledgerAccounts.postable })
        .from(ledgerAccounts)
        .where(eq(ledgerAccounts.companyId, actor.companyId));
      for (const code of codes)
        requireCondition(
          accounts.some((account) => account.code === code && account.postable),
          'ACCOUNT',
          `Contul ${code} nu există sau nu este analitic.`,
        );
      const [file] = await tx
        .select({ id: evidence.id })
        .from(evidence)
        .where(and(eq(evidence.companyId, actor.companyId), eq(evidence.id, input.evidenceId)));
      requireCondition(
        file,
        'EVIDENCE',
        'Procesul-verbal de punere în funcțiune nu este disponibil.',
        404,
      );
      if (input.documentId) {
        const [document] = await tx
          .select({ kind: documents.kind })
          .from(documents)
          .where(and(eq(documents.companyId, actor.companyId), eq(documents.id, input.documentId)));
        requireCondition(
          document?.kind === invoiceKinds.purchase,
          'DOCUMENT',
          'Documentul de achiziție trebuie să fie o factură primită.',
        );
      }
      const [existing] = await tx
        .select({ id: assets.id })
        .from(assets)
        .where(and(eq(assets.companyId, actor.companyId), eq(assets.number, input.number)));
      requireCondition(!existing, 'ASSET_NUMBER', 'Numărul de inventar este deja folosit.', 409);
      const id = randomUUID();
      await tx.insert(assets).values({
        id,
        companyId: actor.companyId,
        number: input.number,
        name: input.name,
        catalogCode: input.catalogCode,
        account: input.account,
        depreciationAccount: input.depreciationAccount,
        expenseAccount: input.expenseAccount,
        valueBani: parseMoney(input.value, 'RON'),
        lifeMonths: input.lifeMonths,
        fiscalLifeMonths: input.fiscalLifeMonths,
        commissionedOn: input.commissionedOn,
        documentId: input.documentId ?? null,
        evidenceId: input.evidenceId,
        createdBy: actor.actorId,
      });
      await appendAudit(tx, {
        companyId: actor.companyId,
        actorId: actor.actorId,
        ...(actor.agentId ? { agentId: actor.agentId } : {}),
        action: 'assets.registered',
        body: { assetId: id, number: input.number },
      });
      return { id, number: input.number };
    });
  }

  /** Records that an asset left use; `assets.derecognize` then takes it off the books. */
  dispose(actor: Actor, key: string, input: z.infer<typeof disposalInput>) {
    return this.commands.run(actor, key, 'assets.dispose', input, 'write', async (tx) => {
      const [card] = await tx
        .select()
        .from(assets)
        .where(and(eq(assets.companyId, actor.companyId), eq(assets.id, input.assetId)));
      requireCondition(card, 'ASSET', 'Mijlocul fix nu există.', 404);
      requireCondition(
        input.date >= card.commissionedOn,
        'DISPOSAL_DATE',
        'Scoaterea din funcțiune nu poate preceda punerea în funcțiune.',
      );
      const [file] = await tx
        .select({ id: evidence.id })
        .from(evidence)
        .where(and(eq(evidence.companyId, actor.companyId), eq(evidence.id, input.evidenceId)));
      requireCondition(
        file,
        'EVIDENCE',
        'Documentul de scoatere din funcțiune nu este disponibil.',
        404,
      );
      const [last] = await tx
        .select()
        .from(assetEvents)
        .where(
          and(eq(assetEvents.companyId, actor.companyId), eq(assetEvents.assetId, input.assetId)),
        )
        .orderBy(desc(assetEvents.seq))
        .limit(1);
      requireCondition(!last, 'DISPOSED', 'Mijlocul fix a fost deja scos din funcțiune.', 409);
      await tx.insert(assetEvents).values({
        companyId: actor.companyId,
        assetId: input.assetId,
        seq: 1,
        kind: 'disposed',
        date: input.date,
        evidenceId: input.evidenceId,
        createdBy: actor.actorId,
      });
      return { assetId: input.assetId, disposedOn: input.date };
    });
  }

  /** The register with each asset's depreciation booked and remaining value. */
  list(actor: Actor) {
    return this.commands.db.read(async (tx) => {
      const { loaded } = await loadState(tx, actor.companyId, { assets: true });
      const cards = await tx
        .select({
          id: assets.id,
          catalogCode: assets.catalogCode,
          fiscalLifeMonths: assets.fiscalLifeMonths,
        })
        .from(assets)
        .where(eq(assets.companyId, actor.companyId))
        .orderBy(asc(assets.number));
      return cards.map((card) => {
        const asset = loaded.assets.get(card.id)!;
        return {
          id: asset.id,
          number: asset.number,
          name: asset.name,
          catalogCode: card.catalogCode,
          account: asset.account,
          value: formatMoney(asset.value, 'RON'),
          depreciated: formatMoney(asset.depreciated, 'RON'),
          remaining: formatMoney(asset.value - asset.depreciated, 'RON'),
          lifeMonths: asset.lifeMonths,
          fiscalLifeMonths: card.fiscalLifeMonths,
          commissionedOn: asset.commissionedOn,
          disposedOn: asset.disposedOn,
        };
      });
    });
  }
}
