import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrate as migrateDrizzle } from 'drizzle-orm/libsql/migrator';
import { Accounting } from '../../source/accounting/application';
import { Database } from '../../source/accounting/db';
import { createAuth } from '../../source/accounting/auth';
import { migrate } from '../../source/accounting/migrate';
import { LocalObjectStore } from '../../source/accounting/object-store';
import { generalBodySchema } from '../../source/accounting/domain';
import {
  approvals,
  commands,
  evidence,
  facts,
  proposals,
  journals,
  journalLines,
  advancePayments,
  advanceRefunds,
  movementPostings,
} from '../../source/accounting/schema';

for (const baseline of [25, 43])
  test.each(['purchase', 'sale'] as const)(
    `populated 00${baseline} %s advance refunds and exact approvals survive the generated table rebuild`,
    async (direction) => {
      const folder = await mkdtemp(join(tmpdir(), 'xfactura-partial-refund-upgrade-')),
        db = new Database(`file:${folder}/books.db`),
        key = () => randomUUID();
      try {
        const previous = join(folder, 'old'),
          source = new URL('../../source/accounting/migrations/', import.meta.url);
        await mkdir(join(previous, 'meta'), { recursive: true });
        const manifest = JSON.parse(await readFile(new URL('meta/_journal.json', source), 'utf8')),
          entries = manifest.entries.filter((e: { idx: number }) => e.idx <= baseline);
        await writeFile(
          join(previous, 'meta/_journal.json'),
          JSON.stringify({ ...manifest, entries }),
        );
        for (const e of entries)
          await copyFile(new URL(`${e.tag}.sql`, source), join(previous, `${e.tag}.sql`));
        await db.initialize();
        await migrateDrizzle(db.orm, { migrationsFolder: previous });
        const secret = 'synthetic-partial-upgrade-secret-at-least-32-characters',
          owner = await createAuth(
            db,
            { publicUrl: 'http://localhost:3000', authSecret: secret },
            true,
          ).api.signUpEmail({
            body: {
              email: 'upgrade@example.test',
              name: 'Upgrade reviewer',
              password: 'synthetic-upgrade-password',
            },
          }),
          service = new Accounting(db, new LocalObjectStore(join(folder, 'objects')), secret),
          company = await service.companies.create(owner.user.id, key(), {
            name: 'Existing advances SRL',
            cui: '12345678',
            year: 2026,
          }),
          actor = { companyId: company.id, actorId: owner.user.id },
          year = (await service.foundation.years(actor)).find((row) => row.kind === 'financial')!;
        const proof = await service.documents.record(actor, key(), {
          filename: 'contract.txt',
          mediaType: 'text/plain',
          bytes: Buffer.from('Retained contract for three independent service advances'),
        });
        async function post(p: { id: string; version: number; hash: string }, commandKey = key()) {
          await service.books.approve(actor, key(), p.id, { version: p.version, hash: p.hash });
          return service.ledger.post(actor, commandKey, {
            id: p.id,
            version: p.version,
            hash: p.hash,
          });
        }
        for (const item of [
          { axis: 'vat', value: 'normal_vat' },
          { axis: 'vat_collection', value: 'no' },
        ])
          await service.foundation.recordRegime(actor, key(), {
            ...item,
            effectiveFrom: '2026-01-01',
            evidenceId: proof.id,
          });
        await post(
          await service.ledger.propose(actor, key(), {
            financialYearId: year.id,
            evidenceId: proof.id,
            date: '2026-01-01',
            purpose: 'opening',
            description: 'Retained opening',
            sourceReference: 'opening',
            lines: [
              { account: '5121', debit: '1000.00', credit: '0.00' },
              { account: '1012', debit: '0.00', credit: '1000.00' },
            ],
          }),
        );
        async function statement(
          from: string,
          to: string,
          opening: string,
          closing: string,
          rows: string,
        ) {
          const file = await service.documents.record(actor, key(), {
            filename: `${key()}.csv`,
            mediaType: 'text/csv',
            bytes: Buffer.from(`movement_id,booking_date,amount,currency,reference\n${rows}`),
          });
          await service.bank.importStatement(actor, key(), {
            evidenceId: file.id,
            bankAccount: 'RO00OLDREFUNDS',
            statementId: key(),
            from,
            to,
            opening,
            closing,
          });
        }
        const sign = direction === 'purchase' ? '-' : '',
          janClosing = direction === 'purchase' ? '637.00' : '1363.00',
          febClosing = direction === 'purchase' ? '915.30' : '1084.70';
        await statement(
          '2026-01-01',
          '2026-01-31',
          '1000.00',
          janClosing,
          `P1,2026-01-10,${sign}121.00,RON,advance-1\nP2,2026-01-11,${sign}121.00,RON,advance-2\nP3,2026-01-12,${sign}121.00,RON,advance-3\n`,
        );
        const movements = (await service.queries.movements(actor, { matched: false })).items,
          payments: Array<{ id: string; version: number; hash: string }> = [];
        for (const ref of ['advance-1', 'advance-2', 'advance-3']) {
          const p = await service.advances.proposePayment(actor, key(), {
            financialYearId: year.id,
            movementId: movements.find((row) => row.reference === ref)!.id,
            direction,
            counterparty: { name: 'Partner SRL', taxId: '87654321', country: 'RO' },
            account: direction === 'purchase' ? '628' : '704',
            net: '100.00',
            vatCategory: 'S',
            counterpartyVatCollection: 'no',
            evidenceId: proof.id,
            evidenceDate: '2026-01-01',
            reference: ref,
            serviceExpectedOn: '2026-06-30',
            reason: 'An independently retained service advance before the schema upgrade',
          });
          await post(p);
          payments.push(p);
        }
        const refundSign = direction === 'sale' ? '-' : '';
        await statement(
          '2026-02-01',
          '2026-02-28',
          janClosing,
          febClosing,
          `R1,2026-02-01,${refundSign}121.00,RON,return-1\nR2,2026-02-02,${refundSign}121.00,RON,return-2\nR3,2026-02-03,${refundSign}36.30,RON,return-3\n`,
        );
        const refunds = (await service.queries.movements(actor, { matched: false })).items;
        async function refund(index: number, net?: string) {
          const agreement = await service.documents.record(actor, key(), {
            filename: `refund-${index}.txt`,
            mediaType: 'text/plain',
            bytes: Buffer.from(`Separate refund agreement ${index} ${key()}`),
          });
          return service.advances.proposeRefund(actor, key(), {
            financialYearId: year.id,
            paymentId: payments[index].id,
            movementId: refunds.find((row) => row.reference === `return-${index + 1}`)!.id,
            evidenceId: agreement.id,
            decisionDate: `2026-02-0${index + 1}`,
            periodBasis: 'current_period_event',
            reason: 'Retained refund of an unused service advance before invoice',
            ...(net ? { net } : {}),
          });
        }
        const first = await refund(0);
        await post(first);
        const pending = await refund(1);
        await service.books.approve(actor, key(), pending.id, {
          version: pending.version,
          hash: pending.hash,
        });
        expect(generalBodySchema.parse(pending.body).advanceRefund!.refundBasis).toBeUndefined();
        const tables = {
            approvals,
            commands,
            evidence,
            facts,
            proposals,
            journals,
            journalLines,
            advancePayments,
            advanceRefunds,
            movementPostings,
          },
          before = new Map<string, unknown>();
        for (const [name, table] of Object.entries(tables))
          before.set(name, await db.orm.select().from(table));
        await migrate(db);
        await migrate(db);
        for (const [name, table] of Object.entries(tables))
          expect(before.get(name)).toEqual(await db.orm.select().from(table));
        const commandKey = key(),
          exact = { id: pending.id, version: pending.version, hash: pending.hash },
          outcome = await service.ledger.post(actor, commandKey, exact);
        expect(await service.ledger.post(actor, commandKey, exact)).toEqual(outcome);
        const partial = await refund(2, '30.00');
        await post(partial);
        expect(
          await service.advances.getPayment(actor, { id: payments[2].id, date: '2026-02-28' }),
        ).toMatchObject({ status: 'open', remainingNet: '70.00', remainingGross: '84.70' });
        expect(
          await service.advances.reconcile(actor, { financialYearId: year.id, date: '2026-02-28' }),
        ).toMatchObject({ status: 'reconciled' });
        expect((await db.client.execute('PRAGMA foreign_key_check')).rows).toHaveLength(0);
        expect((await db.client.execute('PRAGMA integrity_check')).rows[0].integrity_check).toBe(
          'ok',
        );
      } finally {
        await db.close();
        await rm(folder, { recursive: true, force: true });
      }
    },
  );
