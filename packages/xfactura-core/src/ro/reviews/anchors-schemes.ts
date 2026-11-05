import type { Anchor } from './types';

/*
 * The excerpts of the special VAT schemes' clauses (src/ro/sources/schemes.ts), as
 * `clauseAnchors` reads them: ANAF's consolidated Fiscal Code (HTML), OPANAF nr. 174/2026 and
 * ANAF's D394 structure (PDF, as pdftotext gives them).
 */
const CODE = 'ANAF/Cod-fiscal-consolidat';

export const schemeAnchors: Readonly<Record<string, readonly Anchor[]>> = {
  // The agricultural inputs and services at the reduced rate, and the joint order of 2016 that
  // lists them (OMFP1155/2016, the owner's PDF; it spells ş and ţ with a cedilla).
  [`${CODE}:art.291(2)(e)-(f)`]: [
    {
      from: 'e) livrarea de îngrășăminte și pesticide de tipul celor utilizate în mod normal în producția agricolă, altele decât cele prevăzute la lit. f)',
      to: 'prevăzute prin ordin comun al ministrului finanțelor și al ministrului agriculturii și dezvoltării rurale;',
    },
    {
      from: 'f) livrarea de îngrășăminte chimice și de pesticide chimice',
      to: 'prevăzute prin ordin comun al ministrului finanțelor și al ministrului agriculturii și dezvoltării rurale;',
    },
    {
      from: '(33) Prevederile alin. (2) lit. f) se aplică până la data de 31 decembrie 2031 inclusiv.',
      to: '31 decembrie 2031 inclusiv.',
    },
  ],
  'OMFP1155/2016:art.1(1)-(2)': [
    {
      from: '(1) În sensul art. 291 alin. (2) lit. h) din Legea nr. 227/2015 privind Codul fiscal',
      to: 'noţiunea de cod NC are înţelesul prevăzut la art. 266 alin. (1) pct. 9 din Legea nr. 227/2015 privind Codul fiscal, cu modificările şi completările ulterioare.',
    },
    {
      from: 'Prevederile prezentului ordin se aplică începând cu data de 1 august 2016.',
      to: 'începând cu data de 1 august 2016.',
    },
  ],
  'OMFP1155/2016:anexa': [
    {
      from: '(3) Prestările de servicii de tipul celor specifice utilizate în sectorul agricol',
      to: 'integrantă din prezentul ordin.',
    },
    {
      from: 'Prestări de servicii de tipul celor specifice utilizate în sectorul agricol 1. Fertilizat',
      to: '34. Decolmatat sau curăţat canale de irigaţii şi/sau de desecare',
    },
  ],
  [`${CODE}:art.311(1)-(3)`]: [
    {
      from: '(1) În sensul aplicării prezentului articol, prin agenție de turism se înțelege',
      to: 'și serviciul este prestat prin sediul din România.',
    },
  ],
  [`${CODE}:art.311(4)-(6)`]: [
    {
      from: '(4) Baza de impozitare a serviciului unic prevăzut la alin. (2) este constituită din marja de profit',
      to: 'utilizate de agenția de turism pentru furnizarea serviciului unic prevăzut la alin. (2).',
    },
  ],
  [`${CODE}:art.311(7)-(12)`]: [
    {
      from: '(7) Agenția de turism trebuie să țină, în plus față de evidențele',
      to: 'evidențe contabile separate pentru fiecare tip de operațiune în parte.',
    },
  ],
  [`${CODE}:norme.art.311.pct.85`]: [
    {
      from: '85. (1) În sensul art. 311 din Codul fiscal, călătorul poate fi',
      to: 'aplică la rândul său regimul special prevăzut la art. 311 din Codul fiscal.',
    },
  ],
  [`${CODE}:art.312(1)`]: [
    {
      from: 'e) persoana impozabilă revânzătoare este persoana impozabilă care, în cursul desfășurării activității economice',
      to: 'antichități la cota de marjă a profitului.',
    },
  ],
  [`${CODE}:art.312(2)-(4)`]: [
    {
      from: '(2) Persoana impozabilă revânzătoare va aplica regimul special pentru livrările de bunuri second-hand',
      to: 'plus taxa datorată sau achitată la import.',
    },
  ],
  [`${CODE}:art.312(5)-(12)`]: [
    {
      from: '(5) Orice livrare de bunuri second-hand, opere de artă, obiecte de colecție sau antichități, efectuată în regim special',
      to: 'în mod distinct, în facturile emise clienților.',
    },
  ],
  [`${CODE}:art.312(13)-(15)`]: [
    {
      from: '(13) În condițiile stabilite prin normele metodologice, persoana impozabilă revânzătoare care aplică regimul special',
      to: 'organizatori de vânzări prin licitație publică în condițiile stabilite prin normele metodologice.',
    },
  ],
  [`${CODE}:norme.art.312.pct.86`]: [
    {
      from: '86. (1) În sensul art. 312 alin. (1) lit. d) din Codul fiscal, bunurile second-hand includ',
      to: 'care nu trebuie să menționeze separat valoarea taxei.',
    },
  ],
  [`${CODE}:art.315^1(1)-(4)`]: [
    {
      from: 'a) regimul special pentru agricultori se aplică pentru activitățile prevăzute la lit. c) și d)',
      to: 'pentru aplicarea regimului special de scutire pentru întreprinderile mici prevăzută la art. 310.',
    },
  ],
  [`${CODE}:art.315^1(5)-(8)`]: [
    {
      from: '(5) Agricultorul care aplică regimul special prevăzut de prezentul articol depune la organul fiscal competent',
      to: 'persoana obligată la plata taxei conform echivalentului din legislația altui stat membru al art. 307 alin. (2).',
    },
  ],
  [`${CODE}:art.315^1(9)-(16)`]: [
    {
      from: '(9) Prin excepție de la prevederile art. 268 alin. (3) lit. a), nu sunt considerate operațiuni impozabile în România achizițiile intracomunitare de bunuri efectuate de agricultorii',
      to: 'neavând drept de deducere pentru bunurile/serviciile alocate activităților supuse acestui regim.',
    },
  ],
  [`${CODE}:art.315^1(17)-(18)`]: [
    {
      from: '(17) Persoanele impozabile înregistrate în scopuri de TVA conform art. 316, cărora agricultorul',
      to: 'neînregistrate în scopuri de TVA conform art. 316.',
    },
  ],
  [`${CODE}:norme.art.315^1.pct.87^1`]: [
    {
      from: '871. (1) În sensul art. 3151 alin. (1) lit. c), activitățile de producție agricolă includ:',
      to: 'numai în măsura în care agricultorul este înscris la data livrării/prestării în Registrul agricultorilor care aplică regimul special.',
    },
  ],
  [`${CODE}:art.319(20)(k),(n),(o)`]: [
    {
      from: 'k) În cazul în care factura este emisă de beneficiar în numele și în contul furnizorului, mențiunea',
      to: '"regimul marjei - obiecte de colecție și antichități", după caz;',
    },
  ],
  [`${CODE}:art.319(18)`]: [
    {
      from: '(18) Pot fi emise facturi de către beneficiar în numele și în contul furnizorului/prestatorului',
      to: 'în condițiile stabilite prin normele metodologice.',
    },
    {
      from: '96. (1) Potrivit prevederilor art. 319 alin. (18) din Codul fiscal, factura se poate întocmi de către cumpărătorul',
      to: 'dacă este înregistrat în România conform art. 316 din Codul fiscal.',
    },
  ],
  'OPANAF174/2026:rd.9.special': [
    {
      from: '- baza de impozitare şi taxa pe valoarea adăugată colectată pentru operaţiunile supuse regimurilor speciale',
      to: 'determinate pe baza situaţiilor de calcul întocmite în acest scop;',
    },
  ],
  'OPANAF174/2026:rd.27-28': [
    {
      from: 'Rândul 27 - se înscriu sumele reprezentând compensaţia în cotă forfetară',
      to: 'înscrise la rândul 27.',
    },
  ],
  'ANAF/D394:op1.LS-AS': [
    {
      from: 'Nr facturi aferente livrarilor de bunuri/prestari servicii pt operatiunile derulate în regim special pt agentiile de turism',
      to: 'colecție și antichitati',
    },
    {
      from: 'LS = livrari regim special AS = achizitii regim special către pers care aplica sistemul normal de',
      to: 'AI,LS,AS,ASI,N',
    },
  ],
  'ANAF/D394:informatii.marja': [
    {
      from: 'Valoarea incasarilor agentiei persoanelor care aplica regimul special pt agentiile de turism',
      to: 'Marja de profit persoanelor care aplica regimul special pt bunurile second-hand,',
    },
  ],
  // The D394 instructions, consolidated to 17.09.2025.
  'OPANAF3769/2015-A:anexa2.regim-special': [
    {
      from: '12. numărul total al facturilor primite pentru achizițiile de bunuri și servicii efectuate de către persoana impozabilă de la persoane impozabile care aplică regimul special',
      to: 'și care aplică sistemul normal de TVA;',
    },
    {
      from: '– valorile totale înscrise în facturile emise/primite aferente tranzacțiilor efectuate de către persoanele impozabile care aplică regimul special',
      to: 'inclusiv valoarea marjei de profit și a TVA aferentă;',
    },
  ],
  'OPANAF3769/2015-A:anexa2.sect1.litI.pct.6': [
    {
      from: '6. valoarea totală a TVA colectată aferentă marjei de profit',
      to: 'și prețul de cumpărare și TVA aferentă;',
    },
  ],
};
