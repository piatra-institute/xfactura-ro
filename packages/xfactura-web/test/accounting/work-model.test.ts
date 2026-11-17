/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import {
  arrangeWork,
  isFactItem,
  itemTitle,
  periodCount,
  refusal,
  returnChips,
  rowAction,
  type WorkItem,
} from '../../components/accounting/work-model';

const item = (id: string, changes: Partial<WorkItem> = {}): WorkItem => ({
  id,
  kind: 'document.unproposed',
  subject: { kind: 'document', id },
  severity: 'warn',
  due: null,
  period: null,
  message: id,
  details: {},
  labels: {},
  fingerprint: 'a'.repeat(64),
  next: [],
  asOfSeq: 1,
  ...changes,
});
const cause = (id: string) => ({ id, kind: 'fact' as const, message: `Lipsește ${id}.` });
const agentStep = {
  operation: 'questions.ask',
  by: 'agent' as const,
  allowed: true,
  complete: true,
  inputHint: {},
};
const obligation = (key: string, causes = [cause('fact:employer')]) =>
  item(`obligation.due:obligation:${key}`, {
    kind: 'obligation.due',
    subject: { kind: 'obligation', id: key },
    period: key.split('|')[1]!,
    causes,
    next: [agentStep],
  });

describe('returns as chips', () => {
  test('returns group by kind with their periods collapsed', () => {
    expect(
      returnChips([
        'D112|2026-01',
        'D300|2026-01',
        'D112|2026-02',
        'D112|2026-03',
        'D406|2026-Q1',
        'D406|2026-Q2',
        'S1005|2026',
      ]),
    ).toEqual(['D112 · ian–mar 2026', 'D300 · ian 2026', 'D406 · trim. I–II 2026', 'S1005 · 2026']);
    expect(returnChips(['not a return'])).toEqual([]);
  });

  test('a return reads as itself and its period; other items as the engine message', () => {
    expect(itemTitle(obligation('D300|2026-10'))).toBe('D300 · octombrie 2026');
    expect(itemTitle(obligation('D406|2026-Q4'))).toBe('D406 · trimestrul IV 2026');
    expect(itemTitle(item('x', { message: 'Documentul FV-1 nu are o propunere.' }))).toBe(
      'Documentul FV-1 nu are o propunere.',
    );
  });
});

describe('returns by return and state', () => {
  const due = (
    key: string,
    status: string,
    date: string | null,
    steps: WorkItem['next'] = [agentStep],
  ) =>
    item(`obligation.due:obligation:${key}`, {
      kind: 'obligation.due',
      subject: { kind: 'obligation', id: key },
      period: key.split('|')[1]!,
      due: date,
      details: { kind: key.split('|')[0]!, status },
      next: steps,
    });
  const answer = {
    operation: 'questions.answer',
    by: 'human' as const,
    allowed: true,
    complete: false,
    inputHint: {},
  };

  test('the periods of one return in one state, moved on by the same steps, are one row', () => {
    const groups = arrangeWork(
      [
        due('D300|2026-01', 'overdue', '2026-02-25', [agentStep, answer]),
        due('D394|2026-01', 'overdue', '2026-03-02', [agentStep, answer]),
        due('D300|2026-02', 'overdue', '2026-03-25', [agentStep, answer]),
        due('D300|2026-10', 'due', '2026-11-25'),
        due('D300|2026-11', 'due', '2026-12-21'),
        due('D406|2026-Q1', 'overdue', '2026-04-30', [agentStep, answer]),
      ],
      new Map(),
    );
    const rows = groups.flatMap((group) => group.rows);
    expect(
      rows.map((row) =>
        row.kind === 'return'
          ? `${row.form} ${row.status} ${row.items.length}`
          : row.kind === 'item'
            ? row.item.id
            : row.key,
      ),
    ).toEqual([
      'D300 overdue 2',
      'obligation.due:obligation:D394|2026-01',
      'obligation.due:obligation:D406|2026-Q1',
      'D300 due 2',
    ]);
    expect(groups.map((group) => group.heading)).toEqual(['De făcut de tine', 'Așteaptă un agent']);
    // Its action opens the period due first in Declarații.
    expect(rowAction(rows[0]!)).toMatchObject({
      kind: 'link',
      label: 'Deschide',
      section: 'deadlines',
      filters: { return: 'D300|2026-01' },
    });
  });

  test('periods count by their length', () => {
    expect(periodCount(['2026-01', '2026-02'])).toBe('2 luni');
    expect(periodCount(['2026-01'])).toBe('1 lună');
    expect(periodCount(['2026-Q1', '2026-Q2', '2026-Q3'])).toBe('3 trimestre');
    expect(periodCount(Array.from({ length: 21 }, (_, index) => `${2000 + index}`))).toBe(
      '21 de ani',
    );
    expect(periodCount(['2026', '2026-01'])).toBe('2 perioade');
  });
});

