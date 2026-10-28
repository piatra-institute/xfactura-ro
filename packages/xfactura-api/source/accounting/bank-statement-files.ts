import { randomUUID } from 'node:crypto';
import { and, asc, eq, gt, gte, inArray, lte, sql } from 'drizzle-orm';
import { z } from 'zod';
import { Commands, authorize, commandKey, type Actor } from './commands';
import type { Transaction } from './db';
import { canonical, DomainError, fromBani, idSchema, requireCondition } from './domain';
import {
  accountingYears,
  bankStatementEntries,
  bankStatementFiles,
  bankStatementSources,
  evidence,
  movements,
  periods,
  treasuryAccounts,
} from './schema';
import { sha256, type ObjectStore } from './object-store';
import { retainBankStatement } from './bank';
import { parseMt940 } from './bank-mt940';
import { parseCamt } from './bank-camt';
import {
  bankFileFormat,
  bankFileLimits,
  bankFileParserVersion,
  canonicalBankAccount,
  checkedStatements,
  entrySourceId,
  meaningfulReference,
  statementFinancialHash,
  storedBankEntrySchema,
  storedBankStatementSchema,
  type StoredBankStatement,
  type StoredBankEntry,
} from './bank-statement-document';

export const bankFileInput = z
  .object({
    evidenceId: idSchema,
    financialYearId: idSchema,
    format: bankFileFormat,
    encoding: z.enum(['utf-8', 'windows-1250']).default('utf-8'),
  })
  .strict();
export const bankFileReadInput = z.object({ evidenceId: idSchema }).strict();
export const bankStatementEntryPage = z
  .object({
    sourceId: idSchema,
    limit: z.number().int().min(1).max(100).default(25),
    cursor: z
      .number()
      .int()
      .min(0)
      .max(bankFileLimits.entries - 1)
      .optional(),
  })
  .strict();
export const bankStatementHeaderOutput = storedBankStatementSchema.omit({ entries: true });
export const bankFileOutput = z.object({
  evidenceId: idSchema,
  financialYearId: idSchema,
  format: bankFileFormat,
  parserVersion: z.literal(bankFileParserVersion),
  sourceHash: z.string(),
  manifestHash: z.string(),
  statementCount: z.number().int(),
  entryCount: z.number().int(),
  createdBy: z.string(),
  createdAt: z.string(),
  statements: z.array(bankStatementHeaderOutput.extend({ entryCount: z.number().int() })),
});
export const bankStatementEntriesOutput = z.object({
  statement: bankStatementHeaderOutput,
  items: z.array(storedBankEntrySchema).max(100),
  nextCursor: z.number().int().nullable(),
});

const fingerprint = (sourceHash: string, inputHash: string, manifest: StoredBankStatement[]) =>
  sha256(canonical({ sourceHash, inputHash, parserVersion: bankFileParserVersion, manifest }));

async function readFile(tx: Transaction, companyId: string, evidenceId: string) {
  const [row] = await tx
    .select({ file: bankStatementFiles, sourceHash: evidence.hash })
    .from(bankStatementFiles)
    .innerJoin(
      evidence,
      and(
        eq(evidence.companyId, bankStatementFiles.companyId),
        eq(evidence.id, bankStatementFiles.evidenceId),
      ),
    )
    .where(
      and(
        eq(bankStatementFiles.companyId, companyId),
        eq(bankStatementFiles.evidenceId, evidenceId),
      ),
    );
  if (!row) return null;
  requireCondition(
    row.file.manifestHash === fingerprint(row.sourceHash, row.file.inputHash, row.file.manifest),
    'BANK_MANIFEST_INTEGRITY',
    'Integritatea importului bancar nu poate fi confirmată.',
    500,
  );
  const { manifest, companyId: _, inputHash, ...header } = row.file;
  return {
    inputHash,
    result: bankFileOutput.parse({
      ...header,
      sourceHash: row.sourceHash,
      statements: manifest.map(({ entries, ...statement }) => ({
        ...statement,
        entryCount: entries.length,
      })),
    }),
  };
}

