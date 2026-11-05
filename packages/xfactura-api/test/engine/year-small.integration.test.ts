import { afterAll, describe, expect, test } from 'bun:test';
import path from 'node:path';
import {
  AnafKits,
  DukIntegrator,
  saftKitId,
} from '../../source/engine/adapters/declaration-validator';
import type { ActionView } from '../../source/engine/kernel/actions';
import type { Actor } from '../../source/engine/kernel/commands';
import { wireError } from '../../source/engine/kernel/errors';
import type { ProposalView } from '../../source/engine/kernel/views';
import type { WorkItem } from '../../source/engine/kernel/work';
import { FakeTaxpayers } from './fakes/anaf-taxpayers';
import { answerAnnual } from './fixtures/annual';
import { invoiceXml, type XmlInput } from './fixtures/invoice';
import { scenario, type Scenario } from './scenario';

/*
 * Whole years of three small companies, kept the way Phase 1's exit keeps four months: an agent
 * holding a scoped grant does the books' work through the agent operations (files, imports,
 * proposals, posting what people approved, returns from the worklist's steps, closes), invoked as
 * REST and MCP invoke them, under the grant; people do only what the engine reserves to a person
 * (the company's configuration, answers, approvals and reviewed actions). Every return the
 * closure lists is prepared from the books and run through ANAF's own validators; where ANAF has
 * published no structure the return is an explicit FORMAT_GAP, and where the engine cannot write
 * one yet the closure says so (UNSUPPORTED) and the writer's refusal is asserted by its code. Every
 * month and the year close with no blocking item on the worklist but those named.
 * Every party, number and amount is synthetic and the expected figures are worked by hand in the
 * comments, never by the engine.
 */

const root = path.join(import.meta.dir, '../../../..');
const generalKit = path.join(root, '.validators/anaf/dist');
const saftKit = path.join(root, '.validators/anaf-saft/duk_SAFT_an_luna/dist');
const installed =
  DukIntegrator.available(generalKit) &&
  DukIntegrator.available(saftKit) &&
  Bun.which('java') !== null;
// Without ANAF's kits the years are skipped, never passed: their point is `validated_official`.
const official = installed ? describe : describe.skip;
const kits = () =>
  new AnafKits({ general: new DukIntegrator(generalKit), saft: new DukIntegrator(saftKit) });

const open: Scenario[] = [];
afterAll(async () => {
  await Promise.all(open.map((s) => s.dispose()));
});

// Synthetic identifiers with valid control digits.

/** A CUI: its control digit over the key 753217532 (OMFP nr. 1.180/2003 anexa). */
function cui(body: string) {
  const key = [7, 5, 3, 2, 1, 7, 5, 3, 2];
  const digits = body.padStart(9, '0').split('').map(Number);
  const control = (digits.reduce((sum, digit, index) => sum + digit * key[index]!, 0) * 10) % 11;
  return `${body}${control === 10 ? 0 : control}`;
}
/** A CNP: its control digit over the key 279146358279. */
function cnp(body: string) {
  const weights = [2, 7, 9, 1, 4, 6, 3, 5, 8, 2, 7, 9];
  const control =
    weights.reduce((sum, weight, index) => sum + weight * Number(body[index]), 0) % 11;
  return `${body}${control === 10 ? 1 : control}`;
}
/** An IBAN of a Romanian bank code and account: its two check digits (ISO 13616). */
function iban(bank: string, account: string) {
  const bban = `${bank}${account}`;
  const digits = `${bban}RO00`.replace(/[A-Z]/g, (letter) => String(letter.charCodeAt(0) - 55));
  const check = 98n - (BigInt(digits) % 97n);
  return `RO${String(check).padStart(2, '0')}${bban}`;
}

// Dates and money.

const months = Array.from(
  { length: 12 },
  (_, index) => `2026-${String(index + 1).padStart(2, '0')}`,
);
const lastDay = (month: string) => {
  const [year, mm] = month.split('-').map(Number);
  return `${month}-${String(new Date(Date.UTC(year!, mm!, 0)).getUTCDate()).padStart(2, '0')}`;
};
const nextMonth = (month: string) => {
  const [year, mm] = month.split('-').map(Number);
  return mm === 12 ? `${year! + 1}-01` : `${year}-${String(mm! + 1).padStart(2, '0')}`;
};
const cents = (amount: string) =>
  BigInt(amount.replace('-', '').replace('.', '')) * (amount.startsWith('-') ? -1n : 1n);
const money = (bani: bigint) => {
  const sign = bani < 0n ? '-' : '';
  const value = bani < 0n ? -bani : bani;
  return `${sign}${value / 100n}.${String(value % 100n).padStart(2, '0')}`;
};
/** The last day of a month, a quarter or a year. */
const periodEnd = (period: string) =>
  /^\d{4}$/.test(period)
    ? `${period}-12-31`
    : /Q\d$/.test(period)
      ? lastDay(`${period.slice(0, 4)}-${String(Number(period.slice(6)) * 3).padStart(2, '0')}`)
      : lastDay(period);
const sum = (amounts: string[]) =>
  money(amounts.reduce((total, amount) => total + cents(amount), 0n));

/** BNR's reference rates, one cube per calendar day (a synthetic series: the rate of each month
 * on every day of it, so no date reads a rate older than the 7 days the register allows). */
function bnrRates(eur: (date: string) => string, from: string, to: string) {
  const cubes: string[] = [];
  for (
    let at = Date.parse(`${from}T00:00:00Z`);
    at <= Date.parse(`${to}T00:00:00Z`);
    at += 86_400_000
  ) {
    const date = new Date(at).toISOString().slice(0, 10);
    cubes.push(`<Cube date="${date}"><Rate currency="EUR">${eur(date)}</Rate></Cube>`);
  }
  return `<?xml version="1.0" encoding="utf-8"?>
<DataSet xmlns="http://www.bnr.ro/xsd"><Header><Publisher>National Bank of Romania</Publisher><PublishingDate>${to}</PublishingDate><MessageType>DR</MessageType></Header>
<Body><Subject>Reference rates</Subject><OrigCurrency>RON</OrigCurrency>
${cubes.join('\n')}
</Body></DataSet>`;
}

/** A bank's MT940 statement of a month: each row a credit (positive) or debit (negative). */
function mt940(input: {
  iban: string;
  currency: string;
  month: string;
  opening: string;
  rows: { date: string; amount: string; reference: string; text: string }[];
}) {
  const yymmdd = (date: string) => date.slice(2).replace(/-/g, '');
  const mmdd = (date: string) => date.slice(5).replace('-', '');
  const amount = (value: string) => value.replace('-', '').replace('.', ',');
  const closing = sum([input.opening, ...input.rows.map((row) => row.amount)]);
  const lines = [
    `:20:${input.currency}${input.month.replace('-', '')}`,
    `:25:${input.iban}`,
    ':28C:001/001',
    `:60F:C${yymmdd(`${input.month}-01`)}${input.currency}${amount(input.opening)}`,
    ...input.rows.flatMap((row, index) => [
      `:61:${yymmdd(row.date)}${mmdd(row.date)}${row.amount.startsWith('-') ? 'D' : 'C'}${amount(row.amount)}NTRF${row.reference}//${input.currency}-${input.month}-${index + 1}`,
      `:86:${row.text}`,
    ]),
    `:62F:C${yymmdd(lastDay(input.month))}${input.currency}${amount(closing)}`,
  ];
  return { text: lines.join('\n'), closing };
}

type Artifact = {
  id: string;
  kind: string;
  period: string;
  format: string;
  state: string;
  xmlHash: string;
  steps: { state: string; actor: string | null; detail: string | null }[];
};
type Closure = {
  status: string;
  obligations: {
    kind: string;
    period: string;
    state: string;
    rule: string;
    blockers: string[];
  }[];
  needs: { code: string; fact: string; question: { kind: string; subject?: unknown } }[];
  unsupported: { trigger: string; message?: string; missing?: unknown }[];
};
type Movement = { id: string; amount: string; currency: string; reference: string; state: string };
type Asked = {
  kind: string;
  subject: { kind: string; id: string };
  questionId: string;
  reused: boolean;
};
type Determination = {
  axis: string;
  status: string;
  value: string | null;
  effectiveFrom: string;
  changes: { value: string; effectiveFrom: string }[];
  lines: string[];
  recorded: { agrees: boolean | null; confirmed: boolean };
};

const lines = (proposal: ProposalView) =>
  proposal.effect?.lines.map((line) => `${line.side} ${line.account} ${line.amount}`);
const taxes = (proposal: ProposalView) =>
  proposal.effect?.taxEntries.map(
    (entry) => `${entry.direction} ${entry.code} ${entry.base} ${entry.amount}`,
  );
const summaryOf = <T = Record<string, unknown>>(artifact: Artifact) =>
  JSON.parse(artifact.steps[0]!.detail ?? 'null') as T;
const declarant = { lastName: 'Popescu', firstName: 'Ana', role: 'Administrator' };

/**
 * A company's books on a fresh engine with ANAF's validators: the owner configures it, a
 * bookkeeping agent holds a grant over the books' toolsets, the reviewer approves.
 */
async function books(options: {
  cui: string;
  name: string;
  year?: number;
  today: string;
  /** The Romanian suppliers ANAF's registers know, each a VAT payer in good standing. */
  suppliers?: string[];
}) {
  let now = Date.parse(`${options.today}T09:00:00Z`);
  const taxpayers = new FakeTaxpayers();
  for (const supplier of options.suppliers ?? []) taxpayers.taxpayer(supplier);
  const s = await scenario({
    year: options.year ?? 2026,
    cui: options.cui,
    name: options.name,
    clock: () => now,
    declarationValidator: kits(),
    taxpayers,
  });
  open.push(s);
  /** The owner issues the agent's grant, at most 90 days long, and renews it each quarter. */
  let issued = now;
  const issue = async () => {
    issued = now;
    const grant = await s.invoke<{ id: string; token: string; scopes: string[] }>(
      s.owner,
      'agents.issue',
      {
        name: 'Agent contabil',
        scopes: [
          'toolset:inbox',
          'toolset:bank',
          'toolset:books',
          'toolset:review',
          'toolset:close',
          'toolset:tax',
          'toolset:payroll',
          'toolset:reference',
          'parties.checkStatus',
        ],
        expiresAt: new Date(now + 89 * 86_400_000).toISOString(),
      },
    );
    return s.engine.agents.authenticate(grant.token, s.company.id);
  };
  let agent: Actor = await issue();
  const detailed = new Set<string>();
  const as = {
    s,
    get agent() {
      return agent;
    },
    today: () => new Date(now).toISOString().slice(0, 10),
    async at(date: string) {
      now = Date.parse(`${date}T09:00:00Z`);
      // Before the grant ends, the owner issues the next one.
      if (now - issued > 60 * 86_400_000) agent = await issue();
    },
    /** The owner states a fact, with its document. */
    async fact(axis: string, value: string, effectiveFrom: string, file?: string) {
      const evidenceId = (await s.evidence(file ?? `${axis}-${value}-${effectiveFrom}.pdf`)).id;
      await s.invoke(s.owner, 'profile.record', { axis, value, effectiveFrom, evidenceId });
      return { evidenceId };
    },
    /** A file the agent records as evidence. */
    async file(filename: string, text: string, mediaType = 'application/xml') {
      return (
        await s.invoke<{ id: string }>(agent, 'evidence.record', {
          filename,
          mediaType,
          base64: Buffer.from(text).toString('base64'),
        })
      ).id;
    },
    /** An e-Factura invoice the agent imports; the partner's invoicing details recorded the
     * first time (its address, which D406 reports and the UBL here leaves out). */
    async invoice(input: XmlInput) {
      const imported = await s.invoke<{ id: string; partyId: string }>(agent, 'invoices.import', {
        evidenceId: await as.file(
          `${input.number}.xml`,
          invoiceXml({ company: options.cui, ...input }),
        ),
      });
      if (!detailed.has(imported.partyId)) {
        detailed.add(imported.partyId);
        const code = input.counterparty ?? '87654321';
        const country = input.country ?? 'RO';
        const consumer = /^0+$/.test(code);
        await s.invoke(agent, 'parties.recordDetails', {
          partyId: imported.partyId,
          details: {
            name: consumer ? 'Client persoană fizică' : `Companie ${code}`,
            ...(consumer
              ? { legalId: code }
              : { vatId: /^[A-Z]{2}/.test(code) ? code : `${country}${code}` }),
            address: addresses[country] ?? { lines: ['Hauptstraße 1'], city: 'Berlin', country },
          },
        });
      }
      return imported;
    },
    /** The agent proposes; the reviewer approves the exact version, acknowledging exactly the
     * warnings named; the agent posts it. */
    async book(treatment: string, input: unknown, acknowledge: string[] = [], basis?: unknown) {
      const proposal = await s.invoke<ProposalView>(agent, 'proposals.propose', {
        treatment,
        input,
        ...(basis ? { basis } : {}),
      });
      return as.settle(proposal, acknowledge);
    },
    async settle(proposal: ProposalView, acknowledge: string[] = []) {
      const blocking = proposal.issues.filter((issue) => issue.severity === 'block');
      expect(
        blocking.map((issue) => `${issue.code}: ${issue.message}`),
        proposal.treatment,
      ).toEqual([]);
      expect(
        proposal.issues
          .filter((issue) => issue.severity === 'ack')
          .map((issue) => issue.code)
          .sort(),
        `${proposal.treatment} ${proposal.subject}`,
      ).toEqual([...acknowledge].sort());
      const approved = await s.approve(proposal, s.reviewer, acknowledge);
      return s.invoke<ProposalView>(agent, 'ledger.post', {
        proposalId: approved.id,
        version: approved.version,
        effectHash: approved.effectHash,
      });
    },
    /** A month's statement the agent imports; its movements by reference. */
    async statement(input: Parameters<typeof mt940>[0]) {
      const { text, closing } = mt940(input);
      const evidenceId = await as.file(
        `extras-${input.currency}-${input.month}.sta`,
        text,
        'text/plain',
      );
      await s.invoke(agent, 'bank.import', { evidenceId, financialYearId: s.year.id });
      const movements = await s.list<Movement>(agent, 'bank.movements', {
        from: `${input.month}-01`,
        to: lastDay(input.month),
      });
      return { closing, movements: movements.filter((item) => item.currency === input.currency) };
    },
    /** The return, prepared by the agent from the books, and ANAF's verdict on it. */
    async prepare(kind: string, period: string, extra: Record<string, unknown> = {}) {
      return s.invoke<Artifact>(agent, 'declarations.prepare', { kind, period, options: extra });
    },
    /** The returns the worklist says are due for periods that ended, each prepared by the agent
     * from its step (`declarations.prepare`) with the options it knows; what each came to. */
    async returns(
      options: Record<
        string,
        Record<string, unknown> | ((period: string) => Record<string, unknown>)
      >,
    ) {
      const results: { key: string; artifact?: Artifact; code?: string; message?: string }[] = [];
      for (const item of await as.work({ kinds: ['obligation.due'] })) {
        const step = item.next.find(
          (next) =>
            next.operation === 'declarations.prepare' && next.by === 'agent' && next.allowed,
        );
        const period = String(item.details.period);
        if (!step || periodEnd(period) >= as.today()) continue;
        const kind = String(step.inputHint.kind);
        try {
          const given = options[kind] ?? {};
          const artifact = await s.invoke<Artifact>(agent, 'declarations.prepare', {
            ...step.inputHint,
            options: typeof given === 'function' ? given(period) : given,
          });
          results.push({ key: `${kind} ${period}`, artifact });
        } catch (error) {
          const wire = wireError(error).error;
          results.push({ key: `${kind} ${period}`, code: wire.code, message: wire.message });
        }
      }
      return results;
    },
    /** A person authorizes a return on its exact XML (a reviewed action). */
    async authorize(artifactId: string) {
      const request = await s.invoke<ActionView>(s.owner, 'declarations.authorize.request', {
        artifactId,
      });
      expect((request.preview as { findings: unknown[] }).findings).toEqual([]);
      await s.invoke(s.reviewer, 'actions.approve', {
        id: request.id,
        previewHash: request.previewHash,
      });
      return s.invoke<ActionView>(agent, 'actions.execute', { id: request.id });
    },
    /** Everything on the worklist at the engine's time, page by page. */
    async work(input: Record<string, unknown> = {}) {
      const items: WorkItem[] = [];
      let after: string | undefined;
      for (let page = 0; page < 50; page++) {
        const result = await s.invoke<{ items: WorkItem[]; next: string | null }>(
          s.owner,
          'work.list',
          { limit: 200, ...input, ...(after ? { after } : {}) },
        );
        items.push(...result.items);
        if (!result.next) break;
        after = result.next;
      }
      return items;
    },
    /** A month's close: requested by the agent from the worklist's step once nothing blocks,
     * approved by the reviewer on its preview, executed by the agent. */
    async close(month: string, known: string[] = []) {
      // The month's suppliers checked at ANAF, as the close's finding asks (parties.checkStatus).
      for (const item of await as.work({ kinds: ['close.finding'] })) {
        const step = item.next.find(
          (next) => next.operation === 'parties.checkStatus' && next.by === 'agent' && next.allowed,
        );
        if (step) await s.invoke(agent, step.operation, step.inputHint);
      }
      expect(
        (await as.work({ severity: 'block' })).map((item) => `${item.kind} ${item.subject.id}`),
        `the worklist before closing ${month}`,
      ).toEqual(known);
      const step = (await as.work({ kinds: ['period.unclosed'] }))
        .find((item) => item.subject.id === month)
        ?.next.find((next) => next.operation === 'periods.close.request');
      expect(step, `period.unclosed ${month}`).toBeDefined();
      const request = await s.invoke<ActionView>(agent, 'periods.close.request', step!.inputHint);
      const findings = (request.preview as { findings: { code: string; severity: string }[] })
        .findings;
      expect(
        findings.filter((finding) => finding.severity === 'block').map((finding) => finding.code),
        `closing ${month}`,
      ).toEqual([]);
      await s.invoke(s.reviewer, 'actions.approve', {
        id: request.id,
        previewHash: request.previewHash,
      });
      const executed = await s.invoke<ActionView>(agent, 'actions.execute', { id: request.id });
      expect(executed.status).toBe('executed');
      return findings;
    },
    /** The agent opens the year's determinations; the person answers each question from what
     * only they know (`answers`, by kind and subject), then confirms the computations. */
    async determine(year: number, answers: (asked: Asked) => unknown) {
      const seen = new Set<string>();
      for (let round = 0; round < 6; round++) {
        const proposed = await s.invoke<{ asked: Asked[] }>(agent, 'determinations.propose', {
          year,
        });
        const open = proposed.asked.filter((item) => !item.reused && !seen.has(item.questionId));
        if (!open.length) return;
        for (const item of open) {
          seen.add(item.questionId);
          const value = item.kind === 'determination.confirm' ? { confirm: true } : answers(item);
          if (value === undefined) throw new Error(`No answer for ${item.kind} ${item.subject.id}`);
          await s.invoke(s.reviewer, 'questions.answer', { questionId: item.questionId, value });
        }
      }
      throw new Error(`The determinations of ${year} did not settle.`);
    },
    evaluate: async (year: number) =>
      (
        await s.invoke<{ determinations: Determination[] }>(agent, 'determinations.evaluate', {
          year,
        })
      ).determinations,
    closure: (from: string, to: string) =>
      s.invoke<Closure>(agent, 'closure.evaluate', { from, to }),
    trialBalance: (from?: string, to?: string) =>
      s.invoke<{
        rows: {
          account: string;
          opening: { debit: string; credit: string };
          current: { debit: string; credit: string };
          closing: { debit: string; credit: string };
        }[];
        totals: Record<string, { debit: string; credit: string }>;
      }>(agent, 'ledger.trialBalance', {
        financialYearId: s.year.id,
        ...(from ? { from } : {}),
        ...(to ? { to } : {}),
      }),
    /** An account's closing balance, debit positive. */
    async balance(account: string, to?: string) {
      const row = (await as.trialBalance(undefined, to)).rows.find(
        (item) => item.account === account,
      );
      return row ? money(cents(row.closing.debit) - cents(row.closing.credit)) : '0.00';
    },
  };
  return as;
}
type Books = Awaited<ReturnType<typeof books>>;

