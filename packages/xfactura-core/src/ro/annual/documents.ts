import { sha256Hex } from '../../hash';
import type { Cells } from './form';
import type { AnnualDocumentKind, DisclosuresAnswer } from './questions';

/**
 * The documents that accompany a company's annual statements, and the engine's drafts of those
 * whose content the texts prescribe:
 * - the explanatory notes (OMF nr. 2.036/2025 anexa nr. 1 pct. 2.2: required of small entities;
 *   microentities present the information of OMFP nr. 1.802/2014 pct. 576 alin. (2): the
 *   accounting policies, commitments and guarantees, advances to management), drafted from the
 *   books, the accounting-policy facts and the person's disclosures;
 * - the administrators' report (Legea contabilității nr. 82/1991 art. 28 alin. (7), art. 29
 *   alin. (1); OMFP nr. 1.802/2014 pct. 489–492): its figures are drafted from the statements,
 *   its judgments (risks, the foreseeable development) are the administrator's to write;
 * - the proposal to distribute the profit or cover the loss (art. 29 alin. (1)): the result and
 *   the legal reserve set aside are drafted, the destination of the rest is the shareholders';
 * - the declaration of art. 30 (OMF nr. 2.036/2025 pct. 3.5 alin. (3)): its content is the law's,
 *   drafted in full, with the going-concern statement as the person gave it;
 * - the audit or censors' report, when the statements are audited or verified (art. 29): the
 *   auditor's or the censors' own, never drafted.
 * Each is owed until a person supplies the signed file (`annual.document`); a draft is text for
 * that person, never a filed document.
 */

export type AnnualStatementKind = 'S1005' | 'S1003';

export type OwedDocument = {
  document: AnnualDocumentKind;
  title: string;
  clauses: string[];
  /** Whether the engine drafts it. */
  drafted: boolean;
};

const titles: Record<AnnualDocumentKind, string> = {
  notes: 'Note explicative la situațiile financiare anuale',
  'administrators.report': 'Raportul administratorilor',
  'profit.distribution': 'Propunerea de distribuire a profitului sau de acoperire a pierderii',
  declaration: 'Declarația prevăzută la art. 30 din Legea contabilității nr. 82/1991',
  'audit.report': 'Raportul de audit',
  'censors.report': 'Raportul comisiei de cenzori',
};

/** The documents owed with a company's statements. */
export function owedDocuments(
  statement: AnnualStatementKind,
  audit: { kind: 'statutory' | 'voluntary' | 'censors' } | undefined,
): OwedDocument[] {
  const owed: OwedDocument[] = [
    {
      document: 'notes',
      title: titles.notes,
      clauses:
        statement === 'S1003'
          ? ['OMF2036/2025:anexa1.pct.2.2', 'OMFP1802/2014:pct.468-469']
          : ['OMF2036/2025:anexa1.pct.2.1-2.3'],
      drafted: true,
    },
    {
      document: 'administrators.report',
      title: titles['administrators.report'],
      clauses: ['L82/1991:art.28(7),29(1)', 'OMFP1802/2014:pct.489-492'],
      drafted: true,
    },
    {
      document: 'profit.distribution',
      title: titles['profit.distribution'],
      clauses: ['L82/1991:art.28(7),29(1)', 'OMF2036/2025:anexa1.pct.3.5'],
      drafted: true,
    },
    {
      document: 'declaration',
      title: titles.declaration,
      clauses: ['L82/1991:art.30', 'OMF2036/2025:anexa1.pct.3.5'],
      drafted: true,
    },
  ];
  if (audit && audit.kind !== 'censors')
    owed.push({
      document: 'audit.report',
      title: titles['audit.report'],
      clauses: ['L82/1991:art.28(7),29(1)'],
      drafted: false,
    });
  if (audit?.kind === 'censors')
    owed.push({
      document: 'censors.report',
      title: titles['censors.report'],
      clauses: ['L82/1991:art.28(7),29(1)'],
      drafted: false,
    });
  return owed;
}

/** What the drafts are written from. Amounts in whole lei, as the statements give them. */
export type DraftFacts = {
  statement: AnnualStatementKind;
  year: number;
  company: { name: string; cui: string; tradeRegister: string; address: string; form: string };
  administrator: string;
  preparer: { name: string; quality: number };
  /** [previous, current] where the statements have both. */
  turnover: [number | undefined, number];
  /** The year's net result: positive a profit, negative a loss. */
  result: number;
  previousResult: number | undefined;
  equity: number;
  totalAssets: number;
  debts: number;
  /** The legal reserve set aside from the year's profit (129), and the share capital (1012). */
  legalReserve: number;
  capital: number;
  employees: { average: number; atEnd: number };
  /** F40, by row, for the fixed-asset note. */
  fixedAssets: Readonly<Record<string, Cells | undefined>>;
  /** The accounting-policy facts recorded (`policy.*`), by axis. */
  policies: Readonly<Record<string, string>>;
  /** The person's disclosures; null until answered. */
  disclosures: DisclosuresAnswer | null;
  branch: boolean;
};

export type Draft = { document: AnnualDocumentKind; title: string; text: string; hash: string };

