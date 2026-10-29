import { afterAll, describe, expect, test } from 'bun:test';
import path from 'node:path';
import { DukIntegrator } from '../../source/engine/adapters/declaration-validator';
import type { ProposalView } from '../../source/engine/kernel/views';
import { journal, scenario, type Scenario } from './scenario';

const open: Scenario[] = [];
afterAll(async () => {
  await Promise.all(open.map((s) => s.dispose()));
});

const dist = path.join(import.meta.dir, '../../../..', '.validators/anaf/dist');
const official = DukIntegrator.available(dist) && Bun.which('java') ? test : test.skip;

/** A company with 100,000 lei of retained profit, an individual and a company as shareholders. */
async function company(validator?: DukIntegrator) {
  const s = await scenario({
    cui: '18547290',
    ...(validator ? { declarationValidator: validator } : {}),
  });
  open.push(s);
  const { id: opening } = await s.evidence('balanta-deschidere.pdf');
  await s.book(
    'ledger.general',
    journal(
      opening,
      [
        { account: '5121', side: 'D', amount: '100000.00' },
        { account: '1171', side: 'C', amount: '100000.00' },
      ],
      { date: '2026-01-01', purpose: 'opening' },
    ),
  );
  const party = (kind: string, name: string, taxId?: string) =>
    s.invoke<{ id: string }>(s.owner, 'parties.create', {
      kind,
      country: 'RO',
      name,
      ...(taxId ? { taxId } : {}),
    });
  const anaf = await s.invoke<{ id: string }>(s.owner, 'parties.create', {
    kind: 'ro_public_institution',
    country: 'RO',
    name: 'ANAF',
  });
  const person = await party('ro_individual', 'Popescu Ana');
  const holding = await party('ro_legal_entity', 'Holding Exemplu SRL', '14399840');
  const decision = async () => (await s.evidence('hotarare-aga.pdf')).id;
  return { s, anaf, person, holding, decision };
}

const lines = (proposal: ProposalView) =>
  proposal.effect?.lines.map((line) => `${line.side} ${line.account} ${line.amount}`);

describe('dividends', () => {
  test('distributed from retained profit, then taxed at 16% when paid', async () => {
    const { s, anaf, person, holding, decision } = await company();
    const distributed = await s.propose('dividends.distribute', {
      date: '2026-05-20',
      evidenceId: await decision(),
      shareholders: [
        { partyId: person.id, amount: '30000.00' },
        { partyId: holding.id, amount: '10000.00' },
      ],
    });
    expect(lines(distributed)).toEqual(['D 1171 40000.00', 'C 457 30000.00', 'C 457 10000.00']);
    const posted = await s.post(await s.approve(distributed));
    const [personal, corporate] = posted.effect!.openItems;

    const withhold = (openItem: string, gross: string) =>
      s.propose('dividends.withhold', {
        distributionEntryId: posted.entry!.id,
        openItem,
        date: '2026-06-10',
        gross,
        authorityId: anaf.id,
      });
    const individual = await withhold(personal!.id, '30000.00');
    expect(lines(individual)).toEqual(['D 457 4800.00', 'C 446 4800.00']);
    await s.post(await s.approve(individual));

    // A company shareholder: the reviewer confirms the art. 43 alin. (4) exemption does not apply.
    const toCompany = await withhold(corporate!.id, '10000.00');
    expect(toCompany.issues.map((issue) => issue.code)).toEqual(['DIVIDEND_EXEMPTION']);
    await s.post(await s.approve(toCompany, s.reviewer, ['DIVIDEND_EXEMPTION']));
    expect((await s.trialBalance()).rows.find((row) => row.account === '446')?.closing).toEqual({
      debit: '0.00',
      credit: '6400.00',
    });
    expect((await s.trialBalance()).rows.find((row) => row.account === '457')?.closing).toEqual({
      debit: '0.00',
      credit: '33600.00',
    });
  });

  test('refuses distributing more than the retained profit, or paying more than is owed', async () => {
    const { s, anaf, person, decision } = await company();
    const tooMuch = await s.propose('dividends.distribute', {
      date: '2026-05-20',
      evidenceId: await decision(),
      shareholders: [{ partyId: person.id, amount: '100000.01' }],
    });
    expect(tooMuch.issues.map((issue) => issue.code)).toEqual(['DISTRIBUTABLE']);
    const posted = await s.post(
      await s.approve(
        await s.propose('dividends.distribute', {
          date: '2026-05-20',
          evidenceId: await decision(),
          shareholders: [{ partyId: person.id, amount: '1000.00' }],
        }),
      ),
    );
    const over = await s.propose('dividends.withhold', {
      distributionEntryId: posted.entry!.id,
      openItem: posted.effect!.openItems[0]!.id,
      date: '2026-05-10',
      gross: '1000.01',
      authorityId: anaf.id,
    });
    expect(over.issues.map((issue) => issue.code)).toEqual(['DATE', 'AMOUNT']);
  });
});