/** Partners' synthetic addresses, by country. */
const addresses: Record<
  string,
  { lines: string[]; city: string; subdivision?: string; country: string }
> = {
  RO: { lines: ['Str. Mare 1'], city: 'Cluj-Napoca', subdivision: 'RO-CJ', country: 'RO' },
  IE: { lines: ['4 Grand Canal Square'], city: 'Dublin', country: 'IE' },
  DE: { lines: ['Hauptstraße 1'], city: 'Berlin', country: 'DE' },
  FR: { lines: ['1 rue de Rivoli'], city: 'Paris', country: 'FR' },
  IT: { lines: ['Via Roma 1'], city: 'Roma', country: 'IT' },
};

/** ANAF's verdict, never assumed: the validator ran and accepted the exact XML. */
function validated(artifact: Artifact) {
  expect(
    [artifact.kind, artifact.period, artifact.state, artifact.steps.at(-1)?.detail ?? null],
    artifact.steps.map((step) => `${step.state} ${step.detail}`).join('\n'),
  ).toEqual([artifact.kind, artifact.period, 'validated_official', null]);
  return artifact;
}

// 1. A PFA in the real system, outside VAT, keeping single-entry books.

/*
 * Popescu Ion PFA (CIF 31415920, Cluj-Napoca): two independent activities in the real system,
 * software (6201) and consulting (7022), outside VAT; an employee from 1 July; a laptop bought in
 * March. Every amount by hand:
 *   income: software 10.000 lei a month (S-1…S-12, 704.SW), consulting 5.000 lei a month (C-1…
 *   C-12, 704.CONS), each paid in the month: 120.000 + 60.000 = 180.000 lei;
 *   hosting for the software, 1.000 + 210 VAT a month (628.SW): 14.520 lei, the VAT not
 *   deductible outside VAT, so an expense;
 *   the phone serving both activities, 300 + 63 a month (626): 4.356 lei, split by gross income,
 *   2/3 software (2.904) and 1/3 consulting (1.452), the person's key;
 *   the laptop, 9.000 + 1.890 VAT = 10.890 lei on 2131, depreciated for tax over 36 months from
 *   April: 9 × 302,50 = 2.722,50 lei (software);
 *   the employee: 5.000 lei gross a month from July, the net paid each month's end, the
 *   contributions and tax by the 25th of the next month (December's in 2027).
 */
const PFA = '31415920';
const SOFT_CLIENT = '27182818';
const CONSULT_CLIENT = '16180331';
const HOSTING = '14142137';
const PHONE = '17320506';
const LAPTOPS = cui('2357111');
const pfaIban = iban('EEEE', '1B31007593840004');

