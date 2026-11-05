import type { Clause, LegalSource } from './index';

/*
 * The sources of the annual statements beyond the microentities' (Y2): ANAF's package for the
 * small entities' statements of 2025 (S1003), the inactivity declaration (S1046), the half-year
 * reporting order of 2025 and ANAF's listing for 2026, and the clauses of the accounting law and
 * of OMF nr. 2.036/2025 on signatures, accompanying documents and deadlines. Kept apart from the
 * register's main list, which spreads them in.
 */

const anaf = 'https://static.anaf.ro/static/10/Anaf/Declaratii_R';

export const annualSources: readonly LegalSource[] = [
  {
    id: 'ANAF/SF-2025',
    kind: 'official_document',
    title:
      'Situații financiare anuale la 31 decembrie 2025 (S1002, S1003, S1005): pagina ANAF, structura fișierului XML (27.01.2026), formularul PDF (27.03.2026) și schema S1003 (10.02.2026)',
    issuer: 'ANAF',
    publication: null,
    urls: [
      `${anaf}/situatiifinanciare/2025/1002_5_2025.html`,
      `${anaf}/AplicatiiDec/structura_SC_1225_270126.pdf`,
      `${anaf}/AplicatiiDec/bilant_SC_1225_XML_270326.pdf`,
      `${anaf}/AplicatiiDec/s1003_20260210.xsd`,
    ],
    fetch: true,
    snapshots: [
      {
        url: `${anaf}/situatiifinanciare/2025/1002_5_2025.html`,
        sha256: '2dc2d1782b0dde6f03a00e8f3893fa2db99c395c394c68fa886fa7e8b3d6c137',
        retrievedOn: '2026-11-04',
        mediaType: 'text/html',
      },
      {
        url: `${anaf}/AplicatiiDec/structura_SC_1225_270126.pdf`,
        sha256: '1de025767a23a2c7cf3191c1da22dfe37f4b7990560fcf4733c9736426816834',
        retrievedOn: '2026-11-04',
        mediaType: 'application/pdf',
      },
      {
        url: `${anaf}/AplicatiiDec/bilant_SC_1225_XML_270326.pdf`,
        sha256: 'c175c785efaa49d68444f60a3ca9cb7998b2486808bec3e5528fe99036097463',
        retrievedOn: '2026-11-04',
        mediaType: 'application/pdf',
      },
      {
        url: `${anaf}/AplicatiiDec/s1003_20260210.xsd`,
        sha256: '6342c52248b2046857a55b3532b08a482fe4bf83dc1385d70050a67196fab436',
        retrievedOn: '2026-11-04',
        mediaType: 'application/xml',
      },
    ],
  },
  {
    id: 'ANAF/S1046',
    kind: 'official_document',
    title:
      'S1046 Declarație de inactivitate: pagina ANAF pentru 2025, structura fișierului XML (A1.0.0, 28.01.2016) și schema',
    issuer: 'ANAF',
    publication: null,
    urls: [
      `${anaf}/situatiifinanciare/2025/1046_2025.html`,
      `${anaf}/AplicatiiDec/structura_S1046_DI_280116.pdf`,
      `${anaf}/AplicatiiDec/s1046_20160128.xsd`,
    ],
    fetch: true,
    snapshots: [
      {
        url: `${anaf}/situatiifinanciare/2025/1046_2025.html`,
        sha256: 'f54ea8d2d8456770f0a606c8fbcdbae9d70c7239d1ca7e216f956b4d63c27f0a',
        retrievedOn: '2026-11-04',
        mediaType: 'text/html',
      },
      {
        url: `${anaf}/AplicatiiDec/structura_S1046_DI_280116.pdf`,
        sha256: '7ac7bccc26210378f426c02a5dd5efd1f66b49864aa2927094dd3aaeaf8ce3b8',
        retrievedOn: '2026-11-04',
        mediaType: 'application/pdf',
      },
      {
        url: `${anaf}/AplicatiiDec/s1046_20160128.xsd`,
        sha256: '419fbaa4a44672c539445f34ac14e1dc683a9b934d8cfe84617c5d58a1255ebb',
        retrievedOn: '2026-11-04',
        mediaType: 'application/xml',
      },
    ],
  },
  {
    id: 'OMF1194/2025',
    kind: 'act',
    title:
      'Ordinul ministrului finanțelor nr. 1.194/2025 pentru aprobarea Sistemului de raportare contabilă la 30 iunie 2025 a operatorilor economici',
    issuer: 'Ministerul Finanțelor',
    publication: null,
    urls: ['https://static.anaf.ro/static/10/Anaf/legislatie/OMF_1194_2025.pdf'],
    fetch: true,
    snapshots: [
      {
        url: 'https://static.anaf.ro/static/10/Anaf/legislatie/OMF_1194_2025.pdf',
        sha256: '77d8628877ff363ba6c46c9616c1a327b34ef666cf8af641b69d1dd18a9bcbd4',
        retrievedOn: '2026-11-04',
        mediaType: 'application/pdf',
      },
    ],
  },
  {
    id: 'ANAF/raportari-semestriale',
    kind: 'official_document',
    title:
      'Raportări contabile semestriale: paginile ANAF pentru 30 iunie 2025 (S1027–S1050, OMF nr. 1.194/2025) și 30 iunie 2026 (fără S1027–S1050)',
    issuer: 'ANAF',
    publication: null,
    urls: [
      `${anaf}/situatiifinanciare/2025/semestriale/1027_1050_2025.html`,
      `${anaf}/situatiifinanciare/2026/semestriale/1034_2026.html`,
    ],
    fetch: true,
    snapshots: [
      {
        url: `${anaf}/situatiifinanciare/2025/semestriale/1027_1050_2025.html`,
        sha256: 'fc2d42e03fadb8155a0fef0aece691502cbbe070e5eb21136025039102a647e1',
        retrievedOn: '2026-11-04',
        mediaType: 'text/html',
      },
      {
        url: `${anaf}/situatiifinanciare/2026/semestriale/1034_2026.html`,
        sha256: '9d67a5816ee9f4a30e208f0db3180a384d166cfb036b5b4f15fc42083bab01bb',
        retrievedOn: '2026-11-04',
        mediaType: 'text/html',
      },
    ],
  },
];

