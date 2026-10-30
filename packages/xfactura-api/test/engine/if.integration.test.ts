import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { ActionView } from '../../source/engine/kernel/actions';
import type { ProposalView } from '../../source/engine/kernel/views';
import {
  AnafKits,
  DukIntegrator,
  type DeclarationValidator,
} from '../../source/engine/adapters/declaration-validator';
import { iban } from './fixtures/bank';
import { invoiceXml, type XmlInput } from './fixtures/invoice';
import { scenario, type Scenario } from './scenario';

const open: Scenario[] = [];
afterAll(async () => {
  await Promise.all(open.map((s) => s.dispose()));
});

// Synthetic CNPs (valid control digits, nobody's).
const cnps = { ion: '1750312170031', maria: '2800911170044' };

type Register = {
  final: boolean;
  sources: { totals: { gross: string; deductible: string; net: string; loss: string } }[];
  enterprise: {
    version: number;
    members: {
      partyId: string;
      name: string;
      quota: string;
      representative: boolean;
      net: string | null;
      loss: string | null;
    }[];
  } | null;
  contributions: unknown;
  tax: unknown;
  issues: { code: string; severity: string }[];
};

/**
 * A family enterprise of two members in the real system, VAT payer, keeping single-entry books
 * from 1 January of a year (2025 unless given): Popescu Ion, the representative, with 60%, and
 * Popescu Maria with 40%. Its year, every amount by hand: SALE-1 50,000 + 19% collected, INV-1
 * 4,000 + 19% paid, a 12.00 fee: net income 50,000 − 4,012 = 45,988 lei.
 */
async function enterprise(
  options: {
    year?: number;
    agreement?: boolean;
    method?: 'sistem_real' | 'norma';
    declarationValidator?: DeclarationValidator;
  } = {},
) {
  const y = options.year ?? 2025;
  // The enterprise's CIF has a valid control digit: the D204 carries it.
  const s = await scenario({
    year: y,
    cui: '12345674',
    ...(options.declarationValidator ? { declarationValidator: options.declarationValidator } : {}),
  });
  open.push(s);
  const { id: certificate } = await s.evidence('certificat-inregistrare.pdf');
  const fact = (axis: string, value: string) =>
    s.invoke(s.owner, 'profile.record', {
      axis,
      value,
      effectiveFrom: `${y}-01-01`,
      evidenceId: certificate,
    });
  await fact('entity.form', 'if');
  await fact('books.system', 'single');
  await fact('vat.status', 'normal_vat');
  const source = await s.invoke<{ sourceId: string }>(s.owner, 'pfa.sources.record', {
    effectiveFrom: `${y}-01-01`,
    name: 'Fabricarea produselor de brutărie',
    caen: '1071',
    place: 'Str. Morii nr. 3, Galați',
    county: 'GL',
    authorization: { number: `F17/123/${y}`, date: `${y - 1}-12-15` },
    startedOn: `${y}-01-01`,
    liberal: false,
    ...(options.method === 'norma'
      ? { method: 'norma' }
      : { method: 'sistem_real', realBasis: 'required' }),
    evidenceId: certificate,
  });
  const person = async (name: string, cnp?: string) => {
    const party = await s.invoke<{ id: string }>(s.owner, 'parties.create', {
      kind: 'ro_individual',
      country: 'RO',
      name,
    });
    if (cnp) await s.invoke(s.owner, 'parties.recordCnp', { partyId: party.id, cnp });
    return party;
  };
  const ion = await person('Popescu Ion', cnps.ion);
  const maria = await person('Popescu Maria', cnps.maria);
  const { id: agreement } = await s.evidence('acord-constituire.pdf');
  if (options.agreement !== false)
    await s.invoke(s.owner, 'if.members.record', {
      effectiveFrom: `${y}-01-01`,
      members: [
        { partyId: ion.id, quota: '60', representative: true },
        { partyId: maria.id, quota: '40', representative: false },
      ],
      evidenceId: agreement,
    });
  return { s, y, certificate, source, ion, maria, agreement, person };
}