official('a PFA in the real system, outside VAT, over FY2026', () => {
  let b: Books;
  let anaf: { id: string };
  let software: string;
  let consulting: string;
  let holder: { id: string };
  const opened: Record<string, string> = {};
  let ron = '15000.00';
  const filed: Record<string, Artifact | string> = {};

  async function purchase(
    number: string,
    date: string,
    supplier: string,
    net: string,
    account: string,
  ) {
    await b.at(date);
    const tax = (Math.round(Number(net) * 21) / 100).toFixed(2);
    const invoice = await b.invoice({
      number,
      date,
      counterparty: `RO${supplier}`,
      net,
      tax,
      gross: (Number(net) + Number(tax)).toFixed(2),
    });
    const booked = await b.book('invoices.recognize', {
      documentId: invoice.id,
      account,
      deduction: 'none',
    });
    opened[number] = booked.effect!.openItems[0]!.id;
    return { invoice, booked };
  }
  async function sell(number: string, date: string, client: string, net: string, account: string) {
    await b.at(date);
    const invoice = await b.invoice({
      number,
      date,
      direction: 'sale',
      counterparty: `RO${client}`,
      category: 'O',
      rate: '0',
      tax: '0.00',
      net,
      gross: net,
    });
    const booked = await b.book('invoices.recognize', { documentId: invoice.id, account });
    opened[number] = booked.effect!.openItems[0]!.id;
  }

  test('setup: the person, the two sources, the determinations', async () => {
    b = await books({
      cui: PFA,
      name: 'Popescu Ion PFA',
      today: '2026-01-02',
      suppliers: [HOSTING, PHONE, LAPTOPS],
    });
    const { s } = b;
    await s.invoke(s.owner, 'sales.seller.record', {
      details: {
        name: 'Popescu Ion PFA',
        vatId: `RO${PFA}`,
        address: {
          lines: ['Str. Exemplu nr. 1'],
          city: 'Cluj-Napoca',
          subdivision: 'RO-CJ',
          country: 'RO',
        },
      },
    });
    const { evidenceId: certificate } = await b.fact(
      'entity.form',
      'pfa',
      '2024-01-15',
      'certificat-inregistrare-pfa.pdf',
    );
    for (const [axis, value, from] of [
      ['books.system', 'single', '2024-01-15'],
      ['vat.status', 'non_vat', '2024-01-15'],
      ['cas.status', 'liable', '2026-01-01'],
      ['cass.exception', 'none', '2026-01-01'],
      ['employer', 'no', '2024-01-15'],
    ] as const)
      await b.fact(axis, value, from);
    for (const code of ['704.SW', '704.CONS', '628.SW'])
      await s.invoke(s.owner, 'accounts.create', {
        code,
        name: `Analitic ${code}`,
        validFrom: '2026-01-01',
      });
    const source = (input: Record<string, unknown>) =>
      s.invoke<{ sourceId: string }>(s.owner, 'pfa.sources.record', {
        county: 'CJ',
        liberal: false,
        evidenceId: certificate,
        effectiveFrom: '2024-01-15',
        place: 'Str. Exemplu nr. 1, Cluj-Napoca',
        startedOn: '2024-01-15',
        method: 'sistem_real',
        realBasis: 'required',
        ...input,
      });
    software = (
      await source({
        name: 'Dezvoltare software',
        caen: '6201',
        authorization: { number: 'F12/1/2024', date: '2024-01-10' },
      })
    ).sourceId;
    consulting = (
      await source({
        name: 'Consultanță în afaceri',
        caen: '7022',
        authorization: { number: 'F12/2/2024', date: '2024-01-10' },
      })
    ).sourceId;
    holder = await s.invoke<{ id: string }>(s.owner, 'parties.create', {
      kind: 'ro_individual',
      country: 'RO',
      name: 'Popescu Ion (titular)',
    });
    await s.invoke(s.owner, 'parties.recordCnp', { partyId: holder.id, cnp: cnp('178110517003') });
    await s.invoke(s.owner, 'treasury.createAccount', {
      kind: 'bank',
      name: 'Cont curent',
      iban: pfaIban,
      currency: 'RON',
      ledgerAccount: '5121',
      openedOn: '2026-01-01',
    });
    anaf = await s.invoke<{ id: string }>(b.agent, 'parties.create', {
      kind: 'ro_public_institution',
      country: 'RO',
      name: 'ANAF',
    });
    await b.book('ledger.general', {
      date: '2026-01-01',
      purpose: 'opening',
      reference: 'SOLD-INITIAL',
      description: 'Registrul-inventar la 31.12.2025',
      evidenceId: (await s.evidence('registru-inventar-2025.pdf')).id,
      lines: [
        { account: '5121', side: 'D', amount: '15000.00' },
        { account: '1012', side: 'C', amount: '15000.00' },
      ],
    });
    // The closure asks what the books cannot tell: the agent asks the owner each question it
    // names, and the answers are the person's facts.
    const before = await b.closure('2026-01', '2026-12');
    expect(before.status).toBe('NEEDS_EVIDENCE');
    const facts: Record<string, string> = {
      'activity.goods': 'no',
      'regime.excluded': 'none',
      'vat.eu': 'none',
    };
    expect(before.needs.map((need) => need.fact).sort()).toEqual(Object.keys(facts).sort());
    for (const need of before.needs) {
      const asked = await s.invoke<{ id: string }>(b.agent, 'questions.ask', need.question);
      await s.invoke(s.owner, 'questions.answer', {
        questionId: asked.id,
        value: { value: facts[need.fact]!, effectiveFrom: '2024-01-15' },
      });
    }
    // Two sources, both in the real system: D212 is the year's only return until the employee.
    const after = await b.closure('2026-01', '2026-12');
    expect(after).toMatchObject({ status: 'ELIGIBLE', needs: [], unsupported: [] });
    expect(after.obligations.map((item) => `${item.kind} ${item.period}`)).toEqual(['D212 2026']);
    expect((await b.evaluate(2026)).find((item) => item.axis === 'vat.threshold')).toMatchObject({
      value: 'under',
    });
  }, 60_000);

  /** A month's statement: each movement settling the item its text names, or the payroll's. */
  async function statement(
    m: string,
    rows: {
      date: string;
      amount: string;
      reference: string;
      text: string;
      allocations?: { openItem: string; amount: string }[];
    }[],
  ) {
    const { closing, movements } = await b.statement({
      iban: pfaIban,
      currency: 'RON',
      month: m,
      opening: ron,
      rows,
    });
    ron = closing;
    for (const movement of movements.filter((item) => item.state === 'unexplained')) {
      const row = rows.find((item) => movement.reference.endsWith(item.reference))!;
      await b.book('bank.settle', {
        movementId: movement.id,
        allocations: row.allocations ?? [
          { openItem: opened[row.reference], amount: movement.amount.replace('-', '') },
        ],
      });
    }
  }

  /** The quarter of a month. */
  const periodOf = (m: string) => `${m.slice(0, 4)}-Q${Math.ceil(Number(m.slice(5, 7)) / 3)}`;

  test('the year, month by month: invoices, the laptop, the employee from July, each month closed', async () => {
    const { s } = b;
    let employee: { contractId: string } | null = null;
    let owed: { openItem: string; amount: string }[] = [];
    for (const m of months) {
      const n = Number(m.slice(5, 7));
      if (m === '2026-07') {
        // The owner hires from 1 July: a PFA employer files D112 quarterly (art. 80 alin. (2)
        // lit. d)), the year's determination the person confirms; the contract was sent to
        // REGES-ONLINE the day before it starts, as the person records.
        await b.at('2026-07-03');
        await b.fact('employer', 'yes', '2026-07-01', 'contract-munca.pdf');
        const person = await s.invoke<{ id: string }>(s.owner, 'payroll.employees.record', {
          lastName: 'Ionescu',
          firstName: 'Maria',
          cnp: cnp('295030112345'),
          healthFund: 'RO-CJ',
        });
        employee = await s.invoke<{ contractId: string }>(s.owner, 'payroll.contracts.record', {
          employeeId: person.id,
          number: 'CIM-1',
          startDate: '2026-07-01',
          effectiveFrom: '2026-07-01',
          dailyHours: 8,
          mainJob: true,
          occupation: '251201',
          baseSalary: '5000',
        });
        await s.invoke(s.owner, 'payroll.reges.record', {
          contractId: employee.contractId,
          termsSeq: 1,
          event: 'start',
          transmittedOn: '2026-06-30',
          evidenceId: (await s.evidence('recipisa-reges.pdf')).id,
        });
        await b.determine(2026, () => undefined);
        expect(
          (await b.evaluate(2026)).find((item) => item.axis === 'payroll.period'),
        ).toMatchObject({
          value: 'quarterly',
          recorded: { confirmed: true, agrees: true },
        });
      }
      await purchase(`H-${n}`, `${m}-03`, HOSTING, '1000.00', '628.SW');
      if (m === '2026-03') {
        const { invoice, booked } = await purchase(
          'LAP-1',
          '2026-03-02',
          LAPTOPS,
          '9000.00',
          '2131',
        );
        // Outside VAT the VAT is part of the asset's cost.
        expect(lines(booked)).toEqual(['D 2131 10890.00', 'C 404 10890.00']);
        await s.invoke(b.agent, 'assets.register', {
          number: 'MF-1',
          name: 'Laptop',
          catalogCode: '2.2.9',
          account: '2131',
          depreciationAccount: '2813',
          value: '10890.00',
          lifeMonths: 36,
          fiscalLifeMonths: 36,
          commissionedOn: '2026-03-02',
          documentId: invoice.id,
          evidenceId: (await s.evidence('pv-punere-in-functiune.pdf')).id,
        });
      }
      await sell(`S-${n}`, `${m}-10`, SOFT_CLIENT, '10000.00', '704.SW');
      await sell(`C-${n}`, `${m}-12`, CONSULT_CLIENT, '5000.00', '704.CONS');
      await purchase(`T-${n}`, `${m}-15`, PHONE, '300.00', '626');
      const rows: Parameters<typeof statement>[1] = [
        { date: `${m}-08`, amount: '-1210.00', reference: `H-${n}`, text: `Plata H-${n}` },
        ...(m === '2026-03'
          ? [{ date: '2026-03-10', amount: '-10890.00', reference: 'LAP-1', text: 'Plata LAP-1' }]
          : []),
        { date: `${m}-18`, amount: '-363.00', reference: `T-${n}`, text: `Plata T-${n}` },
        { date: `${m}-20`, amount: '10000.00', reference: `S-${n}`, text: `Incasare S-${n}` },
        { date: `${m}-22`, amount: '5000.00', reference: `C-${n}`, text: `Incasare C-${n}` },
      ];
      // Last month's contributions and tax, by the 25th.
      if (owed.length)
        rows.push({
          date: `${m}-25`,
          amount: `-${sum(owed.map((item) => item.amount))}`,
          reference: `D112-${n - 1}`,
          text: `Contributii salarii luna ${n - 1} D112-${n - 1}`,
          allocations: owed,
        });
      owed = [];
      if (employee) {
        await b.at(lastDay(m));
        const run = await s.invoke<{ id: string }>(s.owner, 'payroll.runs.prepare', {
          month: m,
          entries: [],
        });
        const posted = await b.book('payroll.recognize', {
          runId: run.id,
          month: m,
          round: 1,
          authorityId: anaf.id,
        });
        // 5.000 gross: CAS 25% 1.250, CASS 10% 500, tax 10% of 5.000 − 1.750 − the personal
        // deduction of 562 (13% of the 4.325 minimum wage) = 268,80 → 269, net 2.981; CAM 2,25%
        // 112,50 → 113.
        expect(lines(posted)).toEqual([
          'D 641 5000.00',
          'C 421 5000.00',
          'D 421 2019.00',
          'C 4315 1250.00',
          'C 4316 500.00',
          'C 444 269.00',
          'D 646 113.00',
          'C 436 113.00',
        ]);
        // What each item holds: its lines, credits less debits.
        const held = (id: string) =>
          sum(
            posted
              .effect!.lines.filter((line) => line.openItem === id)
              .map((line) => (line.side === 'C' ? line.amount : `-${line.amount}`)),
          );
        const items = posted.effect!.openItems;
        const net = items.find((item) => item.controlAccount === '421')!;
        owed = items
          .filter((item) => item.controlAccount !== '421')
          .map((item) => ({ openItem: item.id, amount: held(item.id) }));
        rows.push({
          date: lastDay(m),
          amount: `-${held(net.id)}`,
          reference: `SAL-${n}`,
          text: `Salariu luna ${n} SAL-${n}`,
          allocations: [{ openItem: net.id, amount: held(net.id) }],
        });
      }
      await b.at(`${nextMonth(m)}-02`);
      await statement(m, rows);
      for (const result of await b.returns({
        D112: {
          declarant: { lastName: 'Popescu', firstName: 'Ion', role: 'Titular' },
          caen: '6201',
          phone: '0264000000',
        },
        D212: {
          holderPartyId: holder.id,
          taxpayer: {
            lastName: 'Popescu',
            initial: 'M',
            firstName: 'Ion',
            address: 'Str. Exemplu nr. 1, Cluj-Napoca, jud. Cluj',
          },
          iban: pfaIban,
        },
      })) {
        if (result.artifact) validated(result.artifact);
        filed[result.key] = result.artifact ?? `${result.code}: ${result.message}`;
      }
      if (m >= '2026-07') {
        const d112 = filed[`D112 ${m}`] as Artifact;
        expect(summaryOf(d112)).toMatchObject({
          insured: 1,
          filing: { period: 'quarterly', counted: periodOf(m), basis: 'quarterly' },
        });
      }
      if (m !== '2026-12') {
        await b.at(`${nextMonth(m)}-03`);
        await b.close(m);
      }
    }
  }, 120_000);

  test('the year’s end: the inventory of the register, December and the year closed', async () => {
    const { s } = b;
    // The register's inventory, transcribed by the agent: the laptop found, the bank's
    // statement.
    await s.invoke(b.agent, 'documents.record', {
      evidenceId: await b.file(
        'inventar-pfa-2026.txt',
        'Registrul-inventar 31.12.2026',
        'text/plain',
      ),
      kind: 'inventory.list',
      body: {
        title: 'Registrul-inventar 2026',
        company: { name: 'Popescu Ion PFA', taxId: PFA },
        date: '2026-12-31',
        commission: { decision: '1', decisionDate: '2026-12-15', members: ['Popescu Ion'] },
        assets: [{ number: 'MF-1', name: 'Laptop', found: true }],
        bank: [{ account: '5121', currency: 'RON', balance: ron }],
      },
    });
    expect(await s.invoke(b.agent, 'inventory.compare', { date: '2026-12-31' })).toMatchObject({
      sections: { assets: true, bank: true },
      differences: [],
      gaps: [],
    });
    // Single entry: no allowances, provisions or result to close; the review is done.
    expect(
      (
        await s.invoke<{ items: unknown[] }>(b.agent, 'yearend.review', {
          financialYearId: s.year.id,
        })
      ).items,
    ).toEqual([]);
    await b.at('2027-01-03');
    // 2027's D112s wait for the rules of 2027 (its payroll period, the deadline): on the
    // worklist, January's begun, never blocking December's close; January's own close check
    // (the natures, `ro.pit.natures` past its horizon) waits for January's end.
    expect(
      (await b.work({ kinds: ['obligation.due'] }))
        .filter((item) => /\|2027-/.test(item.subject.id))
        .map((item) => `${item.subject.id} ${item.severity} ${item.details.waiting}`),
    ).toEqual(['D112|2027-01 warn 2027', 'D112|2027-02 info 2027', 'D112|2027-03 info 2027']);
    expect(
      (await b.work({ kinds: ['close.finding'] })).filter((item) => item.period === '2027-01'),
    ).toEqual([]);
    await b.close('2026-12');
    const request = await s.invoke<ActionView>(b.agent, 'years.close.request', {
      financialYearId: s.year.id,
    });
    expect(
      (request.preview as { findings: { severity: string }[] }).findings.filter(
        (finding) => finding.severity === 'block',
      ),
    ).toEqual([]);
    await s.invoke(s.reviewer, 'actions.approve', {
      id: request.id,
      previewHash: request.previewHash,
    });
    expect(
      (await s.invoke<ActionView>(b.agent, 'actions.execute', { id: request.id })).status,
    ).toBe('executed');
  }, 60_000);

  test('the registers equal the ledger, the fiscal register computes CAS, CASS and the tax, D212 for 2026 is a FORMAT_GAP', async () => {
    const { s } = b;
    // Registrul-jurnal de încasări și plăți: each month, receipts less payments are the bank's
    // change, and its closing is the ledger's.
    const journal = await s.invoke<{
      rows: {
        natures: { nature: string; amount: string }[];
        receipts: { bank: string | null };
        payments: { bank: string | null };
      }[];
      accounts: {
        account: string;
        months: {
          month: string;
          opening: string;
          receipts: string;
          payments: string;
          closing: string;
        }[];
        closing: string;
      }[];
      issues: unknown[];
    }>(b.agent, 'pfa.journal', { year: 2026 });
    expect(journal.issues).toEqual([]);
    expect(journal.accounts.map((account) => `${account.account} ${account.closing}`)).toEqual([
      `5121 ${ron}`,
    ]);
    for (const month of journal.accounts[0]!.months) {
      expect(cents(month.receipts) - cents(month.payments)).toBe(
        cents(month.closing) - cents(month.opening),
      );
      expect(await b.balance('5121', lastDay(month.month))).toBe(month.closing);
    }
    for (const row of journal.rows)
      expect(sum(row.natures.map((nature) => nature.amount))).toBe(
        row.receipts.bank ?? `-${row.payments.bank}`,
      );
    // Its natures over the year, by hand: 180.000 income; 14.520 hosting and 4.356 phone; the
    // laptop as an acquisition; 6 net salaries of 2.981 and five months' withheld contributions
    // and tax, 5 × 2.019, as salaries; five months' CAM, 5 × 113.
    const natures = new Map<string, bigint>();
    for (const row of journal.rows)
      for (const nature of row.natures)
        natures.set(nature.nature, (natures.get(nature.nature) ?? 0n) + cents(nature.amount));
    expect(Object.fromEntries([...natures].map(([nature, bani]) => [nature, money(bani)]))).toEqual(
      {
        'income.activity': '180000.00',
        'expense.full': '-18876.00',
        'asset.acquisition': '-10890.00',
        'expense.salary': '-27981.00',
        'expense.employer': '-565.00',
      },
    );
    // Registrul-inventar: the laptop at its entry value, the bank as the ledger holds it,
    // December's contributions and tax still owed.
    const inventory = await s.invoke<{
      sections: { title: string; rows: { description: string; value: string }[] }[];
      totals: { assets: string; liabilities: string };
      issues: unknown[];
    }>(b.agent, 'pfa.inventory', { occasion: 'year_end', year: 2026 });
    expect(inventory.issues).toEqual([]);
    expect(
      inventory.sections.map((section) => [
        section.title,
        section.rows.map((row) => `${row.description}: ${row.value}`),
      ]),
    ).toEqual([
      ['Imobilizări', ['MF-1 Laptop: 10890.00']],
      ['Stocuri', []],
      ['Creanțe', []],
      ['Disponibilități', [`5121 Conturi la bănci în lei: ${ron}`]],
      [
        'Datorii',
        ['4315 ANAF: 1250.00', '4316 ANAF: 500.00', '436 ANAF: 113.00', '444 ANAF: 269.00'],
      ],
    ]);
    const tb = await b.trialBalance();
    for (const account of ['4315', '4316', '436', '444'])
      expect(await b.balance(account)).toBe(
        `-${inventory.sections[4]!.rows.find((row) => row.description.startsWith(`${account} `))!.value}`,
      );
    for (const total of Object.values(tb.totals)) expect(total.debit).toBe(total.credit);

    // Registrul de evidență fiscală, one register per source with the person's attribution:
    //   consulting 60.000 − 1.452 (a third of the phone) = 58.548;
    //   software 120.000 − (14.520 + 2.904 + 27.981 + 565 + 2.722,50 = 48.692,50, the 50 bani
    //   dropped, art. 66) = 71.308;
    //   129.856 lei in all: CAS on 24 minimum wages (above 97.200 lei) 24.300; CASS 10%
    //   12.985,60 → 12.986; taxable 129.856 − 24.300 − 12.986 = 92.570, tax 9.257.
    const attribution = {
      accounts: [
        { match: '704.SW', sourceId: software },
        { match: '628.SW', sourceId: software },
        { match: '2131', sourceId: software },
        { match: '421', sourceId: software },
        { match: '431', sourceId: software },
        { match: '444', sourceId: software },
        { match: '436', sourceId: software },
        { match: '704.CONS', sourceId: consulting },
      ],
      shared: [
        {
          match: '626',
          key: { kind: 'gross' },
          evidenceId: (await s.evidence('nota-repartizare-telefon.pdf')).id,
        },
      ],
      evidenceId: (await s.evidence('nota-surse-venit.pdf')).id,
    };
    const register = await s.invoke<{
      final: boolean;
      sources: {
        sourceId: string;
        register: { rows: { nr: string; value: string }[] };
        totals: { gross: string; deductible: string; net: string; loss: string };
      }[];
      contributions: {
        cumulated: string;
        cas: { base: string; due: string; deductible: string };
        cass: { base: string; due: string; deductible: string };
      };
      tax: { taxable: string; real: string; total: string };
      issues: { code: string; severity: string }[];
    }>(b.agent, 'pfa.fiscalRegister', { year: 2026, attribution });
    expect(register.final).toBe(true);
    expect(register.issues.map((issue) => `${issue.severity} ${issue.code}`)).toEqual([
      'info PIT_SHARED_EXPENSE',
      'info PIT_EMPLOYER_LIMIT',
    ]);
    expect(register.sources.map((source) => [source.sourceId, source.totals])).toEqual([
      [consulting, { gross: '60000.00', deductible: '1452.00', net: '58548.00', loss: '0.00' }],
      [software, { gross: '120000.00', deductible: '48692.00', net: '71308.00', loss: '0.00' }],
    ]);
    expect(register.sources[1]!.register.rows.map((row) => `${row.nr} ${row.value}`)).toEqual([
      '1 120000.00',
      '1.1 120000.00',
      '2 48692.00',
      '2.1 17424.00',
      '2.2 27981.00',
      '2.3 565.00',
      '2.4 2722.50',
      '3 71308.00',
    ]);
    expect(register.contributions).toMatchObject({
      cumulated: '129856.00',
      cas: { base: '97200.00', due: '24300.00', deductible: '24300.00' },
      cass: { base: '129856.00', due: '12986.00', deductible: '12986.00' },
    });
    expect(register.tax).toMatchObject({ taxable: '92570.00', real: '9257.00', total: '9257.00' });
    // The register equals the journal: each source's gross is its income natures, the
    // expenses paid its expense natures (the depreciation is the register's own).
    expect(sum(register.sources.map((source) => source.totals.gross))).toBe(
      money(natures.get('income.activity')!),
    );

    // D212 for 2026 income: ANAF has not published its structure.
    expect(filed['D212 2026']).toStartWith('FORMAT_GAP: ');
    // The closure: D112 for each month from July, quarterly, and D212; every D112 validated by
    // ANAF, D212 the FORMAT_GAP; no D406 for a PFA (OPANAF nr. 1.783/2021 anexa nr. 5 pct. 4).
    const closure = await b.closure('2026-01', '2026-12');
    expect(closure).toMatchObject({ status: 'ELIGIBLE', needs: [], unsupported: [] });
    const listed = closure.obligations.map((item) => `${item.kind} ${item.period}`);
    expect(listed).toEqual([...months.slice(6).map((m) => `D112 ${m}`), 'D212 2026']);
    for (const key of listed) if (key !== 'D212 2026') validated(filed[key] as Artifact);
  }, 60_000);
});

