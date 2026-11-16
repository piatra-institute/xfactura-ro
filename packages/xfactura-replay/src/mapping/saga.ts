import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { MappingError } from './schema';
import type { SagaDump } from './sources';

const schemaSchema = z.object({
  tables: z.array(
    z.object({
      name: z.string(),
      rowCount: z.number().int().nonnegative(),
      columns: z.array(z.object({ name: z.string() })),
    }),
  ),
});
const accountRow = z.object({ CONT: z.string(), DENUMIRE: z.string().nullable() });
const partnerRow = z.object({
  COD: z.string(),
  DENUMIRE: z.string().nullable(),
  ANALITIC: z.string().nullable(),
  C_SAFT: z.string().nullable(),
  COD_FISCAL: z.string().nullable(),
  TARA: z.string().nullable(),
});
const text = (value: string | null): string | undefined => value?.trim() || undefined;

/** This adapter uses declared column names and exact account/SAF-T IDs, never names. */
export async function readSagaDump(folder: string): Promise<SagaDump> {
  try {
    const schema = schemaSchema.parse(
      JSON.parse(await readFile(join(folder, 'schema.json'), 'utf8')),
    );
    const tables = new Map(schema.tables.map((table) => [table.name, table]));
    const result: SagaDump = { accounts: [], partners: [] };
    for (const name of ['CONTURI', 'CLIENTI', 'FURNIZORI'] as const) {
      const table = tables.get(name);
      const columns =
        name === 'CONTURI' ? Object.keys(accountRow.shape) : Object.keys(partnerRow.shape);
      if (!table || columns.some((column) => !table.columns.some((c) => c.name === column)))
        throw new MappingError('MAPPING_SAGA_SCHEMA');
      const content = await readFile(join(folder, `${name}.jsonl`), 'utf8');
      const rows = content
        .split(/\r?\n/)
        .filter((line) => line.trim())
        .map((line): unknown => JSON.parse(line));
      if (rows.length !== table.rowCount) throw new MappingError('MAPPING_SAGA_ROW_COUNT');
      for (const row of rows) {
        if (name === 'CONTURI') {
          const account = accountRow.parse(row);
          if (!account.CONT.trim()) throw new MappingError('MAPPING_SAGA_ACCOUNT_ID');
          result.accounts.push({ code: account.CONT.trim(), name: text(account.DENUMIRE) });
        } else {
          const partner = partnerRow.parse(row);
          if (!partner.COD.trim()) throw new MappingError('MAPPING_SAGA_PARTNER_ID');
          result.partners.push({
            source: {
              origin: 'saga',
              role: name === 'CLIENTI' ? 'customer' : 'supplier',
              id: partner.COD.trim(),
            },
            account: text(partner.ANALITIC),
            saftId: text(partner.C_SAFT),
            name: text(partner.DENUMIRE),
            country: text(partner.TARA),
            taxId: text(partner.COD_FISCAL),
          });
        }
      }
    }
    return result;
  } catch (error: unknown) {
    if (error instanceof MappingError) throw error;
    throw new MappingError('MAPPING_SAGA_READ');
  }
}
