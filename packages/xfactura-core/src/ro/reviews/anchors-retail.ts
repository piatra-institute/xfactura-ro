import type { Anchor } from './types';

/*
 * The excerpts of retail and B2C's clauses (src/ro/sources/retail.ts), as `clauseAnchors` reads
 * them from the PDFs as `pdftotext` gives them: OUG nr. 28/1999 (the owner's LEX EXPERT copy,
 * with cedilla diacritics), OPANAF nr. 146/2018, ANAF's A4203 structure, OMFP nr. 1.802/2014 as
 * consolidated and ANAF's guide of invoice codes v2.9.
 */
export const retailAnchors: Readonly<Record<string, readonly Anchor[]>> = {
  'OUG28/1999:art.1(8)': [
    {
      from: '(8) În cazul defectării aparatelor',
      to: 'în cazul defectării aparatului de marcat electronic fiscal',
    },
  ],
  'OUG28/1999:art.3(3)-(5)': [
    {
      from: '(3) Aparatele de marcat electronice fiscale trebuie să îndeplinească',
      to: 'datele prevăzute la alin. (3) lit. d).',
    },
  ],
  'OUG28/1999:art.3^1': [{ from: 'ART. 3^1 (1) La nivelul', to: 'în condiţiile legii.' }],
  'OUG28/1999:art.4(5)-(9)': [
    {
      from: '(5) Jurnalul electronic se păstrează',
      to: 'sunt obligaţi să asigure păstrarea şi arhivarea memoriilor fiscale pentru o perioadă de 10 ani.',
    },
  ],
  'OUG28/1999:art.5(3)': [
    {
      from: '(3) Aparatele de marcat electronice fiscale trebuie să fie dotate',
      to: 'cartea de intervenţii însoţeşte aparatul.',
    },
  ],
  'OUG28/1999:art.6': [
    {
      from: 'Obligaţia operatorilor economici prevăzuţi la art. 1 de a utiliza',
      to: 'desfăşurate în fiecare locaţie.',
    },
  ],
  'OPANAF146/2018:anexa2.II.7': [{ from: 'Secțiunea II.7', to: '</rB>' }],
  'OPANAF146/2018:anexa2.II.12-II.13': [
    { from: 'Secțiunea II.12', to: 'Secțiunea II.13' },
    {
      from: 'În cazul aparatelor de marcat electronice fiscale care transmit offline',
      to: 'depune la organul fiscal folosind mijloace de transmitere la distanță.',
    },
  ],
  'ANAF/A4203:structura': [{ from: '<rB> apare 1 data', to: 'Alte metode 9' }],
  'OMFP1802/2014-A:pct.286(4)-(8)': [
    {
      from: '(4) Repartizarea diferențelor de preț asupra valorii bunurilor ieșite',
      to: 'presupune recalcularea marjei brute.',
    },
  ],
  'OMFP1802/2014-A:pct.291(5)': [
    {
      from: '(5) Inventarul intermitent nu se utilizează în comerțul cu amănuntul',
      to: 'metoda global-valorică.',
    },
  ],
  'OMFP1802/2014-A:pct.302(2)': [
    {
      from: '(2) Sumele virate sau depuse la bănci ori prin mandat poștal',
      to: '"Sume în curs de decontare").',
    },
  ],
  'OMFP1802/2014-A:conturi.532': [
    {
      from: 'Contul 532 "Alte valori" Cu ajutorul',
      to: 'Soldul contului reprezintă alte valori existente.',
    },
  ],
  'ANAF/ghid-coduri-facturi-2.9:BT-47': [
    {
      from: 'În cazul în care sunt necesare corecții legate de identificatorul cumpărătorului',
      to: 'respectiv 6 anterior mentionate.',
    },
  ],
};
