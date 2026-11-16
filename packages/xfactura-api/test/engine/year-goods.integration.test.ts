import { afterAll, describe, expect, test } from 'bun:test';
import path from 'node:path';
import { sourceXml } from 'xfactura-core/xml';
import {
  AnafKits,
  DukIntegrator,
  saftKitId,
  type DeclarationValidator,
} from '../../source/engine/adapters/declaration-validator';
import { readViesAnswer, type ViesPort } from '../../source/engine/adapters/vies';
import type { ActionView } from '../../source/engine/kernel/actions';
import type { Actor } from '../../source/engine/kernel/commands';
import type { ProposalView } from '../../source/engine/kernel/views';
import { FakeEFactura } from './fakes/efactura';
import { camt, camtEntry, iban } from './fixtures/bank';
import { invoiceXml, type XmlInput } from './fixtures/invoice';
import type { Issued } from './fixtures/sales';
import { scenario, type Scenario } from './scenario';

/*
 * Three goods companies kept for the whole of FY2026, module beside module, before the product
 * phase: a shop (G1, G2), a joinery (G4) and an EU goods trader (G3). Agents do the bookkeeping
 * through their grants (documents, proposals, postings, returns, closes); people configure the
 * company, answer what only they know, approve every version and reviewed action, authorize and
 * file the returns. Every party, document and amount is synthetic; the expected figures are worked
 * by hand in the comments, never read back from the engine.
 */

const open: Scenario[] = [];
afterAll(async () => {
  await Promise.all(open.map((s) => s.dispose()));
});

const root = path.join(import.meta.dir, '../../../..');
const generalKit = path.join(root, '.validators/anaf/dist');
const saftKit = path.join(root, '.validators/anaf-saft/duk_SAFT_an_luna/dist');
/** ANAF's validators run on every return when installed (they are, wherever the official tests
 * run); the returns' state is asserted `validated_official` only then. */
const installed =
  DukIntegrator.available(generalKit) &&
  DukIntegrator.available(saftKit) &&
  Bun.which('java') !== null;

/** A minimal valid PDF attaching `xml`, as ANAF's tool attaches it, `signed` with a
 * signature dictionary as a signer's incremental update appends it. */