/** Source decoding precedes the write transaction; all statements and provenance commit together. */
export class BankStatementFiles {
  constructor(
    private readonly runner: Commands,
    private readonly objects: ObjectStore,
  ) {}

  async import(actor: Actor, key: string, input: unknown) {
    commandKey(key);
    const body = bankFileInput.parse(input),
      inputHash = sha256(canonical(body));
    requireCondition(
      body.format !== 'camt.053' || body.encoding === 'utf-8',
      'BANK_ENCODING',
      'Documentele camt trebuie codificate UTF-8.',
    );
    const context = await this.runner.read(
      actor,
      async (tx) => {
        await authorize(tx, actor, 'write', 'bank.importFile');
        const [source] = await tx
          .select()
          .from(evidence)
          .where(and(eq(evidence.companyId, actor.companyId), eq(evidence.id, body.evidenceId)));
        const [year] = await tx
          .select()
          .from(accountingYears)
          .where(
            and(
              eq(accountingYears.companyId, actor.companyId),
              eq(accountingYears.id, body.financialYearId),
              eq(accountingYears.kind, 'financial'),
            ),
          );
        requireCondition(
          source && year,
          'NOT_FOUND',
          'Documentul sau exercițiul financiar nu este disponibil.',
          404,
        );
        requireCondition(
          source.size <= bankFileLimits.bytes,
          'IMPORT_LIMIT',
          'Fișierul bancar depășește 2 MB.',
        );
        const existing = await readFile(tx, actor.companyId, body.evidenceId);
        requireCondition(
          !existing || existing.inputHash === inputHash,
          'BANK_FILE_CONFLICT',
          'Fișierul a fost importat cu alte opțiuni.',
          409,
        );
        return { source, year, existing };
      },
      'bank.importFile',
    );
    let parsed = null;
    if (!context.existing) {
      const bytes = await this.objects.get(actor.companyId, context.source.hash);
      requireCondition(
        bytes.length <= bankFileLimits.bytes,
        'IMPORT_LIMIT',
        'Fișierul bancar depășește 2 MB.',
      );
      if (body.format === 'camt.053') parsed = checkedStatements(parseCamt(bytes), context.year);
      else {
        let text: string;
        try {
          text = new TextDecoder(body.encoding, { fatal: true }).decode(bytes);
        } catch {
          throw new DomainError(
            'BANK_ENCODING',
            'Codificarea fișierului bancar nu corespunde opțiunii selectate.',
          );
        }
        parsed = checkedStatements(parseMt940(text, context.year), context.year);
      }
    }
    return this.runner.run(actor, key, 'bank.importFile', body, 'write', async (tx) => {
      const existing = await readFile(tx, actor.companyId, body.evidenceId);
      if (existing) {
        requireCondition(
          existing.inputHash === inputHash,
          'BANK_FILE_CONFLICT',
          'Fișierul a fost importat cu alte opțiuni.',
          409,
        );
        return existing.result;
      }
      requireCondition(parsed, 'BANK_IMPORT_STATE', 'Reîncercați importul bancar.', 409);
      const accounts = await tx
        .select()
        .from(treasuryAccounts)
        .where(
          and(eq(treasuryAccounts.companyId, actor.companyId), eq(treasuryAccounts.kind, 'bank')),
        );
      const locks = await tx.select().from(periods).where(eq(periods.companyId, actor.companyId));
      const closed = new Set(
        locks.filter((row) => row.closedAt).map((row) => row.month.slice(0, 7)),
      );
      const manifest: StoredBankStatement[] = [],
        pending = new Map<string, StoredBankEntry[]>();
      for (const statement of parsed) {
        const mapped = accounts.filter(
          (row) => canonicalBankAccount(row.identifier) === statement.bankAccount,
        );
        const first = statement.from < context.year.from ? context.year.from : statement.from;
        requireCondition(
          mapped.length === 1 && mapped[0].currency === 'RON' && mapped[0].openedOn <= first,
          'BANK_ACCOUNT_REQUIRED',
          'Configurați contul bancar RON înainte de import.',
        );
        const account = mapped[0],
          financialHash = statementFinancialHash(statement);
        const previousVersions = await tx
          .select({ hash: bankStatementSources.financialHash })
          .from(bankStatementSources)
          .innerJoin(
            bankStatementFiles,
            and(
              eq(bankStatementFiles.companyId, bankStatementSources.companyId),
              eq(bankStatementFiles.evidenceId, bankStatementSources.fileEvidenceId),
            ),
          )
          .where(
            and(
              eq(bankStatementSources.companyId, actor.companyId),
              eq(bankStatementSources.bankAccount, account.identifier),
              eq(bankStatementSources.sourceId, statement.sourceId),
              eq(bankStatementFiles.financialYearId, body.financialYearId),
              eq(bankStatementFiles.format, body.format),
            ),
          );
        requireCondition(
          previousVersions.every((row) => row.hash === financialHash),
          'BANK_STATEMENT_CONFLICT',
          'Același extras bancar are un conținut financiar diferit.',
          409,
        );
        const known = await tx
          .select()
          .from(movements)
          .where(
            and(
              eq(movements.companyId, actor.companyId),
              eq(movements.bankAccount, account.identifier),
              gte(movements.date, first),
              lte(movements.date, statement.to),
            ),
          )
          .limit(20001);
        requireCondition(
          known.length <= 20000,
          'BANK_OVERLAP_LIMIT',
          'Intervalul suprapus necesită un import bancar mai restrâns.',
        );
        const details = known.length
          ? await tx
              .select({
                movementId: bankStatementEntries.movementId,
                bankReference: sql<
                  string | null
                >`json_extract(${bankStatementEntries.body},'$.bankReference')`,
                valueDate: sql<
                  string | null
                >`json_extract(${bankStatementEntries.body},'$.valueDate')`,
              })
              .from(bankStatementEntries)
              .where(
                and(
                  eq(bankStatementEntries.companyId, actor.companyId),
                  inArray(
                    bankStatementEntries.movementId,
                    known.map((row) => row.id),
                  ),
                ),
              )
              .limit(20001)
          : [];
        requireCondition(
          details.length <= 20000,
          'BANK_OVERLAP_LIMIT',
          'Prea multe versiuni bancare suprapuse.',
        );
        const history = (id: string) => [
          ...details.filter((row) => row.movementId === id),
          ...(pending.get(id) ?? []),
        ];
        const rows = statement.entries.map((entry) => {
          const sourceId = entrySourceId(statement, entry),
            ref = meaningfulReference(entry.bankReference);
          const previous = known.find(
            (row) =>
              row.sourceId === sourceId ||
              (!entry.reversal && ref !== null && row.sourceId === ref),
          );
          if (previous) {
            requireCondition(
              previous.date === entry.date && fromBani(previous.amountBani) === entry.amount,
              'BANK_SOURCE_CONFLICT',
              'Aceeași referință bancară are altă dată sau sumă.',
              409,
            );
            requireCondition(
              history(previous.id).every(
                (row) => !row.valueDate || !entry.valueDate || row.valueDate === entry.valueDate,
              ),
              'BANK_VALUE_DATE_CONFLICT',
              'Aceeași mișcare are o altă dată a valutei.',
              409,
            );
          } else {
            requireCondition(
              !closed.has(entry.date.slice(0, 7)),
              'PERIOD_CLOSED',
              'Perioada este închisă.',
              409,
            );
            const candidates = known.filter(
              (row) => row.date === entry.date && fromBani(row.amountBani) === entry.amount,
            );
            requireCondition(
              candidates.every((row) => {
                const refs = history(row.id).map((detail) =>
                  meaningfulReference(detail.bankReference),
                );
                return ref && refs.length > 0 && refs.every((old) => old && old !== ref);
              }),
              'AMBIGUOUS_BANK_DUPLICATE',
              'Există o mișcare cu aceeași dată și sumă fără identitate bancară comparabilă. Verificați sursele înainte de import.',
              409,
            );
          }
          return {
            sourceId,
            date: entry.date,
            amount: entry.amount,
            reference: entry.reference,
            ...(previous ? { movementId: previous.id } : {}),
          };
        });
        const retained = await retainBankStatement(
          tx,
          actor,
          {
            evidenceId: body.evidenceId,
            bankAccount: account.identifier,
            statementId: `${body.format}:file:${sha256(canonical([context.source.hash, statement.ordinal]))}`,
            from: statement.from,
            to: statement.to,
            opening: statement.opening,
            closing: statement.closing,
            hash: sha256(
              canonical({
                sourceHash: context.source.hash,
                financialHash,
                ordinal: statement.ordinal,
              }),
            ),
          },
          rows,
        );
        const entries = statement.entries.map((entry, index) => {
          const movement = retained.movements[index];
          const result = storedBankEntrySchema.parse({
            ...entry,
            id: randomUUID(),
            movementId: movement.id,
            sourceId: movement.sourceId,
            identityBasis: meaningfulReference(entry.bankReference)
              ? 'bank_reference'
              : 'statement_entry',
          });
          pending.set(movement.id, [...(pending.get(movement.id) ?? []), result]);
          return result;
        });
        manifest.push(
          storedBankStatementSchema.parse({
            ...statement,
            id: randomUUID(),
            statementId: retained.id,
            sourceAccount: statement.bankAccount,
            bankAccount: account.identifier,
            financialHash,
            entries,
          }),
        );
      }
      await tx.insert(bankStatementFiles).values({
        companyId: actor.companyId,
        evidenceId: body.evidenceId,
        financialYearId: body.financialYearId,
        format: body.format,
        parserVersion: bankFileParserVersion,
        inputHash,
        manifestHash: fingerprint(context.source.hash, inputHash, manifest),
        manifest,
        statementCount: manifest.length,
        entryCount: manifest.reduce((count, statement) => count + statement.entries.length, 0),
        createdBy: actor.actorId,
      });
      return (await readFile(tx, actor.companyId, body.evidenceId))!.result;
    });
  }

