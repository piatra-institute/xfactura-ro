import type { Scenario } from '../scenario';

type Question = {
  id: string;
  kind: string;
  subject: { kind: string; id: string };
  params: {
    chapter?: string;
    rows?: { row: string; label: string; columns: number[] }[];
    document?: string;
  };
};
type Asked = { asked: { kind: string; questionId: string; answered: boolean }[] };

/** The open questions of the annual statements, as `annual.ask` opens them. */
export async function annualQuestions(s: Scenario, kind: 'S1005' | 'S1003', year: number) {
  const asked = await s.invoke<Asked>(s.owner, 'annual.ask', { kind, year });
  const open = await s.list<Question>(s.owner, 'questions.list', { status: 'open', limit: 200 });
  const ids = new Set(asked.asked.filter((item) => !item.answered).map((item) => item.questionId));
  return open.filter((question) => ids.has(question.id));
}

/**
 * Answers what a statement's package asks a person, as an owner would with the company's
 * documents: every F30 chapter the books do not hold has nothing to report, except chapter XII,
 * whose capital (`capital` lei) is all held by individuals; the disclosures state none and that
 * the company continues. Returns the questions answered, by kind.
 */
export async function answerAnnual(
  s: Scenario,
  kind: 'S1005' | 'S1003',
  year: number,
  capital: number,
) {
  const individuals = kind === 'S1005' ? '147' : '151';
  const register = (await s.evidence('registrul-asociatilor.pdf')).id;
  const answered: string[] = [];
  for (const question of await annualQuestions(s, kind, year)) {
    let value: unknown;
    if (question.kind === 'annual.informative') {
      const rows = question.params.rows ?? [];
      const held = rows.find((row) => row.row === individuals);
      value = held
        ? {
            rows: Object.fromEntries(
              rows.map((row) => [
                row.row,
                [1, 2, 3, 4].map((column) =>
                  !row.columns.includes(column)
                    ? null
                    : row.row !== individuals
                      ? 0
                      : column % 2
                        ? capital
                        : 100,
                ),
              ]),
            ),
            evidenceIds: [register],
          }
        : { none: true, evidenceIds: [] };
    } else if (question.kind === 'annual.disclosures')
      value = {
        parent: null,
        commitments: null,
        managementAdvances: null,
        exceptional: null,
        longTermDebts: null,
        subsequentEvents: null,
        relatedParties: null,
        goingConcern: { continues: true, uncertainty: null },
        evidenceIds: [],
      };
    else continue;
    await s.invoke(s.owner, 'questions.answer', { questionId: question.id, value });
    answered.push(`${question.kind} ${question.subject.id}`);
  }
  return answered;
}

/** Supplies every accompanying document a prepared statement owes, signed. */
export async function supplyDocuments(s: Scenario, kind: 'S1005' | 'S1003', year: number) {
  const supplied: string[] = [];
  for (const question of await annualQuestions(s, kind, year)) {
    if (question.kind !== 'annual.document') continue;
    const evidenceId = (await s.evidence(`${question.params.document}-semnat.pdf`)).id;
    await s.invoke(s.owner, 'questions.answer', { questionId: question.id, value: { evidenceId } });
    supplied.push(question.params.document!);
  }
  return supplied;
}
