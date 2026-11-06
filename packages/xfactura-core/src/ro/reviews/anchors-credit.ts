import type { Anchor } from './types';

/*
 * The excerpts of the clauses of credit notes in a currency (src/ro/sources/credit.ts), as
 * `clauseAnchors` reads them: the Fiscal Code's norms in ANAF's consolidated HTML, and OMFP nr.
 * 1.802/2014 in ANAF's PDF of the order (its hyphens are U+2010, its „ş” the cedilla form).
 */
const CODE = 'ANAF/Cod-fiscal-consolidat';
const OMFP = 'OMFP1802/2014';

export const creditAnchors: Readonly<Record<string, readonly Anchor[]>> = {
  [`${CODE}:norme.art.290.pct.35(6)`]: [
    {
      from: '(6) Pentru operațiunile în interiorul țării, dacă baza impozabilă este stabilită în valută',
      to: 'respectiv conform prevederilor art. 280 - 282 alin. (1) și (2) din Codul fiscal.',
    },
  ],
  [`${OMFP}:pct.314(2)-(3)`]: [
    {
      from: '(2) În conformitate cu prevederile art. 6 alin. (1) din Legea contabilității nr. 82/1991',
      to: 'orice document în care se consemnează aceasta.',
    },
  ],
  [`${OMFP}:pct.319`]: [
    {
      from: '319. ‐ O tranzacție în valută trebuie înregistrată inițial',
      to: 'de la data efectuării operațiunii.',
    },
  ],
  [`${OMFP}:pct.330(1)`]: [
    {
      from: '330. ‐ (1) În cazul mărfurilor returnate de clienți',
      to: 'Tratamentul TVA în aceste situații este cel prevăzut de legislația în domeniu.',
    },
  ],
  [`${OMFP}:pct.322`]: [
    {
      from: '322. ‐ (1) Diferențele de curs valutar care apar cu ocazia decontării',
      to: 'în cursul fiecărei luni.',
    },
  ],
};
