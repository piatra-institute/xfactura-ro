import type { ParameterVersion } from '../../rules';

/**
 * Where the engine's Romanian rules come from. A source is a legal act or an official
 * document; a clause is a located place in it. Every parameter version cites clauses by id.
 *
 * A clause is `located` when its text was read in a snapshot whose hash is recorded here, and
 * `pending` when only its locator is known. Neither is a review: values stay `extracted` until
 * an expert contabil reviews them (`ReviewStatus`). Snapshot bytes live outside the repository
 * in `.sources/` (fetched by `scripts/sources/fetch.ts`, or provided by the owner).
 */
export type Snapshot = {
  url: string;
  sha256: string;
  /** When the bytes were retrieved; null when that was not recorded. */
  retrievedOn: string | null;
  mediaType: string;
};

export type LegalSource = {
  id: string;
  kind: 'act' | 'official_document' | 'standard';
  title: string;
  issuer: string;
  /** The Monitorul Oficial publication; null until it has been checked. */
  publication: string | null;
  /** Where the official text can be obtained. `fetch` sources are fetched and hashed by the
   * sources script; the others are provided by the owner (the site refuses automated access). */
  urls: readonly string[];
  fetch: boolean;
  snapshots: readonly Snapshot[];
};

export type Clause = {
  id: string;
  source: string;
  locator: string;
  status: 'located' | 'pending';
  /** What the clause says, in our words; never a substitute for the text. */
  summary: string;
};

export const legalSources: readonly LegalSource[] = [
  {
    id: 'L227/2015',
    kind: 'act',
    title: 'Legea nr. 227/2015 privind Codul fiscal',
    issuer: 'Parlamentul României',
    publication: null,
    urls: ['https://legislatie.just.ro/Public/DetaliiDocument/171282'],
    fetch: false,
    snapshots: [],
  },
  {
    id: 'L141/2025',
    kind: 'act',
    title: 'Legea nr. 141/2025 privind unele măsuri fiscal-bugetare',
    issuer: 'Parlamentul României',
    publication: null,
    urls: [],
    fetch: false,
    snapshots: [],
  },
  {
    id: 'OMFP1802/2014',
    kind: 'act',
    title:
      'Ordinul ministrului finanțelor publice nr. 1.802/2014 pentru aprobarea Reglementărilor contabile privind situațiile financiare anuale individuale și situațiile financiare anuale consolidate',
    issuer: 'Ministerul Finanțelor Publice',
    publication: null,
    urls: ['https://static.anaf.ro/static/10/Anaf/legislatie/OMFP_1802_2014.pdf'],
    fetch: true,
    snapshots: [
      {
        url: 'https://static.anaf.ro/static/10/Anaf/legislatie/OMFP_1802_2014.pdf',
        sha256: '6e0de23520f49de718dead66462f14d624c527a87e8b27eeb5306ab9cc84ff4c',
        retrievedOn: null,
        mediaType: 'application/pdf',
      },
    ],
  },
  {
    id: 'ANAF/D300-12.0.0',
    kind: 'official_document',
    title: 'Structura fișierului XML al decontului de TVA (D300), versiunea 12.0.0',
    issuer: 'ANAF',
    publication: null,
    urls: [
      'https://static.anaf.ro/static/10/Anaf/Declaratii_R/AplicatiiDec/structura_D300_v12.0.0_10022026.pdf',
    ],
    fetch: true,
    snapshots: [
      {
        url: 'https://static.anaf.ro/static/10/Anaf/Declaratii_R/AplicatiiDec/structura_D300_v12.0.0_10022026.pdf',
        sha256: 'fedbf3b11b3e06e72a5f4be8be3c5b0fafd267a87d71de3261b0fd8af2a89b3e',
        retrievedOn: '2026-10-29',
        mediaType: 'application/pdf',
      },
    ],
  },
  {
    id: 'ANAF/ghid-coduri-facturi-2.9',
    kind: 'official_document',
    title: 'Ghid privind codurile din factura electronică, versiunea 2.9',
    issuer: 'ANAF',
    publication: null,
    urls: [
      'https://static.anaf.ro/static/10/Anaf/Informatii_R/Ghid%20cod%20facturi_final%20v2.9.pdf',
    ],
    fetch: true,
    snapshots: [
      {
        url: 'https://static.anaf.ro/static/10/Anaf/Informatii_R/Ghid%20cod%20facturi_final%20v2.9.pdf',
        sha256: 'cbb6d05672f7baed7370c183edbb70fd79149514ed3150cad109a779f4d03cde',
        retrievedOn: '2026-10-29',
        mediaType: 'application/pdf',
      },
    ],
  },
  {
    id: 'ANAF/Ploiesti-modificari-tva',
    kind: 'official_document',
    title: 'Modificări privind cotele de TVA (material informativ ANAF Ploiești)',
    issuer: 'ANAF',
    publication: null,
    urls: ['https://static.anaf.ro/static/10/Ploiesti/modificari_tva.pdf'],
    fetch: true,
    snapshots: [
      {
        url: 'https://static.anaf.ro/static/10/Ploiesti/modificari_tva.pdf',
        sha256: '2e4d2792bb1c6cae010134900141c088063c3feed56aa37397a879be59953b02',
        retrievedOn: '2026-10-29',
        mediaType: 'application/pdf',
      },
    ],
  },
];

