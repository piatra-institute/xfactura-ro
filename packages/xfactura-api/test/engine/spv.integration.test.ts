import { afterAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { strToU8, zipSync } from 'fflate';
import { calculateInvoice, fromInvoicer, writeInvoice } from 'xfactura-core/einvoice';
import type { ActionView } from '../../source/engine/kernel/actions';
import { FakeEFactura } from './fakes/efactura';
import { salesCompany } from './fixtures/sales';
import { invoiceXml } from './fixtures/invoice';
import { scenario, type Scenario } from './scenario';

const open: Scenario[] = [];
afterAll(async () => {
  await Promise.all(open.map((s) => s.dispose()));
});

type Submission = {
  id: string;
  state: string;
  uploadId: string | null;
  downloadId: string | null;
  detail: string | null;
};
type Synced = {
  listed: number;
  recorded: number;
  outcomes: Record<string, number>;
  submissions: Record<string, string>;
};
const day = 86_400_000;

async function company() {
  const fake = new FakeEFactura();
  const s = await scenario({ efactura: fake, clock: () => fake.now });
  open.push(s);
  const sales = await salesCompany(s);
  const submit = async (documentId: string, key = randomUUID()) =>
    s.invoke<Submission>(s.owner, 'spv.submit', { documentId }, key);
  const refresh = (submissionId: string) =>
    s.invoke<Submission>(s.owner, 'spv.refresh', { submissionId });
  /** Syncs from `from` to the fake's present. */
  const sync = (from: string, key = randomUUID()) =>
    s.invoke<Synced>(s.owner, 'spv.sync', { from, to: new Date(fake.now).toISOString() }, key);
  return { s, fake, submit, refresh, sync, ...sales };
}

describe('submissions', () => {
  test('an accepted upload is confirmed by its status and matched in the inbox', async () => {
    const { fake, issue, submit, refresh, sync, s } = await company();
    const invoice = await issue();
    const submitted = await submit(invoice.documentId);
    expect([submitted.state, fake.uploads.length]).toEqual(['submitted', 1]);
    expect(await refresh(submitted.id)).toMatchObject({
      state: 'accepted',
      uploadId: submitted.uploadId,
    });
    expect((await sync('2026-03-10T00:00:00Z')).outcomes).toEqual({ matched: 1 });
    const [message] = await s.list<{ kind: string; documentId: string }>(s.owner, 'spv.messages');
    expect(message).toMatchObject({ kind: 'sent', documentId: invoice.documentId });
  });

  test("a rejection records ANAF's errors, and the invoice can be authorized again", async () => {
    const { fake, issue, submit, refresh, s } = await company();
    const invoice = await issue();
    fake.script = ['reject'];
    const rejected = await refresh((await submit(invoice.documentId)).id);
    expect(rejected.state).toBe('rejected');
    expect(rejected.detail).toContain('BR-RO-100');
    expect((await submit(invoice.documentId)).state).toBe('submitted');
    const all = await s.list<Submission>(s.owner, 'spv.submissions');
    expect(all.map((item) => item.state)).toEqual(['rejected', 'submitted']);
  });

  test('a lost answer is never resent; the inbox shows it was received', async () => {
    const { fake, issue, submit, sync, s } = await company();
    const invoice = await issue();
    fake.script = ['lost_response'];
    const key = randomUUID();
    const uncertain = await submit(invoice.documentId, key);
    expect(uncertain.state).toBe('uncertain');
    expect((await submit(invoice.documentId, key)).id).toBe(uncertain.id);
    expect((await s.refused(submit(invoice.documentId)))?.code).toBe('SUBMISSION_OPEN');
    expect(fake.uploads.length).toBe(1);

    const synced = await sync('2026-03-10T00:00:00Z');
    expect(synced.submissions).toEqual({ [uncertain.id]: 'accepted' });
    expect(synced.outcomes).toEqual({ reconciled: 1 });
    const [resolved] = await s.list<Submission>(s.owner, 'spv.submissions');
    expect(resolved).toMatchObject({ state: 'accepted', uploadId: fake.uploads[0]!.uploadId });
  });

  test('an upload is confirmed absent only once its whole horizon is synced', async () => {
    const { fake, issue, submit, sync, s } = await company();
    const invoice = await issue();
    fake.script = ['refused'];
    const uncertain = await submit(invoice.documentId);
    expect([uncertain.state, fake.uploads.length]).toEqual(['uncertain', 0]);
    fake.advance(day);
    expect((await sync('2026-03-09T00:00:00Z')).submissions).toEqual({});

    fake.advance(3 * day);
    expect((await sync('2026-03-10T12:00:00Z')).submissions).toEqual({ [uncertain.id]: 'absent' });
    expect((await submit(invoice.documentId)).state).toBe('submitted');
    expect(fake.uploads.length).toBe(1);
    expect(
      (await s.list<Submission>(s.owner, 'spv.submissions')).map((item) => item.state),
    ).toEqual(['absent', 'submitted']);
  });

  test('a slow upload stays submitted until ANAF has processed it', async () => {
    const { fake, issue, submit, refresh } = await company();
    fake.script = ['slow'];
    const submitted = await submit((await issue()).documentId);
    expect((await refresh(submitted.id)).state).toBe('submitted');
    fake.finishProcessing();
    expect((await refresh(submitted.id)).state).toBe('accepted');
  });

  test('only issued documents with their XML are submitted, and only by a person', async () => {
    const { s } = await company();
    const purchase = await s.invoke<{ id: string }>(s.owner, 'invoices.import', {
      evidenceId: (
        await s.invoke<{ id: string }>(s.owner, 'evidence.record', {
          filename: 'F-1.xml',
          mediaType: 'application/xml',
          base64: Buffer.from(invoiceXml({ number: 'F-1' })).toString('base64'),
        })
      ).id,
    });
    expect(
      (await s.refused(s.invoke(s.owner, 'spv.submit', { documentId: purchase.id })))?.code,
    ).toBe('NOT_SUBMITTABLE');
    const operation = s.engine.operations.get('spv.submit');
    expect([operation.agent, operation.approval]).toEqual([false, 'human']);
  });
});

describe('inbox', () => {
  test('imports supplier invoices once, even when listings repeat', async () => {
    const { fake, sync, s } = await company();
    fake.pageSize = 1;
    fake.duplicateListing = true;
    fake.deliver('12345678', invoiceXml({ number: 'F-10' }));
    fake.deliver('12345678', invoiceXml({ number: 'F-11' }));
    const first = await sync('2026-03-10T00:00:00Z');
    expect([first.listed, first.outcomes]).toEqual([2, { created: 2 }]);
    expect((await sync('2026-03-10T00:00:00Z')).recorded).toBe(0);
    const purchases = await s.list<{ number: string }>(s.owner, 'documents.list', {
      kinds: ['invoice.received'],
    });
    expect(purchases.map((item) => item.number).sort()).toEqual(['F-10', 'F-11']);
  });

  test('sent invoices confirm or contradict the imported history', async () => {
    const { fake, sync, s } = await company();
    const record = (id: string, number: string, price: number) => ({
      id,
      seller: {
        name: 'Pilot SRL',
        vatNumber: 'RO12345678',
        address: 'Str. Lungă 10',
        city: 'Galați',
        county: 'Galați',
        country: 'România',
      },
      buyer: {
        name: 'Client Test SRL',
        vatNumber: 'RO14399840',
        address: 'Bd. Unirii 5',
        city: 'Brașov',
        county: 'Brașov',
        country: 'România',
      },
      metadata: {
        number,
        currency: 'RON',
        issueDate: Date.parse('2025-09-10T09:00:00Z'),
        dueDate: Date.parse('2025-10-10T09:00:00Z'),
      },
      products: [{ name: 'Servicii', price, quantity: 1, vatRate: 21, vatIncluded: false }],
    });
    const history = [record('a', '20250001', 1000), record('b', '20250002', 500)];
    await s.invoke(s.owner, 'invoices.importInvoicer', {
      evidenceId: (
        await s.invoke<{ id: string }>(s.owner, 'evidence.record', {
          filename: 'export.json',
          mediaType: 'application/json',
          base64: Buffer.from(JSON.stringify(history)).toString('base64'),
        })
      ).id,
    });
    const xml = (item: ReturnType<typeof record>) =>
      writeInvoice(calculateInvoice(fromInvoicer(item).draft));
    fake.sentElsewhere('12345678', xml(history[0]!));
    fake.sentElsewhere(
      '12345678',
      xml({ ...history[1]!, products: [{ ...history[1]!.products[0]!, price: 550 }] }),
    );
    fake.sentElsewhere('12345678', xml(record('c', '20250003', 300)));
    expect((await sync('2026-03-10T00:00:00Z')).outcomes).toEqual({
      matched: 1,
      differs: 1,
      created: 1,
    });
    const messages = await s.list<{ outcome: string; detail: string | null }>(
      s.owner,
      'spv.messages',
    );
    expect(messages.find((item) => item.outcome === 'differs')?.detail).toContain('totaluri');
  });

  test('archives downloaded from the SPV website are read like synced messages', async () => {
    const { s } = await company();
    const archive = (xml: string, uploadId: string) =>
      zipSync({
        [`${uploadId}.xml`]: strToU8(xml),
        [`semnatura_${uploadId}.xml`]: strToU8(
          '<Signature xmlns="http://www.w3.org/2000/09/xmldsig#"/>',
        ),
      });
    const importArchive = async (bytes: Uint8Array, filename: string) =>
      s.invoke<{ kind: string; outcome: string; messageId: string }>(s.owner, 'spv.importArchive', {
        evidenceId: (
          await s.invoke<{ id: string }>(s.owner, 'evidence.record', {
            filename,
            mediaType: 'application/zip',
            base64: Buffer.from(bytes).toString('base64'),
          })
        ).id,
      });
    const purchase = archive(invoiceXml({ number: 'F-20' }), '5001');
    const first = await importArchive(purchase, '5002.zip');
    expect([first.kind, first.outcome]).toEqual(['received', 'created']);
    expect(await importArchive(purchase, '5002-copie.zip')).toEqual(first);
    const sale = await importArchive(
      archive(invoiceXml({ number: 'V-7', direction: 'sale' }), '5003'),
      '5004.zip',
    );
    expect([sale.kind, sale.outcome]).toEqual(['sent', 'created']);
    expect(s.engine.operations.get('spv.importArchive').agent).toBe(true);
  });

  test('a month closes only when its inbox was synced for all of it', async () => {
    const { fake, sync, s, issue, submit } = await company();
    fake.script = ['lost_response'];
    await submit((await issue()).documentId);
    fake.now = Date.parse('2026-04-02T08:00:00Z');
    await sync('2026-03-15T00:00:00Z');
    const findings = async () =>
      (
        (await s.invoke<ActionView>(s.owner, 'periods.close.request', { month: '2026-03' }))
          .preview as {
          findings: { code: string }[];
        }
      ).findings.map((finding) => finding.code);
    expect(await findings()).toContain('SPV_COVERAGE_GAP');
    await sync('2026-02-28T00:00:00Z');
    const after = await findings();
    expect(after).not.toContain('SPV_COVERAGE_GAP');
    // The lost upload was found in the second window.
    expect(after).not.toContain('SPV_PENDING');
  });

  test('refuses windows reaching into the future, and works only with a connection', async () => {
    const { s, fake } = await company();
    expect(
      (
        await s.refused(
          s.invoke(s.owner, 'spv.sync', {
            from: '2026-03-09T00:00:00Z',
            to: new Date(fake.now + day).toISOString(),
          }),
        )
      )?.code,
    ).toBe('SPV_WINDOW');
    const offline = await scenario();
    open.push(offline);
    expect(
      (
        await offline.refused(
          offline.invoke(offline.owner, 'spv.sync', {
            from: '2026-03-09T00:00:00Z',
            to: '2026-03-10T00:00:00Z',
          }),
        )
      )?.code,
    ).toBe('SPV_UNAVAILABLE');
  });
});
