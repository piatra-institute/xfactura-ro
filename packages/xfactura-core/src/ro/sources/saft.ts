import type { Clause, LegalSource } from './index';

/*
 * The sources of D406 (SAF-T) beyond its order (OPANAF nr. 1.783/2021 and nr. 407/2025, in the
 * register's main list): ANAF's schema and its definitions workbook, the taxpayer's guide, ANAF's
 * answers, its clarification of the annual assets file and its worked examples of fixed assets.
 * Kept apart from the main list, which spreads them in.
 */

const saft = 'https://static.anaf.ro/static/10/Anaf/Informatii_R';
const declarations = 'https://static.anaf.ro/static/10/Anaf/Declaratii_R/AplicatiiDec';

export const saftSources: readonly LegalSource[] = [
  {
    id: 'ANAF/D406',
    kind: 'official_document',
    title:
      'Schema SAF-T pentru România 2.4.9 (Ro_SAFT_Schema_v249_2025.xsd) și definițiile ei (RO_SAFT_SchemaDefCod_05.02.2026.xlsx): structura, modul de raportare pe tipuri de fișier și nomenclatoarele',
    issuer: 'ANAF',
    publication: null,
    urls: [
      `${declarations}/Ro_SAFT_Schema_v249_2025.xsd`,
      `${declarations}/RO_SAFT_SchemaDefCod_05.02.2026.xlsx`,
    ],
    fetch: true,
    snapshots: [
      {
        url: `${declarations}/Ro_SAFT_Schema_v249_2025.xsd`,
        sha256: '80ad7eaaf2aafd656a6e3c0e69e3a8fcdb23262640287ebba6383ff3014dccc2',
        retrievedOn: '2026-10-29',
        mediaType: 'application/xml',
      },
      {
        url: `${declarations}/RO_SAFT_SchemaDefCod_05.02.2026.xlsx`,
        sha256: 'd0981202182438e4597ff3bc27d2c41dec06c60bc32b86620c1de29a9cb8436d',
        retrievedOn: '2026-10-29',
        mediaType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      },
    ],
  },
  {
    id: 'ANAF/SAFT_Ghid_2021',
    kind: 'official_document',
    title:
      'Ghidul contribuabilului pentru pregătirea și depunerea Declarației informative D406 – Fișierul standard de control fiscal (SAF-T), 17.12.2021',
    issuer: 'ANAF',
    publication: null,
    urls: [`${saft}/SAF_T_Ghidul_D406_1712021.pdf`],
    fetch: true,
    snapshots: [
      {
        url: `${saft}/SAF_T_Ghidul_D406_1712021.pdf`,
        sha256: 'ccf4c4062e4fd7cbe644ba20fb85eb4366f44c5a96f7ff26de046e8ae791924a',
        retrievedOn: '2026-11-04',
        mediaType: 'application/pdf',
      },
    ],
  },
  {
    id: 'ANAF/SAFT_FAQ_2022',
    kind: 'official_document',
    title: 'Întrebări frecvente și răspunsuri specifice schemei SAF-T, versiunea 1.2 (20.04.2022)',
    issuer: 'ANAF',
    publication: null,
    urls: [`${saft}/Intrebari_rasp_specifice_SAF-T_v_1_2_200422.pdf`],
    fetch: true,
    snapshots: [
      {
        url: `${saft}/Intrebari_rasp_specifice_SAF-T_v_1_2_200422.pdf`,
        sha256: '853e93302fcf6ae5e6d276ccd411056fdc35067f9b3fb3c932996c48af7f3f0b',
        retrievedOn: '2026-11-04',
        mediaType: 'application/pdf',
      },
    ],
  },
  {
    id: 'ANAF/D406_Clarificare_2022',
    kind: 'official_document',
    title: 'Clarificare referitoare la depunerea Declarației anuale D406 Active (14.11.2022)',
    issuer: 'ANAF',
    publication: null,
    urls: [`${saft}/Clarificare_D406_14112022.pdf`],
    fetch: true,
    snapshots: [
      {
        url: `${saft}/Clarificare_D406_14112022.pdf`,
        sha256: 'f762a7a5240d49350a13e15498876373b5515e4334fd6bfd34c531c08e256766',
        retrievedOn: '2026-11-05',
        mediaType: 'application/pdf',
      },
    ],
  },
  {
    // Read for the annual assets file's conventions (signs, the gross value that leaves, the
    // valuation "contabil"); a workbook, so no clause excerpts it.
    id: 'ANAF/SAFT_Exemple_Imobilizari',
    kind: 'official_document',
    title:
      'Exemple de raportare a imobilizărilor în D406 (modernizare și amortizare, vânzare, reevaluare)',
    issuer: 'ANAF',
    publication: null,
    urls: [`${saft}/Exemple_Imobilizari%20site%20ANAF.xls`],
    fetch: true,
    snapshots: [
      {
        url: `${saft}/Exemple_Imobilizari%20site%20ANAF.xls`,
        sha256: 'dfc561c2d843d00e740212911c210c6ee1809e35446722e3d97624d56d33b2c5',
        retrievedOn: '2026-11-05',
        mediaType: 'application/vnd.ms-excel',
      },
    ],
  },
];