describe('rows by who acts', () => {
  test('items that share a first cause collapse into one row, in the order they came', () => {
    const groups = arrangeWork(
      [
        obligation('D112|2026-01'),
        item('alone'),
        obligation('D112|2026-02'),
        obligation('D300|2026-01', [cause('fact:vat.status'), cause('fact:employer')]),
      ],
      new Map(),
    );
    expect(groups.map((group) => group.heading)).toEqual(['Așteaptă un agent', 'În așteptare']);
    const rows = groups[0]!.rows;
    expect(rows.map((row) => row.kind)).toEqual(['cause', 'item']);
    expect(rows[0]!.kind === 'cause' && rows[0]!.items.map((entry) => entry.id)).toEqual([
      'obligation.due:obligation:D112|2026-01',
      'obligation.due:obligation:D112|2026-02',
    ]);
    expect(groups[1]!.rows.map((row) => row.key)).toEqual(['alone']);
  });

  test('causes a person settles in the card wait on that person, as one row with its action', () => {
    const facts = new Map([
      ['fact:income_tax/2026', 'income_tax/2026'],
      ['question:micro.conditions|year:2026', 'income_tax/2026'],
    ]);
    const groups = arrangeWork(
      [
        obligation('D100|2026-03', [cause('question:micro.conditions|year:2026')]),
        item('need', { kind: 'closure.need', causes: [cause('fact:income_tax/2026')] }),
        obligation('S1005|2026', [cause('fact:size.category/2025')]),
      ],
      facts,
    );
    expect(groups.map((group) => group.who)).toEqual(['person', 'agent']);
    const [row] = groups[0]!.rows;
    expect(row!.kind).toBe('cause');
    expect(row!.kind === 'cause' && row!.items.length).toBe(2);
    expect(rowAction(row!)).toEqual({
      kind: 'fact',
      label: 'Completează',
      fact: 'income_tax/2026',
    });
  });

  test('a question and the proposal waiting on it are one row, titled by the question and answered from it', () => {
    const id = 'question:vehicle.use|vehicle:B123XFA';
    const answer = {
      operation: 'questions.answer',
      by: 'human' as const,
      allowed: true,
      complete: false,
      inputHint: { questionId: 'q1' },
    };
    const [group] = arrangeWork(
      [
        item('question.needed:proposal:p', {
          kind: 'question.needed',
          causes: [{ id, kind: 'question', message: 'Achiziția privește vehiculul: întrebați.' }],
          next: [answer],
        }),
        item('question.open:question:q1', {
          kind: 'question.open',
          subject: { kind: 'question', id: 'q1' },
          causes: [{ id, kind: 'question', message: 'Întrebarea privind utilizarea vehiculului.' }],
          next: [answer],
        }),
      ],
      new Map(),
    );
    const [row] = group!.rows;
    expect(row!.kind === 'cause' && row!.cause.message).toBe(
      'Întrebarea privind utilizarea vehiculului.',
    );
    expect(rowAction(row!)).toMatchObject({
      kind: 'link',
      label: 'Răspunde',
      filters: { question: 'q1' },
    });
  });

  test('a row acts by its next step: open the return, answer, approve, else check', () => {
    const only = (entry: WorkItem) => arrangeWork([entry], new Map())[0]!.rows[0]!;
    expect(rowAction(only(obligation('D300|2026-10', [])))).toMatchObject({
      kind: 'link',
      label: 'Deschide',
      section: 'deadlines',
      filters: { return: 'D300|2026-10' },
    });
    const answer = item('question', {
      kind: 'question.open',
      subject: { kind: 'question', id: 'q1' },
      next: [
        {
          operation: 'questions.answer',
          by: 'human',
          allowed: true,
          complete: false,
          inputHint: { questionId: 'q1' },
        },
      ],
    });
    expect(rowAction(only(answer))).toMatchObject({
      label: 'Răspunde',
      section: 'questions',
      filters: { question: 'q1' },
    });
    const approve = item('proposal', {
      kind: 'proposal.awaitingApproval',
      next: [
        {
          operation: 'proposals.approve',
          by: 'human',
          allowed: true,
          complete: true,
          inputHint: {},
        },
      ],
    });
    expect(rowAction(only(approve))).toEqual({ kind: 'expand', label: 'Aprobă' });
    expect(rowAction(only(item('other', { next: [agentStep] })))).toEqual({
      kind: 'expand',
      label: 'Verifică',
    });
  });

  test('items with a person step recording a company fact belong to the card', () => {
    const record = {
      operation: 'profile.record',
      by: 'human' as const,
      allowed: true,
      complete: false,
      inputHint: { axis: 'employer', effectiveFrom: '2026-01-01' },
    };
    expect(isFactItem(item('need', { next: [agentStep, record] }))).toBe(true);
    expect(isFactItem(obligation('D112|2026-01'))).toBe(false);
  });
});

describe('refusals', () => {
  const step = {
    operation: 'profile.record',
    by: 'human' as const,
    allowed: false,
    complete: false,
    inputHint: {},
  };
  test('each reason the engine gives reads as one line', () => {
    expect(refusal({ ...step, reason: { kind: 'role', permission: 'review' } })).toBe(
      'Rolul tău nu are dreptul de verificare.',
    );
    expect(refusal({ ...step, reason: { kind: 'state', message: 'Luna este închisă.' } })).toBe(
      'Luna este închisă.',
    );
    expect(refusal({ ...step, reason: { kind: 'data' }, needs: ['payroll', 'health'] })).toBe(
      'Lipsește accesul la: date salariale, date de sănătate.',
    );
    expect(refusal(step)).toBe('Lipsește permisiunea pentru „Înregistrează faptul despre firmă”.');
  });
});
