import type { Clause, LegalSource } from './index';

/*
 * The sources of retail and B2C (G2): the fiscal cash registers and their daily closing reports
 * (OUG nr. 28/1999 in the owner's LEX EXPERT consolidation to 10 September 2018, registered with
 * the receipts' sources), the XML ANAF prescribes for a register's daily files (OPANAF nr.
 * 146/2018 anexa nr. 2, and ANAF's own structure and schema of form A4203), the retail price
 * method and the accounts it uses (OMFP nr. 1.802/2014 as consolidated to 1 February 2022), the
 * invoice issued for a fiscal receipt (the norms' pct. 97 alin. (1), ANAF's SAF-T answers), and
 * where the returns report a register's receipts (D394's op2 and the instructions' lit. G). Read
 * on 5 November 2026 in the snapshots registered here and in the register's main list.
 */

const CODE = 'ANAF/Cod-fiscal-consolidat';
const OMFPA = 'OMFP1802/2014-A';
const OUG = 'OUG28/1999';
const ORDER = 'OPANAF146/2018';
const A4203 = 'ANAF/A4203';
const declarations = 'https://static.anaf.ro/static/10/Anaf/Declaratii_R/AplicatiiDec';

export const retailSources: readonly LegalSource[] = [
  {
    id: ORDER,
    kind: 'act',
    title:
      'Ordinul președintelui ANAF nr. 146/2018 pentru descrierea profilurilor prevăzute la art. 22 pct. J lit. a) din Normele metodologice pentru aplicarea OUG nr. 28/1999, structura XML a mesajelor de activare a acestora, structura XML a fișierelor prevăzute la art. 22 pct. J lit. b) din aceleași norme și categoriile de URL-uri utilizate în schimbul de informații cu sistemul informatic național de supraveghere și monitorizare a datelor fiscale',
    issuer: 'ANAF',
    publication: 'Monitorul Oficial nr. 87 din 30 ianuarie 2018',
    urls: ['https://static.anaf.ro/static/10/Anaf/legislatie/OPANAF_146_2018.pdf'],
    fetch: true,
    snapshots: [
      {
        url: 'https://static.anaf.ro/static/10/Anaf/legislatie/OPANAF_146_2018.pdf',
        sha256: 'a831e148b32590919f0a92a1094b6bbf2d1fa3e1b4f7f4c5f51e5aaf7c03f96d',
        retrievedOn: '2026-11-05',
        mediaType: 'application/pdf',
      },
    ],
  },
  {
    // ANAF's form A4203 page lists the schema and the structure of 27.09.2018 and a validator
    // (J1.0.8, 06.08.2026) that keeps the 2018 rates list (0, 5, 9, 19, 20) as warnings (R39.1).
    id: A4203,
    kind: 'official_document',
    title:
      'ANAF, formularul A4203: structura XML și schema fișierelor zilnice ale aparatelor de marcat electronice fiscale (bonuri fiscale, secțiunea II.3, și raportul fiscal de închidere zilnică, secțiunea II.7, din anexa nr. 2 la OPANAF nr. 146/2018), versiunea din 27.09.2018',
    issuer: 'ANAF',
    publication: null,
    urls: [`${declarations}/structura_a4203_20180927.pdf`, `${declarations}/a4203_20180927.xsd`],
    fetch: true,
    snapshots: [
      {
        url: `${declarations}/structura_a4203_20180927.pdf`,
        sha256: '737a7657ca45e005410255db318a1da888240bc30e34d26db2f7e39d56c15dba',
        retrievedOn: '2026-11-05',
        mediaType: 'application/pdf',
      },
      {
        url: `${declarations}/a4203_20180927.xsd`,
        sha256: '9507407728e7cb7e99367e2d66953929692af8d7b0b90915338ff9ad51a89312',
        retrievedOn: '2026-11-05',
        mediaType: 'application/xml',
      },
    ],
  },
];

const clause = (source: string, id: string, locator: string, summary: string): Clause => ({
  id: `${source}:${id}`,
  source,
  locator,
  status: 'located',
  summary,
});

