import { afterAll, describe, expect, test } from 'bun:test';
import path from 'node:path';
import * as schemesAgent from 'xfactura-core/ro/schemes/agent';
import {
  AnafKits,
  DukIntegrator,
  saftKitId,
  type DeclarationValidator,
} from '../../source/engine/adapters/declaration-validator';
import type { ProposalView } from '../../source/engine/kernel/views';
import { iban } from './fixtures/bank';
import { invoiceXml, type XmlInput } from './fixtures/invoice';
import type { Issued, Preview } from './fixtures/sales';
import { scenario, type Scenario } from './scenario';

// The special VAT schemes (V4) from the books to the returns. Amounts by hand, at 21%, the
// margin's VAT = margin × 21 ÷ 121 half up:
//   travel: the package sold for 10.000,00 lei, its hotel bought for 7.580,00 lei (6.264,46 +
//     1.315,54 VAT, not deducted): margin 2.420,00, VAT 420,00, base 2.000,00 (rd. 9);
//   second-hand: an item bought for 1.000,00 lei and sold for 1.500,00 (margin 500,00, VAT 86,78,
//     base 413,22), another bought for 2.000,00 and sold for 1.800,00 (no VAT); rd. 9 413 / 87,
//     rd. 29 3.000;
//   flat rate: vegetables of 10.000,00 lei and the 8% compensation, 800,00, deducted (rd. 27 and
//     31), the products on rd. 29.

const open: Scenario[] = [];
afterAll(async () => {
  await Promise.all(open.map((s) => s.dispose()));
});
const dist = path.join(import.meta.dir, '../../../..', '.validators/anaf/dist');
const official = DukIntegrator.available(dist) && Bun.which('java') ? test : test.skip;
const saftDist = path.join(
  import.meta.dir,
  '../../../..',
  '.validators/anaf-saft/duk_SAFT_an_luna/dist',
);
const saftInstalled = DukIntegrator.available(saftDist) && Bun.which('java') !== null;
const cui = '18547290';
const d300Options = {
  declarant: { lastName: 'Popescu', firstName: 'Ana', role: 'Administrator' },
  caen: '7912',
  bank: 'Banca Exemplu',
  account: 'RO49AAAA1B31007593840000',
};
const d394Options = {
  caen: '7912',
  phone: '0236123456',
  representative: { name: 'Popescu Ana', role: 'Administrator', address: 'Galați, Str. Lungă 10' },
  preparer: {
    kind: 'company',
    cui: '14399840',
    name: 'Contabil Exemplu SRL',
    capacity: 'Împuternicit',
  },
  consultation: true,
  affiliates: false,
};
type Artifact = {
  id: string;
  state: string;
  evidenceId: string;
  steps: { state: string; detail: string | null }[];
};
type WorkItem = {
  kind: string;
  subject: { id: string };
  severity: string;
  next: { operation: string; inputHint: Record<string, unknown> }[];
};
const lines = (proposal: ProposalView) =>
  proposal.effect?.lines.map((line) => `${line.side} ${line.account} ${line.amount}`);
const summary = (artifact: Artifact) => JSON.parse(artifact.steps[0]!.detail!);
const validated = (artifact: Artifact) => [
  artifact.state,
  artifact.state === 'validated_official' ? null : artifact.steps.at(-1)?.detail,
];

/** An invoice whose VAT breakdowns carry a reason (BT-120). */
const reasonXml = (input: XmlInput & { reason: string }) =>
  invoiceXml(input).replace(
    /(<cac:TaxSubtotal>.*?<cac:TaxCategory><cbc:ID>[EO]<\/cbc:ID>(?:<cbc:Percent>0<\/cbc:Percent>)?)/,
    `$1<cbc:TaxExemptionReason>${input.reason}</cbc:TaxExemptionReason>`,
  );