official('a PFA’s D212 for 2025 income, from a 2025 book', () => {
  test('prepared in the web form’s structure, equal to the fiscal register; ANAF’s J13.0.1 is for 2024 income and refuses it', async () => {
    /*
     * The 2025 book of a PFA in the real system, one source (software), outside VAT, by hand:
     * income S-1 30.000 (March) and S-2 34.000 (September) = 64.000 lei; hosting 4.000 + 19% (760)
     * and 2.000 + 21% (420), the VAT expensed: 7.180 lei; net 56.820 lei, at least 12 minimum
     * wages of 4.050 lei and below 24: CAS on 48.600 lei, 12.150; CASS 10%, 5.682; taxable
     * 56.820 − 12.150 − 5.682 = 38.988, tax 3.898,80 → 3.899 (art. 66).
     */
    const b = await books({
      cui: PFA,
      name: 'Popescu Ion PFA',
      year: 2025,
      today: '2026-02-10',
      suppliers: [HOSTING],
    });
    const { s } = b;
    await s.invoke(s.owner, 'sales.seller.record', {
      details: {
        name: 'Popescu Ion PFA',
        vatId: `RO${PFA}`,
        address: {
          lines: ['Str. Exemplu nr. 1'],
          city: 'Cluj-Napoca',
          subdivision: 'RO-CJ',
          country: 'RO',
        },
      },
    });
    const { evidenceId: certificate } = await b.fact(
      'entity.form',
      'pfa',
      '2024-01-15',
      'certificat-inregistrare-pfa.pdf',
    );
    for (const [axis, value, from] of [
      ['books.system', 'single', '2024-01-15'],
      ['vat.status', 'non_vat', '2024-01-15'],
      ['cas.status', 'liable', '2025-01-01'],
      ['cass.exception', 'none', '2025-01-01'],
    ] as const)
      await b.fact(axis, value, from);
    await s.invoke(s.owner, 'pfa.sources.record', {
      county: 'CJ',
      liberal: false,
      evidenceId: certificate,
      effectiveFrom: '2024-01-15',
      name: 'Dezvoltare software',
      caen: '6201',
      place: 'Str. Exemplu nr. 1, Cluj-Napoca',
      authorization: { number: 'F12/1/2024', date: '2024-01-10' },
      startedOn: '2024-01-15',
      method: 'sistem_real',
      realBasis: 'required',
    });
    const holder = await s.invoke<{ id: string }>(s.owner, 'parties.create', {
      kind: 'ro_individual',
      country: 'RO',
      name: 'Popescu Ion (titular)',
    });
    await s.invoke(s.owner, 'parties.recordCnp', { partyId: holder.id, cnp: cnp('178110517003') });
    await s.invoke(s.owner, 'treasury.createAccount', {
      kind: 'bank',
      name: 'Cont curent',
      iban: pfaIban,
      currency: 'RON',
      ledgerAccount: '5121',
      openedOn: '2025-01-01',
    });
    await b.book('ledger.general', {
      date: '2025-01-01',
      purpose: 'opening',
      reference: 'SOLD-INITIAL',
      description: 'Registrul-inventar la 31.12.2024',
      evidenceId: (await s.evidence('registru-inventar-2024.pdf')).id,
      lines: [
        { account: '5121', side: 'D', amount: '5000.00' },
        { account: '1012', side: 'C', amount: '5000.00' },
      ],
    });
    const opened: Record<string, string> = {};
    const invoice = async (
      number: string,
      date: string,
      direction: 'sale' | 'purchase',
      net: string,
      account: string,
    ) => {
      // 19% before 1 August 2025, 21% from it.
      const rate = date < '2025-08-01' ? '19' : '21';
      const tax =
        direction === 'sale' ? '0.00' : (Math.round(Number(net) * Number(rate)) / 100).toFixed(2);
      const imported = await b.invoice({
        number,
        date,
        direction,
        counterparty: `RO${direction === 'sale' ? SOFT_CLIENT : HOSTING}`,
        net,
        tax,
        gross: (Number(net) + Number(tax)).toFixed(2),
        ...(direction === 'sale' ? { category: 'O', rate: '0' } : { rate }),
      });
      const booked = await b.book('invoices.recognize', {
        documentId: imported.id,
        account,
        ...(direction === 'purchase' ? { deduction: 'none' } : {}),
      });
      opened[number] = booked.effect!.openItems[0]!.id;
    };
    await invoice('S-1', '2025-03-10', 'sale', '30000.00', '704');
    await invoice('H-1', '2025-03-12', 'purchase', '4000.00', '628');
    await invoice('S-2', '2025-09-10', 'sale', '34000.00', '704');
    await invoice('H-2', '2025-09-12', 'purchase', '2000.00', '628');
    let balance = '5000.00';
    for (const [month, rows] of [
      [
        '2025-03',
        [
          ['2025-03-20', '30000.00', 'S-1'],
          ['2025-03-25', '-4760.00', 'H-1'],
        ],
      ],
      [
        '2025-09',
        [
          ['2025-09-20', '34000.00', 'S-2'],
          ['2025-09-25', '-2420.00', 'H-2'],
        ],
      ],
    ] as const) {
      const { closing, movements } = await b.statement({
        iban: pfaIban,
        currency: 'RON',
        month,
        opening: balance,
        rows: rows.map(([date, amount, reference]) => ({
          date,
          amount,
          reference,
          text: `Factura ${reference}`,
        })),
      });
      balance = closing;
      for (const movement of movements.filter((item) => item.state === 'unexplained')) {
        const reference = rows.find(([, , number]) => movement.reference.endsWith(number))![2];
        await b.book('bank.settle', {
          movementId: movement.id,
          allocations: [{ openItem: opened[reference], amount: movement.amount.replace('-', '') }],
        });
      }
    }
    const register = await s.invoke<{
      final: boolean;
      sources: { totals: { gross: string; deductible: string; net: string; loss: string } }[];
      contributions: { cas: { base: string; due: string }; cass: { base: string; due: string } };
      tax: { taxable: string; real: string };
    }>(b.agent, 'pfa.fiscalRegister', { year: 2025 });
    expect(register.final).toBe(true);
    expect(register.sources.map((source) => source.totals)).toEqual([
      { gross: '64000.00', deductible: '7180.00', net: '56820.00', loss: '0.00' },
    ]);
    expect(register.contributions).toMatchObject({
      cas: { base: '48600.00', due: '12150.00' },
      cass: { base: '56820.00', due: '5682.00' },
    });
    expect(register.tax).toMatchObject({ taxable: '38988.00', real: '3899.00' });
    const prepared = await b.prepare('D212', '2025', {
      holderPartyId: holder.id,
      taxpayer: {
        lastName: 'Popescu',
        initial: 'M',
        firstName: 'Ion',
        address: 'Str. Exemplu nr. 1, Cluj-Napoca, jud. Cluj',
      },
      iban: pfaIban,
    });
    // 2025 income: ANAF's web form (V-1.8.10), which has no published validator; it stops at
    // `prepared`, its authorization blocked, and is filed through the form.
    expect(prepared.format).toBe(
      'D212 mfp:anaf:dgti:d212:declaratie:v11 an_r 2026 (formularul web V-1.8.10 / 15.05.2026)',
    );
    expect(prepared.steps.map((step) => step.state)).toEqual(['prepared']);
    expect(summaryOf(prepared)).toMatchObject({
      validator: null,
      net: '56820.00',
      cas: '12150.00',
      cass: '5682.00',
      tax: '3899.00',
    });
    expect(
      (await s.refused(s.invoke(b.agent, 'declarations.validate', { artifactId: prepared.id })))
        ?.code,
    ).toBe('NO_OFFICIAL_VALIDATOR');
    const request = await s.invoke<ActionView>(s.owner, 'declarations.authorize.request', {
      artifactId: prepared.id,
    });
    expect(
      (request.preview as { findings: { code: string }[] }).findings.map((item) => item.code),
    ).toEqual(['NOT_VALIDATED']);
    // D212 equals the fiscal register, attribute by attribute.
    const xml = new TextDecoder().decode(await s.objects.get(s.company.id, prepared.xmlHash));
    const attribute = (name: string) => new RegExp(`\\s${name}="([^"]*)"`).exec(xml)?.[1];
    expect(
      Object.fromEntries(
        [
          'an_r',
          'venit_brut',
          'chelt_deduc',
          'venit_net_anual',
          'cas_baza',
          'cas_datorat',
          'baza_cass_datorat_ai',
          'cass_datorat_ai',
          'real_venit_net_impozabil_ai',
          'real_impozit_datorat_ai',
          'dif_de_plata',
        ].map((name) => [name, attribute(name)]),
      ),
    ).toEqual({
      an_r: '2026',
      venit_brut: '64000',
      chelt_deduc: '7180',
      venit_net_anual: '56820',
      cas_baza: '48600',
      cas_datorat: '12150',
      baza_cass_datorat_ai: '56820',
      cass_datorat_ai: '5682',
      real_venit_net_impozabil_ai: '38988',
      real_impozit_datorat_ai: '3899',
      // 12.150 + 5.682 + 3.899.
      dif_de_plata: '21731',
    });
    // Which income year ANAF's J13.0.1 validates: run on this return, it refuses the 2025 form's
    // attributes (it is D212_A1.0.3's validator, for the income of 2024)…
    const official = await new DukIntegrator(saftKit, saftKitId).validate(
      'D212',
      new TextEncoder().encode(xml),
    );
    expect(official.ok).toBe(false);
    expect(official.messages).toContain(
      "eroare atribut: bifa19: atribut necunoscut ('bifa19') in namespace='mfp:anaf:dgti:d212:declaratie:v11'",
    );
    // …and the income of 2024, which it would validate, has no PIT values in the engine's
    // register: a RULE_GAP, never a value assumed (pfa.integration.test.ts runs that path on
    // marked test fixtures).
    expect(
      (
        await s.refused(
          b.prepare('D212', '2024', {
            holderPartyId: holder.id,
            taxpayer: { lastName: 'Popescu', firstName: 'Ion', address: 'Cluj-Napoca' },
          }),
        )
      )?.code,
    ).toBe('RULE_GAP');
  }, 120_000);
});

// 2. A non-payer SRL on micro tax over FY2026.

/*
 * Exemplu Servicii SRL (CUI 18547290, Galați): IT services to two Romanian companies, outside VAT
 * (art. 310), micro tax at 1%, an office rented from a VAT payer, Meta ads bought from Ireland
 * with the art. 317 code (obtained in November 2025). Every amount by hand:
 *   sales without VAT, January–September: 40.000, 42.000, 44.000, 43.000, 45.000, 44.000, 43.000,
 *   44.000, 45.000 = 390.000 lei; on 6 October V-10, 12.000 lei, carries the year to 402.000 lei,
 *   above the 395.000 lei of art. 310 alin. (1): the registration is due and valid from that day.
 *   The company goes on invoicing without VAT (V-11, 20 October, 8.000 lei) and registers late,
 *   on 2 November, from 6 October (art. 310 alin. (6^2) lit. a)).
 *   The first year's VAT period: 390.000 lei over the 278 days before 6 October, recalculated for
 *   365 days, 512.050,36 lei, above 100.000 € × 5,0800 = 508.000 lei: monthly (art. 322 alin. (4)).
 *   The VAT owed for registering late: 20.000 lei sold from 6 to 20 October, the price taken to
 *   include VAT: 20.000 × 21/121 = 3.471,07 lei (base 16.528,93), less the 210,00 lei of an
 *   accountant's invoice of 12 October, deducted now.
 *   Rent 2.000 + 420 VAT a month, not deducted before the registration.
 *   Meta ads, 200 € on the 3rd of each month: before the registration the VAT is owed through
 *   D301 (21% of the lei base, on 4423), after it self-assessed and deducted (D300 rd. 7.1, 20.1).
 */
const SERVICES = '18547290';
const CLIENT_A = cui('2233445');
const CLIENT_B = cui('3344556');
const LANDLORD = cui('4455667');
const ACCOUNTANT = cui('5566778');
const META = 'IE9692928F';
/** The synthetic EUR rate of a date: 5,0800 at 2025's close, then 5,08 + 0,001 × the month. */
const eurOf = (date: string) =>
  date < '2026-01-01' ? '5.0800' : (5.08 + 0.001 * Number(date.slice(5, 7))).toFixed(4);
const ronIban = iban('AAAA', '1B31007593840000');
const eurIban = iban('BBBB', '1B31007593840001');
const d300Options = {
  declarant,
  caen: '6201',
  bank: 'Banca Exemplu',
  account: ronIban,
};
/** The S1005 options a person gives (the trade register, CAEN, the signatories). */
const s1005Options = {
  entity: {
    tradeRegister: 'J17/123/2010',
    ownership: 35,
    caen: '6210',
    caenActual: '6210',
    caenVersion: 2025,
    largeTaxpayer: false,
    branch: false,
    economicInterestGroup: false,
    netAssetsBelowHalfCapital: false,
    phone: '0236000000',
  },
  administrator: 'Popescu Ana',
  preparer: { name: 'Ionescu Maria', quality: 22, membership: '12345', cif: '14399840' },
  approved: true,
  rows: {},
};
const d394Options = {
  caen: '6201',
  phone: '0236123456',
  representative: { name: 'Popescu Ana', role: 'Administrator', address: 'Galați' },
  preparer: { kind: 'company', cui: '14399840', name: 'Contabil SRL', capacity: 'Împuternicit' },
  consultation: true,
  affiliates: false,
};