function pdfWith(xml: Uint8Array, signed = false) {
  const objects = [
    Buffer.concat([
      Buffer.from(`1 0 obj\n<< /Type /EmbeddedFile /Length ${xml.length} >>\nstream\n`),
      xml,
      Buffer.from('\nendstream\nendobj\n'),
    ]),
    Buffer.from(
      '2 0 obj\n<< /Type /Filespec /F (d.xml) /UF (d.xml) /EF << /F 1 0 R /UF 1 0 R >> >>\nendobj\n',
    ),
    Buffer.from('3 0 obj\n<< /Type /Pages /Kids [4 0 R] /Count 1 >>\nendobj\n'),
    Buffer.from('4 0 obj\n<< /Type /Page /Parent 3 0 R /MediaBox [0 0 100 100] >>\nendobj\n'),
    Buffer.from(
      '5 0 obj\n<< /Type /Catalog /Pages 3 0 R /Names << /EmbeddedFiles << /Names [(d.xml) 2 0 R] >> >> >>\nendobj\n',
    ),
  ];
  const header = Buffer.from('%PDF-1.4\n');
  let offset = header.length;
  const offsets: number[] = [];
  for (const obj of objects) {
    offsets.push(offset);
    offset += obj.length;
  }
  const xref =
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` +
    offsets.map((at) => `${String(at).padStart(10, '0')} 00000 n \n`).join('') +
    `trailer\n<< /Size ${objects.length + 1} /Root 5 0 R >>\nstartxref\n${offset}\n%%EOF\n`;
  return new Uint8Array(
    Buffer.concat([
      header,
      ...objects,
      Buffer.from(xref),
      ...(signed
        ? [
            Buffer.from(
              '\n99 0 obj\n<< /Type /Sig /ByteRange [0 0 0 0] /Contents <00> >>\nendobj\n%%EOF\n',
            ),
          ]
        : []),
    ]),
  );
}
/** ANAF's validator for each kind; the PDF to sign is the stand-in above (what is checked here is
 * the XML, not ANAF's rendering of it). */
const signing = (kit: DeclarationValidator): DeclarationValidator => ({
  id: kit.id,
  validate: (kind, xml) => kit.validate(kind, xml),
  pdf: async (_kind, xml) => ({ ok: true, messages: [], pdf: pdfWith(xml) }),
});
const validator: DeclarationValidator = installed
  ? new AnafKits({
      general: signing(new DukIntegrator(generalKit)),
      saft: signing(new DukIntegrator(saftKit, saftKitId)),
    })
  : signing({
      id: 'validator de test',
      validate: async () => ({ ok: true, messages: [] }),
      pdf: async () => ({ ok: true, messages: [] }),
    });

// Money, by hand: exact decimal strings through integer bani.
const bani = (value: string) => {
  const negative = value.startsWith('-');
  const [whole, fraction = ''] = value.replace('-', '').split('.');
  const result = BigInt(whole!) * 100n + BigInt((fraction + '00').slice(0, 2));
  return negative ? -result : result;
};
const lei = (value: bigint) => {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  return `${negative ? '-' : ''}${abs / 100n}.${String(abs % 100n).padStart(2, '0')}`;
};
const sum = (values: string[]) => lei(values.reduce((total, value) => total + bani(value), 0n));
const daysIn = (month: number) => new Date(Date.UTC(2026, month, 0)).getUTCDate();
const mm = (month: number) => String(month).padStart(2, '0');
const ym = (month: number) => `2026-${mm(month)}`;
const ymd = (month: number, day: number) => `${ym(month)}-${String(day).padStart(2, '0')}`;
const lastDay = (month: number) => ymd(month, daysIn(month));
const nextMonthDay = (month: number, day: number) =>
  month === 12 ? `2027-01-${String(day).padStart(2, '0')}` : ymd(month + 1, day);

const lines = (proposal: ProposalView) =>
  proposal.effect?.lines.map((line) => `${line.side} ${line.account} ${line.amount}`) ?? [];
const codes = (proposal: ProposalView) => proposal.issues.map((issue) => issue.code);
const acks = (proposal: ProposalView) =>
  proposal.issues.filter((issue) => issue.severity === 'ack').map((issue) => issue.code);

type Artifact = {
  id: string;
  kind: string;
  period: string;
  state: string;
  evidenceId: string;
  steps: { state: string; detail: string | null }[];
};
type WorkItem = {
  id: string;
  kind: string;
  severity: string;
  subject: { kind: string; id: string };
  message: string;
  details: Record<string, unknown>;
};
type Finding = { code: string; severity: string; message: string; items?: string[] };
type Register = {
  positions: { code: string; warehouse: string; quantity: string; value: string }[];
  accounts: { account: string; register: string; ledger: string; outside: string }[];
};
type Question = {
  id: string;
  kind: string;
  subject: { kind: string; id: string };
  params: Record<string, unknown>;
};
type Closure = {
  status: string;
  needs: { code: string; fact: string; question: { kind: string } }[];
  unsupported: { trigger: string }[];
  obligations: { kind: string; period: string; state: string }[];
};
const summary = (artifact: Artifact) =>
  JSON.parse(artifact.steps[0]!.detail ?? 'null') as Record<string, unknown>;

/** A VIES that answers every code valid, for the day the engine asks on. */
function fakeVies(today: () => string): ViesPort & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    async check(query) {
      asked.push(`${query.countryCode}${query.vatNumber}`);
      const raw = new TextEncoder().encode(
        JSON.stringify({
          countryCode: query.countryCode,
          vatNumber: query.vatNumber,
          requestDate: `${today()}T10:00:00.000Z`,
          valid: true,
          requestIdentifier: `WAPI${query.vatNumber}`,
          name: `Companie ${query.countryCode}${query.vatNumber}`,
          address: 'Via Roma 1, Milano',
        }),
      );
      return { raw, result: readViesAnswer(raw, query) };
    },
  };
}

/** BNR's rates of the days a company reads: the 2025 close for the thresholds, and its own. */
const bnrXml = (cubes: [date: string, rates: Record<string, string>][]) =>
  `<?xml version="1.0" encoding="utf-8"?>
<DataSet xmlns="http://www.bnr.ro/xsd"><Header><Publisher>National Bank of Romania</Publisher><PublishingDate>2026-12-31</PublishingDate><MessageType>DR</MessageType></Header>
<Body><Subject>Reference rates</Subject><OrigCurrency>RON</OrigCurrency>
${cubes
  .map(
    ([date, rates]) =>
      `<Cube date="${date}">${Object.entries(rates)
        .map(([currency, rate]) => `<Rate currency="${currency}">${rate}</Rate>`)
        .join('')}</Cube>`,
  )
  .join('\n')}
</Body></DataSet>`;

type Setup = {
  cui: string;
  name: string;
  caen: string;
  /** Profile facts from 1 January 2026 (the scope, the policies). */
  facts: Record<string, string>;
  /** 2025's figures, from the filed statements: the year the books do not keep. */
  figures: Record<string, string>;
  rates?: [string, Record<string, string>][];
  vies?: boolean;
  /** The bank's balance at the year's start, the opening entry's. */
  bank?: string;
};

/**
 * One company's books on a fresh engine whose clock the test moves day by day: the people (owner,
 * reviewer), the agent's grant renewed each month, the harness the months share.
 */
/** What a person gives for the annual statements, enough to ask for FY2026's (a FORMAT_GAP). */
const statementOptions = {
  entity: {
    tradeRegister: 'J17/123/2010',
    ownership: 35,
    caen: '4711',
    caenActual: '4711',
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

async function books(setup: Setup) {
  let now = Date.parse('2026-01-02T09:00:00Z');
  const today = () => new Date(now).toISOString().slice(0, 10);
  const efactura = new FakeEFactura();
  const vies = setup.vies ? fakeVies(today) : undefined;
  const s = await scenario({
    cui: setup.cui,
    name: setup.name,
    clock: () => now,
    efactura,
    declarationValidator: validator,
    ...(vies ? { vies } : {}),
  });
  open.push(s);
  efactura.now = now;
  let agent: Actor;
  const renew = async () => {
    const grant = await s.invoke<{ token: string }>(s.owner, 'agents.issue', {
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
      ],
      expiresAt: s.expiresIn(45),
    });
    agent = await s.engine.agents.authenticate(grant.token, s.company.id);
  };
  /** The engine's day moves on; the agent's grant is renewed at each month's start. */
  const on = async (date: string) => {
    const month = today().slice(0, 7);
    now = Date.parse(`${date}T09:00:00Z`);
    efactura.now = now;
    if (date.slice(0, 7) !== month) await renew();
  };
  await renew();

  const as = {
    agent: <T = unknown>(operation: string, input: unknown = {}) =>
      s.invoke<T>(agent, operation, input),
    owner: <T = unknown>(operation: string, input: unknown = {}) =>
      s.invoke<T>(s.owner, operation, input),
    reviewer: <T = unknown>(operation: string, input: unknown = {}) =>
      s.invoke<T>(s.reviewer, operation, input),
  };
  /** A file the agent keeps as evidence. */
  const file = async (filename: string, bytes: string | Uint8Array, mediaType: string) =>
    (
      await as.agent<{ id: string }>('evidence.record', {
        filename,
        mediaType,
        base64: Buffer.from(bytes).toString('base64'),
      })
    ).id;
  const pdf = (name: string) => file(name, `${setup.name}: ${name}`, 'application/pdf');
  /** An e-Factura invoice the agent imports. */
  const efacturaXml = async (input: XmlInput) =>
    as.agent<{ id: string; partyId: string }>('invoices.import', {
      evidenceId: await file(
        `${input.number}.xml`,
        invoiceXml({ company: setup.cui, ...input }),
        'application/xml',
      ),
    });

  /** The agent proposes; with a basis, through the generic operation. */
  const propose = (treatment: string, input: unknown, basis?: { answers: string[] }) =>
    basis
      ? as.agent<ProposalView>('proposals.propose', { treatment, input, basis })
      : as.agent<ProposalView>(`${treatment}.propose`, input);
  const revise = (proposal: ProposalView, input: unknown, basis?: { answers: string[] }) =>
    as.agent<ProposalView>('proposals.revise', {
      proposalId: proposal.id,
      version: proposal.version,
      input,
      ...(basis ? { basis } : {}),
    });
  /** The reviewer approves the exact version, acknowledging its warnings, which the test names;
   * the agent posts it. */
  const post = async (proposal: ProposalView, expected?: string[]) => {
    expect(
      proposal.issues.filter((issue) => issue.severity === 'block'),
      `${proposal.id} ${proposal.subject}`,
    ).toEqual([]);
    if (expected) expect(acks(proposal).sort()).toEqual([...expected].sort());
    const approved = await s.approve(proposal, s.reviewer, acks(proposal));
    return as.agent<ProposalView>('ledger.post', {
      proposalId: approved.id,
      version: approved.version,
      effectHash: approved.effectHash,
    });
  };
  const book = async (treatment: string, input: unknown, expected?: string[]) =>
    post(await propose(treatment, input), expected);

  /** The person answers an open question the books cannot settle. */
  const answer = (questionId: string, value: unknown) =>
    as.owner('questions.answer', { questionId, value });
  /** The agent asks what a proposal's issue names; the owner answers; returns the question. */
  const answerIssue = async (proposal: ProposalView, code: string, value: unknown) => {
    const issue = proposal.issues.find((item) => item.code === code);
    expect(issue, `${code} in ${codes(proposal)}`).toBeDefined();
    const question = (issue!.details as { question: Record<string, unknown> }).question;
    const asked = await as.agent<{ id: string; answer: unknown }>('questions.ask', question);
    if (!asked.answer) await answer(asked.id, value);
    return asked.id;
  };

  /** Everything on the worklist at a severity or above, every page of it. */
  const listed = async (severity: 'block' | 'info') => {
    const found: WorkItem[] = [];
    let after: string | undefined;
    for (let page = 0; page < 50; page++) {
      const result = await as.owner<{ items: WorkItem[]; next: string | null }>('work.list', {
        severity,
        limit: 200,
        ...(after ? { after } : {}),
      });
      found.push(...result.items);
      if (!result.next) break;
      after = result.next;
    }
    return found;
  };
  /** Everything blocking on the worklist. */
  const blocking = async () =>
    (await listed('block')).map((item) => `${item.kind} ${item.subject.id}: ${item.message}`);
  /** The month's close: nothing blocking on the worklist, the agent requests, the reviewer
   * approves the exact preview, the agent executes. Returns the preview's warnings. */
  /**
   * What waits on the worklist at each close without blocking it, asserted by the tests: 2027's
   * returns once the worklist reaches them (from November), waiting for the rules of 2027 (ROLLOVER.md);
   * FY2026's annual statement's answers, information while ANAF has published no format for them;
   * and, never there, REGES-ONLINE's start of a contract begun in 2025 under Revisal and the
   * month in progress's checks, run once it ends (its production costing).
   */
  const waiting: string[] = [];
  const close = async (month: string) => {
    expect(await blocking(), `the worklist before closing ${month}`).toEqual([]);
    for (const item of await listed('info'))
      if (
        /\|2027(-|$)/.test(item.subject.id) ||
        item.kind === 'annual.input' ||
        item.kind === 'payroll.due' ||
        (item.kind === 'close.finding' && String(item.details.month) > month)
      )
        waiting.push(`${month}: ${item.kind} ${item.subject.id} ${item.severity}`);
    const request = await as.agent<ActionView>('periods.close.request', { month });
    const findings = (request.preview as { findings: Finding[] }).findings;
    expect(
      findings.filter((item) => item.severity === 'block'),
      `the close of ${month}`,
    ).toEqual([]);
    await as.reviewer('actions.approve', { id: request.id, previewHash: request.previewHash });
    const executed = await as.agent<ActionView>('actions.execute', { id: request.id });
    expect(executed.status).toBe('executed');
    return findings.map((item) => item.code);
  };
  /** A reviewed action requested by `requester`, approved by the reviewer, executed by the agent. */
  const reviewed = async (request: ActionView) => {
    expect((request.preview as { findings?: Finding[] }).findings ?? []).toEqual([]);
    await as.reviewer('actions.approve', { id: request.id, previewHash: request.previewHash });
    return as.agent<ActionView>('actions.execute', { id: request.id });
  };

  /** All the returns prepared, with ANAF's verdict on each (or FORMAT_GAP). */
  const returns: { kind: string; period: string; state: string }[] = [];
  const preparedOf = new Map<string, Artifact>();
  /**
   * A return from preparation to filing: the agent prepares it from the books (ANAF's validator
   * runs on its XML), the owner requests its authorization, the reviewer approves, the agent
   * executes, exports and imports the signed PDF, the owner records ANAF's receipt.
   */
  const fileReturn = async (kind: string, period: string, options: Record<string, unknown>) => {
    const gap = await s.refused(
      as.agent<Artifact>('declarations.prepare', { kind, period, options, ...{} }).then((made) => {
        preparedOf.set(`${kind}|${period}`, made);
      }),
    );
    if (gap?.code === 'FORMAT_GAP') {
      // ANAF's format is not pinned for the period: an explicit gap, never skipped silently.
      returns.push({ kind, period, state: 'FORMAT_GAP' });
      return null;
    }
    expect(gap, `${kind} ${period}`).toBeUndefined();
    const prepared = preparedOf.get(`${kind}|${period}`)!;
    returns.push({ kind, period, state: prepared.state });
    expect(
      [prepared.state, installed ? (prepared.steps.at(-1)?.detail ?? null) : null],
      `${kind} ${period}`,
    ).toEqual([installed ? 'validated_official' : prepared.state, null]);
    expect(prepared.state).toBe('validated_official');
    await reviewed(
      await as.owner<ActionView>('declarations.authorize.request', { artifactId: prepared.id }),
    );
    await as.agent('declarations.pdf', { artifactId: prepared.id });
    const xml = (await s.engine.evidence.read(s.owner, prepared.evidenceId)).bytes;
    await as.agent('declarations.importSigned', {
      artifactId: prepared.id,
      evidenceId: await file(`${kind}-${period}-semnat.pdf`, pdfWith(xml, true), 'application/pdf'),
    });
    await as.owner('declarations.recordSubmission', {
      artifactId: prepared.id,
      registrationNumber: `INTERNT-${kind}-${period}`,
      submittedOn: today(),
      receiptEvidenceId: await pdf(`recipisa-${kind}-${period}.pdf`),
    });
    return prepared;
  };
  /** The XML a return was written in. */
  const xmlOf = async (artifact: Artifact) =>
    new TextDecoder().decode((await s.engine.evidence.read(s.owner, artifact.evidenceId)).bytes);

  /** Stock register against the ledger's stock accounts, at a date. */
  const register = (date: string) => as.agent<Register>('stock.register', { date });
  const balances = async (to?: string) =>
    new Map(
      (await s.trialBalance(undefined, to)).rows.map((row) => [
        row.account,
        lei(bani(row.closing.debit) - bani(row.closing.credit)),
      ]),
    );

  // The company as the owner configures it.
  const evidenceOf = async (name: string) => pdf(name);
  for (const [axis, value] of Object.entries(setup.facts))
    await as.owner('profile.record', {
      axis,
      value,
      effectiveFrom: '2026-01-01',
      evidenceId: await evidenceOf(`${axis}.pdf`),
    });
  await as.agent('fx.importBnr', {
    evidenceId: await file(
      'nbrfxrates.xml',
      bnrXml([['2025-12-31', { EUR: '5.0800', USD: '4.5000' }], ...(setup.rates ?? [])]),
      'application/xml',
    ),
  });
  await as.owner('sales.seller.record', {
    details: {
      name: setup.name,
      vatId: `RO${setup.cui}`,
      address: { lines: ['Str. Lungă 10'], city: 'Galați', subdivision: 'RO-GL', country: 'RO' },
    },
  });
  await as.owner('treasury.createAccount', {
    kind: 'bank',
    name: 'Cont curent',
    iban,
    currency: 'RON',
    ledgerAccount: '5121',
    openedOn: '2026-01-01',
  });
  const anaf = await as.agent<{ id: string }>('parties.create', {
    kind: 'ro_public_institution',
    country: 'RO',
    taxId: '4221306',
    name: 'ANAF',
  });

  /**
   * The year's determinations: the agent opens what the books cannot decide, the people answer
   * from 2025's filed statements and confirm each computation; until nothing is asked.
   */
  const determine = async () => {
    const statements = await pdf('situatii-financiare-2025.pdf');
    const seen = new Set<string>();
    for (let round = 0; round < 6; round++) {
      const proposed = await as.agent<{
        asked: { kind: string; subject: { id: string }; questionId: string; reused: boolean }[];
      }>('determinations.propose', { year: 2026 });
      const open = proposed.asked.filter((item) => !item.reused && !seen.has(item.questionId));
      if (!open.length) break;
      const questions = await as.agent<{ items: Question[] }>('questions.list', {
        status: 'open',
        limit: 200,
      });
      for (const item of open) {
        seen.add(item.questionId);
        const question = questions.items.find((candidate) => candidate.id === item.questionId)!;
        if (item.kind === 'determination.confirm') await answer(item.questionId, { confirm: true });
        else if (item.kind === 'year.figures')
          await answer(item.questionId, {
            values: Object.fromEntries(
              (question.params.figures as string[]).map((name) => [name, setup.figures[name]]),
            ),
            evidenceIds: [statements],
          });
        else if (item.kind === 'profile.fact')
          await answer(item.questionId, {
            value: setup.figures[`fact:${item.subject.id}`],
            effectiveFrom: `${item.subject.id.split('/')[1] ?? '2026'}-01-01`,
          });
        else if (item.kind === 'micro.conditions')
          // The owner's conditions of art. 47, from the trade register and the shareholders'.
          await answer(item.questionId, {
            stateOwned: false,
            dissolution: false,
            excludedActivity: false,
            shareholders: 'only_micro',
            statementsOnTime: 'yes',
            mandate: true,
            established: null,
            lateStatementsFrom: null,
            linked: [],
            evidenceIds: [await pdf('certificat-constatator.pdf')],
          });
        else throw new Error(`An unexpected question: ${item.kind} ${item.subject.id}`);
      }
    }
  };

  /** The quarter's or the year's profit tax, with the losses carried in asked once. */
  let losses: string | null = null;
  const profitTax = async (period: string, date: string, expected: string[]) => {
    const input = { period, date, authorityId: anaf.id };
    let proposal = await propose('tax.profit', input);
    if (codes(proposal).includes('PROFIT_LOSSES')) {
      losses = await answerIssue(proposal, 'PROFIT_LOSSES', {
        vintages: [],
        evidenceIds: [await pdf('d101-2025.pdf')],
      });
    }
    if (losses) proposal = await revise(proposal, input, { answers: [losses] });
    return post(proposal, expected);
  };

  /** The VAT of a month settled into 4423 or 4424 on its last day. */
  const settleVat = async (month: number) =>
    book('vat.settle', {
      period: ym(month),
      date: lastDay(month),
      authorityId: anaf.id,
      evidenceId: await pdf(`decont-${ym(month)}.pdf`),
    });

  /** A month's bank statement (camt.053) the agent imports; its movements by reference. */
  let opening = setup.bank ?? '0.00';
  const statement = async (
    month: number,
    entries: { ref: string; day: number; amount: string; credit: boolean; text: string }[],
  ) => {
    const net = sum(entries.map((entry) => (entry.credit ? entry.amount : `-${entry.amount}`)));
    const closing = sum([opening, net]);
    await as.agent('bank.import', {
      evidenceId: await file(
        `extras-${ym(month)}.xml`,
        camt({
          id: `EXTRAS-${ym(month)}`,
          opening,
          closing,
          from: `${ym(month)}-01`,
          to: lastDay(month),
          entries: entries
            .map((entry) =>
              camtEntry({
                amount: entry.amount,
                date: ymd(month, entry.day),
                value: ymd(month, entry.day),
                direction: entry.credit ? 'CRDT' : 'DBIT',
                bankRef: entry.ref,
                text: `${entry.ref} ${entry.text}`,
              }),
            )
            .join(''),
        }),
        'application/xml',
      ),
      financialYearId: s.year.id,
    });
    opening = closing;
    const movements = await as.agent<{ items: { id: string; reference: string }[] }>(
      'bank.movements',
      { state: 'unexplained' },
    );
    return (ref: string) => movements.items.find((item) => item.reference.includes(ref))!.id;
  };
  const openItem = async (document: string) => {
    const items = await as.agent<{
      items: { id: string; document: string | null; amount: string }[];
    }>('openItems.list', { openOnly: true });
    const found = items.items.find((item) => item.document === document);
    expect(found, `the open item of ${document}`).toBeDefined();
    return found!.id;
  };

  /** The year's end: the people answer the review's questions, the agent closes the result. */
  const provisionsReviewed = async () => {
    const asked = await as.agent<{ id: string; answer: unknown }>('questions.ask', {
      kind: 'provisions.review',
      subject: { kind: 'company', id: 'company' },
      params: { year: 2026 },
    });
    if (!asked.answer)
      await answer(asked.id, { none: true, evidenceIds: [await pdf('analiza-obligatii.pdf')] });
  };
  const review = () =>
    as.agent<{ closed: boolean; items: { check: string; severity: string; message: string }[] }>(
      'yearend.review',
      { financialYearId: s.year.id },
    );
  /** The reviewed year close, once every month is closed. */
  const closeYear = async () => {
    const request = await as.agent<ActionView>('years.close.request', {
      financialYearId: s.year.id,
    });
    const findings = (request.preview as { findings: Finding[] }).findings;
    expect(findings.filter((item) => item.severity === 'block')).toEqual([]);
    await as.reviewer('actions.approve', { id: request.id, previewHash: request.previewHash });
    const executed = await as.agent<ActionView>('actions.execute', { id: request.id });
    expect(executed.status).toBe('executed');
    expect((await review()).closed).toBe(true);
  };
  const closure = () => as.agent<Closure>('closure.evaluate', { from: '2026-01', to: '2026-12' });
  /** The returns the closure calls covered for the year (`applies`) that no validated return
   * answers, each with what preparing it comes to: only a published format the engine does not
   * write yet (FORMAT_GAP) may be among them. */
  const uncovered = async (options: Record<string, Record<string, unknown>> = {}) => {
    const done = new Set(
      returns
        .filter((item) => item.state === 'validated_official' || !installed)
        .map((item) => `${item.kind} ${item.period}`),
    );
    const left = (await closure()).obligations.filter(
      (item) => item.state === 'applies' && !done.has(`${item.kind} ${item.period}`),
    );
    const results: string[] = [];
    for (const item of left) {
      const refused = await s.refused(
        as.agent('declarations.prepare', {
          kind: item.kind,
          period: item.period,
          options: options[item.kind] ?? {},
        }),
      );
      results.push(`${item.kind} ${item.period} ${refused?.code ?? 'prepared'}`);
    }
    return results;
  };

  return {
    s,
    as,
    on,
    today,
    efactura,
    vies,
    anaf,
    file,
    pdf,
    efacturaXml,
    propose,
    revise,
    post,
    book,
    answer,
    answerIssue,
    blocking,
    close,
    reviewed,
    returns,
    waiting,
    fileReturn,
    xmlOf,
    register,
    balances,
    determine,
    profitTax,
    settleVat,
    statement,
    openItem,
    provisionsReviewed,
    review,
    closeYear,
    closure,
    uncovered,
    agent: () => agent,
  };
}
type Books = Awaited<ReturnType<typeof books>>;

/** Every stock account the register explains equals the ledger, nothing outside it. */
async function registerEqualsLedger(b: Books, date: string) {
  const read = await b.register(date);
  for (const row of read.accounts)
    expect([date, row.account, row.register, row.outside]).toEqual([
      date,
      row.account,
      row.ledger,
      '0.00',
    ]);
  return read;
}

/** The closing physical stock of a D406 stock file, per product code, as ANAF reads it. */
function physicalStock(xml: string) {
  const root = sourceXml(new TextEncoder().encode(xml));
  const find = (node: typeof root, name: string): (typeof root)[] => [
    ...(node.local === name ? [node] : []),
    ...node.children.flatMap((child) => find(child, name)),
  ];
  const text = (node: typeof root, name: string) => find(node, name)[0]?.text.trim() ?? '';
  const totals = new Map<string, { quantity: bigint; value: bigint }>();
  for (const row of find(root, 'PhysicalStockEntry')) {
    const code = text(row, 'ProductCode');
    const quantity = BigInt(Math.round(Number(text(row, 'ClosingStockQuantity')) * 1000));
    const value = bani(Number(text(row, 'ClosingStockValue')).toFixed(2));
    const total = totals.get(code) ?? { quantity: 0n, value: 0n };
    totals.set(code, { quantity: total.quantity + quantity, value: total.value + value });
  }
  // A position emptied in the period closes at nil: the register no longer lists it.
  for (const [code, total] of totals)
    if (total.quantity === 0n && total.value === 0n) totals.delete(code);
  return totals;
}

/** The register's positions per item code, as the D406 file should carry them. */
function registerStock(read: Register) {
  const totals = new Map<string, { quantity: bigint; value: bigint }>();
  for (const row of read.positions) {
    const quantity = BigInt(Math.round(Number(row.quantity) * 1000));
    const total = totals.get(row.code) ?? { quantity: 0n, value: 0n };
    totals.set(row.code, {
      quantity: total.quantity + quantity,
      value: total.value + bani(row.value),
    });
  }
  return totals;
}

// 1. The shop.
//
// Magazin Exemplu SRL sells coffee (21%) and chocolate (11%) through one fiscal cash register, on
// FIFO and the perpetual inventory. Amounts by hand:
//   each day one Z report: 4 bags of coffee at 30,25 (121,00, VAT 21,00) and 2 bars of chocolate
//   at 11,10 (22,20, VAT 2,20), 5 receipts, 43,20 in cash and 100,00 by card; the fiscal
//   memory's running total after the n-th report 143,20 × n;
//   bought on each month's 1st on e-Factura what the month sells (4 and 2 a day), January
//   26 bags and 18 bars more, June 10 bags more for the B2C invoice: coffee at 10,00 until June
//   and 11,00 from July, chocolate at 8,00; paid on the 10th;
//   so FIFO takes the month's own lot after the 26 bags and 18 bars of the previous one: the goods
//   sold cost 56,00 a day, except July's coffee, 26 × 10,00 + 98 × 11,00 = 1.338,00;
//   the acquirer pays the month's cards on its last day less 1%; the month's VAT is paid on the
//   20th of the next;
//   15 June: a B2C invoice to Maria Ionescu (CNP) for 10 bags, 250,00 + 52,50, paid on the 20th;
//   31 December: 24 bags counted of 26 (2 × 11,00 = 22,00 short, unimputable, VAT 4,62
//   adjusted), 18 bars written down to 6,00 each (18 × 2,00 = 36,00 on 397).

const SHOP = '18547290';
const SUPPLIER = '13548146';
const shopCnp = '1800101221144';
const shopD300 = {
  declarant: { lastName: 'Popescu', firstName: 'Ana', role: 'Administrator' },
  caen: '4711',
  bank: 'Banca Exemplu',
  account: iban,
};
const shopD394 = {
  caen: '4711',
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
const contact = { firstName: 'Ana', lastName: 'Popescu', phone: '0236000000' };
const declarant = { lastName: 'Popescu', firstName: 'Ana', role: 'Administrator' };
const goodsFacts = {
  'entity.form': 'srl',
  'activity.goods': 'yes',
  'regime.excluded': 'none',
  'vat.status': 'normal_vat',
  'vat.cash': 'no',
  'profit.system': 'quarterly',
  'tax.facilities': 'none',
  'vat.ioss': 'none',
  'policy.stock.valuation': 'fifo',
  'policy.stock.inventory': 'permanent',
  'policy.stock.negative': 'refuse',
};
/** 2025 as its filed statements give it: above 100.000 € (508.000,00 lei at 5,0800), so profit
 * tax and monthly VAT in 2026. */
const figures2025 = {
  turnover: '600000.00',
  netTurnover: '600000.00',
  totalRevenue: '600000.00',
  vatTurnover: '600000.00',
  exemptionTurnover: '600000.00',
  totalAssets: '200000.00',
  averageEmployees: '0',
  euGoodsAcquisitions: 'no',
  distanceTurnover: '0.00',
  intrastatArrivals: '0.00',
  intrastatDispatches: '0.00',
  'fact:size.category/2025': 'micro',
};

describe('FY2026: a shop SRL on FIFO with its cash register (G1, G2)', () => {
  let b: Books;
  const ids = {} as Record<
    'coffee' | 'chocolate' | 'store' | 'register' | 'series' | 'buyer',
    string
  >;
  /** Each month's Z reports' documents, for the card settlement. */
  const zReports = new Map<number, string[]>();
  const costs = new Map<number, string>();
  let reportNumber = 0;
  const coffeePrice = (month: number) => (month <= 6 ? '10.00' : '11.00');
  const bought = (month: number) => ({
    coffee: 4 * daysIn(month) + (month === 1 ? 26 : 0) + (month === 6 ? 10 : 0),
    chocolate: 2 * daysIn(month) + (month === 1 ? 18 : 0),
  });
  const times = (quantity: number, price: string) => lei(BigInt(quantity) * bani(price));
  const vatOf = (net: string, rate: number) => lei((bani(net) * BigInt(rate) + 50n) / 100n);
  const purchase = (month: number) => {
    const { coffee, chocolate } = bought(month);
    const net = { coffee: times(coffee, coffeePrice(month)), chocolate: times(chocolate, '8.00') };
    const vat = { coffee: vatOf(net.coffee, 21), chocolate: vatOf(net.chocolate, 11) };
    return {
      coffee,
      chocolate,
      net,
      vat,
      gross: sum([net.coffee, net.chocolate, vat.coffee, vat.chocolate]),
    };
  };

  const zBody = (number: number, date: string) => ({
    seller: { name: 'Magazin Exemplu SRL', taxId: `RO${SHOP}`, country: 'RO' },
    register: '4400012345',
    number: String(number),
    issueDate: date,
    time: '21:05:00',
    receipts: 5,
    currency: 'RON',
    taxes: [
      { rate: '21', gross: '121.00', tax: '21.00' },
      { rate: '11', gross: '22.20', tax: '2.20' },
    ],
    totals: { gross: '143.20', tax: '23.20' },
    payments: [
      { method: 'cash', amount: '43.20', currency: 'RON' },
      { method: 'card', amount: '100.00', currency: 'RON' },
    ],
    cumulative: { gross: lei(14320n * BigInt(number)) },
    items: [
      {
        code: 'CAF-1',
        name: 'Cafea boabe',
        quantity: '4',
        unit: 'H87',
        gross: '121.00',
        rate: '21',
      },
      { code: 'CIO-1', name: 'Ciocolată', quantity: '2', unit: 'H87', gross: '22.20', rate: '11' },
    ],
  });

  /** The month's books: the purchase, every day's Z report, the B2C invoice, the statement. */
  async function month(m: number) {
    await b.on(ymd(m, 1));
    const bill = purchase(m);
    const invoice = await b.efacturaXml({
      number: `FC-${mm(m)}`,
      date: ymd(m, 1),
      counterparty: `RO${SUPPLIER}`,
      taxes: [
        { rate: '21', net: bill.net.coffee, tax: bill.vat.coffee },
        { rate: '11', net: bill.net.chocolate, tax: bill.vat.chocolate },
      ],
      net: sum([bill.net.coffee, bill.net.chocolate]),
      tax: sum([bill.vat.coffee, bill.vat.chocolate]),
      gross: bill.gross,
      lines: [
        { rate: '21', net: bill.net.coffee, name: 'Cafea boabe' },
        { rate: '11', net: bill.net.chocolate, name: 'Ciocolată' },
      ],
    });
    if (m === 1)
      // The supplier's address, for D406, as the invoice gives it.
      await b.as.agent('parties.recordDetails', {
        partyId: invoice.partyId,
        details: {
          name: 'Furnizor Cafea SRL',
          vatId: `RO${SUPPLIER}`,
          address: {
            lines: ['Str. Portului 3'],
            city: 'Brăila',
            subdivision: 'RO-BR',
            country: 'RO',
          },
        },
      });
    const received = await b.book(
      'invoices.recognize',
      {
        documentId: invoice.id,
        allocations: [
          { account: '371', vat: 'S-21', amount: bill.net.coffee },
          { account: '371', vat: 'S-11', amount: bill.net.chocolate },
        ],
        stock: {
          warehouseId: ids.store,
          lines: [
            { line: '1', itemId: ids.coffee, quantity: String(bill.coffee) },
            { line: '2', itemId: ids.chocolate, quantity: String(bill.chocolate) },
          ],
        },
      },
      ['REDUCED_RATE'],
    );
    expect(lines(received).slice(0, 2)).toEqual([
      `D 371 ${bill.net.coffee}`,
      `D 371 ${bill.net.chocolate}`,
    ]);

    const reports: string[] = [];
    let cost = 0n;
    for (let day = 1; day <= daysIn(m); day++) {
      const date = ymd(m, day);
      await b.on(date);
      reportNumber += 1;
      const z = await b.as.agent<{ id: string }>('documents.record', {
        evidenceId: await b.file(`z-${date}.png`, `Z ${reportNumber} ${date}`, 'image/png'),
        kind: 'zreport',
        body: zBody(reportNumber, date),
      });
      const posted = await b.book(
        'retail.zReport',
        {
          documentId: z.id,
          cash: '5311',
          card: '5125',
          account: '707',
          stock: {
            warehouseId: ids.store,
            lines: [
              { line: '1', itemId: ids.coffee },
              { line: '2', itemId: ids.chocolate },
            ],
          },
        },
        ['SOURCE_EXTRACTED', 'REDUCED_RATE'],
      );
      cost += bani(posted.effect!.lines.find((line) => line.account === '607')!.amount);
      reports.push(z.id);
    }
    zReports.set(m, reports);
    costs.set(m, lei(cost));

    let b2c: Issued | null = null;
    if (m === 6) {
      await b.on('2026-06-15');
      // A B2C invoice to a person who gives her CNP: the goods out of the register (FIFO).
      b2c = await b.as.owner<Issued>('sales.issue', {
        seriesId: ids.series,
        buyerId: ids.buyer,
        issueDate: '2026-06-15',
        lines: [
          {
            name: 'Cafea boabe',
            quantity: '10',
            unitCode: 'H87',
            price: '25',
            vat: { category: 'S', rate: '21' },
          },
        ],
        stock: { warehouseId: ids.store, lines: [{ index: 0, itemId: ids.coffee }] },
        b2c: { identification: 'cnp' },
      });
      expect(b2c.recognition.error).toBe(null);
      const sold = await b.post(
        await b.as.agent<ProposalView>('proposals.get', { id: b2c.recognition.proposalId }),
        [],
      );
      expect(lines(sold)).toEqual([
        'D 4111 302.50',
        'C 707 250.00',
        'C 4427 52.50',
        'C 371 100.00',
        'D 607 100.00',
      ]);
      // RO e-Factura within 5 working days: the owner sends it, the agent reads ANAF's answer.
      const due = await b.as.owner<{ items: { details: { number: string } }[] }>('work.list', {
        kinds: ['efactura.due'],
      });
      expect(due.items.map((item) => item.details.number)).toEqual([b2c.number]);
      const sent = await b.as.owner<{ id: string }>('spv.submit', { documentId: b2c.documentId });
      const answered = await b.as.agent<{ state: string }>('spv.refresh', {
        submissionId: sent.id,
      });
      expect(answered.state).toBe('accepted');
    }

    // The statement: the supplier paid on the 10th, the previous month's VAT on the 20th, the
    // acquirer's settlement on the last day, the person's payment in June.
    await b.on(lastDay(m));
    const cards = lei(10000n * BigInt(daysIn(m)));
    const fee = lei(100n * BigInt(daysIn(m)));
    const previousVat = m > 1 ? vatPayable.get(m - 1)! : null;
    const entries = [
      { ref: `FC-${mm(m)}`, day: 10, amount: bill.gross, credit: false, text: `Plata FC-${mm(m)}` },
      ...(previousVat
        ? [{ ref: `TVA-${mm(m)}`, day: 20, amount: previousVat, credit: false, text: 'Plata TVA' }]
        : []),
      ...(b2c
        ? [
            {
              ref: `B2C-${mm(m)}`,
              day: 20,
              amount: '302.50',
              credit: true,
              text: `Plata ${b2c.number}`,
            },
          ]
        : []),
      {
        ref: `POS-${mm(m)}`,
        day: daysIn(m),
        amount: lei(bani(cards) - bani(fee)),
        credit: true,
        text: 'Decontare POS',
      },
    ];
    const movement = await b.statement(m, entries);
    await b.book(
      'bank.settle',
      {
        movementId: movement(`FC-${mm(m)}`),
        allocations: [{ openItem: await b.openItem(`FC-${mm(m)}`), amount: bill.gross }],
      },
      [],
    );
    if (previousVat)
      await b.book(
        'tax.pay',
        { movementId: movement(`TVA-${mm(m)}`), authorityId: b.anaf.id, to: 'vat' },
        [],
      );
    if (b2c)
      await b.book(
        'bank.settle',
        {
          movementId: movement(`B2C-${mm(m)}`),
          allocations: [{ openItem: await b.openItem(b2c.number), amount: '302.50' }],
        },
        [],
      );
    const settled = await b.book(
      'bank.settle',
      {
        movementId: movement(`POS-${mm(m)}`),
        cards: {
          account: '5125',
          settles: reports.map((documentId) => ({ documentId, amount: '100.00' })),
          fee,
          feeAccount: '627',
        },
      },
      [],
    );
    expect(lines(settled).filter((line) => !line.startsWith('C 5125'))).toEqual([
      `D 5121 ${lei(bani(cards) - bani(fee))}`,
      `D 627 ${fee}`,
    ]);
  }

  /** The VAT each month owes, for the next month's payment: settled from the books. */
  const vatPayable = new Map<number, string>();
  /** After the month: its VAT settled, the profit tax of a quarter, the close, the returns. */
  async function wrapUp(m: number, profit?: string[]) {
    await b.on(nextMonthDay(m, 2));
    const settlement = await b.settleVat(m);
    vatPayable.set(
      m,
      settlement.effect!.lines.find((line) => line.account === '4423')?.amount ?? '0.00',
    );
    if (profit) await b.profitTax(`2026-Q${m / 3}`, lastDay(m), profit);
    await registerEqualsLedger(b, lastDay(m));
    const warnings = await b.close(ym(m));
    for (const [kind, options] of [
      ['D300', shopD300],
      ['D394', shopD394],
      ['D406', { contact }],
    ] as const)
      await b.fileReturn(kind, ym(m), options);
    if (profit) await b.fileReturn('D100', ym(m), { declarant });
    return warnings;
  }

  test('setup: the owner configures the shop, the people settle 2026’s determinations', async () => {
    b = await books({
      cui: SHOP,
      name: 'Magazin Exemplu SRL',
      caen: '4711',
      facts: { ...goodsFacts, employer: 'no', 'policy.stock.retail': 'cost' },
      figures: figures2025,
      bank: '50000.00',
    });
    await b.book(
      'ledger.general',
      {
        date: '2026-01-01',
        purpose: 'opening',
        reference: 'SOLD-INITIAL',
        description: 'Solduri inițiale',
        evidenceId: await b.pdf('balanta-deschidere.pdf'),
        lines: [
          { account: '5121', side: 'D', amount: '50000.00' },
          { account: '1012', side: 'C', amount: '50000.00' },
        ],
      },
      [],
    );
    ids.coffee = (
      await b.as.agent<{ id: string }>('stock.items.create', {
        code: 'CAF-1',
        name: 'Cafea boabe',
        unit: 'H87',
        account: '371',
        vatCategory: 'standard',
        nc8: '09012100',
      })
    ).id;
    ids.chocolate = (
      await b.as.agent<{ id: string }>('stock.items.create', {
        code: 'CIO-1',
        name: 'Ciocolată',
        unit: 'H87',
        account: '371',
        vatCategory: 'reduced',
        nc8: '18063100',
      })
    ).id;
    ids.store = (
      await b.as.agent<{ id: string }>('stock.warehouses.create', {
        code: 'M1',
        name: 'Magazin',
        keeper: 'Ionescu Maria',
      })
    ).id;
    ids.register = (
      await b.as.owner<{ id: string }>('retail.registers.record', {
        code: '4400012345',
        fiscalSeries: 'AB1234567',
        location: 'Galați, Str. Lungă 10',
        warehouseId: ids.store,
        activeFrom: '2026-01-01',
        evidenceId: await b.pdf('fiscalizare.pdf'),
      })
    ).id;
    for (const kind of ['anaf_registered', 'service_contract'])
      await b.as.agent('retail.registers.event', {
        registerId: ids.register,
        kind,
        date: '2026-01-01',
        reference: kind,
        evidenceId: await b.pdf(`${kind}.pdf`),
      });
    ids.series = (
      await b.as.owner<{ id: string }>('sales.series.create', {
        code: 'MAG',
        prefix: 'MAG',
        width: 4,
        revenueAccount: '707',
      })
    ).id;
    ids.buyer = (
      await b.as.agent<{ id: string }>('parties.create', {
        kind: 'ro_individual',
        country: 'RO',
        name: 'Maria Ionescu',
      })
    ).id;
    await b.as.agent('parties.recordDetails', {
      partyId: ids.buyer,
      details: {
        name: 'Maria Ionescu',
        address: {
          lines: ['Str. Domnească 7'],
          city: 'Galați',
          subdivision: 'RO-GL',
          country: 'RO',
        },
      },
    });
    await b.as.owner('parties.recordCnp', { partyId: ids.buyer, cnp: shopCnp });
    await b.determine();
  });

  test('January–March: a month of Z reports each day, cards settled net of the fee, Q1’s profit tax', async () => {
    for (const m of [1, 2, 3]) {
      await month(m);
      await wrapUp(m, m === 3 ? ['LEGAL_RESERVE', 'PROFIT_MINIMUM_TAX'] : undefined);
    }
    // 56,00 a day at FIFO: the month's own lot after the previous one's rest, at one price.
    expect([costs.get(1), costs.get(2), costs.get(3)]).toEqual(['1736.00', '1568.00', '1736.00']);
  });

  test('April–June: the B2C invoice with a CNP, sent to RO e-Factura, Q2’s profit tax', async () => {
    for (const m of [4, 5, 6]) {
      await month(m);
      await wrapUp(m, m === 6 ? ['LEGAL_RESERVE', 'PROFIT_MINIMUM_TAX'] : undefined);
    }
    expect([costs.get(4), costs.get(5), costs.get(6)]).toEqual(['1680.00', '1736.00', '1680.00']);
    // The person's invoice is in June's D394 by her CNP, with the receipts in op2.
    const [june] = (await b.as.agent<{ items: Artifact[] }>('declarations.list', {})).items.filter(
      (item) => item.kind === 'D394' && item.period === '2026-06',
    );
    const xml = await b.xmlOf(june!);
    expect(xml).toContain(shopCnp);
    expect(xml).toMatch(/<op2 tip_op2="I1" luna="6" nrAMEF="1" nrBF="150" total="4296"/);
  });

  test('July–September: the coffee’s new price reaches the sales through FIFO, Q3’s profit tax', async () => {
    for (const m of [7, 8, 9]) {
      await month(m);
      await wrapUp(m, m === 9 ? ['LEGAL_RESERVE', 'PROFIT_MINIMUM_TAX'] : undefined);
    }
    // July: 6 days of June's last 24 bags at 10,00 (40,00 a day), a day of 2 at 10,00 and 2 at
    // 11,00 (42,00), 24 days at 11,00 (44,00): 1.338,00 of coffee, 496,00 of chocolate.
    expect([costs.get(7), costs.get(8), costs.get(9)]).toEqual(['1834.00', '1860.00', '1800.00']);
  });

  test('October–December, the count with a shortage, the write-down, the year closed', async () => {
    for (const m of [10, 11]) {
      await month(m);
      await wrapUp(m);
    }
    await month(12);
    expect([costs.get(10), costs.get(11), costs.get(12)]).toEqual([
      '1860.00',
      '1800.00',
      '1860.00',
    ]);

    // The annual inventory on 31 December: 2 bags of coffee missing, the cash and the bank as
    // the books hold them.
    await b.on('2027-01-04');
    const books = await b.balances('2026-12-31');
    const held = await registerEqualsLedger(b, '2026-12-31');
    expect(held.positions.map((row) => `${row.code} ${row.quantity} ${row.value}`)).toEqual([
      'CAF-1 26.000 286.00',
      'CIO-1 18.000 144.00',
    ]);
    // 43,20 a day in cash for 365 days.
    expect(books.get('5311')).toBe('15768.00');
    const list = await b.as.agent<{ id: string }>('documents.record', {
      evidenceId: await b.file('lista-inventariere.pdf', 'Lista 31.12.2026', 'application/pdf'),
      kind: 'inventory.list',
      body: {
        title: 'Lista de inventariere la 31.12.2026',
        company: { name: 'Magazin Exemplu SRL', taxId: SHOP },
        date: '2026-12-31',
        commission: { decision: '12', decisionDate: '2026-12-15', members: ['Pop Ion'] },
        assets: null,
        cash: [{ account: '5311', currency: 'RON', counted: '15768.00' }],
        // The cards in transit (5125) were all settled: the commission confirms nil.
        bank: [
          { account: '5121', currency: 'RON', iban, balance: books.get('5121') },
          { account: '5125', currency: 'RON', iban: null, balance: '0.00' },
        ],
        partners: null,
        stock: [
          {
            account: '371',
            code: 'CAF-1',
            name: 'Cafea boabe',
            unit: 'H87',
            quantity: '24',
            warehouse: 'M1',
          },
          {
            account: '371',
            code: 'CIO-1',
            name: 'Ciocolată',
            unit: 'H87',
            quantity: '18',
            warehouse: 'M1',
          },
        ],
      },
    });
    const counted = await b.book(
      'inventory.stock',
      {
        date: '2026-12-31',
        documentIds: [list.id],
        evidenceId: await b.pdf('decizie-inventar.pdf'),
        causes: [{ itemId: ids.coffee, warehouseId: ids.store, cause: 'unimputable' }],
      },
      ['PROFIT_SHORTAGE', 'SOURCE_EXTRACTED'],
    );
    expect(lines(counted)).toEqual(['C 371 22.00', 'D 607 22.00', 'D 635 4.62', 'C 4426 4.62']);
    const writeDown = await b.book(
      'impairment.stock',
      {
        date: '2026-12-31',
        evidenceId: await b.pdf('valoare-realizabila.pdf'),
        items: [{ itemId: ids.chocolate, value: '108.00' }],
      },
      [],
    );
    expect(lines(writeDown)).toEqual(['D 6814 36.00', 'C 397 36.00']);

    await b.settleVat(12);
    await b.profitTax('2026', '2026-12-31', ['LEGAL_RESERVE', 'PROFIT_MINIMUM_TAX']);
    await b.provisionsReviewed();
    const result = await b.book('year.closeResult', {
      yearEnd: '2026-12-31',
      evidenceId: await b.pdf('nota-inchidere.pdf'),
    });
    void result;
    expect((await b.review()).items.filter((item) => item.severity === 'block')).toEqual([]);
    await registerEqualsLedger(b, '2026-12-31');
    await b.close('2026-12');
    // The shortage's VAT adjusted on 635: ANAF's chart subdivides it (635, 6351), the company's
    // is the general one.
    for (const [kind, options] of [
      ['D300', shopD300],
      ['D394', shopD394],
      ['D406', { contact, accounts: { '635': '635' } }],
    ] as const)
      await b.fileReturn(kind, '2026-12', options);
    await b.closeYear();

    // The on-demand stock file reconciles to the register, product by product.
    const stockFile = await b.as.agent<Artifact>('declarations.prepare', {
      kind: 'D406',
      period: '2026-12-C',
      options: { contact, accounts: { '635': '635' } },
    });
    b.returns.push({ kind: 'D406-C', period: '2026-12', state: stockFile.state });
    expect(stockFile.state).toBe(installed ? 'validated_official' : stockFile.state);
    const file = physicalStock(await b.xmlOf(stockFile));
    const register = registerStock(await b.register('2026-12-31'));
    expect([...file.entries()].sort()).toEqual([...register.entries()].sort());

    const d101 = await b.as.agent<Artifact>('declarations.prepare', {
      kind: 'D101',
      period: '2026',
      options: { declarant, caen: '4711' },
    });
    b.returns.push({ kind: 'D101', period: '2026', state: d101.state });
    expect(d101.state).toBe(installed ? 'validated_official' : d101.state);

    // FY2026's annual statement: ANAF has not published its format.
    const statements = await b.s.refused(
      b.as.agent('declarations.prepare', {
        kind: 'S1005',
        period: '2026',
        options: {
          entity: {
            tradeRegister: 'J17/123/2010',
            ownership: 35,
            caen: '4711',
            caenActual: '4711',
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
        },
      }),
    );
    expect(statements?.code).toBe('FORMAT_GAP');

    const closure = await b.closure();
    expect([closure.status, closure.needs, closure.unsupported]).toEqual(['ELIGIBLE', [], []]);
    // The closure and the writers agree: every return it calls covered is prepared and passes
    // ANAF's validator, but FY2026's statements, whose format ANAF has not published.
    expect(await b.uncovered({ S1005: statementOptions })).toEqual(['S1005 2026 FORMAT_GAP']);
    // Nothing nobody could act on blocked a close: from the October close on (2 November, two
    // months ahead) 2027's returns waited for the rules of 2027, information until their period
    // began; at December's, FY2026's statement's answers, information while ANAF has published
    // no format for them.
    expect([...new Set(b.waiting.map((item) => item.slice(0, 7)))]).toEqual([
      '2026-10',
      '2026-11',
      '2026-12',
    ]);
    expect(
      b.waiting.filter(
        (item) =>
          !/ obligation\.due [\w.]+\|2027-0[1-3] (info|warn)$/.test(item) &&
          item !== '2026-12: annual.input S1005|2026 info',
      ),
    ).toEqual([]);
    expect(b.waiting).toContain('2026-12: annual.input S1005|2026 info');
    // Every return of the year from the books through ANAF's validators: D300, D394 and D406 each
    // month, D100 for the first three quarters, the stock file and D101.
    expect(b.returns).toHaveLength(41);
    expect(b.returns.filter((item) => item.state !== 'validated_official')).toEqual([]);
  });
});

// 1b. The shop's retail-price warehouse.
//
// One company keeps either every warehouse at cost or every one at sale price
// (`policy.stock.retail` is a company fact), so the shop's second warehouse, at sale price, is
// kept here by a company of its own (reported). Goods at 21%, the markup on 378.M2, the VAT
// included on 4428.M2-21; K cumulated from the year's start (pct. 286 alin. (4), note *2)) and,
// alin. (7), spread over the exits and the stock held alike, so that 378 always holds K × the
// stock without VAT. Amounts by hand:
//   5 January: received at cost 10.000,00 (VAT 2.100,00), on the shelf at 18.150,00: VAT
//   included 3.150,00, markup 5.000,00; K = 5.000 ÷ 15.000 = 33,33%;
//   January sells 6.050,00 (net 5.000,00): 5.000 × 1/3 = 1.666,67; February sells the rest,
//   12.100,00 (net 10.000,00): the year's 15.000 × 1/3 − 1.666,67 = 3.333,33, and 378 is nil;
//   3 March: received 20.000,00 at cost, 26.620,00 on the shelf (VAT 4.620,00, markup
//   2.000,00): K = 7.000 ÷ 37.000 = 18,9189%; March sells 3.025,00 (the year's net 17.500,00):
//   17.500 × K − 5.000,00 = −1.689,19 given back, 378 at 3.689,19 = 19.500 × K;
//   April sells 18.150,00 (the year's net 32.500,00): 32.500 × K − 3.310,81 = 2.837,84, 378 at
//   851,35 = 4.500 × K.
// Applied to the month's exits alone, the year's K would take 472,97 in March and 2.837,84 in
// April, leaving 378 at −1.310,81 with 4.500,00 of goods still held.

describe('FY2026: the retail price method over months of uneven sales (pct. 286)', () => {
  test('January–April: received at sale price, sold on Z reports, discharged by K each month', async () => {
    const b = await books({
      cui: SHOP,
      name: 'Magazin Centru SRL',
      caen: '4711',
      facts: { ...goodsFacts, employer: 'no', 'policy.stock.retail': 'retail' },
      figures: figures2025,
    });
    await b.determine();
    const store = await b.as.agent<{ id: string }>('stock.warehouses.create', {
      code: 'M2',
      name: 'Magazin centru',
      keeper: 'Ionescu Maria',
    });
    await b.as.owner('retail.setup', { warehouseId: store.id, rates: ['21'] });
    const receive = async (date: string, number: string, cost: string, sale: string) => {
      const vat = lei((bani(cost) * 21n + 50n) / 100n);
      const invoice = await b.efacturaXml({
        number,
        date,
        counterparty: `RO${SUPPLIER}`,
        net: cost,
        tax: vat,
        gross: sum([cost, vat]),
        lines: [{ rate: '21', net: cost, name: 'Mărfuri diverse' }],
      });
      if (number === 'FR-1')
        await b.as.agent('parties.recordDetails', {
          partyId: invoice.partyId,
          details: {
            name: 'Furnizor Cafea SRL',
            vatId: `RO${SUPPLIER}`,
            address: {
              lines: ['Str. Portului 3'],
              city: 'Brăila',
              subdivision: 'RO-BR',
              country: 'RO',
            },
          },
        });
      return b.book(
        'invoices.recognize',
        {
          documentId: invoice.id,
          account: '371.M2-21',
          retail: {
            warehouseId: store.id,
            evidenceId: await b.pdf(`nir-${number}.pdf`),
            prices: [{ account: '371.M2-21', sale }],
          },
        },
        [],
      );
    };
    let number = 0;
    const sell = async (date: string, gross: string) => {
      number += 1;
      const tax = lei((bani(gross) * 21n * 2n + 121n) / 242n);
      const z = await b.as.agent<{ id: string }>('documents.record', {
        evidenceId: await b.file(`z-m2-${number}.png`, `Z M2 ${number}`, 'image/png'),
        kind: 'zreport',
        body: {
          seller: { name: 'Magazin Centru SRL', taxId: `RO${SHOP}`, country: 'RO' },
          register: '4400099999',
          number: String(number),
          issueDate: date,
          receipts: 40,
          currency: 'RON',
          taxes: [{ rate: '21', gross, tax }],
          totals: { gross, tax },
          payments: [{ method: 'cash', amount: gross, currency: 'RON' }],
        },
      });
      return b.book(
        'retail.zReport',
        { documentId: z.id, cash: '5311', account: '707', goods: { warehouseId: store.id } },
        ['SOURCE_EXTRACTED'],
      );
    };
    const sales: Record<number, string> = {
      1: '6050.00',
      2: '12100.00',
      3: '3025.00',
      4: '18150.00',
    };
    const discharges: string[] = [];
    const held: string[] = [];
    for (const m of [1, 2, 3, 4]) {
      await b.on(ymd(m, 2));
      if (m === 1) await receive('2026-01-05', 'FR-1', '10000.00', '18150.00');
      if (m === 3) await receive('2026-03-03', 'FR-2', '20000.00', '26620.00');
      await b.on(ymd(m, 28));
      await sell(ymd(m, 28), sales[m]!);
      await b.on(nextMonthDay(m, 2));
      const discharge = await b.propose('retail.discharge', {
        month: ym(m),
        warehouseId: store.id,
      });
      const markup = discharge.effect!.lines.find((line) => line.account === '378.M2')!.amount;
      discharges.push(markup);
      await b.post(discharge, []);
      // 378 holds the stock's share at the year's K: K × (371 − 4428), to the ban.
      const books = await b.balances(lastDay(m));
      const net = bani(books.get('371.M2-21') ?? '0.00') + bani(books.get('4428.M2-21') ?? '0.00');
      const k = m < 3 ? [5000n, 15000n] : [7000n, 37000n];
      const share = (net * k[0]! * 2n + k[1]!) / (2n * k[1]!);
      expect([ym(m), books.get('378.M2') ?? '0.00']).toEqual([ym(m), lei(-share)]);
      held.push(books.get('378.M2') ?? '0.00');
      await b.settleVat(m);
      if (m === 3) await b.profitTax('2026-Q1', '2026-03-31', ['PROFIT_MINIMUM_TAX']);
      await b.close(ym(m));
      for (const [kind, options] of [
        ['D300', shopD300],
        ['D394', shopD394],
        // The warehouse's analytics numbered as the company's chart numbers them.
        [
          'D406',
          {
            contact,
            accountIds: { '371.M2-21': '3712021', '378.M2': '37802', '4428.M2-21': '44282021' },
          },
        ],
      ] as const)
        await b.fileReturn(kind, ym(m), options);
      if (m === 3) await b.fileReturn('D100', ym(m), { declarant });
    }
    expect(b.returns.map((item) => item.state)).toEqual(Array(13).fill('validated_official'));
    expect(discharges).toEqual(['1666.67', '3333.33', '-1689.19', '2837.84']);
    expect(held).toEqual(['-3333.33', '0.00', '-3689.19', '-851.35']);
    const position = await b.as.agent<{ markup: string; cost: string }>('retail.position', {
      warehouseId: store.id,
      date: '2026-04-30',
    });
    // 5.445,00 on the shelf: 945,00 VAT, 851,35 markup, a cost of 3.648,65.
    expect(position).toMatchObject({ markup: '851.35', cost: '3648.65' });
  });
});

// 2. The joinery.
//
// Tâmplăria Exemplu SRL makes tables and chairs on work orders at the standard cost (FIFO), with
// one joiner, on profit tax. Amounts by hand:
//   BOMs: a table takes 2 boards (100,00) and 0,5 l of lacquer (25,00), standard 550,00; a chair
//   1 board and 0,25 l, standard 300,00, revised to 320,00 from July;
//   each month: an order of 10 tables, made and closed in the month (20 boards, 5 l); an order of
//   20 chairs opened (15 boards, 4 l), 8 delivered, 12 in progress at 40% at the month's end,
//   finished the next month (5 boards, 1 l, 12 chairs) after its work in progress is taken back;
//   the joiner (6.000,00 lei, CAM 135,00) works the month's days × 8 hours: 72 on the tables, 36
//   on the new chairs, 18 on the previous month's; the workshop's rent (612, 800,00) is a fixed
//   overhead on machine hours (20, 16 and 4) at a normal capacity of 100; energy (605, 600,00)
//   variable on labour hours; sold on the 20th: 8 tables at 900,00, and from February 15 chairs
//   at 450,00, collected on the 28th;
//   January by hand: the tables cost 2.125,00 + 6.135 × 72/144 = 3.067,50 + 160,00 + 400,00 =
//   5.752,50 against 5.500,00 at standard, 252,50 unfavourable; the chairs 1.600,00 + 1.533,75 +
//   128,00 + 200,00 − 2.400,00 = 1.061,75 in progress; 8 tables sold, 4.400,00 at standard, take
//   252,50 × 4.400 ÷ 7.900 = 140,63 of the differences (pct. 286 alin. (4)), and 348 keeps the
//   stock's share;
//   December's chairs are finished within the month (20 boards, 5 l): no work in progress at the
//   year's end; 240 chairs made, 165 sold;
//   31 December: 23 tables found of 24, 75 chairs.

const JOINERY = '18547290';
const BUYER = '14399840';
const MATERIALS = '25648378';
const joineryD300 = { ...shopD300, caen: '3109' };
const joineryD394 = { ...shopD394, caen: '3109' };
const holidays2026 = [
  '01-01',
  '01-02',
  '01-06',
  '01-07',
  '01-24',
  '04-10',
  '04-12',
  '04-13',
  '05-01',
  '05-31',
  '06-01',
  '08-15',
  '11-30',
  '12-01',
  '12-25',
  '12-26',
];
const workingDays = (month: number) => {
  let count = 0;
  for (let day = 1; day <= daysIn(month); day++) {
    const weekday = new Date(Date.UTC(2026, month - 1, day)).getUTCDay();
    if (
      weekday !== 0 &&
      weekday !== 6 &&
      !holidays2026.includes(`${mm(month)}-${String(day).padStart(2, '0')}`)
    )
      count += 1;
  }
  return count;
};
/** A synthetic CNP with a valid control digit. */
function cnpOf(body: string) {
  const weights = [2, 7, 9, 1, 4, 6, 3, 5, 8, 2, 7, 9];
  const control =
    weights.reduce((total, weight, index) => total + weight * Number(body[index]), 0) % 11;
  return `${body}${control === 10 ? 1 : control}`;
}

describe('FY2026: a joinery SRL at the standard cost, on profit tax (G4)', () => {
  let b: Books;
  const ids = {} as Record<string, string>;
  /** Each month's chairs order, finished the next month. */
  const chairs = new Map<number, string>();
  const runs = new Map<number, { id: string; net: string }>();
  const vatPayable = new Map<number, string>();
  const invoiced = new Map<number, Issued>();
  const variances: string[] = [];

  async function month(m: number) {
    await b.on(ymd(m, 1));
    const evidence = (name: string) => b.pdf(`${name}-${ym(m)}.pdf`);
    // The month's materials, rent and energy on e-Factura, each material on its own invoice (two
    // materials on one invoice are d406.integration.test.ts's).
    for (const [number, account, itemId, quantity, net, tax, name] of [
      [`PAL-${mm(m)}`, '301', ids.board!, '40', '4000.00', '840.00', 'Placă PAL 18 mm'],
      [`LAC-${mm(m)}`, '3021', ids.lacquer!, '10', '250.00', '52.50', 'Lac poliuretanic'],
    ] as const) {
      const materials = await b.efacturaXml({
        number,
        date: ymd(m, 1),
        counterparty: `RO${MATERIALS}`,
        net,
        tax,
        gross: sum([net, tax]),
        lines: [{ rate: '21', net, name }],
      });
      if (m === 1 && account === '301')
        await b.as.agent('parties.recordDetails', {
          partyId: materials.partyId,
          details: {
            name: 'Furnizor PAL SRL',
            vatId: `RO${MATERIALS}`,
            address: {
              lines: ['Str. Fabricii 2'],
              city: 'Brăila',
              subdivision: 'RO-BR',
              country: 'RO',
            },
          },
        });
      await b.book(
        'invoices.recognize',
        {
          documentId: materials.id,
          account,
          stock: { warehouseId: ids.depot!, lines: [{ line: '1', itemId, quantity }] },
        },
        [],
      );
    }
    for (const [number, account, net, tax, name] of [
      [`CH-${mm(m)}`, '612', '800.00', '168.00', 'Chirie atelier'],
      [`EN-${mm(m)}`, '605', '600.00', '126.00', 'Energie electrică atelier'],
    ] as const) {
      const bill = await b.efacturaXml({
        number,
        date: ymd(m, 1),
        counterparty: `RO${SUPPLIER}`,
        net,
        tax,
        gross: sum([net, tax]),
        lines: [{ rate: '21', net, name }],
      });
      if (m === 1 && account === '612')
        await b.as.agent('parties.recordDetails', {
          partyId: bill.partyId,
          details: {
            name: 'Utilități Exemplu SRL',
            vatId: `RO${SUPPLIER}`,
            address: {
              lines: ['Str. Portului 3'],
              city: 'Brăila',
              subdivision: 'RO-BR',
              country: 'RO',
            },
          },
        });
      await b.book('invoices.recognize', { documentId: bill.id, account }, []);
    }

    // The previous month's chairs: their work in progress taken back, finished, closed.
    await b.on(ymd(m, 2));
    const tables = await b.as.agent<{ id: string }>('production.orders.open', {
      number: `CP-T-${mm(m)}`,
      itemId: ids.table,
      quantity: '10',
      openedOn: ymd(m, 2),
      evidenceId: await evidence('cp-mese'),
    });
    const newChairs = await b.as.agent<{ id: string; bomVersion: number }>(
      'production.orders.open',
      {
        number: `CP-S-${mm(m)}`,
        itemId: ids.chair,
        quantity: '20',
        openedOn: ymd(m, 2),
        evidenceId: await evidence('cp-scaune'),
      },
    );
    expect(newChairs.bomVersion).toBe(m < 7 ? 1 : 2);
    chairs.set(m, newChairs.id);
    const consume = (orderId: string, reference: string, boards: string, lacquer: string) =>
      b.book(
        'production.consume',
        {
          orderId,
          date: ymd(m, 3),
          warehouseId: ids.depot,
          reference,
          evidenceId: ids.slip,
          lines: [
            { itemId: ids.board, quantity: boards },
            { itemId: ids.lacquer, quantity: lacquer },
          ],
        },
        [],
      );
    await b.on(ymd(m, 3));
    // December's chairs are finished within the month: no work in progress at the year's end.
    const last = m === 12;
    await consume(tables.id, `BC-T-${mm(m)}`, '20', '5');
    await consume(newChairs.id, `BC-S-${mm(m)}`, last ? '20' : '15', last ? '5' : '4');
    const previous = chairs.get(m - 1);
    if (previous) await consume(previous, `BC-SP-${mm(m)}`, '5', '1');
    const output = (orderId: string, reference: string, itemId: string, quantity: string) =>
      b.book(
        'production.output',
        {
          orderId,
          date: ymd(m, 15),
          warehouseId: ids.finished,
          reference,
          evidenceId: ids.slip,
          lines: [{ itemId, quantity }],
        },
        [],
      );
    await b.on(ymd(m, 15));
    await output(tables.id, `BP-T-${mm(m)}`, ids.table!, '10');
    await output(newChairs.id, `BP-S-${mm(m)}`, ids.chair!, last ? '20' : '8');
    if (previous) await output(previous, `BP-SP-${mm(m)}`, ids.chair!, '12');
    for (const orderId of [
      tables.id,
      ...(previous ? [previous] : []),
      ...(last ? [newChairs.id] : []),
    ])
      await b.as.agent('production.orders.close', {
        orderId,
        date: ymd(m, 15),
        evidenceId: await evidence(`inchidere-${orderId.slice(0, 8)}`),
      });

    // Sold on the 20th, sent to RO e-Factura.
    await b.on(ymd(m, 20));
    const sale = await b.as.owner<Issued>('sales.issue', {
      seriesId: ids.series,
      buyerId: ids.buyer,
      issueDate: ymd(m, 20),
      lines: [
        {
          name: 'Masă de bucătărie',
          quantity: '8',
          unitCode: 'H87',
          price: '900',
          vat: { category: 'S', rate: '21' },
        },
        ...(m > 1
          ? [
              {
                name: 'Scaun',
                quantity: '15',
                unitCode: 'H87',
                price: '450',
                vat: { category: 'S', rate: '21' },
              },
            ]
          : []),
      ],
      stock: {
        warehouseId: ids.finished,
        lines: [
          { index: 0, itemId: ids.table },
          ...(m > 1 ? [{ index: 1, itemId: ids.chair }] : []),
        ],
      },
    });
    expect(sale.recognition.error).toBe(null);
    await b.post(
      await b.as.agent<ProposalView>('proposals.get', { id: sale.recognition.proposalId }),
      [],
    );
    const sent = await b.as.owner<{ id: string }>('spv.submit', { documentId: sale.documentId });
    expect(
      (await b.as.agent<{ state: string }>('spv.refresh', { submissionId: sent.id })).state,
    ).toBe('accepted');
    invoiced.set(m, sale);

    // The month's payroll.
    await b.on(ymd(m, 28));
    const run = await b.as.owner<{
      id: string;
      lines: { net: string; cash: string; cam: string }[];
    }>('payroll.runs.prepare', { month: ym(m), workingDays: workingDays(m) });
    expect(run.lines.map((line) => [line.cash, line.cam])).toEqual([['6000.00', '135.00']]);
    await b.book(
      'payroll.recognize',
      { runId: run.id, month: ym(m), round: 1, authorityId: b.anaf.id },
      [],
    );
    runs.set(m, { id: run.id, net: run.lines[0]!.net });

    // The statement: suppliers paid, the previous month's salary and VAT, the customer's money.
    await b.on(lastDay(m));
    const gross = sale.totals.payable;
    const entries = [
      { ref: `PAL-${mm(m)}`, day: 5, amount: '4840.00', credit: false, text: 'Plata' },
      { ref: `LAC-${mm(m)}`, day: 5, amount: '302.50', credit: false, text: 'Plata' },
      { ref: `CH-${mm(m)}`, day: 6, amount: '968.00', credit: false, text: 'Plata' },
      { ref: `EN-${mm(m)}`, day: 7, amount: '726.00', credit: false, text: 'Plata' },
      ...(m > 1
        ? [
            {
              ref: `SAL-${mm(m)}`,
              day: 10,
              amount: runs.get(m - 1)!.net,
              credit: false,
              text: 'Salarii',
            },
            {
              ref: `TVA-${mm(m)}`,
              day: 20,
              amount: vatPayable.get(m - 1)!,
              credit: false,
              text: 'Plata TVA',
            },
          ]
        : []),
      { ref: sale.number, day: 28, amount: gross, credit: true, text: 'Incasare' },
    ];
    const movement = await b.statement(m, entries);
    for (const ref of [`PAL-${mm(m)}`, `LAC-${mm(m)}`, `CH-${mm(m)}`, `EN-${mm(m)}`, sale.number])
      await b.book(
        'bank.settle',
        {
          movementId: movement(ref),
          allocations: [
            {
              openItem: await b.openItem(ref),
              amount: entries.find((entry) => entry.ref === ref)!.amount,
            },
          ],
        },
        [],
      );
    if (m > 1) {
      // The previous month's net salary: the oldest open 421 item.
      const items = await b.as.agent<{
        items: { id: string; account: string; balance: string; dueDate: string | null }[];
      }>('openItems.list', { openOnly: true });
      const salary = items.items
        .filter((item) => item.account.startsWith('421'))
        .sort((x, y) => (x.dueDate ?? '').localeCompare(y.dueDate ?? ''))
        .find((item) => item.balance.replace('-', '') === runs.get(m - 1)!.net)!;
      expect(salary, `the salary of ${ym(m - 1)}`).toBeDefined();
      await b.book(
        'bank.settle',
        {
          movementId: movement(`SAL-${mm(m)}`),
          allocations: [{ openItem: salary.id, amount: runs.get(m - 1)!.net }],
        },
        [],
      );
      await b.book(
        'tax.pay',
        { movementId: movement(`TVA-${mm(m)}`), authorityId: b.anaf.id, to: 'vat' },
        [],
      );
    }

    // The month's costing: the cost sheets, the work in progress of the new chairs.
    await b.on(nextMonthDay(m, 2));
    const hours = String(workingDays(m) * 8);
    const costing = await b.propose('production.cost', {
      month: ym(m),
      labour: {
        method: 'hours',
        runId: run.id,
        evidenceId: await evidence('pontaj'),
        contracts: [
          {
            contractId: ids.contract,
            hours,
            orders: [
              { orderId: tables.id, hours: '72' },
              { orderId: newChairs.id, hours: '36' },
              ...(previous ? [{ orderId: previous, hours: '18' }] : []),
            ],
          },
        ],
      },
      overheads: [
        {
          accounts: ['612'],
          behaviour: 'fixed',
          key: 'machine_hours',
          capacity: { normal: '100', evidenceId: ids.capacity },
        },
        { accounts: ['605'], behaviour: 'variable', key: 'labour_hours' },
      ],
      machineHours: {
        evidenceId: await evidence('ore-utilaje'),
        orders: [
          { orderId: tables.id, hours: '20' },
          { orderId: newChairs.id, hours: '16' },
          ...(previous ? [{ orderId: previous, hours: '4' }] : []),
        ],
      },
      ...(last
        ? {}
        : {
            wip: {
              evidenceId: await evidence('inventar-pic'),
              orders: [
                {
                  orderId: newChairs.id,
                  itemId: ids.chairsInProgress,
                  warehouseId: ids.workshop,
                  quantity: '12',
                  completion: '40',
                },
              ],
            },
          }),
    });
    const posted = await b.post(costing, []);
    variances.push(...lines(posted).filter((line) => / 348 /.test(line)));
    if (m === 1)
      expect(lines(posted).sort()).toEqual([
        'C 711 1061.75',
        'C 711 252.50',
        'D 331 1061.75',
        'D 348 252.50',
      ]);
    const spread = await b.book('production.differences', { month: ym(m) }, []);
    if (m === 1) expect(lines(spread)).toEqual(['D 711 140.63', 'C 348 140.63']);
  }

  /** 348 keeps the products' share at the year's coefficient (pct. 286 alin. (6)–(7)). */
  async function differencesFollowTheStock(m: number) {
    const books = await b.balances(lastDay(m));
    // The year's differences entered over the products entered at standard, both from the books.
    const year = await b.s.trialBalance('2026-01-01', lastDay(m));
    const row = (account: string) => year.rows.find((item) => item.account === account);
    const entered = bani(row('345')!.current.debit);
    const differences = variances.reduce((total, line) => {
      const [side, , amount] = line.split(' ');
      return total + (side === 'D' ? bani(amount!) : -bani(amount!));
    }, 0n);
    const stock = bani(books.get('345')!);
    const share = (stock * differences * 2n + entered) / (2n * entered);
    // To the ban: the exits' share is rounded, the stock's is what remains.
    const off = bani(books.get('348') ?? '0.00') - share;
    expect([ym(m), off <= 1n && off >= -1n]).toEqual([ym(m), true]);
  }

  async function wrapUp(m: number, profit?: string[]) {
    // The next month's first day takes the work in progress back (the function of 331).
    if (m < 12) {
      const held = (await b.balances(lastDay(m))).get('331')!;
      if (m === 1) expect(held).toBe('1061.75');
      const reversed = await b.book('production.wipReverse', { month: ym(m + 1) }, []);
      expect([reversed.effect!.date, ...lines(reversed)]).toEqual([
        ymd(m + 1, 1),
        `C 331 ${held}`,
        `D 711 ${held}`,
      ]);
    }
    const settlement = await b.settleVat(m);
    vatPayable.set(
      m,
      settlement.effect!.lines.find((line) => line.account === '4423')?.amount ?? '0.00',
    );
    if (profit) await b.profitTax(`2026-Q${m / 3}`, lastDay(m), profit);
    await registerEqualsLedger(b, lastDay(m));
    await differencesFollowTheStock(m);
    await b.close(ym(m));
    for (const [kind, options] of [
      ['D300', joineryD300],
      ['D394', joineryD394],
      [
        'D406',
        { contact, accounts: { '605': '6051', '612': '6123', '646': '6461', '635': '635' } },
      ],
      ['D112', { declarant, caen: '3109', phone: '0236000000' }],
    ] as const)
      await b.fileReturn(kind, ym(m), options);
    if (profit) await b.fileReturn('D100', ym(m), { declarant });
  }

  test('setup: the joinery, its BOMs, its joiner, 2026’s determinations', async () => {
    b = await books({
      cui: JOINERY,
      name: 'Tâmplăria Exemplu SRL',
      caen: '3109',
      facts: { ...goodsFacts, employer: 'yes', 'policy.production.cost': 'standard' },
      figures: { ...figures2025, averageEmployees: '1' },
      bank: '100000.00',
    });
    await b.book(
      'ledger.general',
      {
        date: '2026-01-01',
        purpose: 'opening',
        reference: 'SOLD-INITIAL',
        description: 'Solduri inițiale',
        evidenceId: await b.pdf('balanta-deschidere.pdf'),
        lines: [
          { account: '5121', side: 'D', amount: '100000.00' },
          { account: '1012', side: 'C', amount: '100000.00' },
        ],
      },
      [],
    );
    const item = async (code: string, name: string, account: string, unit = 'H87', nc8?: string) =>
      (
        await b.as.agent<{ id: string }>('stock.items.create', {
          code,
          name,
          unit,
          account,
          vatCategory: 'standard',
          ...(nc8 ? { nc8 } : {}),
        })
      ).id;
    ids.board = await item('PAL-18', 'Placă PAL 18 mm', '301');
    ids.lacquer = await item('LAC-1', 'Lac poliuretanic', '3021', 'LTR');
    ids.table = await item('MASA-1', 'Masă de bucătărie', '345', 'H87', '94036010');
    ids.chair = await item('SCAUN-1', 'Scaun', '345', 'H87', '94016100');
    ids.chairsInProgress = await item('PIC-SCAUN', 'Scaune în curs de execuție', '331');
    for (const [key, code, name] of [
      ['depot', 'D1', 'Depozit materiale'],
      ['workshop', 'A1', 'Atelier'],
      ['finished', 'P1', 'Depozit produse finite'],
    ] as const)
      ids[key] = (
        await b.as.agent<{ id: string }>('stock.warehouses.create', {
          code,
          name,
          keeper: 'Ionescu Maria',
        })
      ).id;
    ids.slip = await b.pdf('bonuri-consum-predare.pdf');
    ids.capacity = await b.pdf('capacitate-normala.pdf');
    const bom = async (
      itemId: string,
      validFrom: string,
      standardCost: string,
      board: string,
      lacquer: string,
    ) =>
      b.as.agent<{ version: number }>('production.boms.record', {
        itemId,
        validFrom,
        outputQuantity: '1',
        standardCost,
        labourHours: '8',
        machineHours: '2',
        evidenceId: await b.pdf(`fisa-${itemId}-${validFrom}.pdf`),
        lines: [
          { itemId: ids.board, quantity: board },
          { itemId: ids.lacquer, quantity: lacquer },
        ],
      });
    expect((await bom(ids.table, '2026-01-01', '550.00', '2', '0.5')).version).toBe(1);
    expect((await bom(ids.chair, '2026-01-01', '300.00', '1', '0.25')).version).toBe(1);
    expect((await bom(ids.chair, '2026-07-01', '320.00', '1', '0.25')).version).toBe(2);

    const employee = await b.as.owner<{ id: string }>('payroll.employees.record', {
      lastName: 'Lungu',
      firstName: 'Mihai',
      cnp: cnpOf('180010112345'),
      healthFund: 'RO-GL',
    });
    ids.contract = (
      await b.as.owner<{ contractId: string }>('payroll.contracts.record', {
        employeeId: employee.id,
        number: 'CIM-1',
        startDate: '2025-03-01',
        effectiveFrom: '2025-03-01',
        dailyHours: 8,
        mainJob: true,
        occupation: '752201',
        baseSalary: '6000',
      })
    ).contractId;
    ids.buyer = (
      await b.as.agent<{ id: string }>('parties.create', {
        kind: 'ro_legal_entity',
        country: 'RO',
        taxId: BUYER,
        name: 'Client Mobilier SRL',
      })
    ).id;
    await b.as.agent('parties.recordDetails', {
      partyId: ids.buyer,
      details: {
        name: 'Client Mobilier SRL',
        vatId: `RO${BUYER}`,
        address: { lines: ['Bd. Unirii 5'], city: 'Brașov', subdivision: 'RO-BV', country: 'RO' },
      },
    });
    ids.series = (
      await b.as.owner<{ id: string }>('sales.series.create', {
        code: 'MOB',
        prefix: 'MOB',
        width: 4,
        revenueAccount: '7015',
      })
    ).id;
    await b.determine();
  });

  test('January–June: an order closed and one carried each month, Q1’s and Q2’s profit tax', async () => {
    for (const m of [1, 2, 3, 4, 5, 6]) {
      await month(m);
      await wrapUp(m, m % 3 === 0 ? ['LEGAL_RESERVE', 'PROFIT_MINIMUM_TAX'] : undefined);
    }
    // D112 in ANAF's structure of its month (namespace v7): January–June 2026 with the
    // minimum wage of 4,050 lei and the 300 lei relief, the register's, through ANAF's validator
    // like July's; no return of the half year is a gap.
    expect(b.returns.filter((item) => item.state === 'FORMAT_GAP')).toEqual([]);
    expect(
      b.returns
        .filter((item) => item.kind === 'D112')
        .map((item) => `${item.period} ${item.state}`),
    ).toEqual(
      ['01', '02', '03', '04', '05', '06'].map(
        (mm) => `2026-${mm} ${installed ? 'validated_official' : 'prepared'}`,
      ),
    );
  });

  test('July–December: the chair’s revised standard, the year-end count, the year closed, D101', async () => {
    for (const m of [7, 8, 9, 10, 11]) {
      await month(m);
      await wrapUp(m, m === 9 ? ['LEGAL_RESERVE', 'PROFIT_MINIMUM_TAX'] : undefined);
    }
    await month(12);
    await b.on('2027-01-05');
    // The annual inventory: one table missing; the materials, the chairs and the work in progress
    // as the register holds them.
    const books = await b.balances('2026-12-31');
    const held = await registerEqualsLedger(b, '2026-12-31');
    expect(held.positions.map((row) => `${row.code} ${row.warehouse} ${row.quantity}`)).toEqual([
      'MASA-1 P1 24.000',
      'SCAUN-1 P1 75.000',
    ]);
    const row = (
      account: string,
      code: string,
      name: string,
      quantity: string,
      warehouse: string,
      unit = 'H87',
    ) => ({
      account,
      code,
      name,
      unit,
      quantity,
      warehouse,
    });
    const list = await b.as.agent<{ id: string }>('documents.record', {
      evidenceId: await b.file('lista-inventariere.pdf', 'Lista 31.12.2026', 'application/pdf'),
      kind: 'inventory.list',
      body: {
        title: 'Lista de inventariere la 31.12.2026',
        company: { name: 'Tâmplăria Exemplu SRL', taxId: JOINERY },
        date: '2026-12-31',
        commission: { decision: '45', decisionDate: '2026-12-01', members: ['Pop Ion'] },
        assets: null,
        cash: null,
        bank: [{ account: '5121', currency: 'RON', iban, balance: books.get('5121') }],
        partners: null,
        stock: [
          row('345', 'MASA-1', 'Masă de bucătărie', '23', 'P1'),
          row('345', 'SCAUN-1', 'Scaun', '75', 'P1'),
        ],
      },
    });
    const counted = await b.book(
      'inventory.stock',
      {
        date: '2026-12-31',
        documentIds: [list.id],
        evidenceId: await b.pdf('decizie-inventar.pdf'),
        causes: [{ itemId: ids.table, warehouseId: ids.finished, cause: 'unimputable' }],
      },
      ['PRODUCT_SHORTAGE_VAT', 'PROFIT_SHORTAGE', 'SOURCE_EXTRACTED'],
    );
    // The missing table at its registration price onto 711; the VAT of what it was made of on its
    // cost, 550,00 × 21% = 115,50.
    expect(lines(counted)).toEqual([
      'C 345 550.00',
      'D 711 550.00',
      'D 635 115.50',
      'C 4426 115.50',
    ]);
    const leave = await b.as.agent<{ id: string; answer: unknown }>('questions.ask', {
      kind: 'leave.untaken',
      subject: { kind: 'company', id: 'company' },
      params: { year: 2026 },
    });
    await b.answer(leave.id, {
      days: 0,
      amount: '0.00',
      contributions: '0.00',
      measured: true,
      evidenceId: await b.pdf('concedii.pdf'),
    });
    await b.settleVat(12);
    await b.profitTax('2026', '2026-12-31', ['LEGAL_RESERVE', 'PROFIT_MINIMUM_TAX']);
    await b.provisionsReviewed();
    await b.book('year.closeResult', {
      yearEnd: '2026-12-31',
      evidenceId: await b.pdf('nota-inchidere.pdf'),
    });
    expect((await b.review()).items.filter((item) => item.severity === 'block')).toEqual([]);
    await registerEqualsLedger(b, '2026-12-31');
    await b.close('2026-12');
    for (const [kind, options] of [
      ['D300', joineryD300],
      ['D394', joineryD394],
      [
        'D406',
        { contact, accounts: { '605': '6051', '612': '6123', '646': '6461', '635': '635' } },
      ],
      ['D112', { declarant, caen: '3109', phone: '0236000000' }],
    ] as const)
      await b.fileReturn(kind, '2026-12', options);
    await b.closeYear();

    const stockFile = await b.as.agent<Artifact>('declarations.prepare', {
      kind: 'D406',
      period: '2026-12-C',
      options: { contact, accounts: { '605': '6051', '612': '6123', '646': '6461', '635': '635' } },
    });
    b.returns.push({ kind: 'D406-C', period: '2026-12', state: stockFile.state });
    expect(stockFile.state).toBe(installed ? 'validated_official' : stockFile.state);
    expect([...physicalStock(await b.xmlOf(stockFile)).entries()].sort()).toEqual(
      [...registerStock(await b.register('2026-12-31')).entries()].sort(),
    );
    const d101 = await b.as.agent<Artifact>('declarations.prepare', {
      kind: 'D101',
      period: '2026',
      options: { declarant, caen: '3109' },
    });
    b.returns.push({ kind: 'D101', period: '2026', state: d101.state });
    expect(d101.state).toBe(installed ? 'validated_official' : d101.state);
    const closure = await b.closure();
    expect([closure.status, closure.needs, closure.unsupported]).toEqual(['ELIGIBLE', [], []]);
    // The closure and the writers agree: every return it calls covered is prepared and passes
    // ANAF's validator, but FY2026's statements, whose format ANAF has not published.
    expect(await b.uncovered({ S1005: statementOptions })).toEqual(['S1005 2026 FORMAT_GAP']);
    // Nothing blocked a close that nobody could act on: each month's costing was checked once the
    // month ended, never from its first day; the contract begun in 2025 under Revisal stayed off
    // the worklist once 2027 began, its register's start date past the rules' horizon.
    expect(b.waiting.filter((item) => / (close\.finding|payroll\.due) /.test(item))).toEqual([]);
    // D300, D394, D406 and D112 each month, D100 for three quarters, the stock file and D101:
    // ANAF's validators pass every one.
    expect(b.returns).toHaveLength(53);
    expect(b.returns.filter((item) => item.state !== 'validated_official')).toEqual([]);
  });
});

// 3. The EU goods trader.
//
// Exemplu Comerț SRL buys green coffee in Germany and sells it to Italy, on FIFO; once it imports
// components from China under the VAT deferral certificate and exports half of them. BNR's EUR
// at 5,0800 and USD at 4,5000 every day (synthetic). Amounts by hand:
//   each month on the 5th: 1.500 kg from DE123456788 at 9,00 EUR = 13.500,00 EUR = 68.580,00 lei
//   into stock (45,72 lei/kg), VAT 21% self-assessed 14.401,80 (4427 = 4426, D300 rd. 5 and 20,
//   D390 A);
//   on the 12th, delivered on the 10th: 1.000 kg to IT12345670017 at 75,00 = 75.000,00 lei,
//   exempt (art. 294 alin. (2) lit. a)), VIES asked on the 10th, the CMR and the insurance from
//   two independent issuers (art. 45a), out at 45.720,00 (D300 rd. 1, D390 L), collected on the
//   25th;
//   arrivals reach 80% of INS's 1.000.000 lei in December (12 × 68.580 = 822.960), dispatches
//   in November (11 × 75.000 = 825.000): the watch warns, below the threshold;
//   6 May: 2.000,00 USD of components (9.000,00 lei), duty 240,00, VAT 21% of 9.340,00 =
//   1.961,40 not paid at customs (art. 326 alin. (4) lit. a)): rd. 7 and 22; 100 pieces at 92,40;
//   12 June: 50 of them exported to the US for 6.000,00, the exit certified (rd. 14);
//   31 December: 6.000 kg of coffee and 50 pieces counted, as held.

const TRADER = '18547290';
const GERMANY = 'DE123456788';
const ITALY = 'IT12345670017';
const traderD300 = { ...shopD300, caen: '4637' };
const traderD394 = { ...shopD394, caen: '4637' };
const everyDay = (() => {
  const cubes: [string, Record<string, string>][] = [];
  for (let m = 1; m <= 12; m++)
    for (let day = 1; day <= daysIn(m); day++)
      cubes.push([ymd(m, day), { EUR: '5.0800', USD: '4.5000' }]);
  return cubes;
})();

describe('FY2026: an EU goods trader (G3)', () => {
  let b: Books;
  const ids = {} as Record<string, string>;
  const traded: { month: number; type: 'A' | 'L'; base: number }[] = [];

  /** An invoice the agent imports, in an exempt or outside-the-scope category with its reason. */
  const foreign = async (input: XmlInput & { reason?: string }) => {
    const xml = invoiceXml({ company: TRADER, rate: '0', tax: '0.00', gross: input.net, ...input });
    const withReason = input.reason
      ? xml.replace(
          /(<cac:TaxSubtotal>.*?<cac:TaxCategory><cbc:ID>[EKG]<\/cbc:ID><cbc:Percent>0<\/cbc:Percent>)/,
          `$1<cbc:TaxExemptionReasonCode>${input.reason}</cbc:TaxExemptionReasonCode>`,
        )
      : xml;
    return b.as.agent<{ id: string; partyId: string }>('invoices.import', {
      evidenceId: await b.file(`${input.number}.xml`, withReason, 'application/xml'),
    });
  };
  const details = (partyId: string, name: string, vatId: string, city: string) =>
    b.as.agent('parties.recordDetails', {
      partyId,
      details: { name, vatId, address: { lines: ['Strada 1'], city, country: vatId.slice(0, 2) } },
    });

  async function month(m: number) {
    await b.on(ymd(m, 5));
    const bought = await foreign({
      number: `DE-${mm(m)}`,
      date: ymd(m, 5),
      deliveryDate: ymd(m, 3),
      direction: 'purchase',
      currency: 'EUR',
      category: 'K',
      country: 'DE',
      counterparty: GERMANY,
      net: '13500.00',
      reason: 'VATEX-EU-IC',
      lines: [{ rate: '0', net: '13500.00', name: 'Cafea verde' }],
    });
    if (m === 1) await details(bought.partyId, `Companie ${GERMANY}`, GERMANY, 'Hamburg');
    const acquisition = await b.book(
      'goods.euAcquisition',
      {
        documentId: bought.id,
        account: '371',
        arrangement: 'standard',
        rate: 'standard',
        deduction: 'full',
        stock: {
          warehouseId: ids.depot,
          lines: [{ line: '1', itemId: ids.coffee, quantity: '1500' }],
        },
      },
      [],
    );
    expect(lines(acquisition)).toEqual([
      'D 371 68580.00',
      'C 401 68580.00',
      'C 4427 14401.80',
      'D 4426 14401.80',
    ]);
    traded.push({ month: m, type: 'A', base: 68580 });

    // The supply: VIES asked on the day the goods leave, the transport proved by two documents.
    await b.on(ymd(m, 10));
    if (m === 1) {
      ids.italy = (
        await b.as.agent<{ id: string }>('parties.create', {
          kind: 'eu_taxable',
          country: 'IT',
          taxId: ITALY,
          name: `Companie ${ITALY}`,
        })
      ).id;
      await details(ids.italy, `Companie ${ITALY}`, ITALY, 'Milano');
    }
    const checked = await b.as.agent<{ documentId: string; valid: boolean }>('parties.checkVies', {
      partyId: ids.italy,
    });
    expect(checked.valid).toBe(true);
    await b.on(ymd(m, 12));
    const sold = await foreign({
      number: `IC-${mm(m)}`,
      date: ymd(m, 12),
      deliveryDate: ymd(m, 10),
      direction: 'sale',
      category: 'K',
      country: 'IT',
      counterparty: ITALY,
      net: '75000.00',
      reason: 'VATEX-EU-IC',
      lines: [{ rate: '0', net: '75000.00', name: 'Cafea verde' }],
    });
    const transport = (kind: string, issuer: string) =>
      b.pdf(`${kind}-${mm(m)}.pdf`).then((evidenceId) => ({
        kind,
        evidenceId,
        issuer,
        independent: true,
        destination: 'IT',
        date: ymd(m, 10),
      }));
    const supply = await b.book(
      'goods.euSupply',
      {
        documentId: sold.id,
        account: '707',
        arrangement: 'standard',
        viesDocumentId: checked.documentId,
        transport: {
          by: 'seller',
          documents: [
            await transport('cmr', 'Transport Rapid SRL'),
            await transport('insurance', 'Asigurări Generale SA'),
          ],
        },
        stock: {
          warehouseId: ids.depot,
          lines: [{ line: '1', itemId: ids.coffee, quantity: '1000' }],
        },
      },
      // The VIES answer the engine itself fetched counts as an extracted document.
      ['SOURCE_EXTRACTED'],
    );
    expect(lines(supply)).toEqual([
      'D 4111 75000.00',
      'C 707 75000.00',
      'C 371 45720.00',
      'D 607 45720.00',
    ]);
    traded.push({ month: m, type: 'L', base: 75000 });

    if (m === 5) {
      // The import from China: the customs declaration recorded with its figures, the VAT
      // deferred under the certificate.
      await b.on('2026-05-06');
      const invoice = await foreign({
        number: 'CN-5',
        date: '2026-05-04',
        direction: 'purchase',
        currency: 'USD',
        category: 'O',
        country: 'CN',
        counterparty: 'CN91440300',
        net: '2000.00',
        lines: [{ rate: '0', net: '2000.00', name: 'Componente electronice' }],
      });
      await details(invoice.partyId, 'Companie CN91440300', 'CN91440300', 'Shenzhen');
      const declaration = await b.as.agent<{ id: string }>('documents.record', {
        evidenceId: await b.pdf('dvi-cn-5.pdf'),
        kind: 'customs.declaration',
        body: {
          procedure: 'import',
          mrn: '26RO1234567890ABCE',
          acceptedOn: '2026-05-06',
          office: 'Biroul vamal Constanța Sud',
          declarant: { name: 'Exemplu Comerț SRL', taxId: TRADER, country: 'RO' },
          partner: { name: 'Companie CN91440300', country: 'CN' },
          invoices: [{ number: 'CN-5', currency: 'USD', amount: '2000.00' }],
          exchangeRate: '4.5500',
          lines: [
            {
              description: 'Componente electronice',
              commodity: '85423190',
              customsValue: '9100.00',
              duty: '240.00',
              vatBase: '9340.00',
              vatRate: '21',
              vat: '1961.40',
              origin: 'CN',
            },
          ],
          totals: { customsValue: '9100.00', duty: '240.00', vatBase: '9340.00', vat: '1961.40' },
          vatPayment: { mode: 'deferred', certificate: 'CA-2026-17' },
        },
      });
      const imported = await b.book(
        'goods.import',
        {
          documentId: invoice.id,
          declarationId: declaration.id,
          account: '371',
          deduction: 'full',
          authorityId: ids.customs,
          certificateEvidenceId: await b.pdf('certificat-amanare.pdf'),
          stock: {
            warehouseId: ids.depot,
            lines: [{ line: '1', itemId: ids.parts, quantity: '100' }],
          },
        },
        ['IMPORT_DUTY_COST', 'SOURCE_EXTRACTED'],
      );
      expect(lines(imported)).toEqual([
        'D 371 9240.00',
        'C 401 9000.00',
        'C 446 240.00',
        'C 4427 1961.40',
        'D 4426 1961.40',
      ]);
    }
    if (m === 6) {
      await b.on('2026-06-12');
      const exported = await foreign({
        number: 'EX-6',
        date: '2026-06-12',
        deliveryDate: '2026-06-12',
        direction: 'sale',
        category: 'G',
        country: 'US',
        counterparty: 'US5550001',
        net: '6000.00',
        reason: 'VATEX-EU-G',
        lines: [{ rate: '0', net: '6000.00', name: 'Componente electronice' }],
      });
      await details(exported.partyId, 'Companie US5550001', 'US5550001', 'Boston');
      const declaration = await b.as.agent<{ id: string }>('documents.record', {
        evidenceId: await b.pdf('dvex-6.pdf'),
        kind: 'customs.declaration',
        body: {
          procedure: 'export',
          mrn: '26RO0000000000EXP6',
          acceptedOn: '2026-06-12',
          office: 'Biroul vamal Otopeni',
          declarant: { name: 'Exemplu Comerț SRL', taxId: TRADER, country: 'RO' },
          partner: { name: 'Companie US5550001', country: 'US' },
          invoices: [{ number: 'EX-6', currency: 'RON', amount: '6000.00' }],
          lines: [
            {
              description: 'Componente electronice',
              commodity: '85423190',
              customsValue: '6000.00',
              duty: '0.00',
            },
          ],
          totals: { customsValue: '6000.00', duty: '0.00' },
          exit: { certifiedOn: '2026-06-14', office: 'Biroul vamal Halmeu' },
        },
      });
      const sale = await b.book(
        'goods.export',
        {
          documentId: exported.id,
          account: '707',
          declarationId: declaration.id,
          stock: {
            warehouseId: ids.depot,
            lines: [{ line: '1', itemId: ids.parts, quantity: '50' }],
          },
        },
        ['SOURCE_EXTRACTED'],
      );
      expect(lines(sale)).toEqual([
        'D 4111 6000.00',
        'C 707 6000.00',
        'C 371 4620.00',
        'D 607 4620.00',
      ]);
    }

    // The statement: the Italian customer pays on the 25th, the US one in June.
    await b.on(lastDay(m));
    const entries = [
      { ref: `IC-${mm(m)}`, day: 25, amount: '75000.00', credit: true, text: 'Incasare' },
      ...(m === 6
        ? [{ ref: 'EX-6', day: 26, amount: '6000.00', credit: true, text: 'Incasare' }]
        : []),
    ];
    const movement = await b.statement(m, entries);
    for (const entry of entries)
      await b.book(
        'bank.settle',
        {
          movementId: movement(entry.ref),
          allocations: [{ openItem: await b.openItem(entry.ref), amount: entry.amount }],
        },
        [],
      );
  }

  async function wrapUp(m: number, profit?: string[]) {
    await b.on(nextMonthDay(m, 2));
    // Goods moved across the border: the Intrastat flows' determinations ask 2025's figures.
    if (m === 1) await b.determine();
    await b.settleVat(m);
    if (profit) await b.profitTax(`2026-Q${m / 3}`, lastDay(m), profit);
    await registerEqualsLedger(b, lastDay(m));
    await b.close(ym(m));
    for (const [kind, options] of [
      ['D300', traderD300],
      ['D394', traderD394],
      ['D390', { declarant }],
      ['D406', { contact }],
    ] as const) {
      const filed = await b.fileReturn(kind, ym(m), options);
      if (kind === 'D390') {
        // D390 equals the month's intra-Community operations in the books, by partner and type.
        const operations = (
          summary(filed!).operations as {
            type: string;
            country: string;
            code: string;
            base: number;
          }[]
        )
          .map((item) => `${item.type} ${item.country}${item.code} ${item.base}`)
          .sort();
        expect(operations).toEqual(
          traded
            .filter((item) => item.month === m)
            .map((item) => `${item.type} ${item.type === 'A' ? GERMANY : ITALY} ${item.base}`)
            .sort(),
        );
      }
    }
    if (profit) await b.fileReturn('D100', ym(m), { declarant });
  }

  test('setup: the trader, its goods, the customs authority, 2026’s determinations', async () => {
    b = await books({
      cui: TRADER,
      name: 'Exemplu Comerț SRL',
      caen: '4637',
      facts: { ...goodsFacts, employer: 'no' },
      figures: figures2025,
      rates: everyDay,
      vies: true,
      bank: '20000.00',
    });
    await b.book(
      'ledger.general',
      {
        date: '2026-01-01',
        purpose: 'opening',
        reference: 'SOLD-INITIAL',
        description: 'Solduri inițiale',
        evidenceId: await b.pdf('balanta-deschidere.pdf'),
        lines: [
          { account: '5121', side: 'D', amount: '20000.00' },
          { account: '1012', side: 'C', amount: '20000.00' },
        ],
      },
      [],
    );
    ids.depot = (
      await b.as.agent<{ id: string }>('stock.warehouses.create', {
        code: 'D1',
        name: 'Depozit',
        keeper: 'Ionescu Maria',
      })
    ).id;
    for (const [key, code, name, unit, nc8] of [
      ['coffee', 'CAF-1', 'Cafea verde', 'KGM', '09011100'],
      ['parts', 'CMP-1', 'Componente electronice', 'H87', '85423190'],
    ] as const)
      ids[key] = (
        await b.as.agent<{ id: string }>('stock.items.create', {
          code,
          name,
          unit,
          account: '371',
          nc8,
        })
      ).id;
    ids.customs = (
      await b.as.agent<{ id: string }>('parties.create', {
        kind: 'ro_public_institution',
        country: 'RO',
        name: 'Direcția Generală a Vămilor',
      })
    ).id;
    await b.determine();
  });

  test('January–June: acquisitions from Germany, supplies to Italy, the import and the export', async () => {
    for (const m of [1, 2, 3, 4, 5, 6]) {
      await month(m);
      await wrapUp(m, m % 3 === 0 ? ['LEGAL_RESERVE', 'PROFIT_MINIMUM_TAX'] : undefined);
    }
    // May's D300: the deferred import on rd. 7 and 22; June's: the export on rd. 14.
    const filed = (await b.as.agent<{ items: Artifact[] }>('declarations.list', {})).items;
    const rows = (kind: string, period: string) =>
      summary(filed.find((item) => item.kind === kind && item.period === period)!).rows;
    expect(rows('D300', '2026-05')).toMatchObject({
      R7_1: 9340,
      R7_2: 1961,
      R1_1: 75000,
      R5_1: 68580,
    });
    expect(rows('D300', '2026-06')).toMatchObject({ R14_1: 6000, R1_1: 75000 });
  });

  test('July–December: the Intrastat watch, the count, the year closed', async () => {
    for (const m of [7, 8, 9, 10, 11]) {
      await month(m);
      await wrapUp(m, m === 9 ? ['LEGAL_RESERVE', 'PROFIT_MINIMUM_TAX'] : undefined);
    }
    await month(12);
    // INS's thresholds: both flows past 80% of 1.000.000 lei, neither past it.
    const watch = await b.as.agent<{ items: WorkItem[] }>('work.list', {
      kinds: ['threshold.approaching'],
    });
    expect(
      watch.items
        .filter((item) => item.subject.id.startsWith('ro.intrastat'))
        .map((item) => item.severity),
    ).toEqual(['warn', 'warn']);
    await b.on('2027-01-05');
    const books = await b.balances('2026-12-31');
    const held = await registerEqualsLedger(b, '2026-12-31');
    expect(held.positions.map((row) => `${row.code} ${row.quantity} ${row.value}`)).toEqual([
      'CAF-1 6000.000 274320.00',
      'CMP-1 50.000 4620.00',
    ]);
    const list = await b.as.agent<{ id: string }>('documents.record', {
      evidenceId: await b.file('lista-inventariere.pdf', 'Lista 31.12.2026', 'application/pdf'),
      kind: 'inventory.list',
      body: {
        title: 'Lista de inventariere la 31.12.2026',
        company: { name: 'Exemplu Comerț SRL', taxId: TRADER },
        date: '2026-12-31',
        commission: { decision: '7', decisionDate: '2026-12-01', members: ['Pop Ion'] },
        assets: null,
        cash: null,
        bank: [{ account: '5121', currency: 'RON', iban, balance: books.get('5121') }],
        partners: null,
        stock: [
          {
            account: '371',
            code: 'CAF-1',
            name: 'Cafea verde',
            unit: 'KGM',
            quantity: '6000',
            warehouse: 'D1',
          },
          {
            account: '371',
            code: 'CMP-1',
            name: 'Componente electronice',
            unit: 'H87',
            quantity: '50',
            warehouse: 'D1',
          },
        ],
      },
    });
    void list;
    await b.settleVat(12);
    await b.profitTax('2026', '2026-12-31', ['LEGAL_RESERVE', 'PROFIT_MINIMUM_TAX']);
    await b.provisionsReviewed();
    await b.book('year.closeResult', {
      yearEnd: '2026-12-31',
      evidenceId: await b.pdf('nota-inchidere.pdf'),
    });
    expect((await b.review()).items.filter((item) => item.severity === 'block')).toEqual([]);
    await b.close('2026-12');
    for (const [kind, options] of [
      ['D300', traderD300],
      ['D394', traderD394],
      ['D390', { declarant }],
      ['D406', { contact }],
    ] as const)
      await b.fileReturn(kind, '2026-12', options);
    await b.closeYear();
    const d101 = await b.as.agent<Artifact>('declarations.prepare', {
      kind: 'D101',
      period: '2026',
      options: { declarant, caen: '4637' },
    });
    b.returns.push({ kind: 'D101', period: '2026', state: d101.state });
    expect(d101.state).toBe(installed ? 'validated_official' : d101.state);
    const closure = await b.closure();
    expect([closure.status, closure.needs, closure.unsupported]).toEqual(['ELIGIBLE', [], []]);
    // The closure and the writers agree: every return it calls covered is prepared and passes
    // ANAF's validator, but FY2026's statements, whose format ANAF has not published.
    expect(await b.uncovered({ S1005: statementOptions })).toEqual(['S1005 2026 FORMAT_GAP']);
    // D300, D394, D390 and D406 each month, D100 for three quarters and D101.
    expect(b.returns).toHaveLength(52);
    expect(b.returns.filter((item) => item.state !== 'validated_official')).toEqual([]);
  });
});

// What the year showed was reported and fixed, each case asserted where it belongs: a shop
// keeping one warehouse on FIFO and another at retail price, each by its own dated fact
// (`policy.stock.retail.<warehouseId>`), is retail.integration.test.ts's ('a warehouse at cost
// beside one at retail price'); a purchase whose lines at one rate go to several stock accounts
// (two materials on one invoice) is d406.integration.test.ts's ('attributes a rate's lines over
// several accounts'). The worklist's 2027 returns, FY2026's statement's answers, the month in
// progress's costing, REGES-ONLINE in 2027 and D112 for January–June are asserted in the years
// above; a return filed outside the engine (`obligation.filed`, any return) is
// work.integration.test.ts's.