  get(actor: Actor, input: unknown) {
    const body = bankFileReadInput.parse(input);
    return this.runner.read(
      actor,
      async (tx) => {
        const file = await readFile(tx, actor.companyId, body.evidenceId);
        requireCondition(file, 'NOT_FOUND', 'Importul bancar nu este disponibil.', 404);
        return file.result;
      },
      'bank.file',
    );
  }

  entries(actor: Actor, input: unknown) {
    const body = bankStatementEntryPage.parse(input);
    return this.runner.read(
      actor,
      async (tx) => {
        const [source] = await tx
          .select()
          .from(bankStatementSources)
          .where(
            and(
              eq(bankStatementSources.companyId, actor.companyId),
              eq(bankStatementSources.id, body.sourceId),
            ),
          );
        requireCondition(source, 'NOT_FOUND', 'Extrasul sursă nu este disponibil.', 404);
        const rows = await tx
          .select()
          .from(bankStatementEntries)
          .where(
            and(
              eq(bankStatementEntries.companyId, actor.companyId),
              eq(bankStatementEntries.sourceId, source.id),
              body.cursor === undefined ? undefined : gt(bankStatementEntries.ordinal, body.cursor),
            ),
          )
          .orderBy(asc(bankStatementEntries.ordinal))
          .limit(body.limit + 1);
        const items = rows.slice(0, body.limit).map((row) => row.body);
        return bankStatementEntriesOutput.parse({
          statement: source.body,
          items,
          nextCursor: rows.length > body.limit ? items.at(-1)!.ordinal : null,
        });
      },
      'bank.statementEntries',
    );
  }
}