official('a non-payer SRL on micro tax over FY2026', () => {
  let b: Books;
  let anaf: { id: string };
  type Row = { date: string; amount: string; reference: string; text: string };
  /** What each month brings: the sales (with VAT once registered), the purchases, the rows of
   * the two statements. */
  const sales: Record<string, { number: string; date: string; net: string; client: string }[]> = {
    '2026-01': [{ number: 'V-1', date: '2026-01-12', net: '40000.00', client: CLIENT_A }],
    '2026-02': [{ number: 'V-2', date: '2026-02-10', net: '42000.00', client: CLIENT_B }],
    '2026-03': [{ number: 'V-3', date: '2026-03-10', net: '44000.00', client: CLIENT_A }],
    '2026-04': [{ number: 'V-4', date: '2026-04-10', net: '43000.00', client: CLIENT_B }],
    '2026-05': [{ number: 'V-5', date: '2026-05-11', net: '45000.00', client: CLIENT_A }],
    '2026-06': [{ number: 'V-6', date: '2026-06-10', net: '44000.00', client: CLIENT_B }],
    '2026-07': [{ number: 'V-7', date: '2026-07-10', net: '43000.00', client: CLIENT_A }],
    '2026-08': [{ number: 'V-8', date: '2026-08-10', net: '44000.00', client: CLIENT_B }],
    '2026-09': [{ number: 'V-9', date: '2026-09-10', net: '45000.00', client: CLIENT_A }],
    '2026-10': [
      { number: 'V-10', date: '2026-10-06', net: '12000.00', client: CLIENT_B },
      { number: 'V-11', date: '2026-10-20', net: '8000.00', client: CLIENT_A },
    ],
    '2026-11': [{ number: 'V-12', date: '2026-11-10', net: '30000.00', client: CLIENT_B }],
    '2026-12': [{ number: 'V-13', date: '2026-12-10', net: '30000.00', client: CLIENT_A }],
  };
  const opened: Record<string, string> = {};
  const documents: Record<string, string> = {};
  /** The sales invoiced with VAT. */
  const charged = new Set<string>();
  let ron = '20000.00';
  let eur = '3000.00';
  /** The day the company is registered for VAT from, once a person recorded it. */
  let registered: string | null = null;
  const payer = (date: string) => registered !== null && date >= registered;
  const vat21 = (net: string) => (Math.round(Number(net) * 21) / 100).toFixed(2);

  /** Meta's ads of the month: outside VAT the VAT owed through D301 on 4423; registered, the
   * reverse charge self-assessed and deducted. */
  async function ads(m: string) {
    const date = `${m}-03`;
    await b.at(date);
    const meta = await b.invoice({
      number: `FBADS-${m}`,
      date,
      country: 'IE',
      counterparty: META,
      currency: 'EUR',
      category: 'AE',
      rate: '0',
      tax: '0.00',
      net: '200.00',
      gross: '200.00',
    });
    const booked = await b.book('invoices.crossBorder', {
      documentId: meta.id,
      account: '623',
      supply: 'services_general_rule',
      ...(payer(date) ? {} : { deduction: 'none', authorityId: anaf.id }),
    });
    // 200 € at the month's rate, VAT 21% of that base.
    const base = (200 * Number(eurOf(date))).toFixed(2);
    expect(lines(booked)).toEqual(
      payer(date)
        ? [`D 623 ${base}`, `C 401 ${base}`, `C 4427 ${vat21(base)}`, `D 4426 ${vat21(base)}`]
        : [`D 623 ${base}`, `C 401 ${base}`, `D 623 ${vat21(base)}`, `C 4423 ${vat21(base)}`],
    );
    opened[`FBADS-${m}`] = booked.effect!.openItems.find(
      (item) => item.controlAccount === '401',
    )!.id;
  }

  /** A Romanian VAT payer's invoice: deducted once the company is registered. */
  async function purchase(
    number: string,
    date: string,
    supplier: string,
    net: string,
    account: string,
  ) {
    await b.at(date);
    const invoice = await b.invoice({
      number,
      date,
      counterparty: `RO${supplier}`,
      net,
      tax: vat21(net),
      gross: (Number(net) + Number(vat21(net))).toFixed(2),
    });
    documents[number] = invoice.id;
    const booked = await b.book('invoices.recognize', {
      documentId: invoice.id,
      account,
      deduction: payer(date) ? 'full' : 'none',
    });
    opened[number] = booked.effect!.openItems[0]!.id;
    return booked;
  }

  /** A sale: category O outside VAT, 21% once registered. */
  async function sell(sale: (typeof sales)[string][number]) {
    await b.at(sale.date);
    const tax = payer(sale.date) ? vat21(sale.net) : null;
    const invoice = await b.invoice({
      number: sale.number,
      date: sale.date,
      direction: 'sale',
      counterparty: `RO${sale.client}`,
      net: sale.net,
      ...(tax
        ? { tax, gross: (Number(sale.net) + Number(tax)).toFixed(2) }
        : { category: 'O', rate: '0', tax: '0.00', gross: sale.net }),
    });
    documents[sale.number] = invoice.id;
    if (tax) charged.add(sale.number);
    const booked = await b.book('invoices.recognize', { documentId: invoice.id, account: '704' });
    expect(lines(booked)).toEqual(
      tax
        ? [
            `D 4111 ${(Number(sale.net) + Number(tax)).toFixed(2)}`,
            `C 704 ${sale.net}`,
            `C 4427 ${tax}`,
          ]
        : [`D 4111 ${sale.net}`, `C 704 ${sale.net}`],
    );
    opened[sale.number] = booked.effect!.openItems[0]!.id;
  }

  /** The month's statements, each movement settling the open item its text names; the euro
   * account revalued at the month's end. */
  async function statements(m: string, rows: Row[], euroRows: Row[]) {
    for (const [account, currency, list] of [
      [ronIban, 'RON', rows],
      [eurIban, 'EUR', euroRows],
    ] as const) {
      const { closing, movements } = await b.statement({
        iban: account,
        currency,
        month: m,
        opening: currency === 'RON' ? ron : eur,
        rows: [...list],
      });
      if (currency === 'RON') ron = closing;
      else eur = closing;
      for (const movement of movements.filter((item) => item.state === 'unexplained')) {
        const reference = list.find((row) => movement.reference.endsWith(row.reference))!.reference;
        await b.book('bank.settle', {
          movementId: movement.id,
          allocations: [{ openItem: opened[reference], amount: movement.amount.replace('-', '') }],
        });
      }
    }
    // The euro left at the month's end, at its rate: (3.000 − 200 × months before) × 0,001.
    const left = 3000 - 200 * (Number(m.slice(5, 7)) - 1);
    const revalued = await b.book('fx.revalue', { date: lastDay(m) });
    expect(lines(revalued)).toEqual([
      `D 5124 ${(left * 0.001).toFixed(2)}`,
      `C 7651 ${(left * 0.001).toFixed(2)}`,
    ]);
  }

  /** The rows a month's statements carry: the rent on the 12th, each client on the 25th (or
   * the 28th), Meta from the euro account on the 5th. */
  const rowsOf = (m: string): [Row[], Row[]] => [
    [
      {
        date: `${m}-12`,
        amount: `-${(2000 + 420).toFixed(2)}`,
        reference: `CH-${m}`,
        text: `Plata factura CH-${m}`,
      },
      ...sales[m]!.map((sale, index) => ({
        date: `${m}-${index ? '28' : '25'}`,
        amount: payer(sale.date) ? (Number(sale.net) * 1.21).toFixed(2) : sale.net,
        reference: sale.number,
        text: `Incasare ${sale.number}`,
      })),
    ],
    [
      {
        date: `${m}-05`,
        amount: '-200.00',
        reference: `FBADS-${m}`,
        text: `Meta Platforms Ireland FBADS-${m}`,
      },
    ],
  ];

  /** The returns of the periods that ended, from the worklist, and what each came to. */
  const filed: Record<string, Artifact | string> = {};
  async function returns(fourthQuarter = false) {
    const prepared: Record<string, Artifact | string> = {};
    for (const result of await b.returns({
      D100: { declarant, ...(fourthQuarter ? { fourthQuarterDue: 'june' } : {}) },
      D301: { declarant, bank: 'Trezoreria Galați', account: 'RO12TREZ3065503XXXXXXXXX' },
      D390: { declarant },
      D300: d300Options,
      // The sales were invoiced outside the engine's series (the company's own invoicer): the
      // statement declares the range the period used.
      D394: (period: string) => {
        const issued = (sales[period] ?? []).filter((sale) => charged.has(sale.number));
        return issued.length
          ? {
              ...d394Options,
              outsideSeries: {
                allocated: [{ series: 'V', first: '1' }],
                issued: issued.map((sale) => ({
                  series: 'V',
                  first: sale.number.slice(2),
                  last: sale.number.slice(2),
                })),
                invoices: issued.length,
              },
            }
          : d394Options;
      },
      D406: {
        contact: { firstName: 'Ana', lastName: 'Popescu', phone: '0236123456' },
        accounts: { '612': '6123', '623': '6232', '635': '635' },
      },
      // FY2026's statements: ANAF has not published their package (FORMAT_GAP).
      S1005: s1005Options,
    })) {
      if (result.artifact) validated(result.artifact);
      prepared[result.key] = result.artifact ?? `${result.code}: ${result.message}`;
      filed[result.key] = prepared[result.key]!;
    }
    return prepared;
  }

  /**
   * From November the worklist reaches 2027, whose returns wait for the rules of 2027 (the VAT
   * period cannot be determined before 2026 ends; ROLLOVER.md: `ro.d406.start` BEYOND_HORIZON):
   * listed, never blocking a close of 2026.
   */
  async function close(m: string) {
    await b.at(`${nextMonth(m)}-03`);
    if (m >= '2026-10') {
      const next = (await b.work({ kinds: ['obligation.due'] })).filter((item) =>
        /\|2027-/.test(item.subject.id),
      );
      expect(next.length, `2027's returns at the close of ${m}`).toBeGreaterThan(0);
      expect(
        next.filter((item) => item.severity === 'block' || item.details.waiting !== 2027),
      ).toEqual([]);
    }
    expect(
      (await b.work({ severity: 'block' })).map((item) => `${item.kind} ${item.subject.id}`),
      `the worklist before closing ${m}`,
    ).toEqual([]);
    await b.close(m, []);
  }

  test('setup: the owner configures the company, the agent its determinations', async () => {
    b = await books({
      cui: SERVICES,
      name: 'Exemplu Servicii SRL',
      today: '2026-01-02',
      suppliers: [LANDLORD, ACCOUNTANT],
    });
    const { s } = b;
    await s.invoke(s.owner, 'sales.seller.record', {
      details: {
        name: 'Exemplu Servicii SRL',
        vatId: `RO${SERVICES}`,
        address: { lines: ['Str. Lungă 10'], city: 'Galați', subdivision: 'RO-GL', country: 'RO' },
      },
    });
    for (const [axis, value, from] of [
      ['entity.form', 'srl', '2020-01-01'],
      ['activity.goods', 'no', '2020-01-01'],
      ['regime.excluded', 'none', '2020-01-01'],
      ['employer', 'no', '2020-01-01'],
      ['vat.status', 'non_vat', '2020-01-01'],
      ['vat.eu', 'special', '2025-11-03'],
      // 2025's regime, from its filed D100s: the 2026 determination starts from it (art. 48).
      ['income_tax', 'micro', '2025-01-01'],
    ] as const)
      await b.fact(axis, value, from);
    for (const [kind, ledgerAccount, currency, number] of [
      ['bank', '5121', 'RON', ronIban],
      ['bank', '5124', 'EUR', eurIban],
    ] as const)
      await s.invoke(s.owner, 'treasury.createAccount', {
        kind,
        name: `Cont curent ${currency}`,
        iban: number,
        currency,
        ledgerAccount,
        openedOn: '2026-01-01',
      });
    anaf = await s.invoke<{ id: string }>(b.agent, 'parties.create', {
      kind: 'ro_public_institution',
      country: 'RO',
      name: 'ANAF',
    });
    await s.invoke(b.agent, 'fx.importBnr', {
      evidenceId: await b.file('nbrfxrates2026.xml', bnrRates(eurOf, '2025-12-31', '2026-12-31')),
    });
    // The opening balances of 1 January (the 2025 balance sheet): 20.000 lei and 3.000 € at
    // 5,0800 (15.240 lei) against the capital and retained earnings.
    await b.book('ledger.general', {
      date: '2026-01-01',
      purpose: 'opening',
      reference: 'SOLD-INITIAL',
      description: 'Solduri inițiale din bilanțul 2025',
      evidenceId: (await s.evidence('balanta-2025.pdf')).id,
      lines: [
        { account: '5121', side: 'D', amount: '20000.00' },
        {
          account: '5124',
          side: 'D',
          amount: '15240.00',
          currency: {
            code: 'EUR',
            amount: '3000.00',
            rate: '5.0800',
            rateId: 'BNR/EUR/2025-12-31',
          },
        },
        { account: '1012', side: 'C', amount: '200.00' },
        { account: '1171', side: 'C', amount: '35040.00' },
      ],
    });
    // Nothing is assumed about the year: its regime waits on the determinations, and the first
    // micro-tax return on them, a warning until its period begins; the closure names its needs.
    const start = (await b.work()).map(
      (item) => `${item.kind} ${item.subject.id} ${item.severity}`,
    );
    expect(start).toEqual(
      expect.arrayContaining([
        'determination.missing income_tax/2026 warn',
        'determination.missing size.category/2026 warn',
        'obligation.due D100|2026-03 warn',
        'closure.need micro.conditions|year:2026 warn',
      ]),
    );
    // The agent opens the determinations; the owner answers from the 2025 statements and the
    // trade register (2025 is not in these books), then confirms each computation.
    const statements = (await s.evidence('situatii-financiare-2025.pdf')).id;
    const asked: string[] = [];
    await b.determine(2026, (question) => {
      asked.push(`${question.kind} ${question.subject.id}`);
      if (question.kind === 'year.figures')
        return {
          values: {
            turnover: '310000.00',
            netTurnover: '310000.00',
            totalRevenue: '312000.00',
            vatTurnover: '310000.00',
            exemptionTurnover: '310000.00',
            totalAssets: '120000.00',
            averageEmployees: '0',
            euGoodsAcquisitions: 'no',
          },
          evidenceIds: [statements],
        };
      // The administrator's mandate stands in for the employee of art. 47 alin. (1) lit. g)
      // (art. 51 alin. (4) lit. b)); its pay is outside these books.
      if (question.kind === 'micro.conditions')
        return {
          stateOwned: false,
          dissolution: false,
          excludedActivity: false,
          shareholders: 'only_micro',
          statementsOnTime: 'yes',
          mandate: true,
          established: null,
          lateStatementsFrom: null,
          linked: [],
          evidenceIds: [statements],
        };
      if (question.kind === 'profile.fact' && question.subject.id === 'size.category/2025')
        return { value: 'micro', effectiveFrom: '2025-01-01' };
      return undefined;
    });
    expect(asked.sort()).toEqual([
      'micro.conditions 2026',
      'profile.fact size.category/2025',
      'year.figures 2025',
    ]);
    const year = await b.evaluate(2026);
    const of = (axis: string) => year.find((item) => item.axis === axis)!;
    expect(of('income_tax')).toMatchObject({
      value: 'micro',
      recorded: { confirmed: true, agrees: true },
    });
    expect(of('vat.status')).toMatchObject({
      value: 'non_vat',
      changes: [],
      recorded: { agrees: true },
    });
    expect(of('vat.eu')).toMatchObject({ value: 'special', recorded: { agrees: true } });
    expect(of('vat.threshold')).toMatchObject({ value: 'under', recorded: { confirmed: true } });
    expect(of('vat.period').status).toBe('not_applicable');
    const closure = await b.closure('2026-01', '2026-12');
    expect(closure).toMatchObject({ status: 'ELIGIBLE', needs: [], unsupported: [] });
  }, 60_000);

  test('January to September: outside VAT, the D301 and D390 of each month, the micro tax of each quarter', async () => {
    // Q1 126.000, Q2 132.000, Q3 132.000 lei of revenue, 1% each (FX gains on 765 excluded).
    const micro: Record<string, string> = {
      '2026-03': '1260.00',
      '2026-06': '1320.00',
      '2026-09': '1320.00',
    };
    for (const m of months.slice(0, 9)) {
      await ads(m);
      await purchase(`CH-${m}`, `${m}-05`, LANDLORD, '2000.00', '612');
      for (const sale of sales[m]!) await sell(sale);
      await b.at(`${nextMonth(m)}-02`);
      await statements(m, ...rowsOf(m));
      if (micro[m]) {
        const quarter = `2026-Q${Number(m.slice(5, 7)) / 3}`;
        const tax = await b.book('tax.micro', { quarter, date: lastDay(m), authorityId: anaf.id }, [
          'MICRO_EMPLOYEE',
        ]);
        expect(lines(tax)).toEqual([`D 698 ${micro[m]}`, `C 4418 ${micro[m]}`]);
      }
      // The month's D301 and D390; the quarter's D100 and D406, quarterly outside VAT (OPANAF
      // nr. 1.783/2021 anexa nr. 4 pct. 3), as 100020, its sales under 310326, its purchases with
      // VAT under 351104 and Meta's services, whose VAT it owes through D301, under 356319.
      const prepared = await returns();
      const quarter = micro[m] ? `2026-Q${Number(m.slice(5, 7)) / 3}` : null;
      expect(Object.keys(prepared), m).toEqual([
        ...(micro[m] ? [`D100 ${m}`] : []),
        `D301 ${m}`,
        `D390 ${m}`,
        ...(quarter ? [`D406 ${quarter}`] : []),
      ]);
      if (quarter)
        expect(summaryOf(prepared[`D406 ${quarter}`] as Artifact)).toMatchObject({
          type: 'T',
          vatCodes: ['310326', '351104', '356319'],
        });
      await close(m);
    }
  }, 120_000);

  test('October: the threshold crossed on the 6th, the company registers late, the VAT owed computed from the books', async () => {
    const m = '2026-10';
    await ads(m);
    await purchase(`CH-${m}`, `${m}-05`, LANDLORD, '2000.00', '612');
    const [crossing, after] = sales[m]!;
    await sell(crossing!);
    // The day after the crossing the worklist says so: the registration is due from it.
    await b.at('2026-10-07');
    expect(
      (await b.work({ severity: 'block' })).map((item) => `${item.kind} ${item.subject.id}`),
    ).toEqual(
      expect.arrayContaining([
        'determination.missing vat.status/2026',
        'threshold.approaching ro.vat.exemption.threshold/2026',
      ]),
    );
    // The company goes on as before: the accountant's invoice and one more sale without VAT.
    await purchase('CT-77', '2026-10-12', ACCOUNTANT, '1000.00', '628');
    await sell(after!);
    await b.at('2026-11-02');
    const [rows, euro] = rowsOf(m);
    await statements(
      m,
      [
        ...rows,
        { date: '2026-10-20', amount: '-1210.00', reference: 'CT-77', text: 'Plata factura CT-77' },
      ],
      euro,
    );
    // Registered late: what the books owe for it, before anyone records the registration.
    const before = await b.s.invoke<{
      threshold: { crossed: string; transaction: { number: string } };
      registration: { due: string; recorded: string | null; state: string };
      exposure: {
        from: string;
        until: string;
        consideration: string;
        inclusive: { base: string; vat: string };
        undecided: number;
      };
      purchases: { number: string; vat: string }[];
    }>(b.agent, 'vat.registration', { year: 2026 });
    expect(before).toMatchObject({
      threshold: { crossed: '2026-10-06', transaction: { number: 'V-10' } },
      registration: { due: '2026-10-06', recorded: null, state: 'overdue' },
      exposure: {
        from: '2026-10-06',
        until: '2026-10-20',
        consideration: '20000.00',
        inclusive: { base: '16528.93', vat: '3471.07' },
        undecided: 1,
      },
      purchases: [{ number: 'CT-77', vat: '210.00' }],
    });
    // The worklist blocks on it: the registration the threshold made due, and every return of
    // the months from it, until a person records it.
    const blocked = (await b.work({ severity: 'block' })).map(
      (item) => `${item.kind} ${item.subject.id}`,
    );
    expect(blocked).toEqual(
      expect.arrayContaining([
        'determination.missing vat.status/2026',
        'determination.missing vat.threshold/2026',
        'threshold.approaching ro.vat.exemption.threshold/2026',
        'obligation.due D300|2026-10',
      ]),
    );

    // The owner registers, from the crossing day (art. 310 alin. (6^2) lit. a)); the agent opens
    // the determinations again and the person confirms their computation: monthly from 6 October.
    const certificate = await b.fact(
      'vat.status',
      'normal_vat',
      '2026-10-06',
      'certificat-tva-art316.pdf',
    );
    registered = '2026-10-06';
    await b.determine(2026, () => undefined);
    const year = await b.evaluate(2026);
    const of = (axis: string) => year.find((item) => item.axis === axis)!;
    expect(of('vat.period')).toMatchObject({
      value: 'monthly',
      effectiveFrom: '2026-10-06',
      recorded: { agrees: true, confirmed: true },
    });
    expect(of('vat.period').lines[0]).toContain('512.050,36 lei');
    expect(of('vat.status')).toMatchObject({
      value: 'non_vat',
      changes: [{ value: 'normal_vat', effectiveFrom: '2026-10-06' }],
      recorded: { agrees: true },
    });

    // The VAT owed for the late registration, booked in November's return: the price taken to
    // include the VAT, with the company's statement that its clients will not pay it; the
    // accountant's invoice deducted now.
    const statement = await b.s.evidence('declaratie-nerecuperare-tva.pdf');
    const late = await b.s.invoke<ProposalView>(b.agent, 'proposals.propose', {
      treatment: 'vat.lateRegistration',
      input: {
        from: '2026-10-06',
        until: '2026-10-20',
        date: '2026-11-02',
        evidenceId: certificate.evidenceId,
        consideration: 'inclusive',
        considerationEvidenceId: statement.id,
        purchases: [{ documentId: documents['CT-77'], deduction: 'full' }],
      },
    });
    expect(late.issues.map((issue) => `${issue.severity} ${issue.code}`)).toEqual([
      'info CAPITAL_GOODS',
    ]);
    expect(lines(late)).toEqual([
      'D 635 3471.07',
      'C 4427 3471.07',
      'D 4426 210.00',
      'C 7588 210.00',
    ]);
    expect(taxes(late)).toEqual([
      'output REG-310 16528.93 3471.07',
      'input REG-310 1000.00 210.00',
    ]);
    await b.settle(late);

    // October's returns: the special return for Meta's invoice of the 3rd, outside VAT; the
    // first D300 from the 6th, with nothing of its own (the late registration's VAT is
    // November's); D394 with the accountant's invoice; D390.
    const prepared = await returns();
    expect(summaryOf(prepared['D300 2026-10'] as Artifact)).toMatchObject({ rows: {} });
    expect(summaryOf(prepared['D301 2026-10'] as Artifact)).toMatchObject({
      registeredArt317: true,
      payable: '214.00',
      lines: [
        {
          section: '4',
          number: 'FBADS-2026-10',
          value: '200.00 EUR',
          rate: '5.0900',
          base: '1018.00',
          vat: '214.00',
        },
        { section: '4.1', number: 'FBADS-2026-10' },
      ],
    });
    expect(summaryOf(prepared['D394 2026-10'] as Artifact)).toMatchObject({
      operations: [
        { type: 'A', rate: '21', partner: ACCOUNTANT, invoices: 1, base: 1000, vat: 210 },
      ],
      issuedInvoices: 0,
    });
    // Meta's invoice of 3 October booked outside VAT, its VAT expensed on 623 beside the base
    // (356319 on the base, the expensed VAT and 4423 without), the registration's sales at 21%.
    expect(summaryOf(prepared['D406 2026-10'] as Artifact)).toMatchObject({ type: 'L' });
    await close(m);
  }, 60_000);

  test('November and December: registered, monthly D300, D394 and D390, the VAT settled, the year’s micro tax', async () => {
    const evidenceId = (await b.s.evidence('decont-tva.pdf')).id;
    for (const m of ['2026-11', '2026-12']) {
      await ads(m);
      await purchase(`CH-${m}`, `${m}-05`, LANDLORD, '2000.00', '612');
      for (const sale of sales[m]!) await sell(sale);
      await b.at(`${nextMonth(m)}-02`);
      await statements(m, ...rowsOf(m));
      const settled = await b.book('vat.settle', {
        period: m,
        date: lastDay(m),
        authorityId: anaf.id,
        evidenceId,
      });
      // November: collected 3.471,07 (late registration) + 6.300,00 (V-12) + 213,82 (Meta,
      // 1.018,20 × 21%), deducted 210,00 + 420,00 + 213,82. December: 6.300,00 + 213,86
      // collected, 420,00 + 213,86 deducted.
      expect(lines(settled)).toEqual(
        m === '2026-11'
          ? ['D 4427 9984.89', 'C 4426 843.82', 'C 4423 9141.07']
          : ['D 4427 6513.86', 'C 4426 633.86', 'C 4423 5880.00'],
      );
      if (m === '2026-12') {
        // Q4: the quarter's revenues, 7588 of the late registration's deduction kept in the base
        // by the person's determination, and the year's net favourable FX difference (art. 53
        // alin. (2) lit. b)): 12.000 + 8.000 + 30.000 + 30.000 + 210 + 22,80 (the revaluations
        // of 5124: 3,00 + 2,80 + … + 0,80) = 80.232,80 lei, 1%.
        const micro = await b.book(
          'tax.micro',
          {
            quarter: '2026-Q4',
            date: '2026-12-31',
            authorityId: anaf.id,
            determinations: [
              {
                account: '7588',
                letter: null,
                excluded: '0',
                evidenceId: (await b.s.evidence('analiza-7588-inregistrare-tardiva.pdf')).id,
              },
            ],
          },
          ['MICRO_EMPLOYEE'],
        );
        // 802,33 lei, the tax in whole lei.
        expect(lines(micro)).toEqual(['D 698 802.00', 'C 4418 802.00']);
      }
      const prepared = await returns(m === '2026-12');
      const d300 = summaryOf<{ rows: Record<string, number>; balances: Record<string, number> }>(
        prepared[`D300 ${m}`] as Artifact,
      );
      // rd. 9 the sale; rd. 7 and 7.1 Meta's service, repeated as deductible on rd. 20; rd. 24
      // the rent; rd. 31 what is deducted; in November rd. 16 and 33 the late registration.
      expect(d300.rows).toEqual({
        ...(m === '2026-11' ? { R16_1: 16529, R16_2: 3471, R30_1: 1000, R30_2: 210 } : {}),
        R7_1: 1018,
        R7_2: 214,
        R7_1_1: 1018,
        R7_1_2: 214,
        R22_1: 2000,
        R22_2: 420,
        R9_1: 30000,
        R9_2: 6300,
        R28_2: 634,
      });
      expect(d300.balances.R41_2).toBe(m === '2026-11' ? 9141 : 5880);
      expect(summaryOf(prepared[`D394 ${m}`] as Artifact)).toMatchObject({
        operations: [
          { type: 'A', rate: '21', partner: LANDLORD, invoices: 1, base: 2000, vat: 420 },
          {
            type: 'L',
            rate: '21',
            partner: sales[m]![0]!.client,
            invoices: 1,
            base: 30000,
            vat: 6300,
          },
        ],
        issuedInvoices: 1,
      });
      expect(summaryOf(prepared[`D390 ${m}`] as Artifact)).toMatchObject({
        operations: [{ type: 'S', country: 'IE', code: '9692928F', base: 1018 }],
      });
      if (m === '2026-11') {
        // The late registration's VAT: collected under 310345 on 635, deducted under 309106 on
        // 7588 (D300 rd. 16 and 33).
        expect(summaryOf(prepared['D406 2026-11'] as Artifact).vatCodes).toEqual(
          expect.arrayContaining(['309106', '310345']),
        );
        await close(m);
      } else {
        expect(summaryOf(prepared['D100 2026-12'] as Artifact)).toMatchObject({
          obligations: ['micro'],
        });
        expect(summaryOf(prepared['D406 2026-12'] as Artifact)).toMatchObject({ type: 'L' });
        expect(prepared['S1005 2026']).toStartWith('FORMAT_GAP: ');
      }
    }
  }, 60_000);

  test('the year’s end: the inventory, the result closed, December and the year closed, FY2026’s S1005 a FORMAT_GAP', async () => {
    const { s } = b;
    // The inventory of 31 December, transcribed by the agent from the commission's lists.
    const list = await b.file(
      'liste-inventariere-2026.txt',
      'Lista de inventariere 31.12.2026',
      'text/plain',
    );
    const recorded = await s.invoke<{ checks: { code: string; status: string }[] }>(
      b.agent,
      'documents.record',
      {
        evidenceId: list,
        kind: 'inventory.list',
        body: {
          title: 'Lista de inventariere la 31.12.2026',
          company: { name: 'Exemplu Servicii SRL', taxId: SERVICES },
          date: '2026-12-31',
          commission: {
            decision: '12',
            decisionDate: '2026-12-01',
            members: ['Popescu Ana', 'Rus Dan'],
          },
          bank: [
            { account: '5121', currency: 'RON', balance: ron },
            { account: '5124', currency: 'EUR', balance: eur },
          ],
        },
      },
    );
    expect(recorded.checks.find((check) => check.code === 'TOTALS')?.status).toBe('passed');
    // The lists agree with the books: 5121 and 5124 are the statements' closing balances.
    expect(await s.invoke(b.agent, 'inventory.compare', { date: '2026-12-31' })).toMatchObject({
      differences: [],
      gaps: [],
      unsupported: [],
    });
    // No obligation needs a provision: the agent asks, the owner answers.
    const question = await s.invoke<{ id: string }>(b.agent, 'questions.ask', {
      kind: 'provisions.review',
      subject: { kind: 'company', id: 'company' },
      params: { year: 2026 },
    });
    await s.invoke(s.owner, 'questions.answer', {
      questionId: question.id,
      value: { none: true, evidenceIds: [] },
    });
    // The result: 470.000 + 210 + 22,80 of revenue, against rent 28.200 (2.420 × 10 + 2.000 × 2),
    // Meta 14.343,51 (12 bases of 1.016,20…1.018,40 and the VAT of ten months outside VAT),
    // the accountant 1.210, the late registration's VAT 3.471,07 and the micro tax 4.702.
    const closing = await b.book('year.closeResult', {
      yearEnd: '2026-12-31',
      evidenceId: (await s.evidence('nota-inchidere-2026.pdf')).id,
    });
    expect(closing.effect!.lines.find((line) => line.account === '121')).toMatchObject({
      side: 'C',
      amount: '418306.22',
    });
    // FY2026's statement: the agent asks its chapters, the owner answers them (the package is
    // ANAF's to publish; the inputs wait for it).
    await s.invoke(b.agent, 'annual.ask', { kind: 'S1005', year: 2026 });
    await answerAnnual(s, 'S1005', 2026, 200);
    expect(
      (
        await s.invoke<{ items: unknown[] }>(b.agent, 'yearend.review', {
          financialYearId: s.year.id,
        })
      ).items,
    ).toEqual([]);
    await close('2026-12');
    const request = await s.invoke<ActionView>(b.agent, 'years.close.request', {
      financialYearId: s.year.id,
    });
    expect(
      (request.preview as { findings: { severity: string }[] }).findings.filter(
        (finding) => finding.severity === 'block',
      ),
    ).toEqual([]);
    await s.invoke(s.reviewer, 'actions.approve', {
      id: request.id,
      previewHash: request.previewHash,
    });
    expect(
      (await s.invoke<ActionView>(b.agent, 'actions.execute', { id: request.id })).status,
    ).toBe('executed');
    expect(
      (await s.list<{ month: string; state: string }>(b.agent, 'periods.list', {}))
        .filter((period) => period.month.startsWith('2026'))
        .map((period) => period.state),
    ).toEqual(Array(12).fill('closed'));
  }, 60_000);

  test('cross-checks: D301 and D390 equal the purchases, the books equal the statements, every return the closure lists', async () => {
    const tb = await b.trialBalance();
    for (const total of Object.values(tb.totals)) expect(total.debit).toBe(total.credit);
    expect(await b.balance('5121')).toBe(ron);
    // 600 € left (3.000 − 12 × 200), at December's 5,0920.
    expect(eur).toBe('600.00');
    expect(await b.balance('5124')).toBe('3055.20');
    // Each month outside VAT, D301 declares exactly Meta's invoice: 200 € at the month's rate,
    // its VAT in whole lei; D390 the same base; 4423 holds the VAT the books owe.
    let owed = 0n;
    for (const m of months) {
      const base = (200 * Number(eurOf(`${m}-03`))).toFixed(2);
      const vat = (Math.round(Number(base) * 21) / 100).toFixed(2);
      const whole = (amount: string) => `${Math.round(Number(amount))}.00`;
      expect(summaryOf(filed[`D390 ${m}`] as Artifact)).toMatchObject({
        operations: [
          { type: 'S', country: 'IE', code: '9692928F', base: Math.round(Number(base)) },
        ],
      });
      if (m > '2026-10') {
        expect(filed[`D301 ${m}`]).toBeUndefined();
        continue;
      }
      owed += BigInt(vat.replace('.', ''));
      expect(summaryOf(filed[`D301 ${m}`] as Artifact)).toMatchObject({
        payable: whole(vat),
        lines: [
          {
            section: '4',
            number: `FBADS-${m}`,
            value: '200.00 EUR',
            rate: eurOf(`${m}-03`),
            base: whole(base),
            vat: whole(vat),
          },
          { section: '4.1', number: `FBADS-${m}` },
        ],
      });
    }
    // 2.135,91 lei of special VAT on 4423 from ten months, beside the settlements of
    // November and December (9.141,07 + 5.880,00).
    const vat4423 = tb.rows.find((row) => row.account === '4423')!;
    expect(vat4423.current.credit).toBe(money(owed + 914107n + 588000n));

    // The closure for the year, against what was prepared: every return validated by ANAF but
    // the named gaps.
    const closure = await b.closure('2026-01', '2026-12');
    expect(closure).toMatchObject({ status: 'ELIGIBLE', needs: [], unsupported: [] });
    // Every return the closure calls covered is prepared and validated, or is a published
    // format the engine does not write yet (FORMAT_GAP): the closure and the writers agree.
    const gaps: Record<string, string> = { 'S1005 2026': 'FORMAT_GAP' };
    const listed = closure.obligations.map((item) => `${item.kind} ${item.period}`);
    expect(listed.filter((key) => !filed[key])).toEqual([]);
    for (const key of listed) {
      const result = filed[key]!;
      if (gaps[key]) expect(result, key).toStartWith(`${gaps[key]}: `);
      else validated(result as Artifact);
    }
    expect(listed.filter((key) => key.startsWith('D301')).length).toBe(10);
    expect(listed.filter((key) => key.startsWith('D390')).length).toBe(12);
    expect(listed.filter((key) => key.startsWith('D100')).length).toBe(4);
    expect(listed.filter((key) => /^D3(00|94) /.test(key))).toEqual([
      'D300 2026-10',
      'D394 2026-10',
      'D300 2026-11',
      'D394 2026-11',
      'D300 2026-12',
      'D394 2026-12',
    ]);
  }, 60_000);
});

