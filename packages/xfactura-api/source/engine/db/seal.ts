import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import type { Client } from '@libsql/client';
import { requireCondition } from 'xfactura-core/errors';
import { canonical } from 'xfactura-core/hash';
import type { JsonValue } from 'xfactura-core/kernel';
import { sealAnswer, sealIssues, sealRecords } from '../kernel/personal';

/**
 * Personal data at rest: AES-256-GCM under a key derived from the server's secret, bound to
 * the company. Only what must carry it opens it: a declaration a CNP or a diagnosis, the payroll
 * a certificate it continues, a reader of health data an answer about sick leave.
 */
export class Sealer {
  private readonly key: Buffer;

  constructor(secret: string, purpose = 'payroll personal data v1') {
    this.key = Buffer.from(hkdfSync('sha256', secret, 'xfactura', purpose, 32));
  }

  seal(companyId: string, text: string) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv).setAAD(Buffer.from(companyId));
    const body = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
    return ['v1', iv, body, cipher.getAuthTag()]
      .map((part) => (typeof part === 'string' ? part : part.toString('base64url')))
      .join('.');
  }

  open(companyId: string, sealed: string) {
    const [version, iv, body, tag] = sealed.split('.');
    requireCondition(version === 'v1' && iv && body && tag, 'SEALED', 'Date sigilate necunoscute.');
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64url'))
      .setAAD(Buffer.from(companyId))
      .setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(body, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  }
}

/** A sick item's label as computed before 6 November 2026: it named the certificate and its code
 * (`Concediu medical CCMAM 9, cod 01 (angajator)`). */
const namedSickLabel = /^Concediu medical .+, cod \d{2} (\(.+\))$/;

/**
 * The data step of migration 0032 (`sealed_sick_leave`): what the books kept in clear of a
 * month's sick leave is sealed, as the engine keeps it since 6 November 2026 (kernel/personal.ts):
 * each medical certificate a payroll line paid (`sealRecords`), the line's issues about one
 * (`sealIssues`), the labels of its sick items, which named the certificate and its code, and each
 * absence of an answer about a month's absences but for its certificate's file (`sealAnswer`).
 * Run after the migrations, before the invariants are installed again: the append-only guards of
 * `acc_payroll_lines` and `acc_question_answers` are dropped in the same transaction and restored
 * by `ensureInvariants`. Idempotent; a database holding such data needs the secret. Results of
 * commands recorded before then are kept as they were returned, read only through the views'
 * redaction: the audit chain binds their hashes.
 */
export async function sealSickLeave(client: Client, secret: string | undefined) {
  const lines = (
    await client.execute(
      `SELECT company_id, run_id, contract_id, input_json, result_json FROM acc_payroll_lines
       WHERE EXISTS (SELECT 1 FROM json_each(input_json, '$.sick') s
           WHERE json_extract(s.value, '$.sealed') IS NULL)
         OR EXISTS (SELECT 1 FROM json_each(result_json, '$.issues') i
           WHERE json_extract(i.value, '$.sealed') IS NULL
             AND (json_extract(i.value, '$.health') = 1 OR json_extract(i.value, '$.code') GLOB 'SICK_*'))
         OR EXISTS (SELECT 1 FROM json_each(input_json, '$.items') t
           WHERE json_extract(t.value, '$.label') GLOB 'Concediu medical *, cod *')`,
    )
  ).rows;
  const answers = (
    await client.execute(
      `SELECT a.company_id, a.id, a.value_json FROM acc_question_answers a
       JOIN acc_questions q ON q.company_id = a.company_id AND q.id = a.question_id
       WHERE q.kind = 'payroll.absences' AND EXISTS (
         SELECT 1 FROM json_each(a.value_json, '$.absences') x
         WHERE json_extract(x.value, '$.sealed') IS NULL)`,
    )
  ).rows;
  if (!lines.length && !answers.length) return 0;
  if (!secret)
    throw new Error(
      "Payroll lines and answers keep sick leave in clear: run the migration with the installation's ACCOUNTING_AUTH_SECRET.",
    );
  const sealer = new Sealer(secret);
  const transaction = await client.transaction('write');
  try {
    await transaction.execute('DROP TRIGGER IF EXISTS inv_acc_payroll_lines_no_update');
    await transaction.execute('DROP TRIGGER IF EXISTS inv_acc_question_answers_no_update');
    for (const row of lines) {
      const companyId = String(row.company_id);
      const input = JSON.parse(String(row.input_json)) as {
        sick?: object[];
        items?: { label?: string }[] | null;
      };
      const result = JSON.parse(String(row.result_json)) as {
        issues?: { code: string; message: string; health?: true }[];
      };
      const sealedInput = {
        ...input,
        ...(input.sick ? { sick: sealRecords(sealer, companyId, input.sick) } : {}),
        ...(Array.isArray(input.items)
          ? {
              items: input.items.map((item) =>
                typeof item.label === 'string' && namedSickLabel.test(item.label)
                  ? { ...item, label: item.label.replace(namedSickLabel, 'Concediu medical $1') }
                  : item,
              ),
            }
          : {}),
      };
      const sealedResult = result.issues
        ? { ...result, issues: sealIssues(sealer, companyId, result.issues) }
        : result;
      await transaction.execute({
        sql: `UPDATE acc_payroll_lines SET input_json = ?, result_json = ?
          WHERE company_id = ? AND run_id = ? AND contract_id = ?`,
        args: [
          canonical(sealedInput as JsonValue),
          canonical(sealedResult as JsonValue),
          companyId,
          String(row.run_id),
          String(row.contract_id),
        ],
      });
    }
    for (const row of answers) {
      const companyId = String(row.company_id);
      const value = sealAnswer(
        sealer,
        companyId,
        'payroll.absences',
        JSON.parse(String(row.value_json)),
      );
      await transaction.execute({
        sql: 'UPDATE acc_question_answers SET value_json = ? WHERE company_id = ? AND id = ?',
        args: [canonical(value as JsonValue), companyId, String(row.id)],
      });
    }
    await transaction.commit();
    return lines.length + answers.length;
  } catch (error) {
    await transaction.rollback();
    throw error;
  } finally {
    transaction.close();
  }
}