/** The enterprise's year of invoices, bank receipts and payments. */
async function books(context: Awaited<ReturnType<typeof enterprise>>) {
  const { s, y, ion } = context;
  const document = async (input: XmlInput) => {
    const { id } = await s.invoke<{ id: string }>(s.owner, 'evidence.record', {
      filename: `${input.number}.xml`,
      mediaType: 'application/xml',
      base64: Buffer.from(invoiceXml({ ...input, company: '12345674' })).toString('base64'),
    });
    return s.invoke<{ id: string; partyId: string }>(s.owner, 'invoices.import', {
      evidenceId: id,
    });
  };
  const yy = String(y).slice(2);
  const statement = `:20:IF03${yy}
:25:${iban}
:28C:001/001
:60F:C${yy}0301RON0,00
:61:${yy}03030303C1000,00NTRFAPORT//IF-IN-01
:86:Aport reprezentant
:61:${yy}03200320C59500,00NTRFSALE-1//IF-IN-02
:86:Incasare SALE-1
:61:${yy}03250325D4760,00NTRFINV-1//IF-PAY-01
:86:Plata INV-1
:61:${yy}03310331D12,00NCHGNONREF//IF-FEE-01
:86:Comision bancar
:62F:C${yy}0331RON55728,00`;
  const item = (proposal: ProposalView) => proposal.effect!.openItems[0]!.id;
  const sale = await document({
    number: 'SALE-1',
    direction: 'sale',
    date: `${y}-03-10`,
    rate: '19',
    net: '50000.00',
    tax: '9500.00',
    gross: '59500.00',
  });
  const services = await document({
    number: 'INV-1',
    date: `${y}-03-12`,
    rate: '19',
    net: '4000.00',
    tax: '760.00',
    gross: '4760.00',
  });
  const receivable = item(
    await s.book('invoices.recognize', { documentId: sale.id, account: '704' }),
  );
  const payable = item(
    await s.book('invoices.recognize', { documentId: services.id, account: '628' }),
  );
  await s.invoke(s.owner, 'treasury.createAccount', {
    kind: 'bank',
    name: 'Cont curent',
    iban,
    currency: 'RON',
    ledgerAccount: '5121',
    openedOn: `${y}-01-01`,
  });
  const { id: extract } = await s.invoke<{ id: string }>(s.owner, 'evidence.record', {
    filename: `extras-${y}.sta`,
    mediaType: 'text/plain',
    base64: Buffer.from(statement).toString('base64'),
  });
  await s.invoke(s.owner, 'bank.import', { evidenceId: extract, financialYearId: s.year.id });
  const movements = await s.invoke<{ id: string; amount: string }[]>(s.owner, 'bank.movements', {});
  const movement = (amount: string) =>
    movements.find((entry) => entry.amount.replace('-', '') === amount)!.id;
  await s.book('bank.settle', {
    movementId: movement('1000.00'),
    opens: [{ account: '4551', partyId: ion.id, amount: '1000.00' }],
  });
  await s.book('bank.settle', {
    movementId: movement('59500.00'),
    allocations: [{ openItem: receivable, amount: '59500.00' }],
  });
  await s.book('bank.settle', {
    movementId: movement('4760.00'),
    allocations: [{ openItem: payable, amount: '4760.00' }],
  });
  await s.book('bank.settle', {
    movementId: movement('12.00'),
    lines: [{ account: '627', amount: '12.00' }],
  });
}