export const clauses: readonly Clause[] = [
  {
    id: 'L227/2015:art.291(1)(a)',
    source: 'L227/2015',
    locator: 'art. 291 alin. (1) lit. a)',
    status: 'pending',
    summary: 'Cota standard de TVA.',
  },
  {
    id: 'L227/2015:art.291(2)',
    source: 'L227/2015',
    locator: 'art. 291 alin. (2)',
    status: 'pending',
    summary: 'Cota redusă de TVA și operațiunile cărora li se aplică.',
  },
  {
    id: 'L227/2015:art.290',
    source: 'L227/2015',
    locator: 'art. 290',
    status: 'pending',
    summary: 'Cursul de schimb pentru baza de impozitare a operațiunilor în valută.',
  },
  {
    id: 'L141/2025:rates',
    source: 'L141/2025',
    locator: 'dispozițiile care modifică art. 291 din Codul fiscal, cu efect de la 01.08.2025',
    status: 'pending',
    summary: 'Cota standard devine 21% și cota redusă 11% de la 1 august 2025.',
  },
  {
    id: 'L141/2025:art.III',
    source: 'L141/2025',
    locator: 'art. III',
    status: 'pending',
    summary: 'Cota tranzitorie de 9% pentru anumite livrări de locuințe.',
  },
  {
    id: 'ANAF/D300-12.0.0:rd.9',
    source: 'ANAF/D300-12.0.0',
    locator: 'rândul 9 (R9_1, R9_2), valabil de la 01.08.2025',
    status: 'located',
    summary: 'Livrări și prestări taxabile cu cota 21%.',
  },
  {
    id: 'ANAF/D300-12.0.0:rd.10',
    source: 'ANAF/D300-12.0.0',
    locator: 'rândul 10 (R10_1, R10_2), valabil de la 01.08.2025',
    status: 'located',
    summary: 'Livrări și prestări taxabile cu cota 11%.',
  },
  {
    id: 'ANAF/D300-12.0.0:rd.11',
    source: 'ANAF/D300-12.0.0',
    locator: 'rândul 11 (R11_1, R11_2), valabil de la 01.08.2025',
    status: 'located',
    summary: 'Livrări de bunuri taxabile cu cota 9% conform art. III din Legea nr. 141/2025.',
  },
  {
    id: 'OMFP1802/2014:pct.315-316',
    source: 'OMFP1802/2014',
    locator: 'pct. 315–316 (operațiuni în valută)',
    status: 'pending',
    summary: 'Cursul de schimb pentru înregistrarea operațiunilor în valută.',
  },
  {
    id: 'ANAF/ghid-coduri-facturi-2.9:O',
    source: 'ANAF/ghid-coduri-facturi-2.9',
    locator: 'categoria de TVA "O"',
    status: 'located',
    summary: 'Categoria O se folosește pentru operațiunile efectuate de neplătitorii de TVA.',
  },
  {
    id: 'ANAF/Ploiesti-modificari-tva:cote',
    source: 'ANAF/Ploiesti-modificari-tva',
    locator: 'Cotele de TVA (începând cu 01.08.2025)',
    status: 'located',
    summary:
      'De la 01.08.2025 cota standard crește de la 19% la 21%; o singură cotă redusă, 11%, înlocuiește cotele de 9% și 5% (Legea nr. 141/2025).',
  },
];

const sourceById = new Map(legalSources.map((source) => [source.id, source]));
const clauseById = new Map(clauses.map((item) => [item.id, item]));

export function clause(id: string): Clause | undefined {
  return clauseById.get(id);
}

export function sourceOf(item: Clause): LegalSource {
  return sourceById.get(item.source)!;
}

/**
 * What keeps the citations honest: every parameter version cites at least one registered
 * clause, every clause names a registered source, and a located clause's source has a
 * snapshot whose bytes were read.
 */
export function citationProblems(versions: readonly ParameterVersion[]): string[] {
  const problems: string[] = [];
  for (const item of clauses) {
    const source = sourceById.get(item.source);
    if (!source) problems.push(`${item.id}: unknown source ${item.source}`);
    else if (item.status === 'located' && !source.snapshots.length)
      problems.push(`${item.id}: located in ${item.source}, which has no snapshot`);
  }
  for (const version of versions) {
    if (!version.clauses.length) problems.push(`${version.id}: cites nothing`);
    for (const id of version.clauses)
      if (!clauseById.has(id)) problems.push(`${version.id}: unknown clause ${id}`);
  }
  return problems;
}

/** The parameters a person still has to source: those citing only pending clauses. */
export function unsourced(versions: readonly ParameterVersion[]) {
  return versions.filter((version) =>
    version.clauses.every((id) => clauseById.get(id)?.status !== 'located'),
  );
}