describe('D205 from the books', () => {
  /** A synthetic CNP with a valid control digit. */
  const cnp = (body: string) => {
    const weights = [2, 7, 9, 1, 4, 6, 3, 5, 8, 2, 7, 9];
    const control =
      weights.reduce((sum, weight, index) => sum + weight * Number(body[index]), 0) % 11;
    return `${body}${control === 10 ? 1 : control}`;
  };

  official(
    "the D100 of the month paid and the D205 of the year pass ANAF's validator; companies are left out of D205",
    async () => {
      const { s, anaf, person, holding, decision } = await company(new DukIntegrator(dist));
      await s.invoke(s.owner, 'sales.seller.record', {
        details: {
          name: 'Exemplu Servicii SRL',
          vatId: 'RO18547290',
          address: {
            lines: ['Str. Lungă 10'],
            city: 'Galați',
            subdivision: 'RO-GL',
            country: 'RO',
          },
        },
      });
      const posted = await s.post(
        await s.approve(
          await s.propose('dividends.distribute', {
            date: '2026-05-20',
            evidenceId: await decision(),
            shareholders: [
              { partyId: person.id, amount: '30000.00' },
              { partyId: holding.id, amount: '10000.00' },
            ],
          }),
        ),
      );
      const [personal, corporate] = posted.effect!.openItems;
      for (const [item, gross, ack] of [
        [personal!.id, '30000.00', []],
        [corporate!.id, '10000.00', ['DIVIDEND_EXEMPTION']],
      ] as const)
        await s.post(
          await s.approve(
            await s.propose('dividends.withhold', {
              distributionEntryId: posted.entry!.id,
              openItem: item,
              date: '2026-06-10',
              gross,
              authorityId: anaf.id,
            }),
            s.reviewer,
            [...ack],
          ),
        );
      // June's D100: the tax withheld from the individual (604) and from the company (150).
      const june = await s.invoke<{ state: string; steps: { detail: string | null }[] }>(
        s.owner,
        'declarations.prepare',
        {
          kind: 'D100',
          period: '2026-06',
          options: { declarant: { lastName: 'Popescu', firstName: 'Ana', role: 'Administrator' } },
        },
      );
      expect(JSON.parse(june.steps[0]!.detail!).obligations).toEqual(['dividends', 'dividends']);
      expect(june.state).toBe('validated_official');
      const options = {
        declarant: { lastName: 'Popescu', firstName: 'Ana', role: 'Administrator' },
        paidAs: 'gross',
      };
      const prepare = () =>
        s.invoke<{ state: string; steps: { detail: string | null }[] }>(
          s.owner,
          'declarations.prepare',
          { kind: 'D205', period: '2026', options },
        );
      expect(JSON.stringify(await s.refused(prepare()))).toContain('D205_CNP');
      await s.invoke(s.owner, 'parties.recordCnp', {
        partyId: person.id,
        cnp: cnp('285072217002'),
      });
      const prepared = await prepare();
      expect(JSON.parse(prepared.steps[0]!.detail!)).toEqual({
        year: '2026',
        individuals: 1,
        companies: 1,
      });
      expect([prepared.state, prepared.steps.at(-1)?.detail ?? null]).toEqual([
        'validated_official',
        null,
      ]);
    },
    120_000,
  );
});