describe('family enterprise members', () => {
  test('an agreement is recorded whole: two members or more, 100%, one representative, CNPs sealed', async () => {
    const { s, ion, maria, agreement, person } = await enterprise({ agreement: false });
    const record = (members: unknown[], effectiveFrom = '2025-01-01') =>
      s.refused(
        s.invoke(s.owner, 'if.members.record', { effectiveFrom, members, evidenceId: agreement }),
      );
    const member = (partyId: string, quota: string, representative = false) => ({
      partyId,
      quota,
      representative,
    });
    expect((await record([member(ion.id, '60', true), member(maria.id, '30')]))?.code).toBe(
      'ENTERPRISE_MEMBER_QUOTA',
    );
    expect((await record([member(ion.id, '60'), member(maria.id, '40')]))?.code).toBe(
      'ENTERPRISE_MEMBER_REPRESENTATIVE',
    );
    expect((await record([member(ion.id, '60', true), member(maria.id, '40', true)]))?.code).toBe(
      'ENTERPRISE_MEMBER_REPRESENTATIVE',
    );
    expect((await record([member(ion.id, '50', true), member(ion.id, '50')]))?.code).toBe(
      'ENTERPRISE_MEMBER_DUPLICATE',
    );
    // A member whose CNP is not recorded.
    const ana = await person('Popescu Ana');
    expect((await record([member(ion.id, '60', true), member(ana.id, '40')]))?.code).toBe(
      'ENTERPRISE_MEMBER_CNP',
    );
    // One member is not a family enterprise (art. 28 alin. (1)).
    expect((await record([member(ion.id, '100', true)]))?.code).toBe('VALIDATION');
    // Before the enterprise's form.
    expect(
      (await record([member(ion.id, '60', true), member(maria.id, '40')], '2024-12-31'))?.code,
    ).toBe('ENTERPRISE_MEMBER_FORM');

    // Two decimals: 33.33 + 66.67.
    expect(
      await s.invoke(s.owner, 'if.members.record', {
        effectiveFrom: '2025-01-01',
        members: [member(ion.id, '66.67', true), member(maria.id, '33.33')],
        evidenceId: agreement,
      }),
    ).toEqual({ version: 1 });
    // An addendum applies after the agreement it follows.
    expect(
      (await record([member(ion.id, '60', true), member(maria.id, '40')], '2025-01-01'))?.code,
    ).toBe('ENTERPRISE_MEMBER_DATE');
    await s.invoke(s.owner, 'if.members.record', {
      effectiveFrom: '2025-07-01',
      members: [member(ion.id, '60', true), member(maria.id, '40')],
      evidenceId: agreement,
    });
    const list = await s.invoke<
      { version: number; effectiveFrom: string; members: { name: string; quota: string }[] }[]
    >(s.owner, 'if.members.list');
    expect(
      list.map((item) => [
        item.version,
        item.effectiveFrom,
        item.members.map((row) => `${row.name} ${row.quota}`),
      ]),
    ).toEqual([
      [1, '2025-01-01', ['Popescu Ion 66.67', 'Popescu Maria 33.33']],
      [2, '2025-07-01', ['Popescu Ion 60.00', 'Popescu Maria 40.00']],
    ]);
    // No CNP is read back.
    expect(JSON.stringify(list)).not.toContain(cnps.ion);
    // A viewer reads; only a reviewer records.
    expect(
      (
        await s.refused(
          s.invoke(s.viewer, 'if.members.record', {
            effectiveFrom: '2025-09-01',
            members: [member(ion.id, '60', true), member(maria.id, '40')],
            evidenceId: agreement,
          }),
        )
      )?.code,
    ).toBe('FORBIDDEN');

    // A company that is not a family enterprise has no members.
    const pfa = await scenario({ year: 2025 });
    open.push(pfa);
    const { id: evidenceId } = await pfa.evidence('certificat.pdf');
    await pfa.invoke(pfa.owner, 'profile.record', {
      axis: 'entity.form',
      value: 'pfa',
      effectiveFrom: '2025-01-01',
      evidenceId,
    });
    expect(
      (
        await pfa.refused(
          pfa.invoke(pfa.owner, 'if.members.record', {
            effectiveFrom: '2025-01-01',
            members: [member(ion.id, '60', true), member(maria.id, '40')],
            evidenceId,
          }),
        )
      )?.code,
    ).toBe('ENTERPRISE_MEMBER_FORM');
  });

  test('the fiscal register distributes the net income by quota; contributions are the members’', async () => {
    const context = await enterprise();
    await books(context);
    const { s, ion, maria, agreement } = context;
    const register = await s.invoke<Register>(s.owner, 'pfa.fiscalRegister', { year: 2025 });
    expect(register.final).toBe(true);
    expect(register.sources[0]!.totals).toEqual({
      gross: '50000.00',
      deductible: '4012.00',
      net: '45988.00',
      loss: '0.00',
    });
    // 45,988 × 60% = 27,592.80 and × 40% = 18,395.20: the leftover leu to the larger remainder.
    expect(
      register.enterprise!.members.map((member) => [member.name, member.quota, member.net]),
    ).toEqual([
      ['Popescu Ion', '60.00', '27593.00'],
      ['Popescu Maria', '40.00', '18395.00'],
    ]);
    expect(register.contributions).toBeNull();
    expect(register.tax).toBeNull();

    // An addendum in the course of the year: the distribution by periods is not available.
    await s.invoke(s.owner, 'if.members.record', {
      effectiveFrom: '2025-07-01',
      members: [
        { partyId: ion.id, quota: '50', representative: true },
        { partyId: maria.id, quota: '50', representative: false },
      ],
      evidenceId: agreement,
    });
    const changed = await s.invoke<Register>(s.owner, 'pfa.fiscalRegister', { year: 2025 });
    expect(changed.final).toBe(false);
    expect(changed.issues.map((issue) => issue.code)).toContain('PIT_IF_MEMBERS_CHANGE');
    expect(changed.enterprise).toBeNull();
  });

  test('without members the register is not final', async () => {
    const context = await enterprise({ agreement: false });
    await books(context);
    const register = await context.s.invoke<Register>(context.s.owner, 'pfa.fiscalRegister', {
      year: 2025,
    });
    expect(register.final).toBe(false);
    expect(register.issues.map((issue) => issue.code)).toContain('PIT_IF_MEMBERS');
  });

  test('the obligations calendar lists D204 with both deadlines the texts give, and D212', async () => {
    const { s } = await enterprise();
    const calendar = await s.invoke<
      {
        kind: string;
        period: string;
        due: string | null;
        conflict: { due: string; clauses: string[] }[] | null;
      }[]
    >(s.owner, 'obligations.calendar', { from: '2025-12', to: '2025-12', today: '2025-12-31' });
    expect(calendar.find((item) => item.kind === 'D204')).toMatchObject({
      period: '2025',
      // 28 February 2026 is a Saturday; 15 March 2026 a Sunday.
      due: '2026-03-02',
      conflict: [
        {
          due: '2026-03-02',
          clauses: ['ANAF/Cod-fiscal-consolidat:art.125(4)', 'OPANAF470/2021:anexa2.pct.3.1'],
        },
        { due: '2026-03-16', clauses: ['ANAF/Cod-fiscal-consolidat:norme.art.125.pct.41(4)'] },
      ],
    });
    expect(calendar.find((item) => item.kind === 'D212')).toMatchObject({
      period: '2025',
      due: '2026-05-25',
      conflict: null,
    });
  });
});