async function company(
  facts: Record<string, string>,
  revenueAccount: string,
  validator?: DeclarationValidator,
) {
  const s = await scenario({
    cui,
    clock: () => Date.parse('2026-11-10T10:00:00Z'),
    ...(validator ? { declarationValidator: validator } : {}),
  });
  open.push(s);
  for (const [axis, value] of Object.entries({
    'vat.status': 'normal_vat',
    'vat.period': 'monthly',
    ...facts,
  }))
    await s.invoke(s.owner, 'profile.record', {
      axis,
      value,
      effectiveFrom: '2026-01-01',
      evidenceId: (await s.evidence(`${axis}.pdf`)).id,
    });
  await s.invoke(s.owner, 'sales.seller.record', {
    details: {
      name: 'Exemplu Turism SRL',
      vatId: `RO${cui}`,
      address: { lines: ['Str. Lungă 10'], city: 'Galați', subdivision: 'RO-GL', country: 'RO' },
    },
  });
  const buyer = await s.party('Client Exemplu SRL', '14399840');
  await s.invoke(s.owner, 'parties.recordDetails', {
    partyId: buyer.id,
    details: {
      name: 'Client Exemplu SRL',
      vatId: 'RO14399840',
      address: { lines: ['Bd. Unirii 5'], city: 'Brașov', subdivision: 'RO-BV', country: 'RO' },
    },
  });
  const series = await s.invoke<{ id: string }>(s.owner, 'sales.series.create', {
    code: 'XF',
    prefix: 'XF',
    width: 4,
    revenueAccount,
  });
  const importXml = async (number: string, xml: string) =>
    s.invoke<{ id: string; partyId: string }>(s.owner, 'invoices.import', {
      evidenceId: (
        await s.invoke<{ id: string }>(s.owner, 'evidence.record', {
          filename: `${number}.xml`,
          mediaType: 'application/xml',
          base64: Buffer.from(xml).toString('base64'),
        })
      ).id,
    });
  /** Proposes, approves acknowledging the codes the reviewer confirms, and posts. */
  const post = async (proposal: ProposalView) => {
    expect(proposal.issues.filter((issue) => issue.severity === 'block')).toEqual([]);
    return s.post(
      await s.approve(
        proposal,
        s.reviewer,
        proposal.issues.filter((issue) => issue.severity === 'ack').map((issue) => issue.code),
      ),
    );
  };
  const book = async (treatment: string, input: unknown, basis?: { answers: string[] }) =>
    post(
      await s.invoke<ProposalView>(s.owner, 'proposals.propose', {
        treatment,
        input,
        ...(basis ? { basis } : {}),
      }),
    );
  const sale = (date: string) => ({ seriesId: series.id, buyerId: buyer.id, issueDate: date });
  const line = (name: string, price: string, reason?: string) => ({
    name,
    quantity: '1',
    unitCode: 'C62',
    price,
    vat: { category: 'E', ...(reason ? { exemptionReason: reason } : {}) },
  });
  const recognized = async (issued: Issued) =>
    s.invoke<ProposalView>(s.owner, 'proposals.get', { id: issued.recognition.proposalId });
  const prepare = (kind: 'D300' | 'D394', period = '2026-10') =>
    s.invoke<Artifact>(s.owner, 'declarations.prepare', {
      kind,
      period,
      options: kind === 'D300' ? d300Options : d394Options,
    });
  return { s, buyer, sale, line, importXml, post, book, recognized, prepare };
}

const kits = () =>
  new AnafKits({
    general: new DukIntegrator(dist),
    ...(saftInstalled ? { saft: new DukIntegrator(saftDist, saftKitId) } : {}),
  });