// 3. An e-commerce SRL, VAT payer, selling to consumers in other Member States.

/*
 * Exemplu Digital SRL (CUI 24680133, Galați): online courses and an e-newspaper sold to consumers
 * in Germany, France and Italy (electronic services, art. 278^1), consulting invoiced to a
 * Romanian company each month, hosting bought from a Romanian supplier; VAT payer, quarterly
 * (2025: 280.000 lei, under 100.000 € × 5,0800); micro tax. Every amount by hand, at the
 * synthetic EUR rate of each month (5,08 + 0,001 × the month):
 *   below the €10.000 threshold (46.337 lei, art. 278^1 alin. (5)) the place stays in Romania:
 *   EX-2 (10 February, DE) 4.000 € + 21% at 5,0820 = 20.328,00 lei; EX-6 (12 May, FR) 5.000 € at
 *   5,0850 = 25.425,00 lei; 45.753,00 lei in all, 98,7% of the threshold;
 *   EX-9 (10 July, DE) 400 € at 5,0870 = 2.034,80 lei carries the year to 47.787,80 lei: the
 *   place is Germany from that sale (invoiced at Germany's 19%), and the company is registered
 *   in the Union scheme from 1 July;
 *   then FR 1.000 € at 20% (EX-11, August, a course paid in instalments: 400 € at once), IT 500 €
 *   at 22% and a German e-newspaper 100 € at 7% (EX-13, EX-14, September); Q4: half the French
 *   course cancelled on 12 October before its second instalment (CN-1, 500 € + 100 € VAT, a
 *   correction of Q3 in Q4's D398), the rest paid; DE 200 € (EX-17), IT 300 € (EX-19), FR 250 €
 *   (EX-20).
 *   Consulting 20.000 + 21% a month (EX-1, EX-3, …), hosting 1.000 + 21% a month.
 *   Each consumer pays by card two days after the invoice, into the euro account.
 */
const DIGITAL = '24680133';
const CORP = '35791358';
const HOST = '46813575';
const CONSUMER = '0000000000000';
const digitalRon = iban('CCCC', '1B31007593840002');
const digitalEur = iban('DDDD', '1B31007593840003');

