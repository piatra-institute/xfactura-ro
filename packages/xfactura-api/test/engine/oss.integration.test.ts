import { afterAll, describe, expect, test } from 'bun:test';
import path from 'node:path';
import * as ossAgent from 'xfactura-core/ro/oss/agent';
import { questionKindIds } from 'xfactura-core/questions/kinds';
import { AnafKits, DukIntegrator } from '../../source/engine/adapters/declaration-validator';
import type { DeclarationValidator } from '../../source/engine/adapters/declaration-validator';
import type { ActionView } from '../../source/engine/kernel/actions';
import { workKinds } from '../../source/engine/kernel/work';
import type { ProposalView } from '../../source/engine/kernel/views';
import { invoiceXml, type XmlInput } from './fixtures/invoice';
import { scenario, type Scenario } from './scenario';

// A synthetic e-commerce SRL selling online courses and e-newspaper subscriptions to consumers in
// Germany, France and Italy, registered for VAT, quarterly. Amounts computed by hand from the
// rates below: below the threshold Romanian VAT at 21%; the sale that crosses 46.337 lei moves the
// place to the customer's state; the Union scheme's D398 per quarter, and a refund corrected in
// the next quarter's return.
const bnr = `<?xml version="1.0" encoding="utf-8"?>
<DataSet xmlns="http://www.bnr.ro/xsd"><Header><Publisher>National Bank of Romania</Publisher><PublishingDate>2026-10-15</PublishingDate><MessageType>DR</MessageType></Header>
<Body><Subject>Reference rates</Subject><OrigCurrency>RON</OrigCurrency>
<Cube date="2026-02-09"><Rate currency="EUR">5.0000</Rate></Cube>
<Cube date="2026-05-11"><Rate currency="EUR">5.0500</Rate></Cube>
<Cube date="2026-07-09"><Rate currency="EUR">5.0600</Rate></Cube>
<Cube date="2026-08-07"><Rate currency="EUR">5.0700</Rate></Cube>
<Cube date="2026-09-04"><Rate currency="EUR">5.0800</Rate></Cube>
<Cube date="2026-10-09"><Rate currency="EUR">5.0900</Rate></Cube>
<Cube date="2026-10-19"><Rate currency="EUR">5.1000</Rate></Cube>
</Body></DataSet>`;

const open: Scenario[] = [];
afterAll(async () => {
  await Promise.all(open.map((s) => s.dispose()));
});

const general = path.join(import.meta.dir, '../../../..', '.validators/anaf/dist');
const kit = path.join(
  import.meta.dir,
  '../../../..',
  '.validators/anaf-saft/duk_SAFT_an_luna/dist',
);
const installed =
  DukIntegrator.available(kit) && DukIntegrator.available(general) && Bun.which('java') !== null;
// ANAF's D398 validator (J1.0.11, in the SAF-T kit) when installed; otherwise a stand-in that
// accepts every file, so the books' flow still runs while the official check is skipped.
const validator: DeclarationValidator = installed
  ? new AnafKits({ general: new DukIntegrator(general), saft: new DukIntegrator(kit) })
  : {
      id: 'validator de test',
      validate: async () => ({ ok: true, messages: [] }),
      pdf: async () => ({ ok: true, messages: [] }),
    };
const cui = '18547290';
const consumer = '0000000000000';

type Artifact = {
  id: string;
  state: string;
  evidenceId: string;
  steps: { state: string; detail: string | null }[];
};