describe('margin.travel: a travel agency', () => {
  official(
    "a month of single services: the sale without VAT, the hotel's VAT not deducted, the period's margin on rd. 9, D300 and D394 pass ANAF's validator",
    async () => {
      const c = await company({}, '704', kits());
      const mention = 'regimul marjei - agenții de turism';
      // Issued without VAT: the scheme names its mention, which the preview requires.
      const plain = await c.s.invoke<Preview>(c.s.owner, 'sales.preview', {
        ...c.sale('2026-10-05'),
        lines: [c.line('Pachet turistic CT-1', '10000')],
        margin: { scheme: 'travel' },
      });
      expect(plain.problems.map((problem) => problem.code)).toContain('MARGIN_MENTION');
      const issued = await c.s.invoke<Issued>(c.s.owner, 'sales.issue', {
        ...c.sale('2026-10-05'),
        lines: [c.line('Pachet turistic CT-1', '10000', mention)],
        margin: { scheme: 'travel' },
      });
      const proposal = await c.recognized(issued);
      expect(proposal.treatment).toBe('margin.sale');
      expect(lines(await c.post(proposal))).toEqual(['D 4111 10000.00', 'C 704 10000.00']);

      // The hotel for the travellers: 21% VAT, not deducted (art. 311 alin. (6)).
      const hotel = await c.importXml(
        'H-1',
        invoiceXml({
          company: cui,
          number: 'H-1',
          date: '2026-10-08',
          counterparty: 'RO13548146',
          net: '6264.46',
          tax: '1315.54',
          gross: '7580.00',
        }),
      );
      expect(
        lines(
          await c.book('invoices.recognize', {
            documentId: hotel.id,
            account: '628',
            deduction: 'none',
          }),
        ),
      ).toEqual(['D 628 7580.00', 'C 401 7580.00']);

      // The month ended without a computation: the worklist asks for it.
      const [due] = (
        await c.s.invoke<{ items: WorkItem[] }>(c.s.owner, 'work.list', {
          kinds: ['margin.travel'],
        })
      ).items;
      expect([due!.subject.id, due!.severity, due!.next[0]!.inputHint.treatment]).toEqual([
        '2026-10',
        'warn',
        'margin.travel',
      ]);
      // And October's close warns of it.
      const findings = (
        await c.s.invoke<{ items: { details: { code: string; month: string } }[] }>(
          c.s.owner,
          'work.list',
          { kinds: ['close.finding'], limit: 200 },
        )
      ).items.map((item) => `${item.details.month} ${item.details.code}`);
      expect(findings).toContain('2026-10 TRAVEL_MARGIN_UNCOMPUTED');

      const evidenceId = (await c.s.evidence('situatie-marja-2026-10.pdf')).id;
      const input = {
        period: '2026-10',
        date: '2026-10-31',
        account: '704',
        evidenceId,
        trips: [
          {
            reference: 'CT-1',
            supplied: '2026-10-20',
            place: 'eu',
            sales: [issued.documentId],
            costs: [{ documentId: hotel.id }],
          },
        ],
      };
      const margin = await c.book('margin.travel', input);
      expect(lines(margin)).toEqual(['D 704 420.00', 'C 4427 420.00']);
      expect(
        (
          await c.s.invoke<{ items: WorkItem[] }>(c.s.owner, 'work.list', {
            kinds: ['margin.travel'],
          })
        ).items,
      ).toEqual([]);
      // A second computation cannot count the same documents again.
      const again = await c.s.invoke<ProposalView>(c.s.owner, 'proposals.propose', {
        treatment: 'margin.travel',
        input: { ...input, round: 2 },
      });
      expect(again.issues.map((issue) => issue.code)).toContain('TRAVEL_DOCUMENT_USED');

      const d300 = await c.prepare('D300');
      expect(summary(d300).rows).toMatchObject({
        R9_1: 2000,
        R9_2: 420,
        R22_1: 6264,
        R22_2: 1316,
      });
      expect(summary(d300).rows.R28_2).toBeUndefined();
      expect(validated(d300)).toEqual(['validated_official', null]);
      const d394 = await c.prepare('D394');
      expect(summary(d394).operations).toEqual([
        { type: 'A', rate: '21', partner: '13548146', invoices: 1, base: 6264, vat: 1316 },
        { type: 'LS', rate: '0', partner: '14399840', invoices: 1, base: 10000, vat: 0 },
      ]);
      const xml = Buffer.from(
        (await c.s.invoke<{ base64: string }>(c.s.owner, 'evidence.get', { id: d394.evidenceId }))
          .base64,
        'base64',
      ).toString();
      expect(xml).toContain('incasari_ag="10000" costuri_ag="7580" marja_ag="2000" tva_ag="420"');
      expect(validated(d394)).toEqual(['validated_official', null]);
    },
    120_000,
  );
});