export const annualClauses: readonly Clause[] = [
  {
    id: 'L82/1991:art.28(7),29(1)',
    source: 'L82/1991',
    locator: 'art. 28 alin. (7), art. 29 alin. (1)',
    status: 'located',
    summary:
      'Situațiile financiare anuale constituie un tot unitar și sunt însoțite de raportul administratorilor; ele sunt însoțite și de raportul de audit sau al comisiei de cenzori, după caz, și de propunerea de distribuire a profitului sau de acoperire a pierderii contabile.',
  },
  {
    id: 'L82/1991:art.30',
    source: 'L82/1991',
    locator: 'art. 30',
    status: 'located',
    summary:
      'Situațiile financiare anuale sunt însoțite de o declarație scrisă a persoanelor prevăzute la art. 10 alin. (1) (administratorul sau cel care gestionează entitatea), prin care își asumă răspunderea pentru întocmirea lor și confirmă că: a) politicile contabile sunt conforme reglementărilor aplicabile; b) situațiile oferă o imagine fidelă; c) persoana juridică își desfășoară activitatea în condiții de continuitate.',
  },
  {
    id: 'L82/1991:art.10(1)-(3)',
    source: 'L82/1991',
    locator: 'art. 10 alin. (1)–(3)',
    status: 'located',
    summary:
      'Răspunderea pentru organizarea și conducerea contabilității revine administratorului; contabilitatea se conduce de directorul economic, contabilul-șef sau altă persoană împuternicită, angajată potrivit legii, cu studii economice superioare, ori pe bază de contract cu persoane fizice sau juridice membre CECCAR.',
  },
  {
    id: 'L82/1991:art.28(10)-(13)',
    source: 'L82/1991',
    locator: 'art. 28 alin. (10), (11) și (13)',
    status: 'located',
    summary:
      'Situațiile financiare anuale se semnează de directorul economic, contabilul-șef sau altă persoană împuternicită să îndeplinească această funcție (alin. (10)); pot fi întocmite și semnate de persoane fizice sau juridice autorizate, membre CECCAR (alin. (11)); se semnează și de administrator sau persoana care are obligația gestionării entității (alin. (13)).',
  },
  {
    id: 'L82/1991:art.36(2)',
    source: 'L82/1991',
    locator: 'art. 36 alin. (2)',
    status: 'located',
    summary:
      'Persoanele juridice care de la constituire nu au desfășurat activitate depun o declarație în acest sens în termen de 60 de zile de la încheierea exercițiului financiar.',
  },
  {
    id: 'OMF2036/2025:anexa1.pct.1.6',
    source: 'OMF2036/2025',
    locator: 'anexa nr. 1 pct. 1.6',
    status: 'located',
    summary:
      'Situațiile financiare anuale se semnează conform art. 28 alin. (10) și (13) din Legea contabilității de reprezentantul legal și de directorul economic, contabilul-șef sau altă persoană împuternicită, angajată potrivit legii.',
  },
  {
    id: 'OMF2036/2025:anexa1.pct.1.8',
    source: 'OMF2036/2025',
    locator: 'anexa nr. 1 pct. 1.8 alin. (1), (3), (4)',
    status: 'located',
    summary:
      'Situațiile financiare anuale aprobate se depun numai electronic, semnate cu certificat digital calificat, ca PDF cu XML atașat și o arhivă zip cu prima pagină semnată și documentele cerute de lege, scanate, în limita a 9,5 MB.',
  },
  {
    id: 'OMF2036/2025:anexa1.pct.2.2',
    source: 'OMF2036/2025',
    locator: 'anexa nr. 1 pct. 2.2',
    status: 'located',
    summary:
      'Entitățile mici (care nu sunt microentități și nu depășesc două dintre 25.000.000 lei active, 50.000.000 lei cifră de afaceri, 50 de salariați) întocmesc bilanț prescurtat (cod 10, pct. 599), cont de profit și pierdere (cod 20, pct. 600) și note explicative; opțional situația modificărilor capitalului propriu și/sau a fluxurilor de trezorerie; însoțite de formularele cod 30 (anexa nr. 4 pct. 7) și cod 40 (pct. 8).',
  },
  {
    id: 'OMF2036/2025:anexa1.pct.3.1(1)(a)',
    source: 'OMF2036/2025',
    locator: 'anexa nr. 1 pct. 3.1 alin. (1) lit. a) și alin. (3)',
    status: 'located',
    summary:
      'Societățile reglementate de Legea nr. 31/1990 depun situațiile financiare anuale până la data de 31 mai inclusiv a exercițiului financiar următor; o zi nelucrătoare mută termenul la prima zi lucrătoare următoare.',
  },
  {
    id: 'OMF2036/2025:anexa1.pct.3.3',
    source: 'OMF2036/2025',
    locator: 'anexa nr. 1 pct. 3.3 alin. (1), (3)–(5)',
    status: 'located',
    summary:
      'Entitățile care nu au desfășurat activitate de la constituire până la sfârșitul exercițiului nu întocmesc situații financiare anuale; depun electronic, în 60 de zile de la încheierea exercițiului, o declarație pe propria răspundere a persoanei care gestionează entitatea, cu denumirea, adresa, telefonul, numărul de la registrul comerțului, CUI și capitalul social.',
  },
  {
    id: 'OMF2036/2025:anexa1.pct.3.5',
    source: 'OMF2036/2025',
    locator: 'anexa nr. 1 pct. 3.5 alin. (1) și (3)',
    status: 'located',
    summary:
      'Situațiile financiare anuale sunt însoțite de raportul administratorilor, raportul de audit sau al comisiei de cenzori, după caz, de propunerea de distribuire a profitului sau de acoperire a pierderii și de declarația scrisă prevăzută la art. 30 din Legea contabilității (politici conforme, imagine fidelă, continuitate).',
  },
  {
    id: 'OMF2036/2025:anexa4.pct7',
    source: 'OMF2036/2025',
    locator: 'anexa nr. 4 pct. 7 (cod 30 pentru entitățile de la pct. 2.2 și 2.3 din anexa nr. 1)',
    status: 'located',
    summary:
      'Formularul „Date informative” (cod 30) al entităților mici, mijlocii și mari: plăți restante, salariați, redevențe, chirii, subvenții, creanțe restante, tichete, cercetare-dezvoltare, inovare, alte informații din conturi, colaboratori, bunuri din domeniul public, capital social, dividende și creanțe preluate prin cesionare.',
  },
  {
    id: 'OMFP1802/2014:pct.468-469',
    source: 'OMFP1802/2014',
    locator: 'pct. 468 și 469 (textul inițial, M.Of. nr. 963/30.XII.2014)',
    status: 'located',
    summary:
      'Notele explicative ale tuturor entităților cuprind politicile contabile (bazele de evaluare, conformitatea, modificările), angajamentele, garanțiile și datoriile contingente, avansurile și creditele acordate conducerii, elementele excepționale, datoriile exigibile după cinci ani și cele garantate, numărul mediu de angajați; entitățile mici prezintă și informațiile de la pct. 471 lit. a) (mișcările imobilizărilor), m) (societatea-mamă), p) (natura și scopul angajamentelor în afara bilanțului), q) (evenimentele ulterioare) și r) (tranzacțiile cu cei care dețin interese de participare, cu entitățile în care se dețin și cu membrii conducerii).',
  },
  {
    id: 'OMFP1802/2014:pct.489-492',
    source: 'OMFP1802/2014',
    locator: 'pct. 489–492 (textul inițial)',
    status: 'located',
    summary:
      'Raportul administratorilor prezintă fidel dezvoltarea și performanța activității și poziția entității, principalele riscuri și incertitudini, indicatori financiari, dezvoltarea previzibilă, cercetarea-dezvoltarea, achizițiile de acțiuni proprii, sucursalele și riscurile financiare; microentitățile și entitățile mici nu prezintă informațiile nefinanciare de la pct. 491 alin. (1).',
  },
  {
    id: 'OMF1194/2025:art.2,anexa.pct.16-17',
    source: 'OMF1194/2025',
    locator: 'art. 2 alin. (1) și (4); anexa, cap. I lit. A pct. 16–17',
    status: 'located',
    summary:
      'Raportarea contabilă la 30 iunie 2025 se aplică entităților sub OMFP nr. 1.802/2014 care în exercițiul precedent au avut o cifră de afaceri netă mai mare decât echivalentul în lei a 1.000.000 euro, la cursul BNR valabil la data încheierii exercițiului precedent; nu o întocmesc entitățile fără activitate de la înființare până la 30 iunie 2025, cele în inactivitate temporară tot semestrul I, cele înființate în 2025 și cele în lichidare; termen 18 august 2025.',
  },
  {
    id: 'ANAF/raportari-semestriale:2026',
    source: 'ANAF/raportari-semestriale',
    locator: 'pagina raportărilor semestriale la 30 iunie 2026 (S1034), meniul formularelor',
    status: 'located',
    summary:
      'Pentru 30 iunie 2026 meniul ANAF cuprinde S1012, S1013, S1029, S1031–S1033, S1034, S1035–S1078, S1036–S1038, S1057, S1058, S1059–S1060, S1074 și S1081, dar nu S1027–S1050, raportările operatorilor economici publicate pentru 2025 în baza OMF nr. 1.194/2025 (pagina lor pentru 2026 nu există); ordinul pentru 2026 nu este publicat.',
  },
  {
    id: 'ANAF/SF-2025:S1003',
    source: 'ANAF/SF-2025',
    locator:
      'structura_SC_1225_270126, S1003 (BS) pp. 5–7, F20 pp. 22–28, F30_capital_MM, F30_dividende_MM_an, F30_creante_MM_an, formule suplimentare S1003',
    status: 'located',
    summary:
      'Situațiile financiare ale entităților mici pentru 2025: Bilant1003, tipBIL BS, F10 (F10_BS), F20 (contul de profit și pierdere, rd. 1–70), F30 (cap. I–XVIII) și F40, namespace s1003:declaratie:v15; regulile de control și legăturile dintre formulare.',
  },
  {
    id: 'ANAF/S1046:structura',
    source: 'ANAF/S1046',
    locator: 'structura_S1046_DI_280116, A1.0.0',
    status: 'located',
    summary:
      'Declarația de inactivitate: luna 12, an ≥ 2015, tipul societății, data de sfârșit, CUI, denumirea, adresa, registrul comerțului, tipBIL DI, județul, capitalul social, declarantul, totalPlata_A = capital.',
  },
];
