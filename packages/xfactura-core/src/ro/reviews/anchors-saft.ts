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
};