export const saftClauses: readonly Clause[] = [
  {
    id: 'OPANAF1783/2021:anexa4.pct.1,7-8',
    source: 'OPANAF1783/2021',
    locator: 'anexa nr. 4 pct. 1 (secțiunea „Active”), 7 și 8',
    status: 'located',
    summary:
      'Secțiunea „Active” a D406 se întocmește la nivelul anului financiar și se transmite o singură dată, până la termenul de depunere a situațiilor financiare ale exercițiului; poate fi o declarație independentă, cu zonele obligatorii pentru active.',
  },
  {
    id: 'OPANAF407/2025:anexa5.pct.1-2',
    source: 'OPANAF407/2025',
    locator: 'anexa nr. 5 pct. 1.1–1.3 și 2 (anexa nr. 5 la OPANAF nr. 1.783/2021)',
    status: 'located',
    summary:
      'Datele de referință: marii contribuabili de la 1.01.2022 (cei deveniți mari la 1.01.2022 de la 1.07.2022), cei mijlocii de la 1.01.2023, cei mici și nerezidenții înregistrați doar în scop de TVA de la 1.01.2025; cei încadrați ulterior, de la încadrare; cine a început să depună continuă.',
  },
  {
    id: 'ANAF/D406_Clarificare_2022:precizari',
    source: 'ANAF/D406_Clarificare_2022',
    locator: 'precizările 1–3',
    status: 'located',
    summary:
      'Mijloacele fixe se raportează anual, până la termenul situațiilor financiare; un an financiar început înainte de obligația de raportare nu se raportează; declarația pentru active se depune după toate declarațiile D406 lunare sau trimestriale ale anului.',
  },
  {
    id: 'ANAF/SAFT_FAQ_2022:MF.A.25-SD.AT.18',
    source: 'ANAF/SAFT_FAQ_2022',
    locator: 'răspunsurile la MF.A.25–MF.A.26 și SD.AT.16–SD.AT.18',
    status: 'located',
    summary:
      'Metoda de amortizare se scrie în text liber („LINIARĂ”); rata de amortizare, în procente (1% se înscrie 1.00); în tranzacții, costul doar pentru achiziții, scăderile de valoare cu minus, la vânzare câștigul sau pierderea.',
  },
  {
    id: 'ANAF/SAFT_FAQ_2022:MF.TT.2',
    source: 'ANAF/SAFT_FAQ_2022',
    locator: 'răspunsul 1 la MF.TT.2 / MF.TT.5 (Tabela taxe)',
    status: 'located',
    summary:
      'Pentru alte taxe decât TVA și impozitele reținute la sursă (WHT), contribuabilul alege TaxType-ul impozitului sau codul generic 000, cu TaxCode 000000; ANAF recomandă codul generic. WHT se raportează cu codurile din nomenclatorul WHT.',
  },
  {
    id: 'ANAF/SAFT_Ghid_2021:2.12',
    source: 'ANAF/SAFT_Ghid_2021',
    locator: 'secțiunea 2.12 „Subsecțiunea Assets (Active)”, notele',
    status: 'located',
    summary:
      'Se raportează toate mijloacele fixe deținute în perioadă; AssetValuationType „contabil”; ValuationClass, codul din Catalogul HG nr. 2.139/2004; valorile de început și sfârșit, creșterile, ieșirile, amortizarea perioadei și cea cumulată; fără ajustări extraordinare, metoda și suma lor sunt nule.',
  },
];