describe('margin.purchase and margin.sale: a second-hand dealer', () => {
  official(
    "items bought from individuals, one sold at a margin and one at a loss: the register, D300 and D394 pass ANAF's validator; D406 stays UNSUPPORTED",
    async () => {
      const c = await company({ 'activity.goods': 'margin_goods' }, '707', kits());
      const individual = (number: string, net: string) =>
        c.importXml(
          number,
          invoiceXml({
            company: cui,
            number,
            date: '2026-10-02',
            counterparty: '1800101400016',
            category: 'O',
            net,
            tax: '0.00',
            gross: net,
          }),
        );
      const watch = await individual('AF-1', '1000.00');
      const bike = await individual('AF-2', '2000.00');
      for (const document of [watch, bike]) {
        const bought = await c.book('margin.purchase', {
          documentId: document.id,
          scheme: 'goods',
          goods: 'second_hand',
          supplier: 'individual',
        });
        expect(bought.issues.map((issue) => issue.code)).toContain('MARGIN_SELF_INVOICE');
      }
      const mention = 'regimul marjei - bunuri second-hand';
      const sell = async (name: string, price: string, purchaseDocumentId: string) => {
        const issued = await c.s.invoke<Issued>(c.s.owner, 'sales.issue', {
          ...c.sale('2026-10-15'),
          lines: [c.line(name, price, mention)],
          margin: { scheme: 'goods', items: [{ purchaseDocumentId, price }] },
        });
        return c.post(await c.recognized(issued));
      };
      expect(lines(await sell('Ceas de mână', '1500', watch.id))).toEqual([
        'D 4111 1500.00',
        'C 707 1413.22',
        'C 4427 86.78',
        'D 607 1000.00',
        'C 371 1000.00',
      ]);
      expect(lines(await sell('Bicicletă', '1800', bike.id))).toEqual([
        'D 4111 1800.00',
        'C 707 1800.00',
        'D 607 2000.00',
        'C 371 2000.00',
      ]);
      // An item sold already cannot be sold again (a November invoice, outside October's D394).
      const third = await c.s.invoke<Issued>(c.s.owner, 'sales.issue', {
        ...c.sale('2026-11-03'),
        lines: [c.line('Ceas de mână', '1600', mention)],
        margin: { scheme: 'goods', items: [{ purchaseDocumentId: watch.id, price: '1600' }] },
      });
      expect((await c.recognized(third)).issues.map((issue) => issue.code)).toContain(
        'MARGIN_ITEM_SOLD',
      );
      await c.s.invoke(c.s.owner, 'proposals.withdraw', {
        proposalId: third.recognition.proposalId,
        reason: 'Bunul a fost vândut deja; factura se stornează.',
      });

      const register = await c.s.invoke<{
        items: { state: string; purchase: { cost: string }; sale: { vat: string } | null }[];
        periods: {
          period: string;
          rate: string;
          supplies: number;
          sales: string;
          costs: string;
          base: string;
          vat: string;
        }[];
      }>(c.s.owner, 'margin.goods.register', {});
      expect(
        register.items.map((item) => [item.purchase.cost, item.state, item.sale?.vat]),
      ).toEqual([
        ['1000.00', 'sold', '86.78'],
        ['2000.00', 'sold', '0.00'],
      ]);
      expect(register.periods).toEqual([
        {
          period: '2026-10',
          rate: '21',
          supplies: 2,
          sales: '3300.00',
          costs: '3000.00',
          base: '413.22',
          vat: '86.78',
        },
      ]);

      const d300 = await c.prepare('D300');
      expect(summary(d300).rows).toMatchObject({ R9_1: 413, R9_2: 87, R26_1: 3000 });
      expect(validated(d300)).toEqual(['validated_official', null]);
      const d394 = await c.prepare('D394');
      expect(summary(d394).operations).toEqual([
        { type: 'LS', rate: '0', partner: '14399840', invoices: 2, base: 3300, vat: 0 },
        {
          type: 'N',
          rate: '0',
          partner: 'Companie 1800101400016',
          invoices: 2,
          base: 3000,
          vat: 0,
        },
      ]);
      const xml = Buffer.from(
        (await c.s.invoke<{ base64: string }>(c.s.owner, 'evidence.get', { id: d394.evidenceId }))
          .base64,
        'base64',
      ).toString();
      // The margin is the difference of the prices, VAT included (OPANAF nr. 3.769/2015 anexa nr.
      // 2 secțiunea 1 lit. I pct. 6.2): 3,300 − 3,000 lei, the item sold at a loss included; the
      // VAT is that of the item sold at a margin.
      expect(xml).toContain(
        'pret_vanzare="3300" pret_cumparare="3000" marja_antic="300" tva_antic="87"',
      );
      expect(validated(d394)).toEqual(['validated_official', null]);

      // The closure: covered for D300 and D394, the D406 of the month UNSUPPORTED.
      const closure = await c.s.invoke<{ unsupported: { trigger: string }[] }>(
        c.s.owner,
        'closure.evaluate',
        { from: '2026-10', to: '2026-10' },
      );
      const triggers = closure.unsupported.map((item) => item.trigger);
      expect(triggers).toContain('MARGIN_SCHEME_D406');
      expect(triggers).not.toContain('GOODS_STOCK');
      // And D406 itself refuses the margin's codes rather than guess one.
      const saft = await c.s.refused(
        c.s.invoke(c.s.owner, 'declarations.prepare', {
          kind: 'D406',
          period: '2026-10',
          options: { contact: { firstName: 'Ana', lastName: 'Popescu', phone: '0236000000' } },
        }),
      );
      expect(JSON.stringify(saft)).toContain('MS-312');
    },
    120_000,
  );

  // The register showed every caller the CNP the invoice of an individual states, and the VAT
  // journal the individual's keyed identifier (5 November 2026).
  test('a purchase from an individual: the register and the VAT journal show the CNP and its keyed hash to no agent', async () => {
    const c = await company({ 'activity.goods': 'margin_goods' }, '707');
    const code = '1800101400016';
    const document = await c.importXml(
      'AF-1',
      invoiceXml({
        company: cui,
        number: 'AF-1',
        date: '2026-10-02',
        counterparty: code,
        category: 'O',
        net: '1000.00',
        tax: '0.00',
        gross: '1000.00',
      }),
    );
    await c.book('margin.purchase', {
      documentId: document.id,
      scheme: 'goods',
      goods: 'second_hand',
      supplier: 'individual',
    });
    const grant = await c.s.invoke<{ token: string }>(c.s.reviewer, 'agents.issue', {
      name: 'Asistent',
      scopes: ['margin.goods.register', 'vat.journal'],
      expiresAt: c.s.expiresIn(7),
    });
    const agent = await c.s.engine.agents.authenticate(grant.token, c.s.company.id);
    type Register = { items: { purchase: { supplierTaxId: string } }[] };
    const supplier = async (actor: typeof agent) =>
      (await c.s.invoke<Register>(actor, 'margin.goods.register', {})).items[0]!.purchase
        .supplierTaxId;
    // Compared, not printed: a failure would print the CNP.
    expect((await supplier(c.s.owner)) === code).toBe(true);
    expect(await supplier(agent)).toBe('*************');
    expect(await supplier(c.s.viewer)).toBe('*************');
    type Journal = { rows: { counterpartyTaxId: string | null }[] };
    const journal = async (actor: typeof agent) =>
      (
        await c.s.invoke<Journal>(actor, 'vat.journal', {
          direction: 'input',
          from: '2026-10',
          to: '2026-10',
        })
      ).rows.map((row) => row.counterpartyTaxId);
    expect((await journal(c.s.owner)).every((id) => id?.startsWith('cnp:k1:'))).toBe(true);
    expect(await journal(agent)).toEqual((await journal(c.s.owner)).map(() => '*************'));
  });
});