official(
  'an e-commerce SRL, VAT payer, crossing the distance-sales threshold into the Union scheme',
  () => {
    let b: Books;
    let anaf: { id: string };
    type Row = { date: string; amount: string; reference: string; text: string };
    const opened: Record<string, string> = {};
    const documents: Record<string, string> = {};
    const filed: Record<string, Artifact | string> = {};
    let ron = '30000.00';
    let eur = '0.00';
    const vatOf = (net: string, rate: string) =>
      (Math.round(Number(net) * Number(rate)) / 100).toFixed(2);
    /** Each month's consumer sales (EUR), by number: state, net, rate, TEDB category. */
    const consumers: Record<
      string,
      {
        number: string;
        date: string;
        state: string;
        net: string;
        rate: string;
        category?: string;
        /** Paid in part: a course in two instalments. */
        paid?: string;
      }[]
    > = {
      '2026-02': [{ number: 'EX-2', date: '2026-02-10', state: 'DE', net: '4000.00', rate: '21' }],
      '2026-05': [{ number: 'EX-6', date: '2026-05-12', state: 'FR', net: '5000.00', rate: '21' }],
      '2026-07': [{ number: 'EX-9', date: '2026-07-10', state: 'DE', net: '400.00', rate: '19' }],
      '2026-08': [
        {
          number: 'EX-11',
          date: '2026-08-10',
          state: 'FR',
          net: '1000.00',
          rate: '20',
          paid: '400.00',
        },
      ],
      '2026-09': [
        { number: 'EX-13', date: '2026-09-07', state: 'IT', net: '500.00', rate: '22' },
        {
          number: 'EX-14',
          date: '2026-09-07',
          state: 'DE',
          net: '100.00',
          rate: '7',
          category: 'NEWSPAPERS',
        },
      ],
      '2026-10': [{ number: 'EX-17', date: '2026-10-20', state: 'DE', net: '200.00', rate: '19' }],
      '2026-11': [{ number: 'EX-19', date: '2026-11-16', state: 'IT', net: '300.00', rate: '22' }],
      '2026-12': [{ number: 'EX-20', date: '2026-12-09', state: 'FR', net: '250.00', rate: '20' }],
    };
    /** The consulting invoice of each month: EX-1, EX-3, … in the one series. */
    const consulting: Record<string, string> = Object.fromEntries(
      months.map((m, index) => [m, `EX-${[1, 3, 4, 5, 7, 8, 10, 12, 15, 16, 18, 21][index]}`]),
    );

    /** A question a proposal raises, asked by the agent and answered by the owner; the proposal
     * revised citing it. */
    async function resolve(
      proposal: ProposalView,
      answers: (question: { kind: string; subject: { id: string } }) => unknown,
    ) {
      let current = proposal;
      for (let round = 0; round < 4; round++) {
        const asking = current.issues.find(
          (issue) =>
            issue.severity === 'block' &&
            (issue as { details?: { question?: unknown } }).details?.question,
        ) as
          | {
              details: {
                question: { kind: string; subject: { kind: string; id: string }; params: unknown };
              };
            }
          | undefined;
        if (!asking) return current;
        const asked = await b.s.invoke<{ id: string }>(
          b.agent,
          'questions.ask',
          asking.details.question,
        );
        const value = answers(asking.details.question);
        if (value === undefined)
          throw new Error(`No answer for ${asking.details.question.subject.id}`);
        await b.s.invoke(b.s.owner, 'questions.answer', { questionId: asked.id, value });
        const input = (
          await b.s.invoke<ProposalView & { input: unknown }>(b.agent, 'proposals.get', {
            id: current.id,
          })
        ).input;
        current = await b.s.invoke<ProposalView>(b.agent, 'proposals.revise', {
          proposalId: current.id,
          version: current.version,
          input,
          basis: { answers: [asked.id] },
        });
      }
      throw new Error('The questions did not settle.');
    }

    test('setup and the year’s determinations', async () => {
      b = await books({
        cui: DIGITAL,
        name: 'Exemplu Digital SRL',
        today: '2026-01-02',
        suppliers: [HOST, CORP],
      });
      const { s } = b;
      await s.invoke(s.owner, 'sales.seller.record', {
        details: {
          name: 'Exemplu Digital SRL',
          vatId: `RO${DIGITAL}`,
          address: {
            lines: ['Str. Lungă 12'],
            city: 'Galați',
            subdivision: 'RO-GL',
            country: 'RO',
          },
        },
      });
      for (const [axis, value, from] of [
        ['entity.form', 'srl', '2020-01-01'],
        ['activity.goods', 'no', '2020-01-01'],
        ['regime.excluded', 'none', '2020-01-01'],
        ['employer', 'no', '2020-01-01'],
        ['vat.status', 'normal_vat', '2020-01-01'],
        ['vat.cash', 'no', '2020-01-01'],
        ['income_tax', 'micro', '2025-01-01'],
      ] as const)
        await b.fact(axis, value, from);
      for (const [ledgerAccount, currency, number] of [
        ['5121', 'RON', digitalRon],
        ['5124', 'EUR', digitalEur],
      ] as const)
        await s.invoke(s.owner, 'treasury.createAccount', {
          kind: 'bank',
          name: `Cont curent ${currency}`,
          iban: number,
          currency,
          ledgerAccount,
          openedOn: '2026-01-01',
        });
      anaf = await s.invoke<{ id: string }>(b.agent, 'parties.create', {
        kind: 'ro_public_institution',
        country: 'RO',
        taxId: '8000000000',
        name: 'ANAF',
      });
      await s.invoke(b.agent, 'fx.importBnr', {
        evidenceId: await b.file('nbrfxrates2026.xml', bnrRates(eurOf, '2025-12-31', '2026-12-31')),
      });
      await b.book('ledger.general', {
        date: '2026-01-01',
        purpose: 'opening',
        reference: 'SOLD-INITIAL',
        description: 'Solduri inițiale din bilanțul 2025',
        evidenceId: (await s.evidence('balanta-2025.pdf')).id,
        lines: [
          { account: '5121', side: 'D', amount: '30000.00' },
          { account: '1012', side: 'C', amount: '200.00' },
          { account: '1171', side: 'C', amount: '29800.00' },
        ],
      });
      const statements = (await s.evidence('situatii-financiare-2025.pdf')).id;
      const asked: string[] = [];
      await b.determine(2026, (question) => {
        asked.push(`${question.kind} ${question.subject.id}`);
        if (question.kind === 'year.figures')
          return {
            values: {
              turnover: '280000.00',
              netTurnover: '280000.00',
              totalRevenue: '281000.00',
              vatTurnover: '280000.00',
              exemptionTurnover: '280000.00',
              totalAssets: '90000.00',
              averageEmployees: '0',
              euGoodsAcquisitions: 'no',
            },
            evidenceIds: [statements],
          };
        if (question.kind === 'micro.conditions')
          return {
            stateOwned: false,
            dissolution: false,
            excludedActivity: false,
            shareholders: 'only_micro',
            statementsOnTime: 'yes',
            mandate: true,
            established: null,
            lateStatementsFrom: null,
            linked: [],
            evidenceIds: [statements],
          };
        if (question.kind === 'profile.fact' && question.subject.id === 'size.category/2025')
          return { value: 'micro', effectiveFrom: '2025-01-01' };
        return undefined;
      });
      expect(asked.sort()).toEqual([
        'micro.conditions 2026',
        'profile.fact size.category/2025',
        'year.figures 2025',
      ]);
      const year = await b.evaluate(2026);
      const of = (axis: string) => year.find((item) => item.axis === axis)!;
      expect(of('vat.period')).toMatchObject({
        value: 'quarterly',
        recorded: { confirmed: true, agrees: true },
      });
      expect(of('income_tax')).toMatchObject({
        value: 'micro',
        recorded: { confirmed: true, agrees: true },
      });
      expect(of('vat.distance').status).toBe('not_applicable');
      expect(await b.closure('2026-01', '2026-12')).toMatchObject({
        status: 'ELIGIBLE',
        needs: [],
        unsupported: [],
      });
    }, 60_000);

    /** A consumer's invoice in euro, electronic services: below the threshold Romanian VAT, from
     * the crossing the consumer state's, in the Union scheme. */
    async function consumerSale(sale: (typeof consumers)[string][number]) {
      await b.at(sale.date);
      const tax = vatOf(sale.net, sale.rate);
      const invoice = await b.invoice({
        number: sale.number,
        date: sale.date,
        direction: 'sale',
        counterparty: CONSUMER,
        country: sale.state,
        currency: 'EUR',
        net: sale.net,
        rate: sale.rate,
        tax,
        gross: (Number(sale.net) + Number(tax)).toFixed(2),
      });
      documents[sale.number] = invoice.id;
      const input = {
        documentId: invoice.id,
        account: '704',
        supply: 'electronic',
        location: [
          { kind: 'billing_address', country: sale.state },
          { kind: 'ip', country: sale.state },
        ],
        authorityId: anaf.id,
        ...(sale.category ? { categories: { [sale.rate]: sale.category } } : {}),
      };
      const proposal = await b.s.invoke<ProposalView>(b.agent, 'proposals.propose', {
        treatment: 'invoices.euConsumer',
        input,
      });
      return { invoice, input, proposal };
    }

    async function purchase(m: string) {
      await b.at(`${m}-05`);
      const invoice = await b.invoice({
        number: `H-${m}`,
        date: `${m}-05`,
        counterparty: `RO${HOST}`,
        net: '1000.00',
        tax: '210.00',
        gross: '1210.00',
      });
      const booked = await b.book('invoices.recognize', { documentId: invoice.id, account: '628' });
      expect(lines(booked)).toEqual(['D 628 1000.00', 'D 4426 210.00', 'C 401 1210.00']);
      opened[`H-${m}`] = booked.effect!.openItems[0]!.id;
    }

    async function consult(m: string) {
      const number = consulting[m]!;
      await b.at(`${m}-15`);
      const invoice = await b.invoice({
        number,
        date: `${m}-15`,
        direction: 'sale',
        counterparty: `RO${CORP}`,
        net: '20000.00',
        tax: '4200.00',
        gross: '24200.00',
      });
      const booked = await b.book('invoices.recognize', { documentId: invoice.id, account: '704' });
      opened[number] = booked.effect!.openItems[0]!.id;
    }

    /** The last D300 of 2025, whose information section holds the year's distance sales. */
    let lastReturn2025: string;
    /** The answers only the owner gives, to what the agent asks. */
    const owner = (question: { kind: string; subject: { id: string } }) => {
      if (question.subject.id === 'vat.distance')
        return { value: 'origin', effectiveFrom: '2026-01-01' };
      if (question.kind === 'year.figures')
        return { values: { distanceTurnover: '12000.00' }, evidenceIds: [lastReturn2025] };
      return undefined;
    };

    /** The month's statements, each movement settling the item its text names; the month's
     * revaluation of the euro account once the rate moved its balance. */
    async function statements(m: string, rows: Row[], euroRows: Row[]) {
      for (const [account, currency, list] of [
        [digitalRon, 'RON', rows],
        [digitalEur, 'EUR', euroRows],
      ] as const) {
        const { closing, movements } = await b.statement({
          iban: account,
          currency,
          month: m,
          opening: currency === 'RON' ? ron : eur,
          rows: [...list],
        });
        if (currency === 'RON') ron = closing;
        else eur = closing;
        for (const movement of movements.filter((item) => item.state === 'unexplained')) {
          const reference = list.find((row) =>
            movement.reference.endsWith(row.reference),
          )!.reference;
          await b.book('bank.settle', {
            movementId: movement.id,
            allocations: [
              { openItem: opened[reference], amount: movement.amount.replace('-', '') },
            ],
          });
        }
      }
      // Nothing in euro yet in January and February: nothing to revalue, and the agent leaves it.
      const revaluation = await b.s.invoke<ProposalView>(b.agent, 'proposals.propose', {
        treatment: 'fx.revalue',
        input: { date: lastDay(m) },
      });
      if (['2026-01', '2026-02'].includes(m)) {
        expect(revaluation.issues.map((issue) => issue.code)).toEqual(['NOTHING_TO_REVALUE']);
        await b.s.invoke(b.agent, 'proposals.withdraw', {
          proposalId: revaluation.id,
          reason: 'Nimic de reevaluat la sfârșitul lunii.',
        });
      } else {
        // The euro account and an open receivable in euro, the rate rising each month: gains.
        // From August, the Union scheme's VAT owed in euro on 4423 too, booked at earlier months'
        // rates (a monetary item, OMFP nr. 1.802/2014 pct. 315, 325): more lei owed, losses.
        const posted = await b.settle(revaluation);
        const accounts = posted.effect!.lines.map((line) => line.account);
        expect(
          [...new Set(accounts.filter((account) => !['4111', '5124'].includes(account)))].sort(),
          m,
        ).toEqual(m >= '2026-08' ? ['4423', '6651', '7651'] : ['7651']);
      }
    }

    const rowsOf = (m: string): [Row[], Row[]] => [
      [
        { date: `${m}-12`, amount: '-1210.00', reference: `H-${m}`, text: `Plata factura H-${m}` },
        {
          date: `${m}-25`,
          amount: '24200.00',
          reference: consulting[m]!,
          text: `Incasare ${consulting[m]}`,
        },
      ],
      [
        ...(consumers[m] ?? []).map((sale) => ({
          date: `${sale.date.slice(0, 8)}${String(Number(sale.date.slice(8)) + 2).padStart(2, '0')}`,
          amount: sale.paid ?? (Number(sale.net) + Number(vatOf(sale.net, sale.rate))).toFixed(2),
          reference: sale.number,
          text: `Stripe payout ${sale.number}`,
        })),
        // The French consumer pays the rest of the course, 200 €, after the credit note.
        ...(m === '2026-10'
          ? [
              {
                date: '2026-10-15',
                amount: '200.00',
                reference: 'EX-11',
                text: 'Stripe payout rest EX-11',
              },
            ]
          : []),
      ],
    ];

    async function returns(fourthQuarter: boolean) {
      const prepared: Record<string, Artifact | string> = {};
      for (const result of await b.returns({
        D100: { declarant, ...(fourthQuarter ? { fourthQuarterDue: 'june' } : {}) },
        D300: { ...d300Options, caen: '8559', account: digitalRon },
        // Every invoice of the series was issued by the company's own shop, outside the engine's
        // series: the statement declares the quarter's range.
        D394: (quarter: string) => {
          const last = Number(quarter.slice(6)) * 3;
          const numbers = months
            .slice(last - 3, last)
            .flatMap((m) => [consulting[m]!, ...(consumers[m] ?? []).map((sale) => sale.number)])
            .map((number) => Number(number.slice(3)))
            .sort((x, y) => x - y);
          return {
            ...d394Options,
            caen: '8559',
            outsideSeries: {
              allocated: [{ series: 'EX', first: '1' }],
              issued: [{ series: 'EX', first: String(numbers[0]), last: String(numbers.at(-1)) }],
              invoices: numbers.length,
            },
          };
        },
        D398: {},
        D406: { contact: { firstName: 'Ana', lastName: 'Popescu', phone: '0236123456' } },
        S1005: s1005Options,
      })) {
        if (result.artifact) validated(result.artifact);
        prepared[result.key] = result.artifact ?? `${result.code}: ${result.message}`;
        filed[result.key] = prepared[result.key]!;
      }
      return prepared;
    }

    /**
     * Not covered (the closure says so, OSS_D406): the D406 of a quarter with sales in the Union
     * scheme, which D406 reports under 310340 at each consumer state's rate, a code the file does
     * not write. Each blocks from the close of its first month with such a sale, until it is filed
     * outside the engine. The
     * quarters below the threshold are prepared, the consumers each a customer of their own (04).
     * 2027's returns, from November, wait for the rules of 2027 (see the non-payer's) and block no
     * close of 2026.
     */
    const d406Gap = (today: string) =>
      [
        ['2026-Q3', '2026-08-01'],
        ['2026-Q4', '2026-11-01'],
      ]
        .filter(([, from]) => today >= from!)
        .map(([quarter]) => `obligation.due D406|${quarter}`);
    async function close(m: string) {
      await b.at(`${nextMonth(m)}-03`);
      await b.close(m, d406Gap(b.today()));
    }

    /** What each quarter's VAT settlement and micro tax book, by hand:
     *   Q1: collected 3 × 4.200 + 4.268,88 (EX-2), deducted 3 × 210; micro 1% of 60.000 + 20.328;
     *   Q2: 3 × 4.200 + 5.339,25 (EX-6); 1% of 60.000 + 25.425;
     *   Q3, Q4: the Union scheme's VAT is on 4423 apart, outside the settlement; micro 1% of
     *   60.000 + 2.034,80 + 5.088,00 + 2.544,50 + 508,90 (Q3), of 60.000 + 1.018,00 + 1.527,30 +
     *   1.273,00 − 2.545,00 and the year's FX gains (Q4); each tax in whole lei. */
    const quarters: Record<string, { settle: string[]; micro: string }> = {
      '2026-03': {
        settle: ['D 4427 16868.88', 'C 4426 630.00', 'C 4423 16238.88'],
        micro: '803.00',
      },
      '2026-06': {
        settle: ['D 4427 17939.25', 'C 4426 630.00', 'C 4423 17309.25'],
        micro: '854.00',
      },
      '2026-09': {
        settle: ['D 4427 12600.00', 'C 4426 630.00', 'C 4423 11970.00'],
        micro: '702.00',
      },
      '2026-12': {
        settle: ['D 4427 12600.00', 'C 4426 630.00', 'C 4423 11970.00'],
        micro: '614.00',
      },
    };
    /** The place of each consumer's sale: Romania below the threshold, the consumer's state from
     * EX-9 on. */
    const abroad = (sale: { date: string }) => sale.date >= '2026-07-10';
    /** An amount in euro at the month's rate, to the ban. */
    const lei = (euro: string, date: string) =>
      (Math.round(Number(euro) * Number(eurOf(date)) * 100) / 100).toFixed(2);

    test('the year, month by month: below the threshold, crossing it, the Union scheme, D398 with a correction', async () => {
      const evidenceId = (await b.s.evidence('decont-tva.pdf')).id;
      lastReturn2025 = (await b.s.evidence('d300-2025-T4.pdf')).id;
      for (const m of months) {
        await purchase(m);
        if (m === '2026-10') {
          // A person authorizes Q3's D398 on its exact XML: what later returns correct against.
          await b.authorize((filed['D398 2026-Q3'] as Artifact).id);
          // Half the French course cancelled on 12 October, before its second instalment: a credit
          // note of EX-11, its VAT a correction of Q3 in Q4's return.
          await b.at('2026-10-12');
          const note = await b.invoice({
            number: 'CN-1',
            date: '2026-10-12',
            direction: 'sale',
            credit: true,
            originalNumber: 'EX-11',
            counterparty: CONSUMER,
            country: 'FR',
            currency: 'EUR',
            net: '500.00',
            rate: '20',
            tax: '100.00',
            gross: '600.00',
          });
          const refund = await b.s.invoke<ProposalView>(b.agent, 'proposals.propose', {
            treatment: 'invoices.euConsumer',
            input: {
              documentId: note.id,
              account: '704',
              supply: 'electronic',
              originalDocumentId: documents['EX-11'],
              authorityId: anaf.id,
            },
          });
          // 600 € at 5,0900, by red storno: 3.054 lei of revenue and VAT reversed; the receivable
          // leaves at the rate it is carried at, September's closing 5,0890 (600 × 5,0890 =
          // 3.053,40), the 0,60 lei of the euro's rise since gained (OMFP 1802/2014 pct. 322).
          expect(lines(refund)).toEqual([
            'D 4111 -3053.40',
            'C 704 -2545.00',
            'C 4423 -509.00',
            'C 7651 0.60',
          ]);
          expect(refund.effect?.explanation.details).toMatchObject({
            corrects: '2026-Q3',
            quarter: '2026-Q4',
          });
          await b.settle(refund);
        }
        for (const sale of consumers[m] ?? []) {
          const { proposal } = await consumerSale(sale);
          const codes = proposal.issues.map((issue) => `${issue.severity} ${issue.code}`);
          if (sale.number === 'EX-2') expect(codes).toEqual(['block DETERMINATION_MISSING']);
          // The sale that crosses the threshold: the engine asks where it takes place from now.
          if (sale.number === 'EX-9')
            expect(codes).toEqual(expect.arrayContaining(['block DISTANCE_THRESHOLD_CROSSED']));
          const resolved = await resolve(proposal, (question) => {
            if (question.subject.id === 'vat.distance')
              return abroad(sale)
                ? { value: 'destination', effectiveFrom: '2026-07-10' }
                : { value: 'origin', effectiveFrom: '2026-01-01' };
            // Registered in the Union scheme from 1 July: ANAF informed by 10 August (Regulation
            // (EU) No 282/2011 art. 57d).
            if (question.subject.id === 'vat.oss')
              return { value: 'union', effectiveFrom: '2026-07-01' };
            return undefined;
          });
          const gross = (Number(sale.net) + Number(vatOf(sale.net, sale.rate))).toFixed(2);
          const tax = vatOf(sale.net, sale.rate);
          expect(lines(resolved), sale.number).toEqual([
            `D 4111 ${lei(gross, sale.date)}`,
            `C 704 ${lei(sale.net, sale.date)}`,
            `C ${abroad(sale) ? '4423' : '4427'} ${lei(tax, sale.date)}`,
          ]);
          const acknowledge = resolved.issues
            .filter((issue) => issue.severity === 'ack')
            .map((issue) => issue.code);
          expect(acknowledge).toEqual(sale.category ? ['OSS_REDUCED_RATE'] : []);
          expect(resolved.issues.map((issue) => issue.code)).toContain(
            abroad(sale) ? 'EFACTURA_NOT_REQUIRED' : 'EFACTURA_B2C',
          );
          const posted = await b.settle(resolved, acknowledge);
          opened[sale.number] = posted.effect!.openItems.find(
            (item) => item.controlAccount === '4111',
          )!.id;
          // The year before, from its last D300: the agent asks, the owner answers.
          if (sale.number === 'EX-2') await b.determine(2026, owner);
        }
        if (m === '2026-06') {
          // 45.753 of 46.337 lei: the worklist warns at 80%.
          expect(
            (await b.work({ kinds: ['threshold.approaching'] })).map(
              (item) => `${item.subject.id} ${item.severity}`,
            ),
          ).toEqual(['ro.vat.distance.threshold/2026 warn']);
        }
        await consult(m);
        await b.at(`${nextMonth(m)}-02`);
        await statements(m, ...rowsOf(m));
        const quarter = quarters[m];
        if (quarter) {
          const period = `2026-Q${Number(m.slice(5, 7)) / 3}`;
          expect(
            lines(
              await b.book('vat.settle', {
                period,
                date: lastDay(m),
                authorityId: anaf.id,
                evidenceId,
              }),
            ),
          ).toEqual(quarter.settle);
          const micro = await b.book(
            'tax.micro',
            { quarter: period, date: lastDay(m), authorityId: anaf.id },
            ['MICRO_EMPLOYEE'],
          );
          expect(lines(micro)).toEqual([`D 698 ${quarter.micro}`, `C 4418 ${quarter.micro}`]);
        }
        await returns(m === '2026-12');
        if (m !== '2026-12') await close(m);
      }
    }, 120_000);

    test('the year’s end: the inventory, the result closed, December and the year closed', async () => {
      const { s } = b;
      const recorded = await s.invoke<{ checks: { code: string; status: string }[] }>(
        b.agent,
        'documents.record',
        {
          evidenceId: await b.file(
            'liste-inventariere-2026.txt',
            'Lista de inventariere 31.12.2026',
            'text/plain',
          ),
          kind: 'inventory.list',
          body: {
            title: 'Lista de inventariere la 31.12.2026',
            company: { name: 'Exemplu Digital SRL', taxId: DIGITAL },
            date: '2026-12-31',
            commission: {
              decision: '7',
              decisionDate: '2026-12-01',
              members: ['Popescu Ana', 'Rus Dan'],
            },
            bank: [
              { account: '5121', currency: 'RON', balance: ron },
              { account: '5124', currency: 'EUR', balance: eur },
            ],
          },
        },
      );
      expect(recorded.checks.find((check) => check.code === 'TOTALS')?.status).toBe('passed');
      expect(await s.invoke(b.agent, 'inventory.compare', { date: '2026-12-31' })).toMatchObject({
        differences: [],
        gaps: [],
      });
      const question = await s.invoke<{ id: string }>(b.agent, 'questions.ask', {
        kind: 'provisions.review',
        subject: { kind: 'company', id: 'company' },
        params: { year: 2026 },
      });
      await s.invoke(s.owner, 'questions.answer', {
        questionId: question.id,
        value: { none: true, evidenceIds: [] },
      });
      await b.book('year.closeResult', {
        yearEnd: '2026-12-31',
        evidenceId: (await s.evidence('nota-inchidere-2026.pdf')).id,
      });
      await s.invoke(b.agent, 'annual.ask', { kind: 'S1005', year: 2026 });
      await answerAnnual(s, 'S1005', 2026, 200);
      expect(
        (
          await s.invoke<{ items: unknown[] }>(b.agent, 'yearend.review', {
            financialYearId: s.year.id,
          })
        ).items,
      ).toEqual([]);
      await close('2026-12');
      const request = await s.invoke<ActionView>(b.agent, 'years.close.request', {
        financialYearId: s.year.id,
      });
      expect(
        (request.preview as { findings: { severity: string }[] }).findings.filter(
          (finding) => finding.severity === 'block',
        ),
      ).toEqual([]);
      await s.invoke(s.reviewer, 'actions.approve', {
        id: request.id,
        previewHash: request.previewHash,
      });
      expect(
        (await s.invoke<ActionView>(b.agent, 'actions.execute', { id: request.id })).status,
      ).toBe('executed');
    }, 60_000);

    test('cross-checks: D398 equals the Union scheme’s sales, rd. 17 the sales below the threshold, every return the closure lists', async () => {
      const tb = await b.trialBalance();
      for (const total of Object.values(tb.totals)) expect(total.debit).toBe(total.credit);
      expect(await b.balance('5121')).toBe(ron);
      // 13.587 € at the year's last rate, 5,0920: every month's revaluation added up.
      expect(eur).toBe('13587.00');
      expect(await b.balance('5124')).toBe(lei(eur, '2026-12-31'));

      // D398: per quarter, state and rate, what the Union scheme's invoices hold in euro; Q4 the
      // credit note of EX-11 as a correction of Q3 (−100 € of French VAT).
      const scheme = months.flatMap((m) => (consumers[m] ?? []).filter(abroad));
      for (const quarter of ['2026-Q3', '2026-Q4']) {
        const last = Number(quarter.slice(6)) * 3;
        const expected = new Map<string, { taxable: number; vat: number }>();
        for (const sale of scheme.filter(
          (item) =>
            Number(item.date.slice(5, 7)) > last - 3 && Number(item.date.slice(5, 7)) <= last,
        )) {
          const key = `${sale.state} ${sale.rate}`;
          const sum = expected.get(key) ?? { taxable: 0, vat: 0 };
          expected.set(key, {
            taxable: sum.taxable + Number(sale.net),
            vat: sum.vat + Number(vatOf(sale.net, sale.rate)),
          });
        }
        const summary = summaryOf<{
          supplies: { state: string; rate: string; taxable: string; vat: string }[];
          corrections: { state: string; quarter: string; cents: string }[];
        }>(filed[`D398 ${quarter}`] as Artifact);
        expect(
          summary.supplies
            .map((item) => `${item.state} ${item.rate} ${item.taxable} ${item.vat}`)
            .sort(),
        ).toEqual(
          [...expected]
            .map(([key, sum]) => `${key} ${sum.taxable.toFixed(2)} ${sum.vat.toFixed(2)}`)
            .sort(),
        );
        expect(summary.corrections).toEqual(
          quarter === '2026-Q4' ? [{ state: 'FR', quarter: '2026-Q3', cents: '-10000' }] : [],
        );
      }
      // In lei, the scheme's VAT on 4423 is what those invoices charged at their rates, less the
      // credit note (509,00), beside the four settlements.
      const owed =
        scheme.reduce(
          (total, sale) => total + Number(lei(vatOf(sale.net, sale.rate), sale.date)),
          0,
        ) - 509;
      // The scheme's VAT owed in euro is revalued at each month's end (the rate 0,0010 higher each
      // month), each invoice's from the month after it, to the ban: EX-9's 76 € 0,08 + 0,07 + 0,08
      // + 0,08 + 0,07 = 0,38; EX-11's 200 € 4 × 0,20 = 0,80; EX-13's 110 € 3 × 0,11 = 0,33;
      // EX-14's 7 € 0,01 + 0,01 + 0 = 0,02; EX-17's 38 € 2 × 0,04 = 0,08; EX-19's 66 € 0,06:
      // 1,67 lei more owed (CN-1's item, owed back, is revalued on the debit side).
      const vat4423 = tb.rows.find((row) => row.account === '4423')!;
      expect(vat4423.current.credit).toBe(
        (owed + 16238.88 + 17309.25 + 11970 + 11970 + 1.67).toFixed(2),
      );
      // D300 rd. 17: the two sales with the place in Romania, the information section cumulating
      // them over 2025's 12.000 lei.
      expect(
        summaryOf<{ rows: Record<string, number> }>(filed['D300 2026-Q1'] as Artifact).rows,
      ).toMatchObject({
        R64_1: 20328,
        R64_2: 4269,
        total_precedent: 12000,
        total_curent: 20328,
      });
      expect(
        summaryOf<{ rows: Record<string, number> }>(filed['D300 2026-Q2'] as Artifact).rows,
      ).toMatchObject({
        R64_1: 25425,
        R64_2: 5339,
        total_curent: 45753,
      });
      for (const quarter of ['2026-Q3', '2026-Q4']) {
        const rows = summaryOf<{ rows: Record<string, number> }>(
          filed[`D300 ${quarter}`] as Artifact,
        ).rows;
        // The scheme's sales are on no row of D300.
        expect(rows.R64_1).toBeUndefined();
        expect(rows).toMatchObject({
          R9_1: 60000,
          R9_2: 12600,
          R22_1: 3000,
          R22_2: 630,
          total_curent: 45753,
        });
      }

      // The year is not covered in full: the D406 of the quarters with sales in the Union scheme
      // (310340 at the consumer states' rates) the engine does not write, and the closure says so.
      const closure = await b.closure('2026-01', '2026-12');
      expect(closure).toMatchObject({
        status: 'UNSUPPORTED',
        needs: [],
        unsupported: [expect.objectContaining({ trigger: 'OSS_D406' })],
      });
      expect(
        closure.obligations
          .filter((item) => item.state !== 'applies')
          .map((item) => `${item.kind} ${item.period} ${item.state}`),
      ).toEqual(['D406 2026-Q3 unsupported', 'D406 2026-Q4 unsupported']);
      // Every return the closure calls covered is prepared and validated, or is a published
      // format the engine does not write yet (FORMAT_GAP): the closure and the writers agree. The
      // two quarters it does not cover the worklist offers no one to prepare, and the writer
      // refuses them, as it says.
      const gaps: Record<string, string> = { 'S1005 2026': 'FORMAT_GAP' };
      const listed = closure.obligations
        .filter((item) => item.state === 'applies')
        .map((item) => `${item.kind} ${item.period}`);
      expect(listed.filter((key) => !filed[key])).toEqual([]);
      for (const key of listed) {
        if (gaps[key]) expect(filed[key], key).toStartWith(`${gaps[key]}: `);
        else validated(filed[key] as Artifact);
      }
      for (const quarter of ['2026-Q3', '2026-Q4']) {
        expect(filed[`D406 ${quarter}`], quarter).toBeUndefined();
        const refused = await b.s.refused(
          b.prepare('D406', quarter, {
            contact: { firstName: 'Ana', lastName: 'Popescu', phone: '0236123456' },
          }),
        );
        expect(refused?.code, quarter).toBe('D406_TAX_CODE');
      }
      // Below the threshold, the consumers' sales with the place in Romania under 310346.
      for (const quarter of ['2026-Q1', '2026-Q2'])
        expect(
          summaryOf<{ vatCodes: string[] }>(filed[`D406 ${quarter}`] as Artifact).vatCodes,
        ).toContain('310346');
      expect(listed.filter((key) => key.startsWith('D398'))).toEqual([
        'D398 2026-Q3',
        'D398 2026-Q4',
      ]);
      expect(listed.filter((key) => /^D(300|394|100) /.test(key)).length).toBe(12);
    }, 60_000);
  },
);