describe('D204 and the members’ D212 from the books', () => {
  // ANAF's D204 validator (J3.0.14) loads in the general kit; without it or Java the official
  // test is skipped, never passed.
  const generalDist = path.join(import.meta.dir, '../../../..', '.validators/anaf/dist');
  const official =
    existsSync(path.join(generalDist, 'lib/D204Validator.jar')) && Bun.which('java')
      ? test
      : test.skip;
  const kits = () => new AnafKits({ general: new DukIntegrator(generalDist) });
  /** A validator that must not be called. */
  const unused: DeclarationValidator = {
    id: 'unused',
    validate: () => Promise.reject(new Error('validated')),
    pdf: () => Promise.reject(new Error('validated')),
  };
  type Artifact = {
    id: string;
    format: string;
    state: string;
    xmlHash: string;
    steps: { state: string; actor: string | null; detail: string | null }[];
  };
  const prepare = (s: Scenario, kind: string, options: Record<string, unknown>) =>
    s.invoke<Artifact>(s.owner, 'declarations.prepare', { kind, period: '2025', options });
  const xmlOf = async (s: Scenario, artifact: Artifact) =>
    new TextDecoder().decode(await s.objects.get(s.company.id, artifact.xmlHash));
  const values = (xml: string, name: string) =>
    [...xml.matchAll(new RegExp(`<${name}\\s([^>]*?)/?>`, 'g'))].map((match) =>
      Object.fromEntries(
        [...match[1]!.matchAll(/([\w:-]+)="([^"]*)"/g)].map((item) => [item[1], item[2]]),
      ),
    );
  const d204 = {
    address: 'Str. Morii nr. 3, Galați, jud. Galați',
    locality: 'Galați',
    representative: { address: 'Str. Morii nr. 3, Galați, jud. Galați', phone: '0236000000' },
    contract: { number: '1234/2025', date: '2025-01-20' },
  };
  const d212 = (partyId: string, lastName: string, firstName: string) => ({
    holderPartyId: partyId,
    taxpayer: { lastName, firstName, address: 'Str. Morii nr. 3, Galați, jud. Galați' },
    member: { casStatus: 'liable', cassException: 'none' },
    association: { number: '1234/2025', date: '2025-01-20' },
  });

  official(
    'D204 from the fiscal register to ANAF’s validator; the members’ D212 add up to it',
    async () => {
      const context = await enterprise({ declarationValidator: kits() });
      await books(context);
      const { s, ion, maria } = context;
      const prepared = await prepare(s, 'D204', d204);
      expect(prepared.format).toBe(
        'D204 mfp:anaf:dgti:d204:declaratie:v3 an 2025 (D204 declaratie:v3, structura 15.01.2026)',
      );
      expect(prepared.steps.map((step) => [step.state, step.actor])).toEqual([
        ['prepared', null],
        ['validated_official', 'DUKIntegrator 1.4.17.3.3'],
      ]);
      const xml = await xmlOf(s, prepared);
      expect(values(xml, 'd204')[0]).toMatchObject({
        an: '2025',
        cif: '12345674',
        den_r: 'Popescu Ion',
        cif_r: cnps.ion,
        totalPlata_A: '0',
      });
      expect(values(xml, 'activitate')[0]).toMatchObject({
        nr_asoc: '2',
        CAEN: '1071',
        judet: '17',
        nr_contr: '1234/2025',
        venit3: '50000',
        chelt3: '4012',
        net3: '45988',
        pierd3: '0',
      });
      expect(values(xml, 'asociat').map((row) => [row.cif_d, row.cota_d, row.venit_d])).toEqual([
        [cnps.ion, '60', '27593'],
        [cnps.maria, '40', '18395'],
      ]);
      // The CNPs are in the XML only.
      expect(JSON.stringify(prepared.steps)).not.toContain(cnps.ion);

      // Each member's D212 for 2025 (the web form's structure, never validated by ANAF's Java
      // validator): the net income distributed, their own CAS and CASS.
      // Popescu Ion: 27,593 lei; under 12 minimum wages, no CAS; CASS 2,759; tax 2,483.
      const first = await prepare(s, 'D212', d212(ion.id, 'Popescu', 'Ion'));
      expect(first.state).toBe('prepared');
      const firstXml = await xmlOf(s, first);
      expect(values(firstXml, 'cap11')[0]).toMatchObject({
        forma_org: '2',
        nr_doc_asociere: '1234/2025',
        data_doc_asociere: '20.01.2025',
        venit_net_anual: '27593',
        venit_recalculat: '27593',
      });
      expect(firstXml).not.toContain('venit_brut');
      expect(values(firstXml, 'oblig_realizat')[0]).toMatchObject({
        cass_datorat_ai: '2759',
        real_venit_net_impozabil_ai: '24834',
        real_impozit_datorat_ai: '2483',
        dif_de_plata: '5242',
      });
      // Popescu Maria: 18,395 lei, under 6 minimum wages: CASS on 24,300 lei (2,430), the CASS
      // on her own income (1,839 lei, 50 bani dropped) deducted; tax 1,656.
      const second = await prepare(s, 'D212', d212(maria.id, 'Popescu', 'Maria'));
      const secondXml = await xmlOf(s, second);
      expect(values(secondXml, 'cap11')[0]).toMatchObject({ venit_net_anual: '18395' });
      expect(values(secondXml, 'oblig_realizat')[0]).toMatchObject({
        baza_cass_datorat_ai: '24300',
        cass_datorat_ai: '2430',
        real_impozit_datorat_ai: '1656',
      });
      const detail = (artifact: Artifact) =>
        JSON.parse(artifact.steps[0]!.detail!) as { net: string; member: { quota: string } };
      // The members' D212 add up to the D204's distribution.
      expect(Number(detail(first).net) + Number(detail(second).net)).toBe(45_988);
      expect([detail(first).member.quota, detail(second).member.quota]).toEqual(['60.00', '40.00']);

      // A later entry in the year makes the D204 stale.
      await s.book('ledger.general', {
        date: '2025-12-30',
        purpose: 'general',
        reference: 'NC-IF-1',
        description: 'Comision bancar',
        evidenceId: (await s.evidence('nota-comision.pdf')).id,
        lines: [
          { account: '627', side: 'D', amount: '5.00' },
          { account: '5121', side: 'C', amount: '5.00' },
        ],
      });
      const request = await s.invoke<ActionView>(s.owner, 'declarations.authorize.request', {
        artifactId: prepared.id,
      });
      expect(
        (request.preview as { findings: { code: string }[] }).findings.map((item) => item.code),
      ).toEqual(['STALE']);
    },
    180_000,
  );

  test('what is refused: a member’s D212 without their situation or contract, a non-member', async () => {
    const context = await enterprise({ declarationValidator: unused });
    await books(context);
    const { s, ion, person } = context;
    const refused = (kind: string, options: Record<string, unknown>) =>
      s.refused(prepare(s, kind, options)).then((error) => error?.code);
    const { member: _, ...withoutStatus } = d212(ion.id, 'Popescu', 'Ion');
    expect(await refused('D212', withoutStatus)).toBe('D212_MEMBER');
    const { association: __, ...withoutContract } = d212(ion.id, 'Popescu', 'Ion');
    expect(await refused('D212', withoutContract)).toBe('D212_ASSOCIATION');
    const stranger = await person('Ionescu Dan', '1990101170056');
    expect(await refused('D212', d212(stranger.id, 'Ionescu', 'Dan'))).toBe('PIT_IF_MEMBER');
    // A PFA files no D204.
    const pfa = await scenario({ year: 2025 });
    open.push(pfa);
    const { id: evidenceId } = await pfa.evidence('certificat.pdf');
    await pfa.invoke(pfa.owner, 'profile.record', {
      axis: 'entity.form',
      value: 'pfa',
      effectiveFrom: '2025-01-01',
      evidenceId,
    });
    expect((await pfa.refused(prepare(pfa, 'D204', d204)))?.code).toBe('D204_FORM');
  });

  test('an enterprise on a norm files no D204: nothing is distributed', async () => {
    const { s } = await enterprise({ year: 2026, method: 'norma', declarationValidator: unused });
    const register = await s.invoke<Register>(s.owner, 'pfa.fiscalRegister', { year: 2026 });
    expect(register.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(['PIT_NORM_MISSING', 'PIT_IF_NORMA']),
    );
    expect(register.enterprise!.members.map((member) => member.net)).toEqual([null, null]);
    expect(
      (
        await s.refused(
          s.invoke(s.owner, 'declarations.prepare', {
            kind: 'D204',
            period: '2026',
            options: { ...d204, contract: { number: '1234/2026', date: '2026-01-20' } },
          }),
        )
      )?.code,
    ).toBe('D204_NORMA');
  });
});
