import type { Anchor } from './types';

/**
 * Where the year-end's clauses (Y1) start and end in their snapshots: OMFP nr. 1.802/2014 and
 * OMF nr. 2.861/2009 as `pdftotext` gives them. ANAF's copy of OMF nr. 2.861/2009 has a font
 * without Romanian diacritics, which `pdftotext` leaves as spaces (`Finan elor`): the anchors
 * quote the text as extracted.
 */
export const yearEndAnchors: Readonly<Record<string, readonly Anchor[]>> = {
  'OMF2861/2009:pct.37-38': [
    {
      from: '37. La stabilirea valorii de inventar a bunurilor se aplic principiul pruden ei',
      to: 'ar tând totodat cauzele care au determinat aceste deprecieri.',
    },
  ],
  'OMF2861/2009:pct.39-40': [
    {
      from: '39. Pentru toate plusurile, lipsurile i deprecierile constatate la bunuri',
      to: 'valoarea de imputare se stabile te de c tre o comisie format din speciali ti în domeniul respectiv.',
    },
  ],
  'OMF2861/2009:pct.42-43': [
    {
      from: '42. Rezultatele inventarierii se înscriu de c tre comisia de inventariere',
      to: 'decide asupra solu ion rii propunerilor f cute, cu respectarea dispozi iilor legale.',
    },
  ],
  'OMF2861/2009:pct.46(3)': [
    {
      from: '(3) Bunurile constatate lips la inventariere se evalueaz i se înregistreaz în contabilitate la valoarea contabil .',
      to: 'urm rindu-se recuperarea lor potrivit legii.',
    },
  ],
  'OMFP1802/2014:conturi.461': [
    {
      from: 'Contul 461 "Debitori diverşi" Cu ajutorul acestui cont',
      to: '‐ valoarea bunurilor constatate lipsă sau deteriorate, imputate terților (758, 4427);',
    },
  ],
  'OMFP1802/2014:conturi.428': [
    {
      from: 'Contul 428 "Alte datorii şi creanțe în legătură cu personalul" Cu ajutorul acestui cont',
      to: 'imputații şi alte debite, precum şi sumele achitate de unitate acestuia (706, 708, 758, 4427, 438, 512, 531);',
    },
  ],
  'OMFP1802/2014:conturi.758': [
    {
      from: 'Contul 758 "Alte venituri din exploatare" Cu ajutorul acestui cont',
      to: '‐ valoarea despăgubirilor, amenzilor şi penalităților datorate de terți (411, 451, 453, 461, 418);',
    },
  ],
  'OMFP1802/2014:conturi.475': [
    {
      from: 'Contul 475 "Subvenții pentru investiții" Cu ajutorul acestui cont',
      to: 'Soldul contului reprezintă subvențiile pentru investiții, netransferate la venituri.',
    },
  ],
  'OMFP1802/2014:conturi.151': [
    {
      from: 'Contul 151 "Provizioane" Cu ajutorul acestui cont',
      to: '‐ sumele reprezentând diminuarea sau anularea provizioanelor (781).',
    },
  ],
  'OMFP1802/2014:conturi.291': [
    {
      from: 'Contul 291 "Ajustări pentru deprecierea imobilizărilor corporale" Cu ajutorul acestui cont',
      to: 'Soldul contului reprezintă valoarea ajustărilor aferente imobilizărilor corporale.',
    },
  ],
  'OMFP1802/2014:conturi.491': [
    {
      from: 'Contul 491 "Ajustări pentru deprecierea creanțelor ‐ clienți" Cu ajutorul acestui cont',
      to: '‐ diminuarea sau anularea ajustărilor constituite pentru deprecierea creanțelor ‐ clienți (781).',
    },
  ],
  'OMFP1802/2014:pct.82-84': [
    {
      from: '82. ‐ (1) În scopul întocmirii situațiilor financiare anuale, entitățile trebuie să procedeze la inventarierea',
      to: 'aceste elemente menținându‐se la valoarea lor de intrare.',
    },
  ],
  'OMFP1802/2014:pct.85-86': [
    {
      from: '85. ‐ (1) Evaluarea imobilizărilor corporale şi necorporale, cu ocazia inventarierii',
      to: 'se ține cont de surse externe şi interne de informații.',
    },
  ],
  'OMFP1802/2014:pct.89': [
    {
      from: '89. ‐ (1) Evaluarea la inventar a creanțelor şi a datoriilor se face la valoarea lor probabilă',
      to: 'se diminuează cu ajustările pentru pierdere de valoare.',
    },
  ],
  'OMFP1802/2014:pct.331-332': [
    {
      from: '331. ‐ Creanțele incerte se înregistrează distinct în contabilitate',
      to: 'la nivelul sumei care nu se mai poate recupera.',
    },
  ],
  'OMFP1802/2014:pct.353': [
    {
      from: '353. ‐ Pentru deprecierea creanțelor din conturile de clienți',
      to: 'se reflectă ajustări pentru pierdere de valoare.',
    },
  ],
  'OMFP1802/2014:pct.335,338': [
    {
      from: '335. ‐ (1) În vederea înregistrării primelor reprezentând participarea personalului la profit',
      to: 'Provizionul urmează a fi reluat la venituri în exercițiul financiar în care se acordă aceste prime.',
    },
    {
      from: '338. ‐ (1) Sumele datorate şi neachitate personalului până la sfârşitul exercițiului financiar',
      to: 'se aplică şi în cazul bonusurilor acordate angajaților.',
    },
  ],
  'OMFP1802/2014:pct.369-377': [
    {
      from: '369. ‐ (1) Provizioanele sunt destinate să acopere datoriile',
      to: '(2) Contabilitatea provizioanelor se ține pe feluri, în funcție de natura, scopul sau obiectul pentru care au fost constituite.',
    },
  ],
  'OMFP1802/2014:pct.387-388': [
    {
      from: '387. ‐ (1) Valoarea recunoscută ca provizion trebuie să constituie cea mai bună estimare',
      to: 'tratamentul fiscal al acestora fiind cel prevăzut de legislația fiscală.',
    },
  ],
};
