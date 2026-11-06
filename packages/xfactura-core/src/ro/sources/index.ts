import type { ParameterVersion } from '../../rules';
import { annualClauses, annualSources } from './annual';
import { nonpayerClauses, nonpayerSources } from './nonpayers';
import { exemptClauses, exemptSources } from './exempt';
import { taxAccountClauses, taxAccountSources } from './taxaccount';
import { profitClauses, profitSources } from './profit';
import { saftClauses, saftSources } from './saft';
import { withholdingClauses, withholdingSources } from './withholding';
import { payrollClauses, payrollSources } from './payroll';
import { receiptClauses, receiptSources } from './receipts';
import { schemeClauses, schemeSources } from './schemes';
import { ossClauses, ossSources } from './oss';
import { yearEndClauses, yearEndSources } from './yearend';
import { stockClauses, stockSources } from './stock';
import { tradeClauses, tradeSources } from './trade';
import { retailClauses, retailSources } from './retail';
import { productionClauses, productionSources } from './production';
import { creditClauses } from './credit';

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
    id: 'L207/2015',
    kind: 'act',
    title:
      'Legea nr. 207/2015 privind Codul de procedură fiscală (forma consolidată pe portalul legislativ, actualizată până la 08.08.2026)',
    issuer: 'Parlamentul României',
    publication: 'Monitorul Oficial nr. 547 din 23 iulie 2015',
    // The portal's page is dynamic and refuses automated access: the hash is the copy kept in
    // .sources/.
    urls: ['https://legislatie.just.ro/Public/DetaliiDocument/312603'],
    fetch: false,
    snapshots: [
      {
        url: 'https://legislatie.just.ro/Public/DetaliiDocument/312603',
        sha256: '688ac5103375910fff2a3d2ac7e58ea8bccb6987b8edacb509d8ae50545a6d2c',
        retrievedOn: '2026-11-04',
        mediaType: 'text/html',
      },
    ],
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
  // The regulations as the legislative portal consolidates them, downloaded by the owner (the
  // portal refuses automated requests). The consolidation stops at the amendments of 1 February
  // 2022 (OMF nr. 85/2022): later ones, such as the size thresholds of pct. 9 that OMF nr. 2.036/2025
  // states in lei, are read from their own acts.
  {
    id: 'OMFP1802/2014-A',
    kind: 'act',
    title:
      'Reglementările contabile privind situațiile financiare anuale individuale și situațiile financiare anuale consolidate, aprobate prin OMFP nr. 1.802/2014 (forma consolidată a portalului legislativ, cu modificările până la 1 februarie 2022)',
    issuer: 'Ministerul Finanțelor Publice',
    publication: 'Monitorul Oficial nr. 963 din 30 decembrie 2014',
    urls: [],
    fetch: false,
    snapshots: [
      {
        url: 'https://xfactura.invalid/owner-download/REGLEMENTARI_A_29_12_2014.pdf',
        sha256: '070c826a779245dd630308f9d2256b33a90dae31fecde9caea584666fa8e00b1',
        retrievedOn: '2026-11-05',
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
  {
    id: 'ANAF/Cod-fiscal-consolidat',
    kind: 'official_document',
    title:
      'Codul fiscal adnotat cu normele metodologice, text actualizat publicat de ANAF (ultima actualizare: Legea nr. 204/2026; norme: Hotărârea Guvernului nr. 602/2025)',
    issuer: 'ANAF',
    publication: null,
    urls: ['https://static.anaf.ro/static/10/Anaf/legislatie/Cod_fiscal_norme_2023.htm'],
    fetch: true,
    snapshots: [
      {
        url: 'https://static.anaf.ro/static/10/Anaf/legislatie/Cod_fiscal_norme_2023.htm',
        sha256: 'aba0c753fd326414d4327af00bc56269024a9c248857096aef7354a68013e7c1',
        retrievedOn: '2026-10-29',
        mediaType: 'text/html',
      },
    ],
  },
  {
    id: 'ANAF/Cod-procedura-fiscala-2019',
    kind: 'official_document',
    title:
      'Codul de procedură fiscală, text actualizat publicat de ANAF (ultima actualizare: Ordonanța Guvernului nr. 19/2019; ediție din 02.08.2019); textul în vigoare se verifică pe portalul legislativ',
    issuer: 'ANAF',
    publication: null,
    urls: [
      'https://static.anaf.ro/static/10/Anaf/cod_procedura/Cod_Procedura_Fiscala_08022019.htm',
    ],
    fetch: true,
    snapshots: [
      {
        url: 'https://static.anaf.ro/static/10/Anaf/cod_procedura/Cod_Procedura_Fiscala_08022019.htm',
        sha256: '0306eb2c13047a04e6c1098bd16c5c6b6dc06590c9d220ecf2ca91951f5e052c',
        retrievedOn: '2026-10-30',
        mediaType: 'text/html',
      },
    ],
  },
  // The rounding of taxes and contributions owed to the budget, which the procedure code does
  // not state (its ANAF edition above has no rounding article). The portal's page is dynamic
  // (a token in the print link changes per request), so it is not refetched: the hash is the
  // copy kept in .sources/.
  {
    id: 'OUG59/2005',
    kind: 'act',
    title:
      'Ordonanța de urgență a Guvernului nr. 59/2005 privind unele măsuri de natură fiscală și financiară pentru punerea în aplicare a Legii nr. 348/2004 privind denominarea monedei naționale (forma consolidată pe portalul legislativ, actualizată până la 26.05.2006)',
    issuer: 'Guvernul României',
    publication: 'Monitorul Oficial nr. 556 din 29 iunie 2005',
    urls: ['https://legislatie.just.ro/Public/DetaliiDocument/62685'],
    fetch: false,
    snapshots: [
      {
        url: 'https://legislatie.just.ro/Public/DetaliiDocument/62685',
        sha256: 'ab57d921519c98304b7651461ff2a2c045688612669fafd6fa9d81e06e193fa2',
        retrievedOn: '2026-10-30',
        mediaType: 'text/html',
      },
    ],
  },
  // The code as the legislative portal consolidates it, downloaded by the owner (the portal
  // refuses automated requests). Kept in .sources/L134_2010-A/.
  {
    id: 'L134/2010-A',
    kind: 'act',
    title:
      'Legea nr. 134/2010 privind Codul de procedură civilă, republicată (forma consolidată a portalului legislativ, actualizată până la 14.12.2025)',
    issuer: 'Parlamentul României',
    publication: 'Monitorul Oficial nr. 247 din 10 aprilie 2015 (republicare)',
    urls: [],
    fetch: false,
    snapshots: [
      {
        url: 'https://xfactura.invalid/owner-download/COD_PR_CIVILA_A_01_07_2010.pdf',
        sha256: '1331d41fed8262338246601e9c41e4734fae87aa023e351ddaf38abd8771c14f',
        retrievedOn: '2026-11-05',
        mediaType: 'application/pdf',
      },
    ],
  },
  {
    id: 'L82/1991',
    kind: 'act',
    title: 'Legea contabilității nr. 82/1991, republicată (text publicat de ANAF)',
    issuer: 'Parlamentul României',
    publication: null,
    urls: ['https://static.anaf.ro/static/10/Anaf/legislatie/Legea_82_1991.pdf'],
    fetch: true,
    snapshots: [
      {
        url: 'https://static.anaf.ro/static/10/Anaf/legislatie/Legea_82_1991.pdf',
        sha256: '4ba2780cc74bc427d7b5ec66edb0d83bdb92af1bd8d87e21a97955b7b486c591',
        retrievedOn: '2026-10-30',
        mediaType: 'application/pdf',
      },
    ],
  },
  {
    id: 'OPANAF591/2016',
    kind: 'act',
    title:
      'Ordinul președintelui ANAF nr. 591/2016 pentru aprobarea modelului și conținutului formularului (390 VIES) "Declarație recapitulativă privind livrările/achizițiile/prestările intracomunitare" (textul inițial)',
    issuer: 'ANAF',
    publication: 'Monitorul Oficial nr. 94 din 8 februarie 2016',
    urls: ['https://static.anaf.ro/static/10/Anaf/legislatie/OPANAF_591_2016.pdf'],
    fetch: true,
    snapshots: [
      {
        url: 'https://static.anaf.ro/static/10/Anaf/legislatie/OPANAF_591_2016.pdf',
        sha256: 'a6cea36cae2ff504017b1aa83dd0f719f2587567c64dc10d95895675d84f2e39',
        retrievedOn: '2026-10-30',
        mediaType: 'application/pdf',
      },
    ],
  },
  {
    id: 'OPANAF3769/2015',
    kind: 'act',
    title:
      'Ordinul președintelui ANAF nr. 3.769/2015 privind declararea livrărilor/prestărilor și achizițiilor efectuate pe teritoriul național (D394) (textul inițial; modificat ulterior)',
    issuer: 'ANAF',
    publication: 'Monitorul Oficial nr. 11 din 7 ianuarie 2016',
    urls: ['https://static.anaf.ro/static/10/Anaf/legislatie/OPANAF_3769_2015.pdf'],
    fetch: true,
    snapshots: [
      {
        url: 'https://static.anaf.ro/static/10/Anaf/legislatie/OPANAF_3769_2015.pdf',
        sha256: '7b489956f8a3846de8c1733291969c9617e924e123d5d7afb3de4cc9aa1c096e',
        retrievedOn: '2026-10-30',
        mediaType: 'application/pdf',
      },
    ],
  },
  // The order with its instructions as the legislative portal consolidates them, downloaded by
  // the owner (the portal refuses automated requests). Kept in .sources/OPANAF3769_2015-A/.
  {
    id: 'OPANAF3769/2015-A',
    kind: 'act',
    title:
      'Ordinul președintelui ANAF nr. 3.769/2015 privind declararea livrărilor/prestărilor și achizițiilor efectuate pe teritoriul național de persoanele înregistrate în scopuri de TVA și pentru aprobarea modelului și conținutului declarației informative (394), cu instrucțiunile de completare (forma consolidată a portalului legislativ, actualizată până la 17.09.2025)',
    issuer: 'ANAF',
    publication: 'Monitorul Oficial nr. 11 din 7 ianuarie 2016',
    urls: [],
    fetch: false,
    snapshots: [
      {
        url: 'https://xfactura.invalid/owner-download/ORDIN_A_3769_23_12_2015.pdf',
        sha256: '53ea26fb0a90b47f073ec520de3550922bf5979d9fb56fe4781b8f46d439e350',
        retrievedOn: '2026-11-05',
        mediaType: 'application/pdf',
      },
    ],
  },
  {
    id: 'L70/2015',
    kind: 'act',
    title:
      'Legea nr. 70/2015 pentru întărirea disciplinei financiare privind operațiunile de încasări și plăți în numerar (text publicat de ANAF, actualizat până la Legea nr. 344/2018; modificată ulterior prin Legea nr. 296/2023 și Legea nr. 239/2025)',
    issuer: 'Parlamentul României',
    publication: 'Monitorul Oficial nr. 242 din 9 aprilie 2015',
    urls: ['https://static.anaf.ro/static/10/Anaf/legislatie/L_70_2015.pdf'],
    fetch: true,
    snapshots: [
      {
        url: 'https://static.anaf.ro/static/10/Anaf/legislatie/L_70_2015.pdf',
        sha256: '772976efe067b1a229291afbe7a6a430c01bad29ad3c1f9edcb4ccf6cd6f5571',
        retrievedOn: '2026-10-30',
        mediaType: 'application/pdf',
      },
    ],
  },
  {
    id: 'ANAF/Ploiesti-ghid-numerar-2026',
    kind: 'official_document',
    title:
      'ANAF, DGRFP Ploiești: Disciplina financiară privind operațiunile de încasări și plăți în numerar (31 iulie 2026), după Legea nr. 70/2015 actualizată prin Legea nr. 239/2025; copie publicată de startupcafe.ro, documentul ANAF fiind listat la Asistență contribuabili – Ghiduri',
    issuer: 'ANAF',
    publication: null,
    urls: ['https://startupcafe.ro/wp-content/uploads/2026/08/ghid-anaf-2026-plati-numerar.pdf'],
    fetch: true,
    snapshots: [
      {
        url: 'https://startupcafe.ro/wp-content/uploads/2026/08/ghid-anaf-2026-plati-numerar.pdf',
        sha256: '3cee4bbfea9845a5522b89b87893af5468a4a020193ec86fbb05584790126a80',
        retrievedOn: '2026-10-30',
        mediaType: 'application/pdf',
      },
    ],
  },
  {
    id: 'OPANAF2328/2016',
    kind: 'act',
    title:
      'Ordinul președintelui ANAF nr. 2.328/2016 pentru modificarea Ordinului președintelui ANAF nr. 3.769/2015 (termenul declarației 394)',
    issuer: 'ANAF',
    publication: 'Monitorul Oficial nr. 601 din 8 august 2016',
    urls: ['https://static.anaf.ro/static/10/Anaf/legislatie/OPANAF_2328_2016.pdf'],
    fetch: true,
    snapshots: [
      {
        url: 'https://static.anaf.ro/static/10/Anaf/legislatie/OPANAF_2328_2016.pdf',
        sha256: 'fab9323458cd5e7f60b5812a5381bd871885e333de9dc4f032a970b11608e71e',
        retrievedOn: '2026-10-30',
        mediaType: 'application/pdf',
      },
    ],
  },
  {
    id: 'OPANAF1783/2021',
    kind: 'act',
    title:
      'Ordinul președintelui ANAF nr. 1.783/2021 privind fișierul standard de control fiscal (D406): natura informațiilor, modelul, procedura și termenele de transmitere (textul inițial)',
    issuer: 'ANAF',
    publication: null,
    urls: ['https://static.anaf.ro/static/10/Anaf/legislatie/OPANAF_1783_2021.pdf'],
    fetch: true,
    snapshots: [
      {
        url: 'https://static.anaf.ro/static/10/Anaf/legislatie/OPANAF_1783_2021.pdf',
        sha256: 'c6fd52add135682f57f54c1e2e174553962c1d94f392fc989632597106177a65',
        retrievedOn: '2026-10-30',
        mediaType: 'application/pdf',
      },
    ],
  },
  {
    id: 'OPANAF407/2025',
    kind: 'act',
    title:
      'Ordinul președintelui ANAF nr. 407/2025 pentru modificarea anexei nr. 5 la OPANAF nr. 1.783/2021 (categoriile de contribuabili care transmit D406 și cele exceptate)',
    issuer: 'ANAF',
    publication: 'Monitorul Oficial nr. 310 din 8 aprilie 2025',
    urls: ['https://static.anaf.ro/static/10/Anaf/legislatie/OPANAF_407_2025.pdf'],
    fetch: true,
    snapshots: [
      {
        url: 'https://static.anaf.ro/static/10/Anaf/legislatie/OPANAF_407_2025.pdf',
        sha256: '65c28805d4832feae60ec627c9842c46a9eb48a4aa3a7b348a495ecf2098b082',
        retrievedOn: '2026-11-04',
        mediaType: 'application/pdf',
      },
    ],
  },
  {
    id: 'OPANAF605/2026',
    kind: 'act',
    title:
      'Ordinul comun ANAF/CNPP/CNAS/ANOFM nr. 605/95/928/2.314/2026 pentru aprobarea formularului 112 (de la declararea veniturilor lunii iulie 2026), cu instrucțiunile de completare (anexa nr. 6)',
    issuer: 'ANAF, CNPP, CNAS, ANOFM',
    publication: 'Monitorul Oficial nr. 463 din 2 iunie 2026',
    urls: ['https://static.anaf.ro/static/10/Anaf/legislatie/OPANAF_605_2026.pdf'],
    fetch: true,
    snapshots: [
      {
        url: 'https://static.anaf.ro/static/10/Anaf/legislatie/OPANAF_605_2026.pdf',
        sha256: '2c7c4a03e9cf14d2b77201d98a9af10d70b22171379d76aab606d0ca971e5e6d',
        retrievedOn: '2026-11-04',
        mediaType: 'application/pdf',
      },
    ],
  },
  {
    id: 'OUG128/2024',
    kind: 'act',
    title:
      'OUG nr. 128/2024 pentru modificarea și completarea Legii nr. 227/2015 privind Codul fiscal și măsuri specifice pentru digitalizare (art. 69 alin. (9) de la veniturile anului 2025)',
    issuer: 'Guvernul României',
    publication: 'Monitorul Oficial nr. 1125 din 11 noiembrie 2024',
    urls: ['https://static.anaf.ro/static/10/Anaf/legislatie/OUG_128_2024.pdf'],
    fetch: true,
    snapshots: [
      {
        url: 'https://static.anaf.ro/static/10/Anaf/legislatie/OUG_128_2024.pdf',
        sha256: 'e68d54c6d83da84c93b148fe8445a80f3ca6b8789ffa103547f399c5e98604e8',
        retrievedOn: '2026-11-04',
        mediaType: 'application/pdf',
      },
    ],
  },
  {
    // The portal's consolidated form of 2025 (before Legea nr. 239/2025): official but
    // informative; its validity date on the portal was not confirmed (mid-2025 by its content).
    id: 'LJR/Cod-fiscal-2025',
    kind: 'official_document',
    title:
      'Codul fiscal (Legea nr. 227/2015), forma consolidată din 2025 a portalului legislatie.just.ro (înainte de Legea nr. 239/2025)',
    issuer: 'Ministerul Justiției (portalul legislativ)',
    publication: null,
    urls: ['https://legislatie.just.ro/Public/DetaliiDocument/301684'],
    fetch: false,
    snapshots: [
      {
        url: 'https://legislatie.just.ro/Public/DetaliiDocument/301684',
        sha256: '66e5cc9a6e83c810a5407c163346bf9db576848cb7038df3c3e7c9a4b9d7722c',
        retrievedOn: '2026-11-04',
        mediaType: 'text/html',
      },
    ],
  },
  {
    id: 'OMFP1243/2018',
    kind: 'act',
    title:
      'Ordinul ministrului finanțelor publice nr. 1.243/2018 privind completarea unor reglementări contabile',
    issuer: 'Ministerul Finanțelor Publice',
    publication: 'Monitorul Oficial nr. 120 din 7 februarie 2018',
    urls: ['https://static.anaf.ro/static/10/Anaf/legislatie/OMFP_1243_2018.pdf'],
    fetch: true,
    snapshots: [
      {
        url: 'https://static.anaf.ro/static/10/Anaf/legislatie/OMFP_1243_2018.pdf',
        sha256: '81b0890aad08a3d47559b90521119b4ec320125cc3fd7afbb253061121dcee93',
        retrievedOn: '2026-10-29',
        mediaType: 'application/pdf',
      },
    ],
  },
  {
    id: 'ANAF/D112-0726',
    kind: 'official_document',
    title:
      'Structura și validările declarației 112 pentru lunile de raportare din 07/2026 (anexa validări, 07.09.2026)',
    issuer: 'ANAF',
    publication: null,
    urls: [
      'https://static.anaf.ro/static/10/Anaf/Declaratii_R/AplicatiiDec/structura_D112_0726_070926.pdf',
    ],
    fetch: true,
    snapshots: [
      {
        url: 'https://static.anaf.ro/static/10/Anaf/Declaratii_R/AplicatiiDec/structura_D112_0726_070926.pdf',
        sha256: '3c7c78aee3588357da0b801aa322107071abc010ed25727eb705ca3c5b6edfce',
        retrievedOn: '2026-10-29',
        mediaType: 'application/pdf',
      },
    ],
  },
  {
    id: 'OUG156/2024',
    kind: 'act',
    title: 'Ordonanța de urgență a Guvernului nr. 156/2024',
    issuer: 'Guvernul României',
    publication: 'Monitorul Oficial nr. 1334 din 31 decembrie 2024',
    urls: ['https://static.anaf.ro/static/10/Anaf/legislatie/OUG_156_2024.pdf'],
    fetch: true,
    snapshots: [
      {
        url: 'https://static.anaf.ro/static/10/Anaf/legislatie/OUG_156_2024.pdf',
        sha256: '1e52bf2722bbb7d19ea8ba2868fad591684277957923891aa9e92cc0f3fecccf',
        retrievedOn: '2026-10-29',
        mediaType: 'application/pdf',
      },
    ],
  },
  {
    id: 'MF/eFactura-API',
    kind: 'official_document',
    title:
      'Prezentare servicii web pentru Sistemul național privind factura electronică RO e-Factura',
    issuer: 'Ministerul Finanțelor',
    publication: null,
    urls: ['https://mfinante.gov.ro/static/10/eFactura/prezentare%20api%20efactura.pdf'],
    fetch: false,
    snapshots: [
      {
        url: 'https://mfinante.gov.ro/static/10/eFactura/prezentare%20api%20efactura.pdf',
        sha256: 'cabd5fa5b45a8fe75071632a4b09317f30613f8ca49f05c323ab82ca87cc67c9',
        retrievedOn: '2026-10-29',
        mediaType: 'application/pdf',
      },
    ],
  },
  {
    id: 'MF/eFactura-limite',
    kind: 'official_document',
    title: 'Limite la apelarea API eFactura',
    issuer: 'Ministerul Finanțelor',
    publication: null,
    urls: ['https://mfinante.gov.ro/static/10/eFactura/limiteApeluriAPI.txt'],
    fetch: false,
    // The owner's copy of the text, pasted; the published file's bytes may differ in whitespace.
    snapshots: [
      {
        url: 'https://mfinante.gov.ro/static/10/eFactura/limiteApeluriAPI.txt',
        sha256: 'b3808456840215551c469e72355e318ebb2c2c4e5c7a98adfaa5a040a682b284',
        retrievedOn: '2026-10-29',
        mediaType: 'text/plain',
      },
    ],
  },
  {
    id: 'MF/eFactura-institutii-2021',
    kind: 'official_document',
    title:
      'Sistemul național privind factura electronică RO e-Factura pentru instituții publice, versiunea 0.1 (draft, 13.09.2021)',
    issuer: 'Ministerul Finanțelor',
    publication: null,
    urls: ['https://mfinante.gov.ro/static/10/eFactura/PrezentareE-factura.pdf'],
    fetch: false,
    snapshots: [
      {
        url: 'https://mfinante.gov.ro/static/10/eFactura/PrezentareE-factura.pdf',
        sha256: '122a53f00a104d1178ab0f9bc3d542e2a05c8f0d3e44ea237638dafc34731a0b',
        retrievedOn: '2026-10-29',
        mediaType: 'application/pdf',
      },
    ],
  },
  {
    id: 'ANAF/OAuth',
    kind: 'official_document',
    title: 'Procedura de înregistrare a aplicațiilor în portalul ANAF și obținerea tokenului OAuth',
    issuer: 'ANAF',
    publication: null,
    urls: [
      'https://static.anaf.ro/static/10/Anaf/Informatii_R/API/Oauth_procedura_inregistrare_aplicatii_portal_ANAF.pdf',
    ],
    fetch: true,
    snapshots: [
      {
        url: 'https://static.anaf.ro/static/10/Anaf/Informatii_R/API/Oauth_procedura_inregistrare_aplicatii_portal_ANAF.pdf',
        sha256: 'ea6880e6198c69150dae32db98a9c1111d468086d0a7e7fb9ec89ebf8d385fb5',
        retrievedOn: '2026-10-29',
        mediaType: 'application/pdf',
      },
    ],
  },
  {
    id: 'ANAF/WS-TVA-v9',
    kind: 'official_document',
    title:
      'Documentația serviciului web ANAF de interogare a registrelor contribuabililor (TVA, TVA la încasare, inactivi/reactivați, plata defalcată a TVA, RO e-Factura), versiunea 9',
    issuer: 'ANAF',
    publication: null,
    urls: ['https://static.anaf.ro/static/10/Anaf/Informatii_R/Servicii_web/doc_WS_V9.txt'],
    fetch: true,
    snapshots: [
      {
        url: 'https://static.anaf.ro/static/10/Anaf/Informatii_R/Servicii_web/doc_WS_V9.txt',
        sha256: '9346a0f7435234fa9ddf73e9e72c43ae354577d6a7db3b44fa5ef54ad31ae185',
        retrievedOn: '2026-10-30',
        mediaType: 'text/plain',
      },
    ],
  },
  // The Labour Code as the legislative portal consolidates it, downloaded by the owner (the
  // portal refuses automated requests). Kept in .sources/L53_2003-A/.
  {
    id: 'L53/2003-A',
    kind: 'act',
    title:
      'Legea nr. 53/2003 – Codul muncii, republicată (forma consolidată a portalului legislativ, actualizată până la 27.04.2026)',
    issuer: 'Parlamentul României',
    publication: 'Monitorul Oficial nr. 345 din 18 mai 2011 (republicare)',
    urls: ['https://legislatie.just.ro/Public/DetaliiDocument/128647'],
    fetch: false,
    snapshots: [
      {
        url: 'https://xfactura.invalid/owner-download/CODUL_MUNCII_A_24_01_2003.pdf',
        sha256: '25e033bafbe05ebf985746842b572ca394e2c65e07f8dcd7edffa4ff8be72fc2',
        retrievedOn: '2026-11-05',
        mediaType: 'application/pdf',
      },
    ],
  },
  {
    id: 'OUG70/2024',
    kind: 'act',
    title:
      'Ordonanța de urgență a Guvernului nr. 70/2024 privind unele măsuri de implementare și utilizare a decontului precompletat RO e-TVA',
    issuer: 'Guvernul României',
    publication: 'Monitorul Oficial nr. 582 din 21 iunie 2024',
    urls: ['https://static.anaf.ro/static/10/Anaf/legislatie/OUG_70_2024.pdf'],
    fetch: true,
    snapshots: [
      {
        url: 'https://static.anaf.ro/static/10/Anaf/legislatie/OUG_70_2024.pdf',
        sha256: 'b1e06964d39805e51bfcea345b35f38209aa5a90d6d6d8707d7ba6d2a18e4ff0',
        retrievedOn: '2026-10-29',
        mediaType: 'application/pdf',
      },
    ],
  },
  // The ordinance as the legislative portal consolidates it, downloaded by the owner (the portal
  // refuses automated requests). Its notes quote OUG nr. 91/2025 art. II as Legea nr. 64/2026
  // amended it. Kept in .sources/OUG158_2005-A/.
  {
    id: 'OUG158/2005-A',
    kind: 'act',
    title:
      'Ordonanța de urgență a Guvernului nr. 158/2005 privind concediile și indemnizațiile de asigurări sociale de sănătate (forma consolidată a portalului legislativ, actualizată până la 01.07.2026)',
    issuer: 'Guvernul României',
    publication: 'Monitorul Oficial nr. 1074 din 29 noiembrie 2005',
    urls: ['https://legislatie.just.ro/Public/DetaliiDocument/66305'],
    fetch: false,
    snapshots: [
      {
        url: 'https://xfactura.invalid/owner-download/OUG_A_158_17_11_2005.pdf',
        sha256: 'dd6881304468bc528ee74bbdcf2d86285d4229177592e35f6c713b4372ac9e05',
        retrievedOn: '2026-11-05',
        mediaType: 'application/pdf',
      },
    ],
  },
  {
    id: 'OMF2036/2025',
    kind: 'act',
    title:
      'Ordinul ministrului finanțelor nr. 2.036/2025 privind principalele aspecte legate de întocmirea și depunerea situațiilor financiare anuale și a raportărilor contabile anuale ale operatorilor economici la ANAF',
    issuer: 'Ministerul Finanțelor',
    publication: 'Monitorul Oficial nr. 41 din 20 ianuarie 2026',
    urls: ['https://static.anaf.ro/static/10/Anaf/legislatie/OMF_2036_2025.pdf'],
    fetch: true,
    snapshots: [
      {
        url: 'https://static.anaf.ro/static/10/Anaf/legislatie/OMF_2036_2025.pdf',
        sha256: '29352567d60f380bd82e73a52c3438d8777596b928773341f982343acb1e710f',
        retrievedOn: '2026-10-29',
        mediaType: 'application/pdf',
      },
    ],
  },
  {
    id: 'Norme-OUG158/2005',
    kind: 'act',
    title:
      'Normele de aplicare a OUG nr. 158/2005, aprobate prin Ordinul nr. 15/2018/1.311/2017 al ministrului sănătății și al președintelui CNAS, modificate prin Ordinul nr. 506/1.030/2026 (Monitorul Oficial nr. 507 din 19 iunie 2026, după o sursă secundară)',
    issuer: 'Ministerul Sănătății și Casa Națională de Asigurări de Sănătate',
    publication: 'Monitorul Oficial nr. 31 din 12 ianuarie 2018',
    urls: [],
    fetch: false,
    snapshots: [],
  },
  {
    id: 'L31/1990',
    kind: 'act',
    title: 'Legea nr. 31/1990 privind societățile, republicată (forma consolidată din 18.12.2025)',
    issuer: 'Parlamentul României',
    publication: 'Monitorul Oficial nr. 1066 din 17 noiembrie 2004 (republicare)',
    urls: ['https://legislatie.just.ro/Public/DetaliiDocument/798'],
    fetch: false,
    snapshots: [],
  },
  {
    id: 'HG2139/2004',
    kind: 'act',
    title:
      'Hotărârea Guvernului nr. 2.139/2004 pentru aprobarea Catalogului privind clasificarea și duratele normale de funcționare a mijloacelor fixe',
    issuer: 'Guvernul României',
    publication: 'Monitorul Oficial nr. 46 din 13 ianuarie 2005',
    urls: ['https://legislatie.just.ro/Public/DetaliiDocumentAfis/58613'],
    fetch: false,
    snapshots: [],
  },
  {
    id: 'HG1506/2024',
    kind: 'act',
    title:
      'Hotărârea Guvernului nr. 1.506/2024 pentru stabilirea salariului de bază minim brut pe țară garantat în plată',
    issuer: 'Guvernul României',
    publication: 'Monitorul Oficial nr. 1185 din 28 noiembrie 2024',
    urls: ['https://static.anaf.ro/static/10/Anaf/legislatie/HG_1506_2024.pdf'],
    fetch: true,
    snapshots: [
      {
        url: 'https://static.anaf.ro/static/10/Anaf/legislatie/HG_1506_2024.pdf',
        sha256: 'c829e477306d69e8f1e1d523baf2b6375cda7961dd34219bc36a9d6ae4d5e4f5',
        retrievedOn: '2026-10-29',
        mediaType: 'application/pdf',
      },
    ],
  },
  {
    id: 'HG146/2026',
    kind: 'act',
    title:
      'Hotărârea Guvernului nr. 146/2026 pentru stabilirea salariului de bază minim brut pe țară garantat în plată',
    issuer: 'Guvernul României',
    publication: 'Monitorul Oficial nr. 196 din 13 martie 2026',
    urls: ['https://static.anaf.ro/static/10/Anaf/legislatie/HG_146_2026.pdf'],
    fetch: true,
    snapshots: [
      {
        url: 'https://static.anaf.ro/static/10/Anaf/legislatie/HG_146_2026.pdf',
        sha256: '3dce4be85c2330ff6c79049014c538081c2e55de647125072e8b6937cc8f2488',
        retrievedOn: '2026-10-29',
        mediaType: 'application/pdf',
      },
    ],
  },
  {
    id: 'OMFP170/2015',
    kind: 'act',
    title:
      'Ordinul ministrului finanțelor publice nr. 170/2015 pentru aprobarea Reglementărilor contabile privind contabilitatea în partidă simplă (textul inițial)',
    issuer: 'Ministerul Finanțelor Publice',
    publication: 'Monitorul Oficial nr. 139 din 24 februarie 2015',
    urls: ['https://static.anaf.ro/static/10/Anaf/legislatie/OMFP_170_2015.pdf'],
    fetch: true,
    snapshots: [
      {
        url: 'https://static.anaf.ro/static/10/Anaf/legislatie/OMFP_170_2015.pdf',
        sha256: '158d5ad1647f0fc613c0315bc09fd3a99494e189d717444f01b2d95f5eedfd37',
        retrievedOn: '2026-10-30',
        mediaType: 'application/pdf',
      },
    ],
  },
  {
    id: 'OMFP3254/2017',
    kind: 'act',
    title:
      'Ordinul ministrului finanțelor publice nr. 3.254/2017 privind Registrul de evidență fiscală pentru persoanele fizice, contribuabili potrivit titlului IV din Legea nr. 227/2015 privind Codul fiscal',
    issuer: 'Ministerul Finanțelor Publice',
    publication: 'Monitorul Oficial nr. 10 din 5 ianuarie 2018',
    urls: ['https://static.anaf.ro/static/10/Anaf/legislatie/OMFP_3254_2017.pdf'],
    fetch: true,
    snapshots: [
      {
        url: 'https://static.anaf.ro/static/10/Anaf/legislatie/OMFP_3254_2017.pdf',
        sha256: '4b241a874d513dce4559dfa326afc72ff355fa91306969463d78f937d3c3b0d2',
        retrievedOn: '2026-10-30',
        mediaType: 'application/pdf',
      },
    ],
  },
  {
    id: 'L239/2025',
    kind: 'act',
    title:
      'Legea nr. 239/2025 privind stabilirea unor măsuri de redresare și eficientizare a resurselor publice, precum și pentru modificarea și completarea unor acte normative',
    issuer: 'Parlamentul României',
    publication: null,
    urls: ['https://static.anaf.ro/static/10/Anaf/legislatie/L_239_2025.pdf'],
    fetch: true,
    snapshots: [
      {
        url: 'https://static.anaf.ro/static/10/Anaf/legislatie/L_239_2025.pdf',
        sha256: '376bcec34439ffc37f2e74a83d12f828eab1ba6471e772ec6ce12dc2981ccd08',
        retrievedOn: '2026-10-30',
        mediaType: 'application/pdf',
      },
    ],
  },
  {
    id: 'OPANAF2736/2025',
    kind: 'act',
    title:
      'Ordinul președintelui ANAF nr. 2.736/2025 pentru aprobarea modelului, conținutului, modalității de depunere și de gestionare a formularului 212 "Declarație unică privind impozitul pe venit și contribuțiile sociale datorate de persoanele fizice" (veniturile anului 2025)',
    issuer: 'ANAF',
    publication: 'Monitorul Oficial nr. 1207 bis din 29 decembrie 2025',
    urls: ['https://static.anaf.ro/static/10/Anaf/legislatie/OPANAF_2736_2025.pdf'],
    fetch: true,
    snapshots: [
      {
        url: 'https://static.anaf.ro/static/10/Anaf/legislatie/OPANAF_2736_2025.pdf',
        sha256: '6d1afc4fdd317662d8982421e5df745abaf7796300cf144670f424a68ccae3f0',
        retrievedOn: '2026-10-30',
        mediaType: 'application/pdf',
      },
    ],
  },
  {
    id: 'OUG44/2008',
    kind: 'act',
    title:
      'Ordonanța de urgență a Guvernului nr. 44/2008 privind desfășurarea activităților economice de către persoanele fizice autorizate, întreprinderile individuale și întreprinderile familiale (forma consolidată ONRC la 17.01.2017; modificările ulterioare nu sunt verificate)',
    issuer: 'Guvernul României',
    publication: 'Monitorul Oficial nr. 328 din 25 aprilie 2008',
    urls: ['https://www.onrc.ro/documente/legislatie/15.11.2017/OUG%20NR.%2044%20-%202008.docx'],
    fetch: true,
    snapshots: [
      {
        url: 'https://www.onrc.ro/documente/legislatie/15.11.2017/OUG%20NR.%2044%20-%202008.docx',
        sha256: '2ff04cbad6fd4aede526d8ee706398a4ec3257ad10dc9daa46c1fbae4af496e8',
        retrievedOn: '2026-10-30',
        mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      },
    ],
  },
  {
    id: 'OPANAF97/2019',
    kind: 'act',
    title:
      'Ordinul președintelui ANAF nr. 97/2019 pentru aprobarea modelului și conținutului formularului 204 "Declarație anuală de venit pentru asocieri fără personalitate juridică și entități supuse regimului transparenței fiscale"',
    issuer: 'ANAF',
    publication: null,
    urls: ['https://static.anaf.ro/static/10/Anaf/legislatie/OPANAF_97_2019.pdf'],
    fetch: true,
    snapshots: [
      {
        url: 'https://static.anaf.ro/static/10/Anaf/legislatie/OPANAF_97_2019.pdf',
        sha256: 'd389db58065d6de85c119cca7d1aadc3fd9bf3a659f5caef83d55de76cfecdf0',
        retrievedOn: '2026-10-30',
        mediaType: 'application/pdf',
      },
    ],
  },
  {
    id: 'OPANAF470/2021',
    kind: 'act',
    title:
      'Ordinul președintelui ANAF nr. 470/2021 pentru aprobarea modelului și conținutului formularului 204 "Declarație anuală de venit pentru asocieri fără personalitate juridică și entități supuse regimului transparenței fiscale" (veniturile din 2020)',
    issuer: 'ANAF',
    publication: null,
    urls: ['https://static.anaf.ro/static/10/Anaf/legislatie/OPANAF_470_2021.pdf'],
    fetch: true,
    snapshots: [
      {
        url: 'https://static.anaf.ro/static/10/Anaf/legislatie/OPANAF_470_2021.pdf',
        sha256: '6e22afaee25f50f3bcf928a39992db3f3cc6a953d907d3f377fc674609393fb9',
        retrievedOn: '2026-10-30',
        mediaType: 'application/pdf',
      },
    ],
  },
  {
    id: 'OPANAF90/2022',
    kind: 'act',
    title:
      'Ordinul președintelui ANAF nr. 90/2022 pentru modificarea anexei nr. 1 (formularul 204) la OPANAF nr. 470/2021 (veniturile din 2022)',
    issuer: 'ANAF',
    publication: null,
    urls: ['https://static.anaf.ro/static/10/Anaf/legislatie/OPANAF_90_2022.pdf'],
    fetch: true,
    snapshots: [
      {
        url: 'https://static.anaf.ro/static/10/Anaf/legislatie/OPANAF_90_2022.pdf',
        sha256: 'd6148e2397db765f1106d4609092688a11d7a1bfdb1ae911881003896f7339bf',
        retrievedOn: '2026-10-30',
        mediaType: 'application/pdf',
      },
    ],
  },
  {
    id: 'ANAF/D204-structura-2025',
    kind: 'official_document',
    title:
      'Structura fișierului XML al declarației 204 pentru an >= 2018 (declaratie:v3), actualizată la 15.01.2026',
    issuer: 'ANAF',
    publication: null,
    urls: [
      'https://static.anaf.ro/static/10/Anaf/Declaratii_R/AplicatiiDec/structura_D204_2025_150126.pdf',
    ],
    fetch: true,
    snapshots: [
      {
        url: 'https://static.anaf.ro/static/10/Anaf/Declaratii_R/AplicatiiDec/structura_D204_2025_150126.pdf',
        sha256: '1aa53edc1e1b35c5e52d042d3635b9d152690f373661c3425760a12421a44f3a',
        retrievedOn: '2026-10-30',
        mediaType: 'application/pdf',
      },
    ],
  },
  {
    id: 'OUG89/2025',
    kind: 'act',
    title: 'Ordonanța de urgență a Guvernului nr. 89/2025',
    issuer: 'Guvernul României',
    publication: 'Monitorul Oficial nr. 1203 din 24 decembrie 2025',
    urls: ['https://static.anaf.ro/static/10/Anaf/legislatie/OUG_89_2025.pdf'],
    fetch: true,
    snapshots: [
      {
        url: 'https://static.anaf.ro/static/10/Anaf/legislatie/OUG_89_2025.pdf',
        sha256: '135051fde8008bcddc8982586827fbfaddc49a57c1fa50b25d8dc4521e7ba728',
        retrievedOn: '2026-10-29',
        mediaType: 'application/pdf',
      },
    ],
  },
  ...annualSources,
  ...profitSources,
  ...nonpayerSources,
  ...exemptSources,
  ...taxAccountSources,
  ...saftSources,
  ...withholdingSources,
  ...receiptSources,
  ...schemeSources,
  ...ossSources,
  ...yearEndSources,
  ...stockSources,
  ...payrollSources,
  ...tradeSources,
  ...retailSources,
  ...productionSources,
];

export const clauses: readonly Clause[] = [
  {
    id: 'ANAF/Cod-fiscal-consolidat:art.64(1)(b)',
    source: 'ANAF/Cod-fiscal-consolidat',
    locator: 'art. 64 alin. (1) lit. b)',
    status: 'located',
    summary:
      'Cota impozitului pe venit este 10% pentru veniturile din salarii și asimilate salariilor.',
  },
  {
    id: 'ANAF/Cod-fiscal-consolidat:norme.art.64.pct.4',
    source: 'ANAF/Cod-fiscal-consolidat',
    locator: 'normele metodologice, titlul IV, pct. 4 (aplicarea art. 64)',
    status: 'located',
    summary:
      'Bazele de calcul al impozitului se rotunjesc la leu: fracțiunile de până la 50 de bani inclusiv se neglijează, cele peste 50 de bani se majorează la leu.',
  },
  {
    id: 'ANAF/Cod-fiscal-consolidat:art.76(3)(h)',
    source: 'ANAF/Cod-fiscal-consolidat',
    locator: 'art. 76 alin. (3) lit. h)',
    status: 'located',
    summary:
      'Tichetele de masă, voucherele de vacanță și celelalte bilete de valoare acordate potrivit legii sunt venituri din salarii.',
  },
  {
    id: 'ANAF/Cod-fiscal-consolidat:art.77',
    source: 'ANAF/Cod-fiscal-consolidat',
    locator: 'art. 77 alin. (1)–(4) și (10)',
    status: 'located',
    summary:
      'Deducerea personală la funcția de bază: de bază, după tabelul procentelor din salariul minim pentru venituri brute de până la salariul minim + 2.000 lei și numărul persoanelor în întreținere; suplimentară, 15% din salariul minim până la 26 de ani și 100 lei pentru fiecare copil înscris la școală.',
  },
  {
    id: 'ANAF/Cod-fiscal-consolidat:norme.art.77.pct.13(14)',
    source: 'ANAF/Cod-fiscal-consolidat',
    locator: 'normele metodologice, titlul IV, pct. 13 alin. (14)',
    status: 'located',
    summary:
      'Deducerea personală nu se fracționează pentru contractele cu timp parțial la funcția de bază.',
  },
  {
    id: 'ANAF/Cod-fiscal-consolidat:art.78(2)(a)',
    source: 'ANAF/Cod-fiscal-consolidat',
    locator: 'art. 78 alin. (2) lit. a)',
    status: 'located',
    summary:
      'Impozitul lunar la funcția de bază: 10% din venitul net (brut minus contribuțiile sociale) minus deducerea personală și cotizația sindicală.',
  },
  {
    id: 'ANAF/Cod-fiscal-consolidat:art.138(a)',
    source: 'ANAF/Cod-fiscal-consolidat',
    locator: 'art. 138 lit. a)',
    status: 'located',
    summary: 'Cota contribuției de asigurări sociale datorate de angajați este 25%.',
  },
  {
    id: 'ANAF/Cod-fiscal-consolidat:art.139(1)',
    source: 'ANAF/Cod-fiscal-consolidat',
    locator: 'art. 139 alin. (1)',
    status: 'located',
    summary: 'Baza lunară a CAS este câștigul brut din salarii și venituri asimilate.',
  },
  {
    id: 'ANAF/Cod-fiscal-consolidat:art.76(1)',
    source: 'ANAF/Cod-fiscal-consolidat',
    locator: 'art. 76 alin. (1)',
    status: 'located',
    summary:
      'Venituri din salarii sunt toate veniturile obținute în baza contractului individual de muncă, indiferent de denumirea lor.',
  },
  {
    id: 'ANAF/Cod-fiscal-consolidat:art.139(1)(o)',
    source: 'ANAF/Cod-fiscal-consolidat',
    locator: 'art. 139 alin. (1) lit. o)',
    status: 'located',
    summary:
      'Baza CAS cuprinde indemnizațiile de asigurări sociale de sănătate suportate de angajator sau din FNUASS.',
  },
  {
    id: 'ANAF/Cod-fiscal-consolidat:art.157(1)(v)',
    source: 'ANAF/Cod-fiscal-consolidat',
    locator: 'art. 157 alin. (1) lit. v) și art. 155 alin. (1) lit. i)',
    status: 'located',
    summary:
      'Baza CASS cuprinde indemnizațiile de asigurări sociale de sănătate pentru codurile de indemnizație 01, 07 și 10.',
  },
  {
    id: 'ANAF/Cod-fiscal-consolidat:art.220^5',
    source: 'ANAF/Cod-fiscal-consolidat',
    locator: 'art. 220^5',
    status: 'located',
    summary:
      'CAM nu se datorează pentru prestațiile suportate din bugetul asigurărilor sociale de stat, al asigurărilor pentru șomaj și din FNUASS.',
  },
  {
    id: 'ANAF/Cod-fiscal-consolidat:art.142(r)',
    source: 'ANAF/Cod-fiscal-consolidat',
    locator: 'art. 142 lit. r)',
    status: 'located',
    summary: 'Tichetele de masă și voucherele de vacanță nu intră în baza lunară a CAS.',
  },
  {
    id: 'ANAF/Cod-fiscal-consolidat:art.146(5^6)-(5^9)',
    source: 'ANAF/Cod-fiscal-consolidat',
    locator: 'art. 146 alin. (5^6)–(5^9)',
    status: 'located',
    summary:
      'CAS nu poate fi mai mică decât cea calculată la salariul minim pentru zilele lucrătoare în care contractul a fost activ, cu excepțiile de la alin. (5^7); diferența o suportă angajatorul.',
  },
  {
    id: 'ANAF/Cod-fiscal-consolidat:art.156',
    source: 'ANAF/Cod-fiscal-consolidat',
    locator: 'art. 156',
    status: 'located',
    summary: 'Cota contribuției de asigurări sociale de sănătate este 10%.',
  },
  {
    id: 'ANAF/Cod-fiscal-consolidat:art.157',
    source: 'ANAF/Cod-fiscal-consolidat',
    locator: 'art. 157 alin. (1) și (2)',
    status: 'located',
    summary:
      'Baza lunară a CASS este câștigul brut, inclusiv valoarea nominală a tichetelor de masă și a voucherelor de vacanță.',
  },
  {
    id: 'ANAF/Cod-fiscal-consolidat:art.168(6^1)',
    source: 'ANAF/Cod-fiscal-consolidat',
    locator: 'art. 168 alin. (6^1)',
    status: 'located',
    summary: 'Minimul calculat la salariul minim (art. 146 alin. (5^6)–(5^9)) se aplică și CASS.',
  },
  {
    id: 'ANAF/Cod-fiscal-consolidat:art.220^3(1)',
    source: 'ANAF/Cod-fiscal-consolidat',
    locator: 'art. 220^3 alin. (1)',
    status: 'located',
    summary: 'Cota contribuției asiguratorii pentru muncă este 2,25%.',
  },
  {
    id: 'ANAF/Cod-fiscal-consolidat:art.220^4',
    source: 'ANAF/Cod-fiscal-consolidat',
    locator: 'art. 220^4',
    status: 'located',
    summary: 'Baza CAM este câștigul brut din salarii, fără sumele de la art. 142.',
  },
  {
    id: 'ANAF/Cod-fiscal-consolidat:art.291(1)',
    source: 'ANAF/Cod-fiscal-consolidat',
    locator: 'art. 291 alin. (1)',
    status: 'located',
    summary: 'Cota standard de TVA este 21%.',
  },
  {
    id: 'ANAF/Cod-fiscal-consolidat:art.291(2)',
    source: 'ANAF/Cod-fiscal-consolidat',
    locator: 'art. 291 alin. (2)',
    status: 'located',
    summary: 'Cota redusă de TVA este 11%, pentru livrările și prestările enumerate.',
  },
  // Clauses the review packets' readings rely on (src/ro/reviews/specs); located in the snapshot.
  {
    id: 'ANAF/Cod-fiscal-consolidat:art.291(4)-(6)',
    source: 'ANAF/Cod-fiscal-consolidat',
    locator: 'art. 291 alin. (4)–(6)',
    status: 'located',
    summary:
      'Cota aplicabilă este cea în vigoare la data faptului generator, cu excepția cazurilor de la art. 282 alin. (2), pentru care se aplică cota de la data exigibilității; la schimbarea cotei, acestea se regularizează la cota de la data livrării sau prestării.',
  },
  {
    id: 'ANAF/Cod-fiscal-consolidat:art.281(1)',
    source: 'ANAF/Cod-fiscal-consolidat',
    locator: 'art. 281 alin. (1)',
    status: 'located',
    summary:
      'Faptul generator intervine la data livrării bunurilor sau la data prestării serviciilor.',
  },
  {
    id: 'ANAF/Cod-fiscal-consolidat:art.281(12)',
    source: 'ANAF/Cod-fiscal-consolidat',
    locator: 'art. 281 alin. (12)',
    status: 'located',
    summary:
      'Prestările de servicii care nu sunt de la alin. (7)–(10) (decontări succesive, prestări continue, taxare inversă pe mai mult de un an) se consideră efectuate la data finalizării lor.',
  },
  {
    id: 'ANAF/Cod-fiscal-consolidat:art.282(1)',
    source: 'ANAF/Cod-fiscal-consolidat',
    locator: 'art. 282 alin. (1)',
    status: 'located',
    summary: 'Exigibilitatea taxei intervine la data la care are loc faptul generator.',
  },
  {
    id: 'ANAF/Cod-fiscal-consolidat:art.282(9)',
    source: 'ANAF/Cod-fiscal-consolidat',
    locator: 'art. 282 alin. (9) și normele, pct. 25 alin. (2)',
    status: 'located',
    summary:
      'La ajustările bazei de impozitare (art. 287), taxa este exigibilă la data evenimentului, cu regimul, cotele și cursul operațiunii de bază; dacă aceasta nu poate fi determinată, cu cele de la data evenimentului.',
  },
  {
    id: 'ANAF/Cod-fiscal-consolidat:art.282(2)',
    source: 'ANAF/Cod-fiscal-consolidat',
    locator: 'art. 282 alin. (2)',
    status: 'located',
    summary:
      'Prin excepție, exigibilitatea intervine la emiterea facturii sau la încasarea avansului înainte de faptul generator, ori la extragerea numerarului din automate.',
  },
  {
    id: 'ANAF/Cod-fiscal-consolidat:L141/2025.art.III',
    source: 'ANAF/Cod-fiscal-consolidat',
    locator: 'nota de sub art. 291 alin. (2): Legea nr. 141/2025 art. III, reprodus în textul ANAF',
    status: 'located',
    summary:
      'Cota de 9% pentru o singură locuință cumpărată de o persoană fizică între 01.08.2025 și 31.07.2026, cu act de avans încheiat până la 01.08.2025, și pentru clădirile livrate primăriilor până la 01.08.2026.',
  },
  {
    id: 'ANAF/Cod-fiscal-consolidat:art.54(1)',
    source: 'ANAF/Cod-fiscal-consolidat',
    locator: 'art. 54 alin. (1)',
    status: 'located',
    summary:
      'Limita veniturilor se verifică pe cifra de afaceri; pentru art. 52 alin. (1) se adaugă veniturile din transferul mijloacelor fixe sau al terenurilor când în cursul anului se transferă mai mult de un activ din aceeași subgrupă sau mai mult de un teren.',
  },
  {
    id: 'ANAF/Cod-fiscal-consolidat:art.47(1)(c)',
    source: 'ANAF/Cod-fiscal-consolidat',
    locator: 'art. 47 alin. (1) lit. c) și art. 54 alin. (3)',
    status: 'located',
    summary:
      'Microîntreprinderea a realizat la 31 decembrie a anului precedent venituri de cel mult echivalentul a 100.000 euro (de la 1 ianuarie 2026), la cursul de la închiderea exercițiului financiar.',
  },
  {
    id: 'ANAF/Cod-fiscal-consolidat:art.47(1)(g)',
    source: 'ANAF/Cod-fiscal-consolidat',
    locator: 'art. 47 alin. (1) lit. g) și art. 51 alin. (4)',
    status: 'located',
    summary:
      'Microîntreprinderea are cel puțin un salariat cu normă întreagă (sau fracțiuni de normă însumând o normă, sau un contract de administrare ori mandat remunerat cel puțin cu salariul minim).',
  },
  {
    id: 'ANAF/Cod-fiscal-consolidat:art.51(1)',
    source: 'ANAF/Cod-fiscal-consolidat',
    locator: 'art. 51 alin. (1)',
    status: 'located',
    summary: 'Cota impozitului pe veniturile microîntreprinderilor este 1%.',
  },
  {
    id: 'ANAF/Cod-fiscal-consolidat:art.52(1),(5)',
    source: 'ANAF/Cod-fiscal-consolidat',
    locator: 'art. 52 alin. (1) și (5)',
    status: 'located',
    summary:
      'Peste 100.000 euro venituri în cursul anului, cumulat de la începutul anului la cursul de la închiderea exercițiului precedent, microîntreprinderea datorează impozit pe profit din trimestrul depășirii.',
  },
  {
    id: 'ANAF/Cod-fiscal-consolidat:art.53',
    source: 'ANAF/Cod-fiscal-consolidat',
    locator: 'art. 53 alin. (1) și (2)',
    status: 'located',
    summary:
      'Baza impozabilă: veniturile din orice sursă, din care se scad veniturile enumerate (stocuri, producția de imobilizări, subvenții, diferențe de curs valutar, reduceri comerciale acordate, dividende de la persoane juridice române etc.) și la care se adaugă reducerile comerciale primite și, în trimestrul IV, diferența favorabilă de curs valutar a anului.',
  },
  {
    id: 'ANAF/Cod-fiscal-consolidat:art.56(1)',
    source: 'ANAF/Cod-fiscal-consolidat',
    locator: 'art. 56 alin. (1) și (2)',
    status: 'located',
    summary:
      'Impozitul se calculează și se plătește trimestrial, până la 25 a lunii următoare trimestrului, cu declarația aferentă.',
  },
  {
    id: 'ANAF/Cod-fiscal-consolidat:art.43(2)',
    source: 'ANAF/Cod-fiscal-consolidat',
    locator: 'art. 43 alin. (1)–(3)',
    status: 'located',
    summary:
      'Dividendele plătite unei persoane juridice române se impozitează cu 16% din dividendul brut; impozitul se reține la plată și se plătește până la 25 a lunii următoare, iar pentru dividendele distribuite și neplătite până la sfârșitul anului, până la 25 ianuarie.',
  },
  {
    id: 'ANAF/Cod-fiscal-consolidat:art.43(4)',
    source: 'ANAF/Cod-fiscal-consolidat',
    locator: 'art. 43 alin. (4)',
    status: 'located',
    summary:
      'Scutirea dividendelor între persoane juridice române: beneficiarul deține cel puțin 10% de cel puțin un an și ambele plătesc, fără opțiune, impozit pe profit sau unul care îl substituie.',
  },
  {
    id: 'ANAF/Cod-fiscal-consolidat:art.97(7)',
    source: 'ANAF/Cod-fiscal-consolidat',
    locator: 'art. 97 alin. (7) și nota privind art. VII din Legea nr. 141/2025',
    status: 'located',
    summary:
      'Dividendele plătite persoanelor fizice se impozitează cu 16%, impozit final reținut la plată și virat până la 25 a lunii următoare plății, pentru dividendele distribuite începând cu 1 ianuarie 2026.',
  },
  {
    id: 'ANAF/Cod-fiscal-consolidat:art.28',
    source: 'ANAF/Cod-fiscal-consolidat',
    locator: 'art. 28 alin. (2), (5), (6) și (11)',
    status: 'located',
    summary:
      'Amortizarea fiscală: metoda liniară pentru construcții, liniară, degresivă sau accelerată pentru echipamente și computere, liniară sau degresivă pentru celelalte; începe cu luna următoare punerii în funcțiune.',
  },
  {
    id: 'OMFP1802/2014:pct.238',
    source: 'OMFP1802/2014',
    locator: 'pct. 238 alin. (1)–(3)',
    status: 'located',
    summary:
      'Amortizarea se aplică valorii de intrare, începe cu luna următoare punerii în funcțiune și continuă până la recuperarea integrală; duratele contabile, stabilite prin politicile contabile, pot diferi de cele fiscale.',
  },
  {
    id: 'L53/2003-A:art.139',
    source: 'L53/2003-A',
    locator: 'art. 139 alin. (1)',
    status: 'located',
    summary:
      'Zilele de sărbătoare legală nelucrătoare: 1, 2, 6, 7 și 24 ianuarie, Vinerea Mare, prima și a doua zi de Paști, 1 mai, 1 iunie, prima și a doua zi de Rusalii, 15 august, 30 noiembrie, 1 decembrie, prima și a doua zi de Crăciun.',
  },
  {
    id: 'L53/2003-A:art.150',
    source: 'L53/2003-A',
    locator: 'art. 150 alin. (1)–(2)',
    status: 'located',
    summary:
      'Indemnizația de concediu de odihnă: media zilnică a salariului de bază, a indemnizațiilor și sporurilor cu caracter permanent din ultimele 3 luni, înmulțită cu zilele de concediu, cel puțin salariul de bază pentru perioada respectivă.',
  },
  {
    id: 'OUG70/2024:art.5',
    source: 'OUG70/2024',
    locator: 'art. 5 alin. (1)–(3)',
    status: 'located',
    summary:
      'Diferențe semnificative între decont și decontul precompletat RO e-TVA: cel puțin 20% și cel puțin 1.000 lei, cumulativ, pe rândurile decontului, la coloana TVA (sau Valoare, unde nu există TVA), fără rândurile de regularizări.',
  },
  {
    id: 'OUG89/2025:art.XII-XIII',
    source: 'OUG89/2025',
    locator: 'art. XII și art. XIII',
    status: 'located',
    summary:
      'De la 1 ianuarie 2026 se abrogă art. 5 alin. (8) și (10), art. 7 și art. 8 alin. (1) și (3) din OUG nr. 70/2024; pentru persoanele care aplică TVA la încasare, art. 5 și 8 se suspendă până la 30 septembrie 2026.',
  },
  {
    id: 'OUG158/2005-A:art.10(1)',
    source: 'OUG158/2005-A',
    locator: 'art. 10 alin. (1) și (8)',
    status: 'located',
    summary:
      'Baza de calcul a indemnizației este media veniturilor brute lunare din ultimele 6 luni din cele 12 ale stagiului, până la 12 salarii minime brute pe țară lunar; din durata concediului, în zile calendaristice, se plătesc zilele lucrătoare.',
  },
  {
    id: 'OUG158/2005-A:art.12',
    source: 'OUG158/2005-A',
    locator: 'art. 12',
    status: 'located',
    summary:
      'Indemnizația pentru incapacitate temporară de muncă se suportă de angajator din prima până în a 5-a zi și din FNUASS din ziua următoare; pentru persoanele cu măsura izolării (Legea nr. 136/2020), din FNUASS din prima zi.',
  },
  {
    id: 'OUG158/2005-A:art.17(1)',
    source: 'OUG158/2005-A',
    locator: 'art. 17 alin. (1) și (1^2)',
    status: 'located',
    summary:
      'Pentru boli obișnuite sau accidente în afara muncii, pe fiecare episod: 55% din baza de calcul pentru certificatele de până la 7 zile, 65% pentru cele între 8 și 14 zile, 75% pentru cele de peste 15 zile. Din 1 iulie 2026, diferențele rezultate din recalcularea unui episod prelungit în luna următoare se includ în veniturile lunii în care se determină (alin. (1^2)).',
  },
  {
    id: 'OMF2036/2025:anexa4.pct6',
    source: 'OMF2036/2025',
    locator: 'anexa nr. 4 pct. 6, cap. XIX din datele informative (F30)',
    status: 'located',
    summary:
      'Situația veniturilor și cheltuielilor din datele informative ale microentităților, cu conturile fiecărui rând; legată de contul de profit și pierdere (F20) prin regulile validatorului S1005.',
  },
  {
    id: 'OUG158/2005-A:nota.OUG91-2025.art.II',
    source: 'OUG158/2005-A',
    locator:
      'nota după art. 51: OUG nr. 91/2025 art. II alin. (1), (1^1), (4) și (5), cu modificările Legii nr. 64/2026',
    status: 'located',
    summary:
      'Pentru certificatele eliberate între 1 februarie 2026 și 31 decembrie 2027 indemnizația se diminuează cu o zi, o singură dată pe episod; angajatorul suportă zilele 2–6, FNUASS de a doua zi după acestea. Nu se diminuează concediile de la art. 2 alin. (1) lit. c), d^1) și e), pentru pacienții din programele naționale de sănătate și pentru cei internați.',
  },
  {
    id: 'Norme-OUG158/2005:art.73',
    source: 'Norme-OUG158/2005',
    locator:
      'art. 73 alin. (1) (citit doar într-o sursă secundară; textul oficial este de obținut)',
    status: 'pending',
    summary:
      'Media zilnică a bazei de calcul este raportul dintre veniturile din ultimele 6 luni pentru care s-a plătit contribuția și numărul zilelor de stagiu din acestea, cel mult zilele lucrătoare ale fiecărei luni; indemnizația este media zilnică × procentul × (zilele lucrătoare ale concediului minus prima zi lucrătoare, când se diminuează).',
  },
  {
    id: 'L31/1990:art.183',
    source: 'L31/1990',
    locator: 'art. 183 alin. (1)–(2) (citit pe portalul legislativ, forma din 18.12.2025)',
    status: 'pending',
    summary:
      'Din profitul societății se preiau în fiecare an cel puțin 5% pentru fondul de rezervă, până ce acesta atinge cel puțin o cincime din capitalul social; un fond micșorat se completează.',
  },
  {
    id: 'HG2139/2004:catalog',
    source: 'HG2139/2004',
    locator:
      'anexa: Catalogul privind clasificarea și duratele normale de funcționare a mijloacelor fixe',
    status: 'pending',
    summary:
      'Codul de clasificare și intervalul duratei normale de funcționare a fiecărui mijloc fix.',
  },
  {
    id: 'OMFP1243/2018:art.1,4',
    source: 'OMFP1243/2018',
    locator: 'art. 1 și art. 4',
    status: 'located',
    summary:
      'Introduce în planul de conturi conturile 4315, 4316, 436 (pasiv) și 646, pentru contribuțiile datorate pentru veniturile realizate de la 1 ianuarie 2018.',
  },
  {
    id: 'ANAF/D112-0726:salariul-minim',
    source: 'ANAF/D112-0726',
    locator: 'modificări: Suma300, Suma200, salMin și suma limită B2_5P',
    status: 'located',
    summary:
      'Salariul minim 4.050 lei (01–06/2026) și 4.325 lei (07–12/2026); suma care nu se include în baze 300 lei (01–06/2026) și 200 lei (07–12/2026), cu plafonul venitului de 4.300, respectiv 4.600 lei; suma limită pentru contribuția minimă: (salariul minim − suma) / zile lucrătoare × zile, la leu.',
  },
  {
    id: 'OUG156/2024:art.LXVI',
    source: 'OUG156/2024',
    locator: 'art. LXVI',
    status: 'located',
    summary:
      'În 2025, pentru salariații cu normă întreagă, la funcția de bază, cu salariul de bază egal cu salariul minim (nediminuat după intrarea în vigoare a ordonanței) și venitul brut fără tichete de cel mult 4.300 lei, nu se datorează impozit și contribuții pentru 300 lei pe lună; salariul minim pentru contribuția minimă se diminuează cu 300 lei.',
  },
  {
    id: 'HG1506/2024:art.1',
    source: 'HG1506/2024',
    locator: 'art. 1',
    status: 'located',
    summary:
      'Salariul de bază minim brut pe țară garantat în plată este 4.050 lei lunar de la 1 ianuarie 2025.',
  },
  {
    id: 'HG146/2026:art.1',
    source: 'HG146/2026',
    locator: 'art. 1 și art. 2',
    status: 'located',
    summary:
      'Salariul de bază minim brut pe țară garantat în plată este 4.325 lei lunar de la 1 iulie 2026; la aceeași dată se abrogă HG nr. 1.506/2024.',
  },
  {
    id: 'OUG89/2025:art.III',
    source: 'OUG89/2025',
    locator: 'art. III',
    status: 'located',
    summary:
      'Pentru salariații cu normă întreagă, la funcția de bază, cu salariul de bază egal cu salariul minim (și nediminuat de la intrarea în vigoare a ordonanței) și venitul brut fără tichete și indemnizația de hrană de cel mult 4.300 lei (01–06/2026), respectiv 4.600 lei (07–12/2026), nu se datorează impozit și contribuții pentru 300 lei, respectiv 200 lei pe lună, diminuați în funcție de perioada lucrată; salariul minim pentru contribuția minimă se diminuează cu aceeași sumă.',
  },
  {
    id: 'ANAF/Cod-fiscal-consolidat:art.64(1)(a)',
    source: 'ANAF/Cod-fiscal-consolidat',
    locator: 'art. 64 alin. (1) lit. a)',
    status: 'located',
    summary:
      'Cota impozitului pe venit este 10% pentru venitul impozabil din activități independente, pe fiecare sursă.',
  },
  {
    id: 'ANAF/Cod-fiscal-consolidat:art.66',
    source: 'ANAF/Cod-fiscal-consolidat',
    locator: 'art. 66',
    status: 'located',
    summary:
      'Sumele se rotunjesc la un leu: fracțiunile de până la 50 de bani inclusiv se neglijează, cele peste 50 de bani se majorează la leu.',
  },
  {
    id: 'ANAF/Cod-fiscal-consolidat:art.68(2)-(3)',
    source: 'ANAF/Cod-fiscal-consolidat',
    locator: 'art. 68 alin. (2) și (3)',
    status: 'located',
    summary:
      'Venitul brut cuprinde sumele încasate și echivalentul în lei al veniturilor în natură, dobânzile din creanțe comerciale, câștigurile din transferul activelor afacerii, veniturile din anularea datoriilor; nu sunt venit brut aporturile, creditele și împrumuturile, despăgubirile, sponsorizările, mecenatul și donațiile primite.',
  },
  {
    id: 'ANAF/Cod-fiscal-consolidat:art.68(4)',
    source: 'ANAF/Cod-fiscal-consolidat',
    locator: 'art. 68 alin. (4)',
    status: 'located',
    summary:
      'Cheltuielile se deduc dacă sunt efectuate în cadrul activității, justificate prin documente, plătite în anul fiscal, cheltuieli cu salariile potrivit cap. III, cu respectarea regulilor de amortizare din titlul II.',
  },
  {
    id: 'ANAF/Cod-fiscal-consolidat:art.68(5)-(6)',
    source: 'ANAF/Cod-fiscal-consolidat',
    locator: 'art. 68 alin. (5) și (6)',
    status: 'located',
    summary:
      'Cheltuieli deductibile limitat: burse private 5% și protocol 2% din baza de calcul (venitul brut minus cheltuielile deductibile, altele decât acestea), cheltuieli sociale 5% din cheltuielile cu salariile, pensii facultative, ocupaționale și PEPP, asigurări de sănătate și ETF câte 400 euro anual pe persoană, cotizații la asociații profesionale 4.000 euro anual, contribuții profesionale obligatorii 5% din venitul brut, abonamente sportive 100 euro anual pe persoană; contribuțiile datorate ca angajator, fără o limită numerică.',
  },
  {
    id: 'ANAF/Cod-fiscal-consolidat:art.68(7)',
    source: 'ANAF/Cod-fiscal-consolidat',
    locator: 'art. 68 alin. (7)',
    status: 'located',
    summary:
      'Nu sunt deductibile: uzul personal, impozitul pe venit, donațiile, amenzile și majorările datorate autorităților, ratele creditelor, achizițiile de bunuri amortizabile din Registrul-inventar, sponsorizările și 50% din cheltuielile cu vehiculele de cel mult 3.500 kg și 9 scaune neutilizate exclusiv în activitate (fără amortizare; excepțiile 1–5 integral).',
  },
  {
    id: 'ANAF/Cod-fiscal-consolidat:art.69(3),(9)',
    source: 'ANAF/Cod-fiscal-consolidat',
    locator: 'art. 69 alin. (3) și (9)',
    status: 'located',
    summary:
      'Norma de venit nu poate fi mai mică decât 12 salarii minime brute pe țară în vigoare la 1 ianuarie a anului de realizare a venitului; venitul brut de peste 25.000 euro (cursul mediu anual BNR) în anul anterior obligă la sistemul real din anul următor.',
  },
  {
    id: 'ANAF/Cod-fiscal-consolidat:art.69^1',
    source: 'ANAF/Cod-fiscal-consolidat',
    locator: 'art. 69^1',
    status: 'located',
    summary:
      'Opțiunea pentru sistemul real se exercită prin declarația unică până la termenul de la art. 122 alin. (3), este obligatorie 2 ani fiscali consecutivi (anul declarației de opțiune și cel următor) și se reînnoiește tacit dacă nu se solicită revenirea.',
  },
  {
    id: 'ANAF/Cod-fiscal-consolidat:art.69^2',
    source: 'ANAF/Cod-fiscal-consolidat',
    locator: 'art. 69^2 alin. (1)',
    status: 'located',
    summary:
      'Impozitul anual pentru venitul din norme de venit este 10% din norma anuală de venit ajustată.',
  },
  {
    id: 'ANAF/Cod-fiscal-consolidat:art.118(2)-(2^4)',
    source: 'ANAF/Cod-fiscal-consolidat',
    locator: 'art. 118 alin. (2), (2^2), (2^3) și (2^4)',
    status: 'located',
    summary:
      'Venitul net anual impozabil: suma veniturilor nete recalculate (după pierderile reportate), minus CAS și CASS deductibile, fiecare proporțional cu ponderea venitului net din sistemul real în totalul cumulat potrivit art. 148 alin. (3), respectiv art. 170 alin. (1), fără diferența de CASS de la art. 174 alin. (6), cel mult venitul net anual recalculat.',
  },
  {
    id: 'ANAF/Cod-fiscal-consolidat:art.118(4)-(5)',
    source: 'ANAF/Cod-fiscal-consolidat',
    locator: 'art. 118 alin. (4) și (5)',
    status: 'located',
    summary:
      'Pierderea fiscală pe fiecare sursă se reportează și se compensează în limita a 70% din veniturile nete anuale ale aceleiași surse în următorii 5 ani fiscali consecutivi, cronologic; dreptul este personal, iar pierderea necompensată după 5 ani este definitivă.',
  },
  {
    id: 'ANAF/Cod-fiscal-consolidat:art.135^1(3)',
    source: 'ANAF/Cod-fiscal-consolidat',
    locator: 'art. 135^1 alin. (3)',
    status: 'located',
    summary:
      'Pentru plafoanele și bazele anuale ale CAS și CASS (art. 148, 151, 170, 174) se ia salariul minim brut pe țară în vigoare la 1 ianuarie a anului de realizare a venitului, chiar dacă în cursul anului se modifică.',
  },
  {
    id: 'ANAF/Cod-fiscal-consolidat:art.148(1)-(4)',
    source: 'ANAF/Cod-fiscal-consolidat',
    locator: 'art. 148 alin. (1)–(4)',
    status: 'located',
    summary:
      'CAS se datorează când venitul cumulat din activități independente și drepturi de proprietate intelectuală este cel puțin 12 salarii minime, la un venit ales de cel puțin 12 salarii minime (venituri între 12 și 24 de salarii) sau 24 de salarii minime (venituri de cel puțin 24); sub plafon se poate opta pentru plată.',
  },
  {
    id: 'ANAF/Cod-fiscal-consolidat:art.150(1)',
    source: 'ANAF/Cod-fiscal-consolidat',
    locator: 'art. 150 alin. (1)',
    status: 'located',
    summary:
      'Persoanele asigurate în sisteme proprii de asigurări sociale și pensionarii nu datorează CAS pentru veniturile din activități independente.',
  },
  {
    id: 'ANAF/Cod-fiscal-consolidat:art.170(1)',
    source: 'ANAF/Cod-fiscal-consolidat',
    locator: 'art. 170 alin. (1)',
    status: 'located',
    summary:
      'CASS pentru veniturile din activități independente se datorează la o bază anuală egală cu suma veniturilor nete sau a normelor de venit, de cel mult 72 de salarii minime brute pe țară; pierderile fiscale nu se iau în considerare.',
  },
  {
    id: 'ANAF/Cod-fiscal-consolidat:norme.art.69.pct.8(5)',
    source: 'ANAF/Cod-fiscal-consolidat',
    locator: 'normele metodologice, titlul IV pct. 8 alin. (5)',
    status: 'located',
    summary:
      'Într-o asociere fără personalitate juridică, norma anuală de venit a fiecărui asociat nu poate fi mai mică de 12 salarii minime (în vigoare la stabilirea ei); fiecare membru aplică criteriile de corecție normei de venit proprii.',
  },
  {
    id: 'ANAF/Cod-fiscal-consolidat:art.170(2)-(3)',
    source: 'ANAF/Cod-fiscal-consolidat',
    locator: 'art. 170 alin. (2)–(3)',
    status: 'located',
    summary:
      'CASS pentru veniturile de la art. 155 alin. (1) lit. c)–h) (drepturi de proprietate intelectuală, asocieri cu persoane juridice, cedarea folosinței bunurilor, investiții, agricultură, alte surse) se datorează dacă venitul cumulat este de cel puțin 6 salarii minime, la o bază de 6, 12 sau 24 de salarii minime după pragul atins.',
  },
  {
    id: 'ANAF/Cod-fiscal-consolidat:art.174(1)-(8)',
    source: 'ANAF/Cod-fiscal-consolidat',
    locator: 'art. 174 alin. (1), (2), (6), (7) și (8)',
    status: 'located',
    summary:
      'CASS este 10% din baza art. 170 alin. (1); nu se datorează pentru pierdere sau venit net zero; sub 6 salarii minime se datorează până la 6 salarii, cu excepția celor cu salarii de cel puțin 6 salarii minime, alte venituri pentru care datorează CASS la cel puțin 6 salarii, pensii sau care în anul precedent au fost exceptați ori au optat.',
  },
  {
    id: 'ANAF/Cod-fiscal-consolidat:norme.art.68.pct.7(1)-(2)',
    source: 'ANAF/Cod-fiscal-consolidat',
    locator: 'normele metodologice, titlul IV, pct. 7 alin. (1)–(2)',
    status: 'located',
    summary:
      'Venitul brut include încasările în avans pentru alte exerciții, dobânzile bancare pentru disponibilitățile afacerii, facturile încasate după încetare și bunurile trecute în patrimoniul personal, la prețul pieței.',
  },
  {
    id: 'ANAF/Cod-fiscal-consolidat:norme.art.68.pct.7(4)-(5)',
    source: 'ANAF/Cod-fiscal-consolidat',
    locator: 'normele metodologice, titlul IV, pct. 7 alin. (4) și (5)',
    status: 'located',
    summary:
      'Se deduc cheltuielile din evidența contabilă cu respectarea art. 68 alin. (4)–(7): materii prime, mărfuri, servicii, chirii, dobânzi și comisioane bancare, asigurări, utilități, salarii, impozite și taxe altele decât impozitul pe venit, amortizarea, valoarea neamortizată a bunurilor înstrăinate în limita venitului, plățile în avans pentru perioade următoare.',
  },
  {
    id: 'ANAF/Cod-fiscal-consolidat:norme.art.68.pct.7(6)-(7)',
    source: 'ANAF/Cod-fiscal-consolidat',
    locator: 'normele metodologice, titlul IV, pct. 7 alin. (6) și (7)',
    status: 'located',
    summary:
      'Limitele în euro se transformă la cursul mediu BNR al anului plății; vehiculele se consideră utilizate exclusiv în activitate după regulile pct. 68 din normele art. 298, dovedit prin foaia de parcurs; limitarea la 50% cuprinde impozitele locale, RCA, ITP, rovinieta, nu și amortizarea.',
  },
  {
    id: 'ANAF/Cod-fiscal-consolidat:norme.art.69.pct.8(6)-(14)',
    source: 'ANAF/Cod-fiscal-consolidat',
    locator: 'normele metodologice, titlul IV, pct. 8 alin. (6), (7), (10) și (14)',
    status: 'located',
    summary:
      'Norma de venit se ajustează cu coeficienții de corecție publicați, luându-se coeficientul cel mai mare de majorare și cel mai mare de reducere; pentru o parte de an se raportează la 365 de zile și se înmulțește cu zilele de activitate. Exemplu: normă 23.000 lei, majorare 25%, reducere 60% din norma majorată: venit net 11.500 lei, impozit 1.150 lei.',
  },
  {
    id: 'ANAF/Cod-fiscal-consolidat:norme.art.118.pct.35(9)',
    source: 'ANAF/Cod-fiscal-consolidat',
    locator: 'normele metodologice, titlul IV, pct. 35 alin. (9), exemplul 1',
    status: 'located',
    summary:
      'Exemplu (2018): pierdere reportată 45.000 lei compensată integral cu venitul net de 60.000 lei al aceleiași surse, plus 30.000 lei din altă sursă, minus CAS de 6.250 lei: venit net impozabil 38.750 lei, impozit 3.875 lei; exemplul precedă limita de 70% și deducerea proporțională a CAS.',
  },
  {
    id: 'L239/2025:art.XII.pct.6',
    source: 'L239/2025',
    locator: 'art. XII pct. 6 (art. 69 alin. (3) din Codul fiscal)',
    status: 'located',
    summary:
      'Norma de venit nu poate fi mai mică decât 12 salarii minime brute în vigoare la 1 ianuarie a anului de realizare a venitului.',
  },
  {
    id: 'L239/2025:art.XII.pct.18',
    source: 'L239/2025',
    locator: 'art. XII pct. 18 (art. 148 alin. (3) din Codul fiscal)',
    status: 'located',
    summary:
      'Încadrarea în plafoanele CAS de 12 și 24 de salarii minime cumulează veniturile nete și normele din activități independente (art. 68, 68^3, 69), veniturile din contracte de activitate sportivă și cele din drepturi de proprietate intelectuală.',
  },
  {
    id: 'L239/2025:art.XII.pct.19',
    source: 'L239/2025',
    locator: 'art. XII pct. 19 (art. 170 alin. (1) din Codul fiscal)',
    status: 'located',
    summary:
      'Baza anuală a CASS pentru veniturile din activități independente nu poate depăși 72 de salarii minime brute pe țară; pierderile fiscale nu se iau în considerare.',
  },
  {
    id: 'L239/2025:art.XIII',
    source: 'L239/2025',
    locator: 'art. XIII alin. (1) și (2) lit. b)',
    status: 'located',
    summary:
      'Prevederile art. XII pct. 3–11, 16 și 18–20 se aplică începând cu veniturile anului 2026.',
  },
  {
    id: 'OPANAF2736/2025:instr.pct.47.1',
    source: 'OPANAF2736/2025',
    locator: 'anexa nr. 2 (instrucțiuni), cap. I, secțiunea a 3-a, subsecțiunea a 2-a, pct. 47.1',
    status: 'located',
    summary:
      'Pentru veniturile anului 2025, baza anuală a CASS pentru veniturile din activități independente nu poate depăși 60 de salarii minime brute pe țară.',
  },
  {
    id: 'OPANAF2736/2025:instr.cap.I.rd.9',
    source: 'OPANAF2736/2025',
    locator:
      'anexa nr. 2, instrucțiuni, cap. I secț. 1, rd. 9 "Impozit anual datorat" (venitul anului 2025)',
    status: 'located',
    summary:
      'Impozitul anual pe venitul net din activități independente al anului 2025 este de 10%.',
  },
  {
    id: 'OPANAF2736/2025:instr.pct.43',
    source: 'OPANAF2736/2025',
    locator: 'anexa nr. 2, instrucțiuni, pct. 43',
    status: 'located',
    summary:
      'Pentru anul fiscal 2025, plafonul minim anual al CAS (12 salarii minime) se stabilește cu salariul minim de 4.050 lei din HG nr. 1.506/2024 (art. 135^1 alin. (3)).',
  },
  {
    id: 'OPANAF2736/2025:instr.pct.46',
    source: 'OPANAF2736/2025',
    locator: 'anexa nr. 2, instrucțiuni, pct. 46.1–46.4 și secț. 3 rd. 2',
    status: 'located',
    summary:
      'CAS pentru venitul anului 2025: 25% asupra unei baze de cel puțin 12 salarii minime pentru venituri între 12 și 24 de salarii și de cel puțin 24 de salarii peste acest nivel.',
  },
  {
    id: 'OPANAF2736/2025:instr.cap.I.rd.6',
    source: 'OPANAF2736/2025',
    locator:
      'anexa nr. 2 (instrucțiuni), cap. I, secțiunea 1, rd. 6 „Pierdere fiscală compensată în anul de raportare”',
    status: 'located',
    summary:
      'Pierderea compensată în an este cel mult 70% din venitul net anual al sursei; pierderile anilor dinaintea lui 2024 rămase la 31.12.2023 se compensează pe perioada rămasă din cei 7 ani, tot în limita a 70%, cumulate cu cele de după 2024.',
  },
  {
    id: 'OPANAF2736/2025:instr.I.1',
    source: 'OPANAF2736/2025',
    locator: 'anexa nr. 2 (instrucțiuni), cap. I „Termenul de depunere a declarației”, pct. 1',
    status: 'located',
    summary:
      'Declarația se depune până la 25 mai inclusiv a anului următor celui de realizare a veniturilor; pentru opțiunea de plată a CASS, oricând în cursul anului.',
  },
  {
    id: 'OPANAF2736/2025:instr.pct.51-52',
    source: 'OPANAF2736/2025',
    locator: 'anexa nr. 2 (instrucțiuni), pct. 51–52',
    status: 'located',
    summary:
      'Pentru veniturile din drepturi de proprietate intelectuală, asocieri cu persoane juridice, cedarea folosinței bunurilor, investiții și alte surse, încadrarea în plafonul de 6, 12 sau 24 de salarii minime (4.050 lei în 2025) se face prin cumularea lor; baza anuală este plafonul atins, CASS 10% din ea (secțiunea 3.2.2).',
  },
  {
    id: 'OPANAF2736/2025:instr.pct.49.1.5',
    source: 'OPANAF2736/2025',
    locator: 'anexa nr. 2 (instrucțiuni), cap. I, secțiunea a 3-a, subsecțiunea a 2-a, pct. 49.1.5',
    status: 'located',
    summary:
      'CASS datorată ca urmare a opțiunii exercitate în 2025 este cea corespunzătoare a 6 salarii minime brute pe țară, 2.430 lei (24.300 lei bază).',
  },
  {
    id: 'ANAF/Cod-fiscal-consolidat:art.122(3)',
    source: 'ANAF/Cod-fiscal-consolidat',
    locator: 'art. 122 alin. (3)',
    status: 'located',
    summary:
      'Declarația unică se completează și se depune pentru fiecare an fiscal până la 25 mai inclusiv a anului următor celui de realizare a veniturilor, și când activitatea începe, încetează sau se întrerupe în cursul anului.',
  },
  {
    id: 'ANAF/Cod-fiscal-consolidat:art.180(2)',
    source: 'ANAF/Cod-fiscal-consolidat',
    locator: 'art. 180 alin. (2)',
    status: 'located',
    summary:
      'Persoanele care optează pentru plata CASS datorează contribuția pe anul opțiunii la o bază de 6 salarii de bază minime brute pe țară în vigoare la 1 ianuarie a acelui an.',
  },
  {
    id: 'OMFP170/2015:art.2-5',
    source: 'OMFP170/2015',
    locator: 'art. 2–5',
    status: 'located',
    summary:
      'Persoanele fizice impuse în sistem real țin contabilitatea în partidă simplă sau, la opțiune, în partidă dublă, dacă actul de înființare sau legi speciale nu prevăd expres partida simplă; trecerea la partida dublă se face de la începutul exercițiului următor deciziei (sau de la înființare), cu soldurile inițiale preluate prin contul 455.',
  },
  {
    id: 'OMFP170/2015:cap.II.pct.8-11',
    source: 'OMFP170/2015',
    locator: 'anexa, cap. II pct. 8–11',
    status: 'located',
    summary:
      'Inventarierea se face la începutul activității, cel puțin o dată pe an și la încetarea activității; elementele patrimoniale sunt imobilizările, stocurile și imobilizările necorporale; persoanele care țin partida simplă nu întocmesc situații financiare anuale.',
  },
  {
    id: 'OMFP170/2015:cap.III.pct.18',
    source: 'OMFP170/2015',
    locator: 'anexa, cap. III pct. 18',
    status: 'located',
    summary:
      'Operațiunile în valută se înregistrează în lei la cursul BNR din ultima zi bancară anterioară operațiunii (încasare, plată, emitere de documente); în Registrul-jurnal de încasări și plăți, în lei, cu valoarea în valută în coloana de explicații.',
  },
  {
    id: 'OMFP170/2015:cap.V.14-1-1',
    source: 'OMFP170/2015',
    locator: 'anexa, cap. V secțiunea a 2-a, Registrul-jurnal de încasări și plăți (cod 14-1-1/b)',
    status: 'located',
    summary:
      'Un rând pentru fiecare încasare sau plată, pe document justificativ, în numerar și prin bancă, la valoarea din document inclusiv TVA, cu data, documentul, explicații privind natura operațiunii; totalizare lunară; ordine cronologică; încasările și plățile cuprind și aporturile, creditele, despăgubirile, donațiile, restituirile.',
  },
  {
    id: 'OMFP170/2015:cap.V.14-1-2',
    source: 'OMFP170/2015',
    locator: 'anexa, cap. V secțiunea a 2-a, Registrul-inventar (cod 14-1-2/b)',
    status: 'located',
    summary:
      'Se completează la începutul activității, la sfârșitul exercițiului și la încetare, element cu element sau pe grupe, la valoarea de intrare a elementelor patrimoniale și la valoarea rămasă de încasat sau de plată a creanțelor și datoriilor; la încetare, la valoarea inventariată faptic.',
  },
  {
    id: 'OMFP3254/2017:art.1,3,8',
    source: 'OMFP3254/2017',
    locator: 'art. 1, 3 și 8',
    status: 'located',
    summary:
      'Registrul de evidență fiscală îl completează cei impuși în sistem real (cei cu norme de venit numai partea de venituri), anual, cu totalurile, pe fiecare sursă din fiecare categorie de venit, înainte de depunerea declarației.',
  },
  {
    id: 'OMFP3254/2017:art.3-5',
    source: 'OMFP3254/2017',
    locator: 'art. 3 alin. (3)–(4), art. 4 alin. (1), art. 5 alin. (1)',
    status: 'located',
    summary:
      'Registrul de evidență fiscală se ține pe fiecare sursă de venit din fiecare categorie; cu mai multe surse, evidența se ține pe fiecare sursă în același registru; venitul brut și cheltuielile deductibile se înregistrează pe fiecare sursă. Ordinul nu spune cum se împart cheltuielile comune mai multor surse.',
  },
  {
    id: 'OMFP3254/2017:art.4-5',
    source: 'OMFP3254/2017',
    locator: 'art. 4 și 5',
    status: 'located',
    summary:
      'Venitul brut se înregistrează pe natura activității, fără TVA colectată; cheltuielile deductibile și deductibile limitat se înregistrează pe natura lor, fără cele peste limite, cele nedeductibile, contribuțiile sociale proprii și TVA dedusă.',
  },
  {
    id: 'OUG44/2008:art.28-29',
    source: 'OUG44/2008',
    locator: 'art. 28 alin. (1) și art. 29 alin. (1)–(2) (modificat prin Legea nr. 182/2016)',
    status: 'located',
    summary:
      'Întreprinderea familială se constituie din 2 sau mai mulți membri ai unei familii, prin acord de constituire scris care stipulează membrii, reprezentantul desemnat dintre ei și cota procentuală a fiecărui membru la beneficii și la pierderi.',
  },
  {
    id: 'ANAF/Cod-fiscal-consolidat:art.125(4)',
    source: 'ANAF/Cod-fiscal-consolidat',
    locator: 'art. 125 alin. (4)',
    status: 'located',
    summary:
      'Asocierile fără personalitate juridică depun până în ultima zi a lunii februarie inclusiv a anului următor celui de realizare a venitului declarația anuală de venit, cu distribuția venitului net sau a pierderii pe asociați.',
  },
  {
    id: 'ANAF/Cod-fiscal-consolidat:art.125(1)(c),(5),(10)',
    source: 'ANAF/Cod-fiscal-consolidat',
    locator: 'art. 125 alin. (1) lit. c), alin. (5) și (10)',
    status: 'located',
    summary:
      'Venitul sau pierderea asocierii se distribuie asociaților proporțional cu cota de participare din contract; asocierile ai căror membri au venituri din norme de venit nu distribuie venitul și nu intră sub regulile articolului.',
  },
  {
    id: 'ANAF/Cod-fiscal-consolidat:art.122(4)',
    source: 'ANAF/Cod-fiscal-consolidat',
    locator: 'art. 122 alin. (4)',
    status: 'located',
    summary:
      'Declarația unică se completează pentru fiecare sursă din fiecare categorie de venit; pentru veniturile realizate într-o formă de asociere, venitul declarat este venitul net sau pierderea distribuită din asociere.',
  },
  {
    id: 'OPANAF470/2021:anexa2.pct.1-2',
    source: 'OPANAF470/2021',
    locator: 'anexa nr. 2 (instrucțiuni), pct. 1 și 2',
    status: 'located',
    summary:
      'Formularul 204 se depune de asocierile fără personalitate juridică între persoane fizice cu venituri din activități independente în sistem real (și din drepturi de proprietate intelectuală, agricultură, piscicultură, silvicultură); nu se depune pentru asocierile cu venituri independente stabilite pe bază de norme de venit, ale căror venituri nu se consideră distribuite.',
  },
  {
    id: 'OPANAF470/2021:anexa2.pct.3.1',
    source: 'OPANAF470/2021',
    locator: 'anexa nr. 2 (instrucțiuni), pct. 3.1',
    status: 'located',
    summary:
      'Declarația se depune până în ultima zi a lunii februarie a anului următor celui de raportare, pentru veniturile din activități independente în sistem real.',
  },
  {
    id: 'OPANAF470/2021:anexa2.pct.5.1',
    source: 'OPANAF470/2021',
    locator: 'anexa nr. 2 (instrucțiuni), pct. 4.2 și 5.1',
    status: 'located',
    summary:
      'Declarația se completează și se depune de asociatul care răspunde pentru îndeplinirea obligațiilor asocierii față de autoritățile publice, care transmite o copie fiecărui asociat.',
  },
  {
    id: 'OPANAF90/2022:art.II',
    source: 'OPANAF90/2022',
    locator: 'art. I pct. 1 și art. II',
    status: 'located',
    summary:
      'Formularul 204 din anexa nr. 1 la OPANAF nr. 470/2021 se înlocuiește și se utilizează pentru veniturile realizate începând cu anul 2022; instrucțiunile de completare (anexa nr. 2) rămân cele din OPANAF nr. 470/2021.',
  },
  {
    id: 'ANAF/D204-structura-2025:asociat',
    source: 'ANAF/D204-structura-2025',
    locator: 'secțiunea <asociat>, rândurile 47–55',
    status: 'located',
    summary:
      'Distribuția pe asociați: cota (0–100, două zecimale, suma 100), venitul net distribuit = round(net3 × cota) și pierderea distribuită = round(pierd3 × cota), cu o marjă de ±1 leu.',
  },
  {
    id: 'ANAF/Cod-fiscal-consolidat:norme.art.125.pct.41(4)',
    source: 'ANAF/Cod-fiscal-consolidat',
    locator: 'normele metodologice, titlul IV, pct. 41 alin. (4)',
    status: 'located',
    summary:
      'Asociația, prin asociatul desemnat, depune până la data de 15 martie a anului următor declarația anuală cu venitul net sau pierderea asociației și distribuția pe asociați; o copie se transmite fiecărui asociat.',
  },
  {
    id: 'ANAF/Cod-fiscal-consolidat:norme.art.125.pct.41(6)',
    source: 'ANAF/Cod-fiscal-consolidat',
    locator: 'normele metodologice, titlul IV, pct. 41 alin. (6)',
    status: 'located',
    summary:
      'Când cotele de participare se modifică în cursul anului, se determină un venit net sau o pierdere intermediară la sfârșitul lunii modificării, alocată după cotele de până atunci; diferența anuală se alocă după cotele noi.',
  },
  {
    id: 'OPANAF97/2019:instr.I.1-2',
    source: 'OPANAF97/2019',
    locator: 'anexa nr. 2 (instrucțiuni), cap. I pct. 1 și 2',
    status: 'located',
    summary:
      'Formularul 204 se depune de asocierile fără personalitate juridică între persoane fizice cu venituri din activități independente în sistem real (și alte categorii); nu se depune pentru asocierile cu venituri stabilite pe bază de norme de venit, ale căror venituri nu se consideră distribuite.',
  },
  {
    id: 'OPANAF97/2019:instr.I.3(a)',
    source: 'OPANAF97/2019',
    locator: 'anexa nr. 2 (instrucțiuni), cap. I pct. 3 lit. a)',
    status: 'located',
    summary:
      'Declarația se depune până la data de 15 februarie a anului următor celui de raportare, pentru veniturile din activități independente în sistem real.',
  },
  {
    id: 'OUG44/2008:art.15',
    source: 'OUG44/2008',
    locator: 'art. 15 (modificat prin Legea nr. 182/2016)',
    status: 'located',
    summary:
      'Persoana fizică autorizată, titularul întreprinderii individuale și reprezentantul întreprinderii familiale țin contabilitatea în partidă simplă.',
  },
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
    id: 'ANAF/Cod-fiscal-consolidat:art.298',
    source: 'ANAF/Cod-fiscal-consolidat',
    locator: 'art. 298 alin. (1)–(4)',
    status: 'located',
    summary:
      'Dreptul de deducere a TVA pentru vehiculele rutiere motorizate și cheltuielile legate de ele se limitează la 50% când nu sunt utilizate exclusiv în scopul activității economice; nu se limitează peste 3.500 kg sau 9 locuri, nici pentru urgențe, pază, curierat, agenți de vânzări, taxi, servicii cu plată, închiriere, leasing sau mărfuri.',
  },
  {
    id: 'ANAF/Cod-fiscal-consolidat:norme.art.298.pct.68',
    source: 'ANAF/Cod-fiscal-consolidat',
    locator: 'normele metodologice, titlul VII, pct. 68 alin. (1)–(5) și (7) (aplicarea art. 298)',
    status: 'located',
    summary:
      'Cheltuielile legate de vehicule sunt cele direct atribuibile unui vehicul (reparații, întreținere, lubrifianți, piese, combustibil), nu cele care nu pot fi atribuite unui anumit vehicul; vehiculul este cel de cel mult 3.500 kg și 9 scaune; folosirea exclusivă în scopul activității economice se dovedește cu foaia de parcurs (categoria vehiculului, scopul și locul deplasării, kilometrii, norma de consum); orice uz personal, ocazional, limitează deducerea la 50%, fără foaie de parcurs; pentru vehiculele de la art. 298 alin. (3) lit. b)–f) uzul personal este neglijabil, iar cele de la lit. a) se folosesc exclusiv pentru acele servicii.',
  },
  {
    id: 'ANAF/Cod-fiscal-consolidat:art.11(7)',
    source: 'ANAF/Cod-fiscal-consolidat',
    locator: 'art. 11 alin. (7)',
    status: 'located',
    summary:
      'Cine cumpără bunuri sau servicii de la o persoană impozabilă stabilită în România după înscrierea ei ca inactivă în Registrul contribuabililor inactivi/reactivați nu deduce cheltuielile și TVA aferente; excepții: bunurile achiziționate în procedura de executare silită și achizițiile de la persoane impozabile aflate în procedura falimentului (Legea nr. 85/2014).',
  },
  {
    id: 'ANAF/Cod-fiscal-consolidat:art.282(3)',
    source: 'ANAF/Cod-fiscal-consolidat',
    locator: 'art. 282 alin. (3) lit. a) și b)',
    status: 'located',
    summary:
      'Pentru persoanele impozabile care optează pentru sistemul TVA la încasare, exigibilitatea intervine la data încasării contravalorii integrale sau parțiale a livrării ori prestării. Plafonul sistemului este de 5.000.000 lei în perioada 1 martie – 31 decembrie 2026 și de 5.500.000 lei începând cu 1 ianuarie 2027.',
  },
  {
    id: 'ANAF/Cod-fiscal-consolidat:art.282(4)',
    source: 'ANAF/Cod-fiscal-consolidat',
    locator: 'art. 282 alin. (4) lit. a)–d)',
    status: 'located',
    summary:
      'Nu sunt eligibile pentru sistemul TVA la încasare: membrii unui grup fiscal unic, persoanele nestabilite în România, cele care au depășit plafonul în anul precedent și cele înregistrate în cursul anului care au depășit plafonul în anul precedent sau în anul curent.',
  },
  {
    id: 'ANAF/Cod-fiscal-consolidat:art.282(5)',
    source: 'ANAF/Cod-fiscal-consolidat',
    locator: 'art. 282 alin. (5)',
    status: 'located',
    summary:
      'Cine optează pentru sistemul TVA la încasare îl aplică cel puțin până la sfârșitul anului calendaristic; dacă cifra de afaceri depășește plafonul în cursul anului, îl aplică până la sfârșitul perioadei fiscale următoare celei în care plafonul a fost depășit. Renunțarea se notifică între 1 și 20 ale lunii, nu în primul an.',
  },
  {
    id: 'ANAF/Cod-fiscal-consolidat:art.282(6)',
    source: 'ANAF/Cod-fiscal-consolidat',
    locator: 'art. 282 alin. (6) lit. a)–d)',
    status: 'located',
    summary:
      'Sistemul TVA la încasare se aplică doar operațiunilor cu locul livrării sau prestării în România și nu se aplică: taxării inverse (art. 307 alin. (2)–(6), art. 331), operațiunilor scutite, regimurilor speciale de la art. 311–313 și livrărilor ori prestărilor către un beneficiar afiliat (art. 7 pct. 26); acestea urmează regulile generale de exigibilitate.',
  },
  {
    id: 'ANAF/Cod-fiscal-consolidat:art.282(7)',
    source: 'ANAF/Cod-fiscal-consolidat',
    locator: 'art. 282 alin. (7) lit. a) și b)',
    status: 'located',
    summary:
      'Facturile pentru contravaloarea totală emise înainte de intrarea în sistem, cu faptul generator după intrare, nu intră în sistem; cele emise înainte de ieșirea din sistem, cu faptul generator după ieșire, rămân în sistem. Pentru facturile parțiale se aplică sistemul diferențelor facturate după intrare, respectiv taxei facturate înainte de ieșire.',
  },
  {
    id: 'ANAF/Cod-fiscal-consolidat:art.282(8)',
    source: 'ANAF/Cod-fiscal-consolidat',
    locator: 'art. 282 alin. (8)',
    status: 'located',
    summary:
      'Pentru taxa devenită exigibilă la încasare, fiecare încasare totală sau parțială se consideră că include și taxa aferentă.',
  },
  {
    id: 'ANAF/Cod-fiscal-consolidat:art.282(10)',
    source: 'ANAF/Cod-fiscal-consolidat',
    locator: 'art. 282 alin. (10) lit. a)–e)',
    status: 'located',
    summary:
      'La evenimentele de la art. 287 pentru operațiuni în sistemul TVA la încasare, regimul, cotele și cursul sunt ale operațiunii de bază. La anulare totală, exigibilitatea intervine la data anulării pentru contravaloarea a cărei taxă devenise exigibilă, iar taxa neexigibilă se anulează; la anulare parțială se reduce întâi taxa neexigibilă, iar diferența care o depășește devine exigibilă la data anulării. Refuzurile (lit. b) și ambalajele returnate (lit. e) urmează lit. a), reducerile de preț (lit. c) urmează lit. a) pct. 2, iar la faliment (lit. d) se anulează taxa neexigibilă.',
  },
  {
    id: 'ANAF/Cod-fiscal-consolidat:art.297(2)',
    source: 'ANAF/Cod-fiscal-consolidat',
    locator: 'art. 297 alin. (2)',
    status: 'located',
    summary:
      'Dreptul de deducere a TVA pentru achizițiile de la o persoană impozabilă care aplică sistemul TVA la încasare este amânat până la data la care taxa a fost plătită furnizorului.',
  },
  {
    id: 'ANAF/Cod-fiscal-consolidat:art.297(3)',
    source: 'ANAF/Cod-fiscal-consolidat',
    locator: 'art. 297 alin. (3)',
    status: 'located',
    summary:
      'Persoana impozabilă care aplică sistemul TVA la încasare își amână dreptul de deducere pentru achizițiile ei până la plata taxei către furnizor, chiar dacă o parte din operațiunile ei sunt excluse din sistem; nu și pentru achizițiile intracomunitare, importuri și achizițiile cu taxare inversă (art. 307 alin. (2)–(6), art. 331).',
  },
  {
    id: 'ANAF/Cod-fiscal-consolidat:art.319(20)(p)',
    source: 'ANAF/Cod-fiscal-consolidat',
    locator: 'art. 319 alin. (20) lit. p)',
    status: 'located',
    summary:
      'Când exigibilitatea TVA intervine la data încasării contravalorii integrale sau parțiale, factura cuprinde mențiunea „TVA la încasare”.',
  },
  {
    id: 'ANAF/Cod-fiscal-consolidat:art.324(14)',
    source: 'ANAF/Cod-fiscal-consolidat',
    locator: 'art. 324 alin. (14)',
    status: 'located',
    summary:
      'Persoana care aplică sistemul TVA la încasare și depășește plafonul în cursul anului notifică organul fiscal până la data de 20 a lunii următoare perioadei fiscale în care l-a depășit; altfel este radiată din oficiu din registru.',
  },
  {
    id: 'ANAF/Cod-fiscal-consolidat:norme.art.282.pct.26',
    source: 'ANAF/Cod-fiscal-consolidat',
    locator:
      'normele metodologice, titlul VII, pct. 26 alin. (2), (3), (7), (14) și (16) (aplicarea art. 282 alin. (3)–(8))',
    status: 'located',
    summary:
      'Sistemul se aplică tuturor operațiunilor, cu excepțiile de la art. 282 alin. (6), iar mențiunea „TVA la încasare” lipsește doar pe facturile acestora; încasarea înseamnă orice contrapartidă (plată, compensare, cesiune de creanțe, instrumente de plată); beneficiarul afiliat se apreciază la data emiterii facturii; la încasarea parțială a unei facturi cu mai multe cote, persoana impozabilă poate alege bunurile ori serviciile considerate încasate.',
  },
  {
    id: 'ANAF/Cod-fiscal-consolidat:norme.art.287.pct.32',
    source: 'ANAF/Cod-fiscal-consolidat',
    locator: 'normele metodologice, titlul VII, pct. 32 alin. (2), (5) și (6)',
    status: 'located',
    summary:
      'Facturile de corecție ale celor care aplică sistemul TVA la încasare se emit cu minus, indiferent dacă taxa este sau nu exigibilă, după art. 282 alin. (10); beneficiarul aplică aceleași reguli: la o reducere de preț diminuează TVA neexigibilă (exemplul: 667 lei rămași, reduși cu 100 lei).',
  },
  {
    id: 'ANAF/Cod-fiscal-consolidat:norme.art.297.pct.67',
    source: 'ANAF/Cod-fiscal-consolidat',
    locator: 'normele metodologice, titlul VII, pct. 67 alin. (6), (8) și (9)',
    status: 'located',
    summary:
      'Beneficiarul amână deducerea dacă furnizorul este înscris în registrul TVA la încasare la data facturii, chiar fără mențiune; se amână doar taxa care ar fi deductibilă, cea nedeductibilă nu se reflectă ca neexigibilă; taxa deductibilă aferentă unei plăți parțiale se determină prin procedeul sutei mărite (1.300 x 20 / 120).',
  },
  {
    id: 'ANAF/ghid-coduri-facturi-2.9:BT-22',
    source: 'ANAF/ghid-coduri-facturi-2.9',
    locator: 'capitolul 5, „Recomandări”, BT-22 – Comentariu în factură',
    status: 'located',
    summary:
      'Conform RO_CIUS, mențiunile obligatorii fără alt loc în factură, ca „TVA la încasare”, se înscriu în comentariul facturii (BT-22), separate prin „#”.',
  },
  {
    id: 'ANAF/Cod-fiscal-consolidat:art.323(1)',
    source: 'ANAF/Cod-fiscal-consolidat',
    locator: 'art. 323 alin. (1)',
    status: 'located',
    summary:
      'Decontul de taxă se depune pentru fiecare perioadă fiscală până la data de 25 inclusiv a lunii următoare încheierii ei.',
  },
  {
    id: 'ANAF/Cod-fiscal-consolidat:art.147(1)',
    source: 'ANAF/Cod-fiscal-consolidat',
    locator: 'art. 147 alin. (1)',
    status: 'located',
    summary:
      'Angajatorii depun lunar declarația 112 până la data de 25 inclusiv a lunii următoare celei pentru care se datorează veniturile.',
  },
  {
    id: 'ANAF/Cod-fiscal-consolidat:art.56(1)-(2)',
    source: 'ANAF/Cod-fiscal-consolidat',
    locator: 'art. 56 alin. (1) și (2)',
    status: 'located',
    summary:
      'Impozitul microîntreprinderilor se calculează și se plătește trimestrial, până la data de 25 inclusiv a lunii următoare trimestrului; declarația se depune până la termenul de plată.',
  },
  {
    id: 'ANAF/Cod-fiscal-consolidat:art.132(2)',
    source: 'ANAF/Cod-fiscal-consolidat',
    locator: 'art. 132 alin. (2)',
    status: 'located',
    summary:
      'Plătitorii de venituri cu reținere la sursă depun declarația pe beneficiari până în ultima zi a lunii februarie inclusiv a anului următor.',
  },
  {
    id: 'ANAF/Cod-procedura-fiscala-2019:art.75',
    source: 'ANAF/Cod-procedura-fiscala-2019',
    locator: 'art. 75 (citit și pe portalul legislativ, forma din martie 2026)',
    status: 'located',
    summary:
      'Termenele din legislația fiscală se calculează potrivit Codului de procedură civilă, dacă legislația fiscală nu dispune altfel.',
  },
  {
    id: 'ANAF/Cod-procedura-fiscala-2019:art.155(2)',
    source: 'ANAF/Cod-procedura-fiscala-2019',
    locator: 'art. 155 alin. (2) (forma din 2019; forma în vigoare nu a putut fi citită)',
    status: 'located',
    summary:
      'Creanțele administrate de organul fiscal central scadente sau de declarat la 25 decembrie se plătesc și se declară până la 21 decembrie; dacă 21 decembrie este zi nelucrătoare, până în ultima zi lucrătoare dinaintea ei.',
  },
  {
    id: 'L134/2010-A:art.181(2)',
    source: 'L134/2010-A',
    locator: 'art. 181 alin. (2)',
    status: 'located',
    summary:
      'Un termen care se împlinește într-o zi nelucrătoare se prelungește până la sfârșitul primei zile lucrătoare următoare.',
  },
  {
    id: 'L82/1991:art.36(1)(a)',
    source: 'L82/1991',
    locator: 'art. 36 alin. (1) lit. a)',
    status: 'located',
    summary:
      'Societățile depun situațiile financiare anuale în termen de 150 de zile de la încheierea exercițiului financiar.',
  },
  {
    id: 'OPANAF591/2016:anexa4.pct.1.1',
    source: 'OPANAF591/2016',
    locator: 'anexa nr. 4 pct. 1.1',
    status: 'located',
    summary:
      'Declarația recapitulativă (390) se depune lunar până la data de 25 inclusiv a lunii următoare celei în care a intervenit exigibilitatea.',
  },
  {
    id: 'L70/2015:art.3(1)',
    source: 'L70/2015',
    locator: 'art. 3 alin. (1) lit. a), c), e) (neschimbat în ghidul ANAF din 2026)',
    status: 'located',
    summary:
      'Încasări în numerar de la persoane juridice și PFA de cel mult 5.000 lei pe zi de la o persoană; plăți de cel mult 5.000 lei pe zi către o persoană și 10.000 lei pe zi în total; plăți din avansuri spre decontare de cel mult 5.000 lei pe zi.',
  },
  {
    id: 'L70/2015:art.4',
    source: 'L70/2015',
    locator: 'art. 4 alin. (1) și (4) (neschimbat în ghidul ANAF din 2026)',
    status: 'located',
    summary:
      'Încasări de la și plăți către persoane fizice de cel mult 10.000 lei pe zi de la sau către o persoană; plățile fragmentate peste plafon sunt interzise.',
  },
  {
    id: 'L70/2015:art.4^2',
    source: 'L70/2015',
    locator:
      'art. 4^2 (introdus după 2018; textul legii nu este citit, ci ghidul ANAF care îl redă)',
    status: 'pending',
    summary:
      'Numerarul din casierie nu poate depăși la sfârșitul zilei 50.000 lei, cu excepția sumelor pentru salarii și alte plăți către persoane fizice, timp de 3 zile lucrătoare.',
  },
  {
    id: 'ANAF/Ploiesti-ghid-numerar-2026:plafoane',
    source: 'ANAF/Ploiesti-ghid-numerar-2026',
    locator: 'secțiunile „Plafoane zilnice maxime” și „Plafonul maxim de numerar în casierie”',
    status: 'located',
    summary:
      'În 2026: 5.000 lei pe zi de la sau către un operator economic (10.000 lei pe zi plăți în total), 10.000 lei pe zi de la sau către o persoană fizică, 5.000 lei pe zi din avansuri spre decontare, 50.000 lei numerar în casierie la sfârșitul zilei.',
  },
  {
    id: 'OPANAF2328/2016:art.I',
    source: 'OPANAF2328/2016',
    locator:
      'art. I (art. 8 din Ordinul nr. 3.769/2015; modificările ulterioare ale art. 8 nu sunt verificate)',
    status: 'located',
    summary:
      'Declarația 394 se depune până în data de 30 inclusiv a lunii următoare încheierii perioadei de raportare; pentru ianuarie, până la 28, respectiv 29 februarie.',
  },
  {
    id: 'OPANAF1783/2021:anexa4.pct.1-4',
    source: 'OPANAF1783/2021',
    locator: 'anexa nr. 4 pct. 1–4',
    status: 'located',
    summary:
      'D406 se transmite lunar sau trimestrial, după perioada fiscală de TVA (trimestrial pentru cei neînregistrați în scopuri de TVA), până în ultima zi calendaristică a lunii următoare perioadei.',
  },
  {
    id: 'OPANAF407/2025:anexa5.pct.4',
    source: 'OPANAF407/2025',
    locator: 'anexa nr. 5 pct. 4 lit. a)–c), n), q) (anexa nr. 5 la OPANAF nr. 1.783/2021)',
    status: 'located',
    summary:
      'Nu au obligația de a depune D406 (SAF-T): PFA, întreprinderile individuale și întreprinderile familiale, alături de persoanele fizice cu profesii liberale și entitățile care țin contabilitatea în partidă simplă; scutirea PFA, II și IF este în toate versiunile anexei (OPANAF nr. 1.783/2021, 373/2022, 2.518/2022).',
  },
  {
    id: 'OPANAF605/2026:anexa6.cap.I',
    source: 'OPANAF605/2026',
    locator: 'anexa nr. 6 cap. I „Termenul de depunere a declarației”',
    status: 'located',
    summary:
      'Plătitorii de la art. 80 alin. (2) depun D112 trimestrial, câte o declarație pentru fiecare lună a trimestrului, până la 25 a lunii următoare trimestrului; în luna unui concediu medical sau a încetării calității de asigurat declarația se depune până la 25 a lunii următoare, iar la încetarea în luna a doua se depun și declarația primei luni, și a celei de-a doua.',
  },
  {
    id: 'ANAF/Cod-fiscal-consolidat:art.147(11)',
    source: 'ANAF/Cod-fiscal-consolidat',
    locator: 'art. 147 alin. (11)',
    status: 'located',
    summary:
      'În trimestrul în care un salariat are concediu medical sau îi încetează calitatea de asigurat, D112 se depune până la 25 a lunii următoare evenimentului; declarațiile perioadei rămase din trimestru, după trimestru; la încetarea în luna a doua se depun atât declarația primei luni, cât și a celei de-a doua.',
  },
  {
    id: 'OUG128/2024:art.I.pct.1',
    source: 'OUG128/2024',
    locator: 'art. I pct. 1 (art. 69 alin. (9) din Codul fiscal) și art. II alin. (2)',
    status: 'located',
    summary:
      'Contribuabilul pe normă de venit cu un venit brut anual de peste 25.000 euro în anul fiscal anterior, la cursul mediu anual BNR al anului de realizare, trece la sistemul real din anul următor; se aplică de la veniturile anului 2025.',
  },
  {
    id: 'LJR/Cod-fiscal-2025:art.69(3)',
    source: 'LJR/Cod-fiscal-2025',
    locator: 'art. 69 alin. (3), în forma de dinainte de Legea nr. 239/2025',
    status: 'located',
    summary:
      'Norma de venit a fiecărei activități nu poate fi mai mică decât salariul de bază minim brut pe țară în vigoare la momentul stabilirii ei, înmulțit cu 12; în asociere, norma se stabilește pentru fiecare membru.',
  },
  {
    id: 'OUG59/2005:art.1(1)',
    source: 'OUG59/2005',
    locator: 'art. 1 alin. (1), modificat prin Legea nr. 15/2006, și nota C.T.C.E. de sub el',
    status: 'located',
    summary:
      'Impozitele, taxele, contribuțiile și celelalte sume datorate bugetului general consolidat se stabilesc la nivel de leu, fără subdiviziuni: fracțiunile sub 50 de bani prin reducere, cele de 50 de bani sau mai mari prin majorare. Fraza despre sumele sub un leu, întregite la un leu, este dată de nota consolidării ca inaplicabilă după respingerea OUG nr. 181/2005.',
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
    id: 'OMFP1802/2014:pct.212-215',
    source: 'OMFP1802/2014',
    locator: 'pct. 212–215 și 218 (imobilizări deținute în baza unui contract de leasing)',
    status: 'located',
    summary:
      'Leasingul se clasifică la începutul contractului, după fondul economic; e financiar dacă îndeplinește una dintre condițiile pct. 213 alin. (2). Locatarul înregistrează în leasing financiar imobilizarea și o amortizează; dobânzile de plătit se înregistrează periodic, pe cheltuieli, iar dobânda aferentă perioadelor viitoare în contul în afara bilanțului 8051. În leasing operațional, bunul se ține în afara bilanțului și ratele sunt cheltuieli.',
  },
  {
    id: 'OMFP1802/2014:pct.321',
    source: 'OMFP1802/2014',
    locator: 'pct. 321 alin. (1)–(2)',
    status: 'located',
    summary:
      'Datoriile de leasing financiar în valută, ca și cele în lei decontate în funcție de cursul unei valute, se înregistrează la cursul BNR de la data acordării finanțării; într-o zi nebancară, la cursul ultimei zile bancare anterioare.',
  },
  {
    id: 'OMFP1802/2014:pct.360',
    source: 'OMFP1802/2014',
    locator: 'pct. 360–363 și 368',
    status: 'located',
    summary:
      'O datorie este curentă când se așteaptă să fie decontată în ciclul normal de exploatare sau este exigibilă în 12 luni de la data bilanțului; celelalte sunt pe termen lung. Datoriile pe termen lung purtătoare de dobândă rămân în această categorie când termenul inițial depășea 12 luni și există un acord de refinanțare sau reeșalonare încheiat înainte de data bilanțului.',
  },
  {
    id: 'OMFP1802/2014:conturi.16',
    source: 'OMFP1802/2014',
    locator: 'funcțiunea conturilor 162, 166, 167 și 168',
    status: 'located',
    summary:
      'Creditele bancare pe termen lung (162), datoriile față de entitățile afiliate (166) și alte împrumuturi (167, inclusiv imobilizările primite în leasing financiar, debitat cu ratele facturate de locator prin 404) se creditează la primire și se debitează la rambursare; dobânzile datorate se înregistrează în 168 pe seama contului 666. Diferențele de curs din evaluarea la sfârșitul lunii merg la 665/765, iar pentru datoriile din leasing în lei decontate la cursul unei valute, la 668/768.',
  },
  {
    id: 'OMFP1802/2014:conturi.519',
    source: 'OMFP1802/2014',
    locator: 'funcțiunea conturilor 518 și 519',
    status: 'located',
    summary:
      'Creditele bancare pe termen scurt, acordate prin conturi bancare distincte, se înregistrează în 519 inclusiv cu dobânzile datorate (666); dobânzile datorate pentru creditele în conturile curente se înregistrează în 518.',
  },
  {
    id: 'OMFP1802/2014:conturi.455',
    source: 'OMFP1802/2014',
    locator: 'funcțiunea contului 455',
    status: 'located',
    summary:
      'Sumele lăsate temporar la dispoziția entității de acționari sau asociați și dobânzile aferente lor (666) se creditează în 455; se debitează cu sumele restituite.',
  },
  {
    id: 'OMFP1802/2014:conturi.666',
    source: 'OMFP1802/2014',
    locator: 'funcțiunea conturilor 404, 666, 668 și 768',
    status: 'located',
    summary:
      'Dobânzile datorate se înregistrează în 666 în contul 168 (împrumuturi), 404 (ratele de leasing financiar), 455 (acționari/asociați), 518 sau 519 (credite pe termen scurt). Furnizorii de imobilizări (404) se creditează cu ratele de leasing financiar facturate și dobânda lor (167, 666) și cu TVA. Diferențele din evaluarea datoriilor din leasing financiar în lei decontate la cursul unei valute sunt alte cheltuieli (668) sau venituri (768) financiare.',
  },
  {
    id: 'ANAF/Cod-fiscal-consolidat:art.97(2)',
    source: 'ANAF/Cod-fiscal-consolidat',
    locator: 'art. 97 alin. (2) și (4)',
    status: 'located',
    summary:
      'Dobânzile la depozite la termen, instrumente de economisire și din contracte civile se impun cu 10%, impozit final. Pentru dobânzile la împrumuturile din contracte civile, plătitorul calculează impozitul la plata dobânzii; plata impozitului: lunar, până la 25 inclusiv a lunii următoare înregistrării sau răscumpărării, „respectiv la momentul plății dobânzii” pentru contractele civile.',
  },
  {
    id: 'ANAF/Cod-fiscal-consolidat:art.29',
    source: 'ANAF/Cod-fiscal-consolidat',
    locator: 'art. 29 alin. (1)–(3) și normele, pct. 32',
    status: 'located',
    summary:
      'În leasingul financiar utilizatorul este tratat fiscal ca proprietar, amortizează bunul și deduce dobânda; în leasingul operațional, locatarul deduce chiria (rata de leasing).',
  },
  {
    id: 'ANAF/Cod-fiscal-consolidat:art.271(3)(a)',
    source: 'ANAF/Cod-fiscal-consolidat',
    locator: 'art. 270 alin. (3) lit. a), art. 271 alin. (3) lit. a) și normele, pct. 8 alin. (4)',
    status: 'located',
    summary:
      'Transmiterea folosinței bunurilor în cadrul unui contract de leasing este prestare de servicii (contractele de leasing sunt excluse de la livrările cu plata în rate); transferul proprietății la sfârșitul leasingului este o livrare de bunuri pentru valoarea de transfer.',
  },
  {
    id: 'ANAF/Cod-fiscal-consolidat:art.281(8)',
    source: 'ANAF/Cod-fiscal-consolidat',
    locator: 'art. 281 alin. (8) și normele, pct. 24 alin. (6)–(7)',
    status: 'located',
    summary:
      'Livrările și prestările efectuate continuu (utilități, telefonie, închirieri, leasing și altele asemenea) se consideră efectuate la fiecare dată prevăzută în contract pentru plată sau, în lipsa ei, la emiterea facturii; un termen de plată înscris doar pe factură nu este fapt generator. Avansul perceput în leasing este o rată de leasing, cu același fapt generator.',
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
  // The yearly determinations (src/ro/determinations): micro-enterprise eligibility, the VAT
  // period, quarterly D112, the size category, the small-enterprise threshold and VAT on
  // collection, read in ANAF's consolidated Code (snapshot of 29.10.2026), OMF nr. 2.036/2025 and
  // OMFP nr. 1.802/2014.
  {
    id: 'ANAF/Cod-fiscal-consolidat:art.47(1)',
    source: 'ANAF/Cod-fiscal-consolidat',
    locator: 'art. 47 alin. (1) lit. d), e), h) și i) (lit. a), b) și f) abrogate)',
    status: 'located',
    summary:
      'La 31 decembrie a anului fiscal precedent, microîntreprinderea: are capitalul deținut de alte persoane decât statul și unitățile administrativ-teritoriale; nu este în dizolvare urmată de lichidare; dacă are asociați cu peste 25%, este singura persoană juridică stabilită de ei să aplice titlul III; a depus în termen situațiile financiare anuale.',
  },
  {
    id: 'ANAF/Cod-fiscal-consolidat:art.47(1^1)',
    source: 'ANAF/Cod-fiscal-consolidat',
    locator: 'art. 47 alin. (1^1) lit. a)–d)',
    status: 'located',
    summary:
      'Limita veniturilor se verifică pe veniturile persoanei juridice cumulate cu ale întreprinderilor legate (deținere directă sau indirectă de peste 25% ori dreptul de a numi administratorul, în oricare sens sau printr-o persoană comună; PFA, II sau IF ale asociaților cu peste 25%, cu veniturile ori norma lor anuală).',
  },
  {
    id: 'ANAF/Cod-fiscal-consolidat:art.47(3)',
    source: 'ANAF/Cod-fiscal-consolidat',
    locator: 'art. 47 alin. (3) și (4)',
    status: 'located',
    summary:
      'Nu aplică titlul III fondurile de garantare, entitățile transparente fiscal, băncile, asigurătorii și piața de capital (cu excepția intermediarilor secundari de asigurări sub 15%), jocurile de noroc și petrolul și gazele; asociații cu peste 25% în mai multe microîntreprinderi stabilesc până la 31 martie una singură.',
  },
  {
    id: 'ANAF/Cod-fiscal-consolidat:art.48(1)-(2^1)',
    source: 'ANAF/Cod-fiscal-consolidat',
    locator: 'art. 48 alin. (1)–(2^1) și art. 55 alin. (2)',
    status: 'located',
    summary:
      'Impozitul pe veniturile microîntreprinderilor este opțional, din anul următor celui în care se îndeplinesc condițiile; microîntreprinderea nu poate opta pentru impozit pe profit în cursul anului; aplicarea se comunică până la 31 martie.',
  },
  {
    id: 'ANAF/Cod-fiscal-consolidat:art.48(3)-(3^3)',
    source: 'ANAF/Cod-fiscal-consolidat',
    locator: 'art. 48 alin. (3)–(3^3)',
    status: 'located',
    summary:
      'Persoana juridică nou-înființată poate fi microîntreprindere din primul an dacă angajează un salariat în 90 de zile de la înregistrare; suspendarea contractului sub 30 de zile, prima dată în an, și concediul medical cumulat de cel mult 30 de zile nu încalcă condiția salariatului.',
  },
  {
    id: 'ANAF/Cod-fiscal-consolidat:art.52(2)-(3)',
    source: 'ANAF/Cod-fiscal-consolidat',
    locator: 'art. 52 alin. (2), (3) și (6)',
    status: 'located',
    summary:
      'Microîntreprinderea datorează impozit pe profit din trimestrul în care nu a depus în termen situațiile financiare, respectiv din trimestrul următor încetării raportului de muncă, dacă unicul salariat nu este înlocuit în 30 de zile.',
  },
  {
    id: 'ANAF/Cod-fiscal-consolidat:art.52(5^1)-(5^2)',
    source: 'ANAF/Cod-fiscal-consolidat',
    locator: 'art. 52 alin. (5^1) și (5^2)',
    status: 'located',
    summary:
      'În cursul anului, limita de 100.000 euro a microîntreprinderii cu întreprinderi legate se verifică pe veniturile ei însumate cu cifra de afaceri a celor legate; se adaugă o pătrime din norma anuală de venit a PFA, II sau IF legate impozitate pe normă.',
  },
  {
    id: 'OUG156/2024:art.LXIV.pct.2-3',
    source: 'OUG156/2024',
    locator:
      'art. LXIV pct. 2, 3 și 6 (art. 47 alin. (1) lit. c) și f), art. 54 alin. (3) din Codul fiscal)',
    status: 'located',
    summary:
      'Limita veniturilor microîntreprinderii devine 250.000 euro, respectiv 100.000 euro de la 1 ianuarie 2026; litera f) a art. 47 alin. (1) se abrogă; condiția ponderii veniturilor din consultanță sau management la 31 decembrie 2024 nu se aplică limitei de 250.000 euro.',
  },
  {
    id: 'ANAF/Cod-fiscal-consolidat:art.80(2)-(3)',
    source: 'ANAF/Cod-fiscal-consolidat',
    locator: 'art. 80 alin. (2) și (3)',
    status: 'located',
    summary:
      'Plătesc trimestrial impozitul pe salarii: entitățile fără scop patrimonial; persoanele juridice plătitoare de impozit pe profit cu venituri totale de până la 100.000 euro și un număr mediu de până la 3 salariați exclusiv în anul anterior; microîntreprinderile cu un număr mediu de până la 3 salariați exclusiv; PFA, II, IF și profesiile liberale cu salariați.',
  },
  {
    id: 'ANAF/Cod-fiscal-consolidat:art.147(4)-(10)',
    source: 'ANAF/Cod-fiscal-consolidat',
    locator: 'art. 147 alin. (4)–(11)',
    status: 'located',
    summary:
      'Plătitorii de la art. 80 alin. (2) depun D112 trimestrial, câte una pentru fiecare lună, până la 25 a lunii următoare trimestrului; numărul mediu de salariați este media aritmetică a numărului de salariați din declarațiile depuse pentru fiecare lună a anului anterior, iar venitul total se ia din situațiile financiare; opțiunea pentru depunerea lunară se depune până la 31 ianuarie; în luna unui concediu medical sau a încetării calității de asigurat, declarația se depune lunar.',
  },
  {
    id: 'ANAF/Cod-fiscal-consolidat:art.322(2)-(6)',
    source: 'ANAF/Cod-fiscal-consolidat',
    locator: 'art. 322 alin. (2)–(8)',
    status: 'located',
    summary:
      'Perioada fiscală este trimestrul pentru persoana impozabilă cu o cifră de afaceri din anul precedent (operațiuni taxabile, scutite cu drept de deducere sau cu locul în străinătate cu drept de deducere) de cel mult 100.000 euro, fără achiziții intracomunitare de bunuri; cine se înregistrează în cursul anului se încadrează după cifra de afaceri estimată; o achiziție intracomunitară de bunuri trece persoana la luna calendaristică.',
  },
  {
    id: 'ANAF/Cod-fiscal-consolidat:norme.art.322.pct.103(2)-(3)',
    source: 'ANAF/Cod-fiscal-consolidat',
    locator: 'normele metodologice, titlul VII pct. 103 alin. (2) și (3)',
    status: 'located',
    summary:
      'Echivalentul în lei al plafonului de 100.000 euro se determină la cursul BNR valabil pentru 31 decembrie a anului precedent; cifra de afaceri este baza de impozitare din rândurile decontului pentru livrările taxabile, scutite cu drept de deducere și cu locul în străinătate cu drept de deducere, cu regularizările; nu intră livrările din perioada fără cod de TVA.',
  },
  {
    id: 'ANAF/Cod-fiscal-consolidat:art.310(1)-(2),(6)',
    source: 'ANAF/Cod-fiscal-consolidat',
    locator: 'art. 310 alin. (1), (2) și (6)',
    status: 'located',
    summary:
      'Persoana impozabilă stabilită în România cu o cifră de afaceri anuală de cel mult 395.000 lei poate aplica scutirea; cifra de afaceri cuprinde livrările și prestările cu locul în România, taxabile sau care ar fi taxabile, fără activele fixe corporale și necorporale; la depășire se solicită înregistrarea cel târziu la data depășirii, iar regimul normal se aplică din acea tranzacție.',
  },
  {
    id: 'ANAF/Cod-fiscal-consolidat:art.317',
    source: 'ANAF/Cod-fiscal-consolidat',
    locator: 'art. 317 alin. (1)–(2)',
    status: 'located',
    summary:
      'Persoana impozabilă neînregistrată după art. 316 se înregistrează în scopuri de TVA înainte de a presta servicii pentru care beneficiarul din alt stat membru datorează taxa sau de a primi servicii pentru care ea datorează taxa în România.',
  },
  {
    id: 'ANAF/Cod-fiscal-consolidat:art.282(3^1)-(5)',
    source: 'ANAF/Cod-fiscal-consolidat',
    locator: 'art. 282 alin. (3^1), (4) și (5)',
    status: 'located',
    summary:
      'Aplică TVA la încasare persoanele înregistrate în România a căror cifră de afaceri din anul precedent nu a depășit plafonul; nu sunt eligibile cele care l-au depășit în anul precedent; la depășire în cursul anului, sistemul se aplică până la sfârșitul perioadei fiscale următoare celei în care plafonul a fost depășit.',
  },
  {
    id: 'OMF2036/2025:anexa1.pct.2.1-2.3',
    source: 'OMF2036/2025',
    locator: 'anexa nr. 1 cap. II lit. A pct. 2.1–2.3',
    status: 'located',
    summary:
      'Microentitățile nu depășesc la data bilanțului două dintre: active totale 2.250.000 lei, cifră de afaceri netă 4.500.000 lei, 10 salariați în medie; entitățile mici nu depășesc două dintre 25.000.000 lei, 50.000.000 lei și 50 de salariați; peste acestea, entități mijlocii și mari (pct. 9 din OMFP nr. 1.802/2014).',
  },
  {
    id: 'OMF2036/2025:anexa1.pct.2.6',
    source: 'OMF2036/2025',
    locator: 'anexa nr. 1 cap. II lit. A pct. 2.6 alin. (2)–(4)',
    status: 'located',
    summary:
      'Încadrarea pentru situațiile financiare se face la sfârșitul exercițiului, pe baza indicatorilor din situațiile financiare ale exercițiului precedent și a celor din balanța exercițiului curent; entitățile mijlocii și mari sunt auditate, ca și cele care depășesc două dintre 16.000.000 lei active, 32.000.000 lei cifră de afaceri și 50 de salariați în două exerciții consecutive.',
  },
  {
    id: 'OMFP1802/2014:pct.12-13',
    source: 'OMFP1802/2014',
    locator: 'pct. 12 alin. (1), pct. 13 și pct. 14',
    status: 'located',
    summary:
      'O entitate schimbă categoria doar dacă depășește sau încetează să depășească limitele a două dintre cele trei criterii în două exerciții financiare consecutive: exercițiul precedent și cel curent, pentru care se întocmesc situațiile financiare.',
  },
  {
    id: 'OMFP1802/2014:pct.15',
    source: 'OMFP1802/2014',
    locator: 'pct. 15',
    status: 'located',
    summary:
      'Totalul activelor din criteriile de mărime este valoarea totală a activelor de la literele A–C ale activului bilanțului (active imobilizate, active circulante, cheltuieli în avans).',
  },
  ...annualClauses,
  ...profitClauses,
  ...nonpayerClauses,
  ...exemptClauses,
  ...taxAccountClauses,
  ...saftClauses,
  ...withholdingClauses,
  ...receiptClauses,
  ...schemeClauses,
  ...ossClauses,
  ...yearEndClauses,
  ...stockClauses,
  ...payrollClauses,
  ...tradeClauses,
  ...retailClauses,
  ...productionClauses,
  ...creditClauses,
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