const n = (value: number) => value.toLocaleString('ro-RO', { maximumFractionDigits: 0 });
const none = (value: string | null | undefined) => value?.trim() || 'Nu este cazul.';
const pending = '[de completat de administrator]';

/** The explanatory notes: what the books, the policies and the disclosures give. */
function notes(facts: DraftFacts): string {
  const d = facts.disclosures;
  const rows: [string, string][] = [
    ['01', 'Cheltuieli de constituire'],
    ['02', 'Cheltuieli de dezvoltare'],
    ['03', 'Concesiuni, brevete, licențe și alte imobilizări necorporale'],
    ['08', 'Terenuri și amenajări de terenuri'],
    ['09', 'Construcții'],
    ['10', 'Instalații tehnice și mașini'],
    ['11', 'Alte instalații, utilaje și mobilier'],
    ['13', 'Imobilizări corporale în curs de execuție'],
    ['19', 'Imobilizări financiare'],
  ];
  const table = rows
    .filter(([row]) => facts.fixedAssets[row])
    .map(([row, label]) => {
      const cells = facts.fixedAssets[row]!;
      return `| ${label} | ${n(cells[0] ?? 0)} | ${n(cells[1] ?? 0)} | ${n(cells[2] ?? 0)} | ${n(cells[4] ?? 0)} |`;
    });
  const depreciation = ['26', '34']
    .map((row) => facts.fixedAssets[row])
    .filter((cells): cells is Cells => cells !== undefined)
    .reduce((sum, cells) => [sum[0]! + (cells[0] ?? 0), sum[1]! + (cells[3] ?? 0)], [0, 0]);
  const policies = [
    'Elementele bilanțiere sunt evaluate la cost istoric; nu s-au efectuat reevaluări.',
    'Imobilizările sunt amortizate liniar, pe durata de utilizare economică înscrisă în registrul imobilizărilor.',
    'Operațiunile în valută sunt înregistrate la cursul de referință BNR, iar elementele monetare în valută sunt reevaluate la cursul BNR de la data bilanțului.',
    facts.policies['policy.storno']
      ? `Stornările se fac în ${facts.policies['policy.storno'] === 'red' ? 'roșu' : 'negru'}.`
      : null,
    facts.policies['policy.payroll.employer_share']
      ? `Contribuțiile datorate în numele salariaților cu normă parțială suportate de angajator se înregistrează în contul ${facts.policies['policy.payroll.employer_share']}.`
      : null,
    facts.policies['policy.assets.disposal_month']
      ? `Imobilizările ieșite se amortizează ${facts.policies['policy.assets.disposal_month'] === 'included' ? 'inclusiv' : 'fără'} luna ieșirii.`
      : null,
  ].filter((line): line is string => line !== null);
  const sections = [
    `# ${titles.notes} — exercițiul ${facts.year}`,
    `## 1. Informații generale\n${facts.company.name}, CUI ${facts.company.cui}, înregistrată la registrul comerțului sub nr. ${facts.company.tradeRegister}, cu sediul în ${facts.company.address}. Situațiile financiare anuale sunt individuale, întocmite potrivit Legii contabilității nr. 82/1991 și Reglementărilor contabile aprobate prin OMFP nr. 1.802/2014, pentru exercițiul încheiat la 31 decembrie ${facts.year}, în lei.`,
    `## 2. Politici contabile\n${policies.map((line) => `- ${line}`).join('\n')}`,
    `## 3. Angajamente, garanții, active și datorii contingente neincluse în bilanț\n${d ? none(d.commitments) : pending}`,
    `## 4. Avansuri și credite acordate membrilor organelor de administrație și conducere\n${d ? none(d.managementAdvances) : pending}`,
  ];
  if (facts.statement === 'S1003')
    sections.push(
      `## 5. Imobilizări\n| Element | Sold inițial | Creșteri | Reduceri | Sold final |\n|---|---|---|---|---|\n${table.join('\n') || '| Nu există imobilizări | 0 | 0 | 0 | 0 |'}\n\nAmortizarea cumulată: ${n(depreciation[0]!)} lei la începutul exercițiului, ${n(depreciation[1]!)} lei la sfârșitul lui.`,
      `## 6. Elemente de venituri și cheltuieli excepționale\n${d ? none(d.exceptional) : pending}`,
      `## 7. Datorii exigibile după mai mult de cinci ani și datorii garantate\n${d ? none(d.longTermDebts) : pending}`,
      `## 8. Numărul mediu de salariați\n${facts.employees.average} salariați în medie în ${facts.year}; ${facts.employees.atEnd} la 31 decembrie ${facts.year}.`,
      `## 9. Societatea-mamă\n${d ? (d.parent ? `${d.parent.name}, ${d.parent.seat}.` : 'Nu este cazul.') : pending}`,
      `## 10. Natura și scopul comercial al angajamentelor în afara bilanțului\n${d ? none(d.commitments) : pending}`,
      `## 11. Evenimente ulterioare datei bilanțului\n${d ? none(d.subsequentEvents) : pending}`,
      `## 12. Tranzacții cu deținătorii de interese de participare, cu entitățile în care se dețin participații și cu membrii conducerii\n${d ? none(d.relatedParties) : pending}`,
    );
  return sections.join('\n\n');
}

