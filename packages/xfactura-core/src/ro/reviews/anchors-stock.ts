import type { Anchor } from './types';

/*
 * The excerpts of the stock register's clauses (src/ro/sources/stock.ts), as `clauseAnchors`
 * reads them: OMFP nr. 1.802/2014 (both texts), OMF nr. 2.861/2009, OPANAF nr. 1.783/2021,
 * OMFP nr. 2.634/2015 and ANAF's SAF-T guide and answers in their PDFs as `pdftotext` gives them,
 * the Fiscal Code in ANAF's consolidated HTML, the D406 structure in its workbook and schema.
 */
export const stockAnchors: Readonly<Record<string, readonly Anchor[]>> = {
  'OMFP1802/2014:pct.8(6)': [
    {
      from: '6. cost de achiziție înseamnă prețul datorat şi eventualele cheltuieli conexe',
      to: 'atunci când funcția de aprovizionare este externalizată;',
    },
  ],
  'OMFP1802/2014:pct.75(1)': [
    {
      from: '75. ‐ (1) La data intrării în entitate, bunurile se evaluează',
      to: 'valoarea justă se substituie costului de achiziție.',
    },
  ],
  'OMFP1802/2014:pct.76': [
    {
      from: '76. ‐ (1) Reducerile comerciale acordate de furnizor',
      to: 'tranzacțiilor efectuate cu acelaşi terț, în decursul unei perioade determinate.',
    },
  ],
  'OMFP1802/2014:pct.88': [
    {
      from: '88. ‐ (1) Activele de natura stocurilor se evaluează la cost',
      to: 'costurile estimate necesare vânzării.',
    },
  ],
  'OMFP1802/2014-A:pct.95-96': [
    {
      from: '95. - (1) La data ieșirii din entitate sau la darea în consum',
      to: 'costul de producție al lotului anterior, în ordine cronologică.',
    },
  ],
  'OMFP1802/2014:pct.95(2)-(3)': [
    {
      from: '(2) Activele constatate minus în gestiune se scot din evidență la data constatării lipsei acestora.',
      to: 'pierdere de valoare aferente acestora.',
    },
  ],
  'OMFP1802/2014-A:pct.272-276': [
    { from: '272. - (1) Stocurile sunt active circulante:', to: 'din Planul de conturi general).' },
  ],
  'OMFP1802/2014:pct.283-284': [
    {
      from: '283. ‐ (1) Înregistrarea în contabilitate a intrării stocurilor se efectuează la data transferului',
      to: 'potrivit contractelor încheiate.',
    },
  ],
  'OMFP1802/2014:pct.285-286': [
    {
      from: '285. ‐ (1) Costul stocurilor care nu sunt de obicei fungibile',
      to: 'Orice modificare a prețului de vânzare presupune recalcularea marjei brute.',
    },
  ],
  'OMFP1802/2014:pct.287': [
    {
      from: '287. ‐ (1) Metoda aleasă trebuie aplicată cu consecvență',
      to: 'nu este suficientă pentru a justifica alegerea de metode diferite.',
    },
  ],
  'OMFP1802/2014:pct.289-292': [
    {
      from: '289. ‐ Contabilitatea stocurilor se ține cantitativ',
      to: 'prin reflectarea unei ajustări pentru depreciere.',
    },
  ],
  'OMFP1802/2014:plan.clasa3': [
    {
      from: 'Clasa 3 ‐ Conturi de stocuri şi producție în curs de execuție 30. Stocuri de materii prime',
      to: '398. Ajustări pentru deprecierea ambalajelor (P)',
    },
  ],
  'OMFP1802/2014:conturi.30': [
    {
      from: 'Contul 301 "Materii prime" Cu ajutorul acestui cont',
      to: 'se reiau pe cheltuieli la aceeaşi valoare.',
    },
  ],
  'OMFP1802/2014:conturi.371-378': [
    {
      from: 'Contul 371 "Mărfuri" Cu ajutorul acestui cont',
      to: 'aferent mărfurilor existente în stoc la sfârşitul perioadei.',
    },
  ],
  'OMFP1802/2014:conturi.381-388': [
    {
      from: 'Contul 381 "Ambalaje" Cu ajutorul acestui cont',
      to: 'aferente ambalajelor existente în stoc la sfârşitul perioadei.',
    },
  ],
  'OMFP1802/2014:conturi.39': [
    {
      from: 'GRUPA 39 "AJUSTĂRI PENTRU DEPRECIEREA STOCURILOR',
      to: 'Soldul conturilor reprezintă valoarea ajustărilor constituite la sfârşitul perioadei.',
    },
  ],
  'OMFP1802/2014:conturi.401(intermitent)': [
    {
      from: 'inventar, mărfurilor, ambalajelor etc. achiziționate, în cazul folosirii metodei inventarului intermitent (601,',
      to: '602, 603, 607, 608);',
    },
  ],
  'OMFP1802/2014:conturi.408': [
    {
      from: 'Contul 408 "Furnizori ‐ facturi nesosite" Cu ajutorul acestui cont se ține evidența decontărilor cu furnizorii',
      to: '‐ valoarea facturilor sosite (401);',
    },
  ],
  'OMFP1802/2014:conturi.4428': [
    {
      from: 'Contul 4428 "Taxa pe valoarea adăugată neexigibilă" În acest cont',
      to: 'Soldul contului reprezintă taxa pe valoarea adăugată neexigibilă.',
    },
  ],
  'OMFP1802/2014:conturi.60': [
    { from: 'GRUPA 60 "CHELTUIELI PRIVIND STOCURILE"', to: 'la care se referă (401).' },
  ],
  'OMFP1802/2014:conturi.681': [
    {
      from: 'Contul 681 "Cheltuieli de exploatare privind amortizările, provizioanele şi ajustările pentru depreciere" Cu ajutorul',
      to: 'sau majorate (391 la 398);',
    },
  ],
  'OMFP1802/2014:conturi.781': [
    {
      from: 'Contul 781 "Venituri din provizioane şi ajustări pentru depreciere privind activitatea de exploatare" Cu ajutorul',
      to: 'producției în curs de execuție (391 la 398);',
    },
  ],
  'OMFP1802/2014:conturi.707': [
    {
      from: 'Contul 707 "Venituri din vânzarea mărfurilor" Cu ajutorul',
      to: 'entități controlate în comun (451, 453).',
    },
  ],
  'ANAF/Cod-fiscal-consolidat:norme.art.270.pct.7(5)': [
    {
      from: '(5) Bunurile constatate lipsă din gestiune nu sunt considerate livrări de bunuri',
      to: 'ale pct. 78, 79 și 80.',
    },
  ],
  'ANAF/Cod-fiscal-consolidat:art.304(1)-(2)': [
    {
      from: '(1) În condițiile în care regulile privind livrarea către sine sau prestarea către sine nu se aplică, deducerea inițială se ajustează',
      to: 'b) situațiilor prevăzute la art. 270 alin. (8) și la art. 271 alin. (5).',
    },
  ],
  'ANAF/Cod-fiscal-consolidat:norme.art.304.pct.78(10)-(13)': [
    {
      from: '(10) În sensul art. 304 alin. (2) lit. a) din Codul fiscal',
      to: 'utilizând cota de taxă în vigoare la data la care intervine obligația/dreptul de ajustare.',
    },
  ],
  'ANAF/Cod-fiscal-consolidat:art.25(3)(d)': [
    {
      from: '(3) Următoarele cheltuieli au deductibilitate limitată:',
      to: 'd) scăzămintele, perisabilitățile, pierderile rezultate din manipulare/depozitare, potrivit legii;',
    },
  ],
  'ANAF/Cod-fiscal-consolidat:art.25(4)(c)': [
    {
      from: 'c) cheltuielile privind bunurile de natura stocurilor sau a mijloacelor fixe amortizabile constatate lipsă din gestiune',
      to: 'dacă termenul de valabilitate/expirare este depășit, potrivit legii;',
    },
  ],
  'ANAF/Cod-fiscal-consolidat:art.26(1)': [
    {
      from: '(1) Contribuabilul are dreptul la deducerea rezervelor și provizioanelor/ajustărilor pentru depreciere, numai în conformitate cu prezentul articol, astfel:',
      to: '2. au fost încheiate contracte de asigurare.',
    },
  ],
  'OMF2861/2009-A:pct.40': [
    {
      from: '40. - (1) În situaţia constatării unor plusuri în gestiune',
      to: 'Eliminarea se face începând cu sorturile care au preţurile unitare cele mai scăzute, în ordine crescătoare.',
    },
  ],
  'OMF2861/2009-A:pct.41': [
    {
      from: '41. - (1) Pentru bunurile la care sunt acceptate scăzăminte',
      to: 'aşa cum a fost definită în prezentele norme.',
    },
  ],
  'OPANAF1783/2021:anexa4.pct.9-10': [
    {
      from: '9. Informaţiile privind "stocurile de produse" şi "producţie în curs"',
      to: 'care nu poate fi mai mic de 30 de zile calendaristice de la data solicitării.',
    },
  ],
  'ANAF/SAFT_Ghid_2021:4.6.stocuri': [
    {
      from: 'La cerere, există obligația de raportare pentru următoarele secțiuni privind Stocurile',
      to: '4.4 MovementOfGoods [Mișcări Bunuri]',
    },
  ],
  'ANAF/SAFT_FAQ_2022:MovementOfGoods': [
    {
      from: 'In sub-secțiunea “StockMovement” se raportează mișcările de stocuri pe baza documentelor corespunzătoare',
      to: 'respectand perioaa prevazuta in solicitarea ANAF',
    },
  ],
  'ANAF/D406:S.H.11': [
    {
      from: 'Restricție pentru valorile: - L - pentru declarații lunare - T - pentru declarații trimestriale - A - pentru declarații anuale - C - pentru declarații la cerere',
      to: '- NT - nerezidenti trimestrial',
    },
  ],
  'ANAF/D406:Nomenclator_stocuri': [
    {
      from: 'NOMENCLATOR CODIFICARE MIȘCĂRI DE PRODUSE ÎN STOCURI',
      to: 'unde acest câmp este OBLIGATORIU.',
    },
  ],
  'ANAF/D406:xsd.PhysicalStock': [
    { from: '<xs:element name="PhysicalStock" minOccurs="0">', to: '<xs:element name="Owners">' },
  ],
  'ANAF/D406:xsd.MovementOfGoods': [
    {
      from: '<xs:element name="MovementOfGoods">',
      to: '<xs:element name="AssetTransactions" minOccurs="0">',
    },
  ],
  'OMFP2634/2015:anexa1.pct.2': [
    {
      from: '2. Documentele justificative trebuie să cuprindă următoarele elemente principale:',
      to: 'operaţiunii economico-financiare.',
    },
  ],
  'OMFP2634/2015:anexa4': [
    { from: '| 1.| Notă de recepţie şi constatare de diferenţe', to: '| global-valorice)' },
  ],
};