export const retailClauses: readonly Clause[] = [
  clause(
    OUG,
    'art.1(8)',
    'art. 1 alin. (8) și (8^1)',
    'Cât timp aparatul de marcat este defect, utilizatorul înregistrează toate operațiunile într-un registru special, emite chitanțe și, la cerere, facturi, și anunță imediat distribuitorul autorizat sau unitatea de service.',
  ),
  clause(
    OUG,
    'art.3(3)-(5)',
    'art. 3 alin. (3)–(5)',
    'Aparatul de marcat conservă datele prin acumulări progresive, emite bonuri, rapoarte fiscale de închidere zilnică și jurnale electronice și înregistrează în memoria fiscală datele de sinteză ale rapoartelor zilnice; memoria fiscală nu poate fi modificată sau ștearsă și reține seria fiscală, codul fiscal al utilizatorului și adresa locului de instalare.',
  ),
  clause(
    OUG,
    'art.3^1',
    'art. 3^1',
    'ANAF ține un registru național al aparatelor de marcat instalate; utilizatorii asigură conectarea lor la distanță, pentru transmiterea datelor fiscale către ANAF, după procedura aprobată prin ordin al președintelui ANAF.',
  ),
  clause(
    OUG,
    'art.4(5)-(9)',
    'art. 4 alin. (5)–(9)',
    'Raportul fiscal de închidere zilnică cuprinde numărul de ordine progresiv, data, numărul bonurilor emise, totalul operațiunilor și al TVA pe cote, operațiunile scutite și taxele din afara bazei; la aparatele cu jurnal electronic și bonurile cu codul beneficiarului, identificatorul jurnalului, reducerile, anulările, sumele de serviciu și sumele pe fiecare mijloc de plată; se păstrează 5 ani, jurnalul electronic 5 ani, memoria fiscală 10 ani.',
  ),
  clause(
    OUG,
    'art.5(3)',
    'art. 5 alin. (3)',
    'Aparatul are cartea de intervenții, pe care utilizatorul o păstrează și, împreună cu unitatea de service, o completează cu intervențiile efectuate.',
  ),
  clause(
    OUG,
    'art.6',
    'art. 6',
    'Obligația de a utiliza aparate de marcat ia naștere de la data începerii activității comerciale în fiecare locație.',
  ),
  clause(
    ORDER,
    'anexa2.II.7',
    'anexa nr. 2 secțiunile I și II.7',
    'Fișierul XML al raportului fiscal de închidere zilnică (rB): identificatorul raportului (numărul unic al aparatului, data și ora, numărul raportului), numărul bonurilor, totalul operațiunilor, bonurile cu codul de TVA al beneficiarului, anulările, reducerile, majorările, TVA totală, taxele din afara bazei, operațiunile scutite, sumele de serviciu, moneda, plățile pe tipuri (pl) și operațiunile și TVA pe cote (coteZ).',
  ),
  clause(
    ORDER,
    'anexa2.II.12-II.13',
    'anexa nr. 2 secțiunile II.12–II.14',
    'Mesajul registru indică primul și ultimul raport zilnic al perioadei; offline, aparatul exportă pentru fiecare zi fiscală încheiată fișiere XML semnate (PKCS#7, SHA-256, RSA 2048) cu certificatul lui, care se validează și se depun prin aplicația ANAF.',
  ),
  clause(
    A4203,
    'structura',
    'structura A4203 din 27.09.2018 (msj, bon, rB, pl, coteZ) și nomenclatorul tipurilor de plată',
    'Atributele raportului Z: idR (numărul unic al aparatului din 10 caractere, data și ora AAAALLZZHHMMSS, numărul raportului din 4 cifre), nrB, totB, nrBC, totBC, nrA/totA, nrR/totR, nrM/totM, totTva, totTvaC, totTaxe, totNet, sume_serv_in/out, monRef; plățile tipP 1 card, 2 avans în numerar, 3 numerar, 4 tichete de masă, 5 bonuri/tichete valorice, 6 voucher, 7 credit, 8 metode moderne, 9 alte metode.',
  ),
  clause(
    OMFPA,
    'pct.286(4)-(8)',
    'pct. 286 alin. (4)–(8) și nota *2)',
    'Diferențele de preț se repartizează asupra ieșirilor cu un coeficient: soldul inițial al diferențelor plus diferențele intrărilor cumulate de la începutul exercițiului până la finele perioadei, raportat la soldul inițial al stocurilor la preț de înregistrare plus intrările cumulate, fără TVA neexigibilă; în comerțul cu amănuntul, costul bunurilor vândute este prețul de vânzare minus marja brută, recalculată la orice modificare a prețului.',
  ),
  clause(
    OMFPA,
    'pct.291(5)',
    'pct. 291 alin. (5)',
    'Inventarul intermitent nu se utilizează în comerțul cu amănuntul când se aplică metoda global-valorică.',
  ),
  clause(
    OMFPA,
    'pct.302(2)',
    'pct. 302 alin. (2)',
    'Sumele virate sau depuse la bănci, pe bază de documente prezentate entității și neapărute încă în extrasele de cont, se înregistrează distinct în contul 5125 „Sume în curs de decontare”.',
  ),
  clause(
    OMFPA,
    'conturi.532',
    'funcțiunea contului 532',
    'Contul 532 „Alte valori” ține bonurile valorice, timbrele, biletele și tichetele de masă: se debitează cu valorile achiziționate și se creditează cu cele consumate sau acordate.',
  ),
  clause(
    CODE,
    'norme.art.319.pct.97(1)',
    'normele metodologice, titlul VII pct. 97 alin. (1)',
    'Pe facturile emise și achitate pe bază de bonuri fiscale emise conform OUG nr. 28/1999 nu este necesară menționarea bunurilor sau serviciilor, fiind suficientă mențiunea „conform bon fiscal nr./data”.',
  ),
  clause(
    'ANAF/SAFT_FAQ_2022',
    'GL.raportZ',
    'Întrebări și răspunsuri SAF-T v1.2, secțiunea General Ledger Entries, răspunsurile 1, 3 și 4',
    'Vânzările cu bon fiscal se înregistrează după raportul zilnic Z, cu codurile 3803xx („Livrări/prestări pentru care nu există obligația emiterii facturii”, art. 319 alin. (10)); factura emisă la cerere pentru un bon nu are o notă contabilă proprie, se raportează în luna emiterii la SalesInvoices cu tipul 751 și codul 310327.',
  ),
  clause(
    'ANAF/D394',
    'op2',
    'secțiunile op2 (tip_op2 I1/I2, luna, nrAMEF, nrBF, total, baza și TVA pe cote), rezumat2 (baza_incasari_i1, tva_incasari_i1) și informatii (nr_BF_i1, incasari_i1, incasari_i2)',
    'Încasările prin aparatele de marcat (I1) și cele din activitățile scutite de obligația lor (I2) se declară lunar: numărul aparatelor și al bonurilor, totalul încasărilor și baza și TVA pe cote, însumate în rezumat2 și informatii.',
  ),
  clause(
    'OPANAF3769/2015-A',
    'anexa2.litG',
    'anexa nr. 2 secțiunea 1 lit. G și secțiunea a 2-a pct. 2, 13–17',
    'Cartușul G cuprinde bonurile fiscale și încasările prin aparatele de marcat ale perioadei, pe luni și cote, inclusiv bonurile care îndeplinesc condițiile facturii simplificate; nu cuprinde bonurile pentru care s-au emis facturi, care se declară ca facturi.',
  ),
  clause(
    'ANAF/ghid-coduri-facturi-2.9',
    'BT-47',
    'secțiunea despre corecțiile identificatorului cumpărătorului (BT-47, BT-48)',
    'Ghidul numește BT-47 codul de înregistrare fiscală al cumpărătorului și BT-48 codul lui de înregistrare în scopuri de TVA.',
  ),
];
