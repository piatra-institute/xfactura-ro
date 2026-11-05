import type { Anchor } from './types';

/** Where the tax account's clauses start and end in their snapshots (see `clauseAnchors`). */
export const taxAccountAnchors: Readonly<Record<string, readonly Anchor[]>> = {
  'L207/2015:art.163(3)-(5)': [
    {
      from: '(3) Distribuirea sumelor din contul unic se face de organul fiscal competent',
      to: 'în cadrul categoriei respective, proporțional cu obligațiile fiscale datorate.',
    },
  ],
  'L207/2015:art.163(7)': [
    {
      from: '(7) Plata obligațiilor fiscale, altele decât cele prevăzute la alin. (2), se efectuează',
      to: 'distinct pe fiecare tip de creanță fiscală.',
    },
  ],
  'L207/2015:art.165(1)': [
    {
      from: 'Dacă un debitor datorează mai multe tipuri de obligații fiscale, iar suma plătită nu este suficientă',
      to: 'obligațiile cu scadențe viitoare, la solicitarea debitorului.',
    },
  ],
  'L207/2015:art.165(1),(3)': [
    {
      from: 'Dacă un debitor datorează mai multe tipuri de obligații fiscale, iar suma plătită nu este suficientă',
      to: 'obligațiile cu scadențe viitoare, la solicitarea debitorului.',
    },
    {
      from: '(3) În scopul stingerii obligațiilor fiscale, vechimea acestora se stabilește astfel',
      to: 'pentru diferențele de obligații fiscale principale stabilite de organul fiscal competent, precum și pentru obligațiile fiscale accesorii;',
    },
  ],
  'L207/2015:art.173(3)': [
    {
      from: '(3) Nu se datorează obligații fiscale accesorii pentru suma plătită în contul obligației fiscale principale',
      to: 'până la data plății, inclusiv.',
    },
  ],
  'L207/2015:art.173(1),(4)-(5)': [
    {
      from: 'Pentru neachitarea la termenul de scadență de către debitor a obligațiilor fiscale principale',
      to: 'se datorează după acest termen dobânzi și penalități de întârziere.',
    },
    {
      from: '(4) Dobânzile și penalitățile de întârziere se fac venit la bugetul căruia îi aparține creanța principală.',
      to: 'cu excepția situației prevăzute la art. 227 alin. (8).',
    },
  ],
  'OPANAF1613/2018:pct.4-7': [
    {
      from: '4. Sumele plătite de către contribuabili în contul unic se distribuie',
      to: 'dacă acesta a optat pentru a fi înștiințat.',
    },
  ],
  'OPANAF1613/2018:pct.8-10': [
    {
      from: '8.1. În situația în care, după efectuarea operațiunilor de distribuire și de stingere',
      to: 'obligațiile fiscale datorate celorlalte bugete, în mod proporțional.',
    },
  ],
  'OPANAF551/2021:anexa': [
    {
      from: 'NOMENCLATORUL obligaţiilor fiscale care se plătesc în contul unic',
      to: '| 8 | impozit pe veniturile |',
    },
  ],
  'OPANAF551/2021:anexa.poz.11': [
    { from: '| 11 | impozit pe veniturile din', to: '| 12 | impozit pe veniturile din' },
  ],
  'OPANAF551/2021:anexa.poz.18-24': [
    { from: '| 18 | impozit pe veniturile din', to: '| 22 | impozit pe veniturile obţinute|' },
    { from: '| 24 | impozit pe veniturile din', to: '| 25 | impozit pe veniturile obţinute|' },
  ],
  'OPANAF874/2024:art.I.pct.2': [
    {
      from: '2. După poziţia 33 se introduc cinci noi poziţii',
      to: 'alte entităţi care au obligaţia de a conduce evidenţă contabilă',
    },
  ],
  'OMFP1802/2014:conturi.448': [
    {
      from: 'Contul 448 "Alte datorii şi creanțe cu bugetul statului" Cu ajutorul acestui cont',
      to: 'sumele cuvenite de la bugetul de stat.',
    },
  ],
  'OMFP1802/2014:conturi.658': [
    {
      from: 'Contul 658 "Alte cheltuieli de exploatare" Cu ajutorul acestui cont',
      to: 'datorate sau plătite terților şi bugetului (401, 404, 448, 462, 408, 512);',
    },
  ],
  'OMFP1802/2014:conturi.442': [
    {
      from: 'Contul 4423 "Taxa pe valoarea adăugată de plată" Cu ajutorul acestui cont',
      to: 'Soldul contului reprezintă taxa pe valoarea adăugată de recuperat de la bugetul statului.',
    },
  ],
  'OMFP1802/2014:pct.352': [
    {
      from: '352. ‐ (1) Operațiunile care nu pot fi înregistrate direct în conturile corespunzătoare',
      to: 'Sumele înregistrate în acest cont trebuie clarificate',
    },
  ],
};
