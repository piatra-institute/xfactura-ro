import type { Anchor } from './types';

/** Where the D406 clauses (sources/saft.ts and the order's annexes) start and end in their
 * snapshots' text: the order in its own spelling (ş, ţ), ANAF's documents in theirs. */
export const saftAnchors: Readonly<Record<string, readonly Anchor[]>> = {
  'OPANAF1783/2021:anexa4.pct.1,7-8': [
    {
      from: '1. Declaraţia informativă D406 se transmite în format electronic',
      to: 'în cazul secţiunii "Active";',
    },
    {
      from: '7. Informaţiile privind "Activele"',
      to: 'ci doar a zonelor indicate ca fiind obligatorii pentru transmiterea acestui tip de informaţie.',
    },
  ],
  'OPANAF407/2025:anexa5.pct.1-2': [
    {
      from: '1.1. Obligaţia de transmitere a fişierului standard',
      to: 'continuă să raporteze fişierul standard de control fiscal prin depunerea de declaraţii informative D406.',
    },
  ],
  'ANAF/D406_Clarificare_2022:precizari': [
    { from: 'facem următoarele precizări:', to: '(lunare sau trimestriale).' },
  ],
  'ANAF/SAFT_FAQ_2022:MF.A.25-SD.AT.18': [
    {
      from: 'Informația din câmpul MF.A.25 Depreciation Method',
      to: 'Rata de amortizarea lunară de 1% se înscrie ca 1.00.',
    },
    {
      from: 'SD.AT.16 AcquisitionAndProductionCostOnTransaction se va raporta valoarea de achiziție',
      to: 'creștere neta sau scădere neta de valoare înregistrată la reevaluare, etc.).',
    },
  ],
  'ANAF/SAFT_Ghid_2021:2.12': [
    { from: '2.12. Subsecțiunea Assets (Active)', to: 'acest element se va completa cu 0.' },
  ],
  'ANAF/SAFT_Ghid_2021:2.5': [
    {
      from: '2.5. Subsecțiunea Tax Table (Tabelă taxe)',
      to: 'descrierea codului de taxă din nomenclatorul aferent.',
    },
  ],
  'ANAF/SAFT_FAQ_2022:MF.TT.12': [
    {
      from: 'În cadrul raportării Declarației informative D406 -SAF-T pentru România, valoare implicită',
      to: 'nomenclator disponibil în cadrul Schemei SAF-T pentru România.',
    },
  ],
  'ANAF/SAFT_FAQ_2022:R6.distanta': [
    {
      from: '2. Societatea realizeaza vanzarile la distanta din Bulgaria si Ungaria',
      to: 'se raportează în decontul de TVA din alte țări.',
    },
  ],
  // The workbook has no text extraction: the anchors name its cells' strings, in its order.
  'ANAF/D406:MF.TT.9-12': [
    {
      from: 'MF.TT.9 TaxPercentage Tax percentage Procentul de impozitare',
      to: 'Valoare implicită ”RO” pentru România',
    },
  ],
  'ANAF/D406:S.AM.1-4': [
    {
      from: 'N/A - nu se mai face validarea dintre Suma în lei și Suma în valută',
      to: 'convertită pe baza ratei de schimb valutar raportată',
    },
    {
      from: 'Cursul de schimb utilizat. CurrencyAmount x ExchangeRate = Sumă',
      to: 'indiferent de data la care sunt sau vor fi recepționate bunurile/ facturile/ serviciile/ alte documente financiare',
    },
  ],
  'ANAF/D406:S.TI.4': [
    { from: 'Baza pe care se calculează impozitul.', to: 'Aceasta poate fi o sumă' },
  ],
  'ANAF/SAFT_FAQ_2022:MF.C.6': [
    {
      from: 'Pentru cazurile în care se specifică că valoarea trebuie transmisă în valuta implicită',
      to: 'ExchangeRate, declarate de declarant',
    },
  ],
  'ANAF/D406:Livrari.310325': [
    {
      from: 'Livrari de bunuri/ prestari de servicii care nu sunt raportabile in decontul de TVA din Romania si care se raporteaza in decontul de TVA din alte tari',
      to: 'reportable in the VAT return from other countries',
    },
  ],
};