function administratorsReport(facts: DraftFacts): string {
  const [previous, current] = facts.turnover;
  const change =
    previous && previous > 0
      ? ` (${current >= previous ? '+' : ''}${(((current - previous) / previous) * 100).toFixed(1)}% față de ${facts.year - 1})`
      : '';
  return [
    `# ${titles['administrators.report']} — exercițiul ${facts.year}`,
    `## Dezvoltarea și performanța activității\nCifra de afaceri netă a fost de ${n(current)} lei${change}. Exercițiul s-a încheiat cu ${facts.result >= 0 ? `profit net de ${n(facts.result)}` : `pierdere netă de ${n(-facts.result)}`} lei. La 31 decembrie ${facts.year}, activele totale sunt de ${n(facts.totalAssets)} lei, datoriile de ${n(facts.debts)} lei, iar capitalurile proprii de ${n(facts.equity)} lei. Entitatea a avut în medie ${facts.employees.average} salariați.`,
    `## Principalele riscuri și incertitudini\n${pending}`,
    `## Dezvoltarea previzibilă\n${pending}`,
    `## Cercetare-dezvoltare\n${pending}`,
    `## Acțiuni proprii\n${facts.company.form === 'srl' ? 'Societatea nu a achiziționat părți sociale proprii.' : pending}`,
    `## Sucursale\n${facts.branch ? pending : 'Entitatea nu are sucursale.'}`,
    `## Riscul financiar (preț, credit, lichiditate, flux de numerar)\n${pending}`,
    facts.statement === 'S1003'
      ? 'Informațiile nefinanciare prevăzute la pct. 491 alin. (1) din OMFP nr. 1.802/2014 nu se prezintă de entitățile mici (pct. 492).'
      : 'Informațiile nefinanciare prevăzute la pct. 491 alin. (1) din OMFP nr. 1.802/2014 nu se prezintă de microentități (pct. 492).',
    `Administrator: ${facts.administrator}`,
  ].join('\n\n');
}

function profitDistribution(facts: DraftFacts): string {
  const header = `# ${titles['profit.distribution']} — exercițiul ${facts.year}`;
  if (facts.result < 0)
    return [
      header,
      `Exercițiul ${facts.year} s-a încheiat cu o pierdere contabilă de ${n(-facts.result)} lei. Se propune acoperirea ei din: ${pending} (profitul reportat, rezervele, primele de capital sau capitalul social, în ordinea hotărâtă de adunarea generală a asociaților, OMFP nr. 1.802/2014 pct. 423).`,
      `Administrator: ${facts.administrator}`,
    ].join('\n\n');
  const rest = facts.result - facts.legalReserve;
  return [
    header,
    `Profitul net al exercițiului ${facts.year}: ${n(facts.result)} lei.`,
    `Repartizat în cursul exercițiului la rezerva legală (Legea nr. 31/1990 art. 183, cont 1061): ${n(facts.legalReserve)} lei.`,
    `Profitul rămas de repartizat: ${n(rest)} lei, propus pentru: dividende ${pending} lei; profit reportat (cont 117) ${pending} lei; alte rezerve ${pending} lei, după hotărârea adunării generale a asociaților.`,
    `Administrator: ${facts.administrator}`,
  ].join('\n\n');
}

function declaration(facts: DraftFacts): string {
  const going = facts.disclosures?.goingConcern;
  const continuity = !going
    ? `c) persoana juridică își desfășoară activitatea în condiții de continuitate ${pending}.`
    : going.continues
      ? 'c) persoana juridică își desfășoară activitatea în condiții de continuitate.'
      : `c) [nu se poate confirma] continuitatea activității: ${going.uncertainty}`;
  return [
    `# ${titles.declaration}`,
    `Subsemnatul ${facts.administrator}, în calitate de administrator al ${facts.company.name}, CUI ${facts.company.cui}, îmi asum răspunderea pentru întocmirea situațiilor financiare anuale la 31 decembrie ${facts.year} și confirm că:`,
    'a) politicile contabile utilizate la întocmirea situațiilor financiare anuale sunt în conformitate cu reglementările contabile aplicabile;',
    'b) situațiile financiare anuale oferă o imagine fidelă a poziției financiare, performanței financiare și a celorlalte informații referitoare la activitatea desfășurată;',
    continuity,
    `Administrator: ${facts.administrator}`,
  ].join('\n\n');
}

/** The engine's drafts of the documents it drafts, each with the hash an answer is tied to. */
export function draftDocuments(facts: DraftFacts): Draft[] {
  const texts: [AnnualDocumentKind, string][] = [
    ['notes', notes(facts)],
    ['administrators.report', administratorsReport(facts)],
    ['profit.distribution', profitDistribution(facts)],
    ['declaration', declaration(facts)],
  ];
  return texts.map(([document, text]) => ({
    document,
    title: titles[document],
    text,
    hash: sha256Hex(text),
  }));
}