async function company() {
  const s = await scenario({
    cui,
    clock: () => Date.parse('2026-11-05T09:00:00Z'),
    declarationValidator: validator,
  });
  open.push(s);
  const file = async (filename: string, text: string, mediaType = 'application/xml') =>
    (
      await s.invoke<{ id: string }>(s.owner, 'evidence.record', {
        filename,
        mediaType,
        base64: Buffer.from(text).toString('base64'),
      })
    ).id;
  const record = async (axis: string, value: string, effectiveFrom: string) =>
    s.invoke(s.owner, 'profile.record', {
      axis,
      value,
      effectiveFrom,
      evidenceId: (await s.evidence(`${axis}-${value}.pdf`)).id,
    });
  await record('vat.status', 'normal_vat', '2026-01-01');
  await record('vat.period', 'quarterly', '2026-01-01');
  await s.invoke(s.owner, 'fx.importBnr', { evidenceId: await file('nbrfxrates.xml', bnr) });
  await s.invoke(s.owner, 'sales.seller.record', {
    details: {
      name: 'Exemplu Digital SRL',
      vatId: `RO${cui}`,
      address: { lines: ['Str. Lungă 10'], city: 'Galați', subdivision: 'RO-GL', country: 'RO' },
    },
  });
  const anaf = await s.invoke<{ id: string }>(s.owner, 'parties.create', {
    kind: 'ro_public_institution',
    country: 'RO',
    taxId: '8000000000',
    name: 'ANAF',
  });
  const document = async (input: XmlInput) =>
    s.invoke<{ id: string }>(s.owner, 'invoices.import', {
      evidenceId: await file(
        `${input.number}.xml`,
        invoiceXml({
          company: cui,
          direction: 'sale',
          counterparty: consumer,
          currency: 'EUR',
          ...input,
        }),
      ),
    });
  const location = (country: string) => [
    { kind: 'billing_address', country },
    { kind: 'ip', country },
  ];
  const propose = async (input: XmlInput, extra: Record<string, unknown> = {}) => {
    const { id } = await document(input);
    const treatmentInput = {
      documentId: id,
      account: '704',
      supply: 'electronic',
      location: location(input.country ?? 'DE'),
      authorityId: anaf.id,
      ...extra,
    };
    return {
      documentId: id,
      input: treatmentInput,
      proposal: await s.propose('invoices.euConsumer', treatmentInput),
    };
  };
  const post = async (proposal: ProposalView) =>
    s.post(
      await s.approve(
        proposal,
        s.reviewer,
        proposal.issues.filter((issue) => issue.severity === 'ack').map((issue) => issue.code),
      ),
    );
  const prepare = (kind: string, period: string, options: Record<string, unknown> = {}) =>
    s.invoke<Artifact>(s.owner, 'declarations.prepare', { kind, period, options });
  const authorize = async (artifactId: string) => {
    const request = await s.invoke<ActionView>(s.owner, 'declarations.authorize.request', {
      artifactId,
    });
    await s.invoke(s.reviewer, 'actions.approve', {
      id: request.id,
      previewHash: request.previewHash,
    });
    return s.invoke(s.reviewer, 'actions.execute', { id: request.id });
  };
  return { s, record, propose, post, prepare, authorize, anaf, file };
}

const d300Options = {
  declarant: { lastName: 'Popescu', firstName: 'Ana', role: 'Administrator' },
  caen: '4791',
  bank: 'Banca Exemplu',
  account: 'RO49AAAA1B31007593840000',
};
const lines = (proposal: ProposalView) =>
  proposal.effect?.lines.map((line) => `${line.side} ${line.account} ${line.amount}`);
const sale = (
  number: string,
  date: string,
  country: string,
  net: string,
  rate: string,
  tax: string,
) => ({
  number,
  date,
  country,
  net,
  rate,
  tax,
  gross: (Number(net) + Number(tax)).toFixed(2),
});