describe('invoices.flatRate: a purchase from a farmer', () => {
  official(
    "the compensation deducted once the register answer covers the supply: D300 rd. 27 and 31, D394 N, pass ANAF's validator",
    async () => {
      const c = await company({}, '704', kits());
      const farmer = await c.importXml(
        'AGR-7',
        reasonXml({
          company: cui,
          number: 'AGR-7',
          date: '2026-10-12',
          counterparty: '41287658',
          category: 'O',
          net: '10800.00',
          tax: '0.00',
          gross: '10800.00',
          taxes: [{ rate: '0', net: '10800.00', tax: '0.00' }],
          lines: [
            { rate: '0', net: '10000.00', name: 'Legume' },
            { rate: '0', net: '800.00', name: 'Compensație în cotă forfetară 8%' },
          ],
          reason: 'Regim special pentru agricultori',
        }),
      );
      const input = {
        documentId: farmer.id,
        parts: [{ account: '6028', amount: '10000.00' }],
        deduction: 'full',
      };
      const asked = await c.s.invoke<ProposalView>(c.s.owner, 'proposals.propose', {
        treatment: 'invoices.flatRate',
        input,
      });
      const issue = asked.issues.find((item) => item.code === 'FLAT_RATE_REGISTER')!;
      const request = (issue.details as { question: Record<string, unknown> }).question;
      const question = await c.s.invoke<{ id: string }>(c.s.owner, 'questions.ask', request);
      await c.s.invoke(c.s.owner, 'questions.answer', {
        questionId: question.id,
        value: {
          registered: true,
          from: '2025-03-01',
          evidenceId: (await c.s.evidence('registrul-agricultorilor.pdf')).id,
        },
      });
      const revised = await c.s.invoke<ProposalView>(c.s.owner, 'proposals.revise', {
        proposalId: asked.id,
        version: asked.version,
        input,
        basis: { answers: [question.id] },
      });
      expect(lines(await c.post(revised))).toEqual([
        'D 6028 10000.00',
        'D 4426 800.00',
        'C 401 10800.00',
      ]);

      const d300 = await c.prepare('D300');
      expect(summary(d300).rows).toMatchObject({ R43_2: 800, R28_2: 800, R26_1: 10000 });
      expect(validated(d300)).toEqual(['validated_official', null]);
      const d394 = await c.prepare('D394');
      expect(summary(d394).operations).toEqual([
        {
          type: 'N',
          rate: '0',
          partner: 'Companie 41287658',
          invoices: 1,
          base: 10000,
          vat: 0,
        },
      ]);
      expect(validated(d394)).toEqual(['validated_official', null]);

      // D406: the compensation on ANAF's row for the flat rate (Achizitii ded 100% 308301).
      if (!saftInstalled) return;
      const address = { lines: ['Str. Morii 3'], city: 'Galați', subdivision: 'RO-GL' };
      await c.s.invoke(c.s.owner, 'parties.recordDetails', {
        partyId: farmer.partyId,
        details: {
          name: 'Companie 41287658',
          legalId: '41287658',
          address: { ...address, country: 'RO' },
        },
      });
      await c.s.invoke(c.s.owner, 'treasury.createAccount', {
        kind: 'bank',
        name: 'Cont curent',
        iban,
        currency: 'RON',
        ledgerAccount: '5121',
        openedOn: '2026-01-01',
      });
      // The file holds at least one customer: a sale of the month.
      const sold = await c.s.invoke<Issued>(c.s.owner, 'sales.issue', {
        ...c.sale('2026-10-20'),
        lines: [
          {
            name: 'Servicii',
            quantity: '1',
            unitCode: 'C62',
            price: '1000',
            vat: { category: 'S', rate: '21' },
          },
        ],
      });
      await c.post(await c.recognized(sold));
      const saft = await c.s.invoke<Artifact>(c.s.owner, 'declarations.prepare', {
        kind: 'D406',
        period: '2026-10',
        options: { contact: { firstName: 'Ana', lastName: 'Popescu', phone: '0236000000' } },
      });
      expect(validated(saft)).toEqual(['validated_official', null]);
      const codes = [
        ...Buffer.from(
          (await c.s.invoke<{ base64: string }>(c.s.owner, 'evidence.get', { id: saft.evidenceId }))
            .base64,
          'base64',
        )
          .toString()
          .matchAll(/<nsSAFT:TaxCodeDetails>\s*<nsSAFT:TaxCode>(\d+)</g),
      ].map((match) => match[1]);
      expect(codes).toEqual(['308301', '310344']);
    },
    120_000,
  );

  test('the agent module names its documents, questions and detectors', () => {
    expect(schemesAgent.documentTypes.map((item) => item.id)).toEqual([
      'margin.travel.invoice',
      'travel.cost.invoice',
      'travel.computation',
      'margin.self.invoice',
      'margin.dealer.invoice',
      'margin.goods.invoice',
      'farmer.invoice',
      'farmer.register.extract',
    ]);
    expect(schemesAgent.questions.map((item) => item.kind)).toEqual([
      'farmer.register',
      'profile.fact',
    ]);
    expect(schemesAgent.detectors[0]!.kind).toBe('margin.travel');
  });
});