describe('an e-commerce SRL selling to consumers in other Member States', () => {
  test('below the threshold, crossing it, registered in the Union scheme: three states, the D398 and a correction', async () => {
    const { s, record, propose, post, prepare, authorize } = await company();

    // 1. The first sale: where it takes place is asked, never assumed.
    const first = await propose(sale('EB-1', '2026-02-10', 'DE', '4000.00', '21', '840.00'));
    expect(first.proposal.issues.map((issue) => issue.code)).toContain('DETERMINATION_MISSING');
    await record('vat.distance', 'origin', '2026-01-01');
    const booked = await s.revise('invoices.euConsumer', first.proposal, first.input);
    // 4.840 EUR at 5.0000 = 24.200 lei; Romanian VAT 20.000 × 21% = 4.200 lei.
    expect(lines(booked)).toEqual(['D 4111 24200.00', 'C 704 20000.00', 'C 4427 4200.00']);
    expect(booked.issues.map((issue) => issue.code)).toContain('EFACTURA_B2C');
    await post(booked);

    // 2. A second sale below the threshold: 6.050 EUR at 5.0500; base 25.250 lei, 45.250 in all.
    const second = await propose(sale('EB-2', '2026-05-12', 'FR', '5000.00', '21', '1050.00'));
    expect(lines(second.proposal)).toEqual(['D 4111 30552.50', 'C 704 25250.00', 'C 4427 5302.50']);
    await post(second.proposal);
    // The worklist warns: 45.250 of 46.337 lei (97%).
    const watched = await s.list<{
      kind: string;
      subject: { id: string };
      severity: string;
      details: { level: number };
    }>(s.owner, 'work.list', { kinds: ['threshold.approaching'] });
    expect(watched).toEqual([
      expect.objectContaining({
        subject: expect.objectContaining({ id: 'ro.vat.distance.threshold/2026' }),
        severity: 'warn',
        details: expect.objectContaining({ level: 80 }),
      }),
    ]);

    // D300 rd. 17 and the information section, by quarter. 2025 is not in the books: its total
    // is asked (year.figures), from its last D300, never assumed to be zero.
    const blocked = await s.refused(prepare('D300', '2026-Q1', d300Options));
    expect(blocked?.code).toBe('D300_DISTANCE_PREVIOUS');
    const question = await s.invoke<{ id: string }>(s.owner, 'questions.ask', {
      kind: 'year.figures',
      subject: { kind: 'year', id: '2025' },
      params: { year: 2025, figures: ['distanceTurnover'] },
    });
    await s.invoke(s.reviewer, 'questions.answer', {
      questionId: question.id,
      value: {
        values: { distanceTurnover: '0.00' },
        evidenceIds: [(await s.evidence('d300-2025-Q4.pdf')).id],
      },
    });
    const q1 = await prepare('D300', '2026-Q1', d300Options);
    // ANAF's D300 validator (or the stand-in) accepts rd. 17 and the information section.
    expect(q1.state).toBe('validated_official');
    const q1Rows = JSON.parse(q1.steps[0]!.detail!).rows as Record<string, number>;
    expect(q1Rows).toMatchObject({ R64_1: 20000, R64_2: 4200, total_curent: 20000 });
    expect(q1Rows.R9_1).toBeUndefined();
    const q2 = await prepare('D300', '2026-Q2', d300Options);
    expect(q2.state).toBe('validated_official');
    expect(JSON.parse(q2.steps[0]!.detail!).rows).toMatchObject({
      R64_1: 25250,
      R64_2: 5303,
      total_curent: 45250,
    });

    // 3. The sale that crosses the threshold: 400 EUR at 5.0600 = 2.024 lei, 47.274 > 46.337.
    const third = await propose(sale('EB-3', '2026-07-10', 'DE', '400.00', '21', '84.00'));
    expect(third.proposal.issues.map((issue) => issue.code)).toContain(
      'DISTANCE_THRESHOLD_CROSSED',
    );
    await record('vat.distance', 'destination', '2026-07-10');
    // Registered in the Union scheme from 1 July (ANAF's decision); the invoice is reissued with
    // Germany's 19%.
    await record('vat.oss', 'union', '2026-07-01');
    const german = await propose(sale('EB-3A', '2026-07-10', 'DE', '400.00', '19', '76.00'));
    // 476 EUR at 5.0600 = 2.408,56 lei; VAT 76 EUR = 384,56 lei on 4423, outside 4427.
    expect(lines(german.proposal)).toEqual(['D 4111 2408.56', 'C 704 2024.00', 'C 4423 384.56']);
    expect(german.proposal.issues.map((issue) => issue.code)).toContain('EFACTURA_NOT_REQUIRED');
    await post(german.proposal);
    await s
      .invoke(s.reviewer, 'proposals.withdraw', {
        proposalId: third.proposal.id,
        version: third.proposal.version,
        reason: 'Factura reemisă cu TVA Germaniei (EB-3A).',
      })
      .catch(() => undefined);

    // 4. France at 20%, Italy at 22%, a German e-newspaper at 7% (TEDB: NEWSPAPERS).
    const france = await propose(sale('EB-4', '2026-08-10', 'FR', '1000.00', '20', '200.00'));
    await post(france.proposal);
    const italy = await propose(sale('EB-5', '2026-09-07', 'IT', '500.00', '22', '110.00'));
    await post(italy.proposal);
    const newspaper = await propose(sale('EB-6', '2026-09-07', 'DE', '100.00', '7', '7.00'), {
      categories: { '7': 'NEWSPAPERS' },
    });
    expect(newspaper.proposal.issues.map((issue) => issue.code)).toContain('OSS_REDUCED_RATE');
    await post(newspaper.proposal);

    // The determinations agree with the recorded facts: the crossing of 10 July.
    const evaluated = await s.invoke<{
      determinations: {
        axis: string;
        status: string;
        value: string | null;
        changes: { value: string; effectiveFrom: string }[];
      }[];
    }>(s.owner, 'determinations.evaluate', { year: 2026 });
    const distance = evaluated.determinations.find((item) => item.axis === 'vat.distance')!;
    expect(distance).toMatchObject({ status: 'proposed', value: 'origin' });
    expect(distance.changes).toEqual([
      expect.objectContaining({ value: 'destination', effectiveFrom: '2026-07-10' }),
    ]);
    expect(evaluated.determinations.find((item) => item.axis === 'vat.oss')).toMatchObject({
      status: 'proposed',
      value: 'union',
    });

    // The Q3 D300 holds none of the Union scheme's sales (ANAF's SAF-T sheet: D398 only).
    const q3vat = await prepare('D300', '2026-Q3', d300Options);
    const q3Rows = JSON.parse(q3vat.steps[0]!.detail!).rows as Record<string, number>;
    expect(q3Rows.R3_1).toBeUndefined();
    expect(q3Rows.R64_1).toBeUndefined();
    expect(q3Rows.total_curent).toBe(45250);

    // 5. The quarter's D398: three states, in euro.
    const q3 = await prepare('D398', '2026-Q3');
    expect(q3.state).toBe('validated_official');
    const summary = JSON.parse(q3.steps[0]!.detail!) as {
      supplies: unknown[];
      declared: Record<string, string>;
    };
    expect(summary.supplies).toEqual([
      {
        state: 'DE',
        type: 'services',
        rateType: 'standard',
        rate: '19',
        taxable: '400.00',
        vat: '76.00',
      },
      {
        state: 'DE',
        type: 'services',
        rateType: 'reduced',
        rate: '7',
        taxable: '100.00',
        vat: '7.00',
      },
      {
        state: 'FR',
        type: 'services',
        rateType: 'standard',
        rate: '20',
        taxable: '1000.00',
        vat: '200.00',
      },
      {
        state: 'IT',
        type: 'services',
        rateType: 'standard',
        rate: '22',
        taxable: '500.00',
        vat: '110.00',
      },
    ]);
    expect(summary.declared).toEqual({ DE: '8300', FR: '20000', IT: '11000' });
    await authorize(q3.id);

    // The calendar: due on 31 October 2026, a Saturday, not moved (art. 315 alin. (6^1)).
    const calendar = await s.invoke<{
      items: { kind: string; period: string; due: string | null }[];
    }>(s.owner, 'obligations.calendar', { from: '2026-07', to: '2026-12' });
    expect(
      calendar.items.find((item) => item.kind === 'D398' && item.period === '2026-Q3'),
    ).toMatchObject({
      due: '2026-10-31',
    });

    // 6. A refund in October of half the French course: a correction of Q3 in Q4's return.
    const { documentId: refundId } = await (async () => {
      const id = (
        await s.invoke<{ id: string }>(s.owner, 'invoices.import', {
          evidenceId: (
            await s.invoke<{ id: string }>(s.owner, 'evidence.record', {
              filename: 'CN-1.xml',
              mediaType: 'application/xml',
              base64: Buffer.from(
                invoiceXml({
                  company: cui,
                  direction: 'sale',
                  counterparty: consumer,
                  currency: 'EUR',
                  credit: true,
                  number: 'CN-1',
                  originalNumber: 'EB-4',
                  date: '2026-10-12',
                  country: 'FR',
                  net: '500.00',
                  rate: '20',
                  tax: '100.00',
                  gross: '600.00',
                }),
              ).toString('base64'),
            })
          ).id,
        })
      ).id;
      return { documentId: id };
    })();
    const refund = await s.propose('invoices.euConsumer', {
      documentId: refundId,
      account: '704',
      supply: 'electronic',
      originalDocumentId: france.documentId,
      authorityId: (await s.list<{ id: string; kind: string }>(s.owner, 'parties.list')).find(
        (party) => party.kind === 'ro_public_institution',
      )!.id,
    });
    // 600 EUR at 5.0900: the receivable and the VAT owed reduced by red storno.
    expect(lines(refund)).toEqual(['D 4111 -3054.00', 'C 704 -2545.00', 'C 4423 -509.00']);
    expect(refund.issues.filter((issue) => issue.severity === 'block')).toEqual([]);
    expect(refund.effect?.explanation.details).toMatchObject({
      corrects: '2026-Q3',
      quarter: '2026-Q4',
    });
    await post(refund);
    const october = await propose(sale('EB-7', '2026-10-20', 'DE', '200.00', '19', '38.00'));
    await post(october.proposal);
    const q4 = await prepare('D398', '2026-Q4');
    expect(q4.state).toBe('validated_official');
    const q4Summary = JSON.parse(q4.steps[0]!.detail!) as {
      supplies: unknown[];
      corrections: unknown[];
    };
    expect(q4Summary.supplies).toEqual([
      {
        state: 'DE',
        type: 'services',
        rateType: 'standard',
        rate: '19',
        taxable: '200.00',
        vat: '38.00',
      },
    ]);
    expect(q4Summary.corrections).toEqual([{ state: 'FR', quarter: '2026-Q3', cents: '-10000' }]);

    // The closure: the D398 of both quarters the company is registered in.
    const closure = await s.invoke<{
      obligations: { kind: string; period: string; state: string }[];
    }>(s.owner, 'closure.evaluate', { from: '2026-07', to: '2026-12' });
    expect(
      closure.obligations
        .filter((item) => item.kind === 'D398')
        .map((item) => [item.period, item.state]),
    ).toEqual([
      ['2026-Q3', 'applies'],
      ['2026-Q4', 'applies'],
    ]);
  }, 120_000);

  test('an unbooked invoice to an EU consumer is proposed as invoices.euConsumer', async () => {
    const { s, file } = await company();
    await s.invoke(s.owner, 'invoices.import', {
      evidenceId: await file(
        'EB-9.xml',
        invoiceXml({
          company: cui,
          direction: 'sale',
          counterparty: consumer,
          currency: 'EUR',
          number: 'EB-9',
          date: '2026-10-01',
          country: 'IT',
          rate: '22',
          tax: '22.00',
          gross: '122.00',
        }),
      ),
    });
    const items = await s.list<{
      kind: string;
      next: { operation: string; inputHint: { treatment?: string } }[];
    }>(s.owner, 'work.list', { kinds: ['document.unproposed'] });
    expect(items[0]!.next[0]!.inputHint.treatment).toBe('invoices.euConsumer');
  });

  test("agent.ts's kinds are the worklist's and the questions'", () => {
    for (const detector of ossAgent.detectors)
      expect(workKinds as readonly string[]).toContain(detector.kind);
    for (const question of ossAgent.questions)
      expect(questionKindIds as readonly string[]).toContain(question.kind);
    expect(ossAgent.templates).toEqual([]);
  });
});