describe('the margin scheme after a storno', () => {
  const d394Options = {
    caen: '4779',
    phone: '0236123456',
    representative: {
      name: 'Popescu Ana',
      role: 'Administrator',
      address: 'Galați, Str. Lungă 10',
    },
    preparer: {
      kind: 'company',
      cui: '14399840',
      name: 'Contabil Exemplu SRL',
      capacity: 'Împuternicit',
    },
    consultation: true,
    affiliates: false,
  };
  const d300Options = {
    declarant: { lastName: 'Popescu', firstName: 'Ana', role: 'Administrator' },
    caen: '4779',
    bank: 'Banca Exemplu',
    account: 'RO49AAAA1B31007593840000',
  };
  type Artifact = { state: string; steps: { state: string; detail: string | null }[] };
  const summary = (artifact: Artifact) => JSON.parse(artifact.steps[0]!.detail!);

  // A storno negates the amounts its tax entries' attributes hold (`signedAttributes`): D394
  // sums an item's `price` and `cost`, so the sale and its storno cancel out.
  test('a margin sale reversed in the period leaves no LS operation in D394', async () => {
    const s = await scenario({ cui, clock: () => Date.parse('2026-11-10T10:00:00Z') });
    open.push(s);
    for (const [axis, value] of Object.entries({
      'vat.status': 'normal_vat',
      'vat.period': 'monthly',
      'activity.goods': 'margin_goods',
      'policy.storno': 'black',
    }))
      await s.invoke(s.owner, 'profile.record', {
        axis,
        value,
        effectiveFrom: '2026-01-01',
        evidenceId: (await s.evidence(`${axis}.pdf`)).id,
      });
    await s.invoke(s.owner, 'sales.seller.record', {
      details: {
        name: 'Exemplu SRL',
        vatId: `RO${cui}`,
        address: { lines: ['Str. Lungă 10'], city: 'Galați', subdivision: 'RO-GL', country: 'RO' },
      },
    });
    const buyer = await s.party('Client Exemplu SRL', '14399840');
    await s.invoke(s.owner, 'parties.recordDetails', {
      partyId: buyer.id,
      details: {
        name: 'Client Exemplu SRL',
        vatId: 'RO14399840',
        address: { lines: ['Bd. Unirii 5'], city: 'Brașov', subdivision: 'RO-BV', country: 'RO' },
      },
    });
    const series = await s.invoke<{ id: string }>(s.owner, 'sales.series.create', {
      code: 'XF',
      prefix: 'XF',
      width: 4,
      revenueAccount: '707',
    });
    const post = async (proposal: ProposalView) => {
      expect(proposal.issues.filter((issue) => issue.severity === 'block')).toEqual([]);
      return s.post(
        await s.approve(
          proposal,
          s.reviewer,
          proposal.issues.filter((issue) => issue.severity === 'ack').map((issue) => issue.code),
        ),
      );
    };
    const xml = invoiceXml({
      company: cui,
      number: 'AF-1',
      date: '2026-10-02',
      counterparty: '1800101400016',
      category: 'O',
      net: '1000.00',
      tax: '0.00',
      gross: '1000.00',
    });
    const watch = await s.invoke<{ id: string }>(s.owner, 'invoices.import', {
      evidenceId: (
        await s.invoke<{ id: string }>(s.owner, 'evidence.record', {
          filename: 'AF-1.xml',
          mediaType: 'application/xml',
          base64: Buffer.from(xml).toString('base64'),
        })
      ).id,
    });
    await post(
      await s.invoke<ProposalView>(s.owner, 'proposals.propose', {
        treatment: 'margin.purchase',
        input: {
          documentId: watch.id,
          scheme: 'goods',
          goods: 'second_hand',
          supplier: 'individual',
        },
      }),
    );
    const mention = 'regimul marjei - bunuri second-hand';
    const issued = await s.invoke<Issued>(s.owner, 'sales.issue', {
      seriesId: series.id,
      buyerId: buyer.id,
      issueDate: '2026-10-15',
      lines: [
        {
          name: 'Ceas',
          quantity: '1',
          unitCode: 'C62',
          price: '1500',
          vat: { category: 'E', exemptionReason: mention },
        },
      ],
      margin: { scheme: 'goods', items: [{ purchaseDocumentId: watch.id, price: '1500' }] },
    });
    const sold = await post(
      await s.invoke<ProposalView>(s.owner, 'proposals.get', { id: issued.recognition.proposalId }),
    );
    // The sale is reversed (black storno) in the same month.
    const reversed = await s.propose('ledger.reverse', {
      entryId: sold.entry!.id,
      date: '2026-10-20',
      reason: 'Factura emisă din greșeală',
      evidenceId: (await s.evidence('storno.pdf')).id,
    });
    await post(reversed);

    const d300 = await s.invoke<Artifact>(s.owner, 'declarations.prepare', {
      kind: 'D300',
      period: '2026-10',
      options: d300Options,
    });
    // The sale and its reversal net to nothing on rd. 9.
    expect(summary(d300).rows.R9_1 ?? 0).toBe(0);
    expect(summary(d300).rows.R9_2 ?? 0).toBe(0);
    const d394 = await s.invoke<Artifact>(s.owner, 'declarations.prepare', {
      kind: 'D394',
      period: '2026-10',
      options: d394Options,
    });
    // No LS operation: the sale and its storno cancel out, and so do the margins' fields.
    expect(summary(d394).operations.filter((op: { type: string }) => op.type === 'LS')).toEqual([]);
  });
});
