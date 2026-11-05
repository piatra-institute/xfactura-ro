import type { Clause, LegalSource } from './index';

/*
 * The sources of the profit tax (P1) and of the micro ↔ profit transitions (P2): OUG nr. 8/2026
 * (the D101 deadline of 25 June from the return for 2026, the 5,000 lei threshold and the
 * superaccelerated depreciation), OMF nr. 808/2026 (the fiscal register), OPANAF nr. 206/2025 (the
 * D101 form and its instructions) and ANAF's D101 structure; and the clauses of title II of the
 * consolidated Codul fiscal the parameters cite, read in ANAF's snapshot (updated to Legea nr.
 * 204/2026). Kept apart from the register's main list, which spreads them in.
 */

const anaf = 'https://static.anaf.ro/static/10/Anaf';
const CF = 'ANAF/Cod-fiscal-consolidat';

export const profitSources: readonly LegalSource[] = [
  // The legislative portal's printable form; not refetched (its pages are served dynamically):
  // the hash is the copy kept in .sources/.
  {
    id: 'OUG8/2026',
    kind: 'act',
    title:
      'Ordonanța de urgență a Guvernului nr. 8/2026 privind instituirea unor măsuri de relansare economică, creșterea investițiilor productive și a competitivității, precum și pentru modificarea și completarea unor acte normative în domeniul fiscal-bugetar',
    issuer: 'Guvernul României',
    publication: 'Monitorul Oficial nr. 147 din 25 februarie 2026',
    urls: ['https://legislatie.just.ro/Public/FormaPrintabila/00000G1R7B0B8M6HMQ11HGGWYI9P0NCK'],
    fetch: false,
    snapshots: [
      {
        url: 'https://legislatie.just.ro/Public/FormaPrintabila/00000G1R7B0B8M6HMQ11HGGWYI9P0NCK',
        sha256: '158caca4159deb6f5cfa670aa2bef2b1047b5ba303edb3fcec2492562c189320',
        retrievedOn: '2026-11-04',
        mediaType: 'text/html',
      },
    ],
  },
  {
    id: 'OMF808/2026',
    kind: 'act',
    title: 'Ordinul ministrului finanțelor nr. 808/2026 privind Registrul de evidență fiscală',
    issuer: 'Ministerul Finanțelor',
    publication: 'Monitorul Oficial nr. 556 din 7 iulie 2026',
    urls: ['https://legislatie.just.ro/Public/FormaPrintabila/00000G3BA4OSPILQR5U0GQ89UMI2SITG'],
    fetch: false,
    snapshots: [
      {
        url: 'https://legislatie.just.ro/Public/FormaPrintabila/00000G3BA4OSPILQR5U0GQ89UMI2SITG',
        sha256: '3ed3ee6c471d4bb8f2c6a5c9cc4936390acd77ffffbd3ff96df6a34c7e4b3dd2',
        retrievedOn: '2026-11-04',
        mediaType: 'text/html',
      },
    ],
  },
  {
    id: 'OPANAF206/2025',
    kind: 'act',
    title:
      'Ordinul președintelui ANAF nr. 206/2025 pentru aprobarea modelului, conținutului și instrucțiunilor de completare a formularelor 101 „Declarație privind impozitul pe profit” și 101 Grup fiscal (formularul și instrucțiunile, publicate de ANAF)',
    issuer: 'ANAF',
    publication: 'Monitorul Oficial nr. 140 din 18 februarie 2025',
    urls: [`${anaf}/formulare/101_OPANAF_206_2025.pdf`],
    fetch: true,
    snapshots: [
      {
        url: `${anaf}/formulare/101_OPANAF_206_2025.pdf`,
        sha256: '4d0e26cfe296bb41cb310be4f5a97ab646d9a83c060e0ed913446c3a46ff1ec9',
        retrievedOn: '2026-11-04',
        mediaType: 'application/pdf',
      },
    ],
  },
  {
    id: 'ANAF/D101-2025',
    kind: 'official_document',
    title:
      'Structura fișierului XML al declarației 101 (an de sfârșit al exercițiului >= 2024), OPANAF nr. 206/2025, cu corecțiile din 26.01.2026',
    issuer: 'ANAF',
    publication: null,
    urls: [`${anaf}/Declaratii_R/AplicatiiDec/structura_D101_2025_260126.pdf`],
    fetch: true,
    snapshots: [
      {
        url: `${anaf}/Declaratii_R/AplicatiiDec/structura_D101_2025_260126.pdf`,
        sha256: 'c1b8f38c930cdd77aa2ba8d06dba4fea4e780b88b498f8d6f4364f35d40a5ea4',
        retrievedOn: '2026-11-04',
        mediaType: 'application/pdf',
      },
    ],
  },
];

const cf = (id: string, locator: string, summary: string): Clause => ({
  id: `${CF}:${id}`,
  source: CF,
  locator,
  status: 'located',
  summary,
});

export const profitClauses: readonly Clause[] = [
  cf('art.17', 'art. 17', 'Cota impozitului pe profit aplicată profitului impozabil este 16%.'),
  cf(
    'art.18^1(1),(17)',
    'art. 18^1 alin. (1)–(3), (16)–(17)',
    'Contribuabilii cu o cifră de afaceri a anului precedent de peste 50.000.000 euro datorează impozit pe profit cel puțin la nivelul impozitului minim pe cifra de afaceri; regula se aplică până la 31 decembrie 2026.',
  ),
  cf(
    'art.19(1)',
    'art. 19 alin. (1)–(2) și (7)',
    'Rezultatul fiscal este diferența dintre veniturile și cheltuielile înregistrate contabil, minus veniturile neimpozabile și deducerile, plus cheltuielile nedeductibile și elementele similare, minus pierderile recuperate; se calculează trimestrial sau anual, cumulat de la începutul anului, și se evidențiază în registrul de evidență fiscală.',
  ),
  cf(
    'art.19(3)',
    'art. 19 alin. (3)',
    'Erorile corectate pe seama rezultatului reportat ajustează rezultatul fiscal al anului la care se referă, cu declarație rectificativă; cele corectate pe seama contului de profit și pierdere intră în rezultatul fiscal al anului corectării.',
  ),
  cf(
    'art.23(a)',
    'art. 23 lit. a)',
    'Dividendele primite de la o persoană juridică română sunt venituri neimpozabile.',
  ),
  cf(
    'art.23(d)',
    'art. 23 lit. d)',
    'Sunt neimpozabile veniturile din anularea sau recuperarea cheltuielilor, din reducerea sau anularea provizioanelor și din restituirea dobânzilor sau penalităților pentru care nu s-a acordat deducere.',
  ),
  cf(
    'art.25(1)',
    'art. 25 alin. (1)',
    'Sunt deductibile cheltuielile efectuate în scopul desfășurării activității economice, inclusiv cele reglementate prin acte normative.',
  ),
  cf(
    'art.25(2)',
    'art. 25 alin. (2)',
    'Cheltuielile cu salariile și cele asimilate salariilor sunt deductibile, în afara celor limitate sau nedeductibile la alin. (3) și (4).',
  ),
  cf(
    'art.25(3)(a)',
    'art. 25 alin. (3) lit. a)',
    'Cheltuielile de protocol sunt deductibile în limita a 2% din profitul contabil la care se adaugă cheltuielile cu impozitul pe profit și cele de protocol; cuprind și TVA colectată pentru cadourile de peste 100 lei.',
  ),
  cf(
    'art.25(3)(b)',
    'art. 25 alin. (3) lit. b)',
    'Cheltuielile sociale (ajutoare, cadouri pentru salariați și copiii lor, tichete culturale și de creșă, servicii turistice și de tratament, unități sociale proprii) sunt deductibile în limita a 5% din cheltuielile cu salariile personalului.',
  ),
  cf(
    'art.25(3)(b)-(c)',
    'art. 25 alin. (3) lit. b) și c)',
    'Cadourile și tichetele cadou acordate salariaților sunt cheltuieli sociale, limitate la 5%; tichetele de masă și voucherele de vacanță acordate potrivit legii sunt deductibile limitat, potrivit legii.',
  ),
  cf(
    'art.25(3)(l)',
    'art. 25 alin. (3) lit. l) și m)',
    'Cheltuielile cu vehiculele rutiere motorizate de cel mult 3.500 kg și 9 locuri, folosite și în alte scopuri decât activitatea economică, sunt deductibile 50%, fără amortizare; integral, pentru vehiculele de urgență, pază, curierat, agenți de vânzări, transport cu plată, servicii cu plată, închiriere ori mărfuri.',
  ),
  cf(
    'norme.art.25.pct.16',
    'normele metodologice, titlul II pct. 16 alin. (1)–(3)',
    'Vehiculele limitate și termenii sunt cei de la normele art. 298; folosirea exclusivă se dovedește cu foaia de parcurs; limita de 50% se aplică și TVA nededuse aferente cheltuielilor cu vehiculul.',
  ),
  cf(
    'art.25(4)(a)',
    'art. 25 alin. (4) lit. a)',
    'Cheltuielile cu impozitul pe profit, inclusiv diferențele din anii precedenți, și impozitele pe profit sau venit plătite în străinătate nu sunt deductibile.',
  ),
  cf(
    'art.25(4)(b)',
    'art. 25 alin. (4) lit. b)',
    'Dobânzile și majorările de întârziere, amenzile, confiscările și penalitățile datorate autorităților române sau străine nu sunt deductibile, cu excepția celor din contractele încheiate cu acestea.',
  ),
  cf(
    'art.25(4)(c)',
    'art. 25 alin. (4) lit. c)',
    'Stocurile și mijloacele fixe lipsă sau degradate, neimputabile, și TVA aferentă nu sunt deductibile, în afara cazurilor enumerate (calamități, asigurare, distrugere dovedită, risipa alimentară, expirare).',
  ),
  cf(
    'art.25(4)(h)',
    'art. 25 alin. (4) lit. h)',
    'Pierderile la scoaterea din evidență a creanțelor nu sunt deductibile pentru partea neacoperită de provizion, în afara cazurilor enumerate (reorganizare, faliment închis, deces, dizolvare, dificultăți majore, asigurare).',
  ),
  cf(
    'art.25(4)(i)',
    'art. 25 alin. (4) lit. i)',
    'Cheltuielile de sponsorizare și mecenat nu sunt deductibile; se scad din impozitul pe profit datorat la nivelul minim dintre 0,75% din cifra de afaceri și 20% din impozitul pe profit, pentru o entitate nonprofit doar dacă este înscrisă în Registrul entităților la data contractului.',
  ),
  cf(
    'art.26(1)',
    'art. 26 alin. (1) și (5)',
    'Rezervele și provizioanele sunt deductibile numai în cazurile și limitele art. 26; reducerea sau anularea celor deduse se impozitează.',
  ),
  cf(
    'art.26(1)(a)',
    'art. 26 alin. (1) lit. a)',
    'Rezerva legală este deductibilă în limita a 5% din profitul contabil la care se adaugă cheltuielile cu impozitul pe profit, până ce atinge a cincea parte din capitalul social subscris și vărsat.',
  ),
  cf(
    'norme.art.26.pct.19(1)',
    'normele metodologice, titlul II pct. 19 alin. (1)',
    'Rezerva legală se calculează cumulat de la începutul anului și este deductibilă la calculul rezultatului fiscal trimestrial sau anual; se majorează sau se diminuează după profitul contabil al perioadei.',
  ),
  cf(
    'art.26(1)(c)',
    'art. 26 alin. (1) lit. c)',
    'Ajustările pentru deprecierea creanțelor asupra clienților sunt deductibile în limita a 30% dacă creanțele sunt neîncasate de peste 270 de zile de la scadență, negarantate și de la persoane neafiliate.',
  ),
  cf(
    'art.26(12)',
    'art. 26 alin. (12)',
    'Limita de 30% pentru ajustările creanțelor asupra clienților se aplică creanțelor înregistrate din 1 ianuarie 2024.',
  ),
  cf(
    'art.28(2)(b)',
    'art. 28 alin. (2) lit. b) și alin. (21)',
    'Mijlocul fix amortizabil are, la intrarea în patrimoniu, o valoare fiscală de cel puțin 5.000 lei; o imobilizare sub limită poate fi totuși amortizată.',
  ),
  cf(
    'art.28(8^1)-(8^2)',
    'art. 28 alin. (8^1)–(8^3)',
    'Activele noi din subgrupele 2.1 și 2.4 achiziționate sau produse și puse în funcțiune în 2026 pot fi amortizate superaccelerat: cel mult 65% în primul an, apoi restul pe durata rămasă.',
  ),
  cf(
    'norme.art.28.pct.25-27',
    'normele metodologice, titlul II pct. 25–27',
    'Exemplul regimului degresiv (cota liniară înmulțită cu coeficientul, trecerea la liniar când acesta e mai mare), investițiile la mijloacele fixe închiriate și deducerea valorii rămase a autoturismelor M1 la scoaterea din gestiune, în limita de 1.500 lei pe lunile rămase.',
  ),
  cf(
    'art.28(17)',
    'art. 28 alin. (17)',
    'Amortizarea fiscală se determină fără amortizarea contabilă; câștigul sau pierderea la vânzarea ori scoaterea din funcțiune se calculează pe valoarea fiscală minus amortizarea fiscală.',
  ),
  cf(
    'art.31(1)',
    'art. 31 alin. (1)',
    'Pierderile fiscale anuale din 2024 se recuperează din profiturile impozabile, în limita a 70%, în următorii 5 ani consecutivi, în ordinea înregistrării, la fiecare termen de plată.',
  ),
  cf(
    'art.31(5)',
    'art. 31 alin. (5)',
    'Fostul plătitor de impozit pe veniturile microîntreprinderilor care avea pierdere fiscală o recuperează potrivit alin. (1) și (7) de la data la care a revenit la impozitul pe profit.',
  ),
  cf(
    'art.31(7)-(8)',
    'art. 31 alin. (7)–(8)',
    'Pierderile dinaintea anului 2024 rămase la 31.12.2023 se recuperează din 2024 în limita a 70%, pe perioada rămasă din cei 7 ani; recuperând pierderi din ambele categorii, ele se cumulează pentru limita de 70%.',
  ),
  cf(
    'art.40^2(4)',
    'art. 40^2 alin. (1) și (4)',
    'Costurile excedentare ale îndatorării sunt deductibile până la 1.000.000 euro pe perioadă fiscală (500.000 euro pentru cele de la persoane afiliate), la cursul BNR din ultima zi a trimestrului sau anului; peste, în limita a 30% din baza de calcul.',
  ),
  cf(
    'art.41(1)',
    'art. 41 alin. (1)–(3) și (6)',
    'Impozitul pe profit se calculează, se declară și se plătește trimestrial, până la 25 a lunii următoare trimestrelor I–III, iar definitivarea anuală până la termenul declarației anuale; opțiunea pentru sistemul anual cu plăți anticipate se face la începutul anului, pentru cel puțin 2 ani, și nu se poate aplica după un an de microîntreprindere.',
  ),
  cf(
    'art.42(1)',
    'art. 42 alin. (1)',
    'Declarația anuală de impozit pe profit se depune până la 25 iunie inclusiv a anului următor.',
  ),
  cf(
    'art.52(4),(6)-(7)',
    'art. 52 alin. (4), (6) și (7)',
    'Microîntreprinderea care începe o activitate exclusă, sau ai cărei asociați cu peste 25% dețin și alte microîntreprinderi, datorează impozit pe profit din trimestrul respectiv; impozitul pe profit se calculează pe veniturile și cheltuielile de la începutul acelui trimestru.',
  ),
  cf(
    'art.53(2)(b)',
    'art. 53 alin. (2) lit. b)',
    'La microîntreprinderea care devine plătitoare de impozit pe profit, diferența favorabilă de curs valutar cumulată de la începutul anului este element similar veniturilor în primul trimestru cu impozit pe profit (nu în primul trimestru al anului).',
  ),
  cf(
    'art.55(2)',
    'art. 55 alin. (2)',
    'Aplicarea sistemului de impunere pe veniturile microîntreprinderilor se comunică până la 31 martie inclusiv a anului pentru care se plătește impozitul.',
  ),
  cf(
    'art.55(1),(5)',
    'art. 55 alin. (1) și (5)',
    'Microîntreprinderile care ies din sistem după art. 52 comunică ieșirea potrivit Codului de procedură fiscală; cele care devin plătitoare de impozit pe profit pentru că nu mai îndeplinesc condițiile art. 47 ori prin opțiune o comunică până la 31 martie inclusiv a anului fiscal următor.',
  ),
  {
    id: 'OUG8/2026:art.6.pct.7',
    source: 'OUG8/2026',
    locator: 'art. 6 pct. 7 și pct. 14 (art. 45 alin. (21^3))',
    status: 'located',
    summary:
      'Valoarea mijlocului fix amortizabil devine 5.000 lei; mijloacele fixe de 2.500–5.000 lei existente la 31.12.2025 se amortizează în continuare pe durata rămasă.',
  },
  {
    id: 'OUG8/2026:art.6.pct.8',
    source: 'OUG8/2026',
    locator: 'art. 6 pct. 8 (art. 28 alin. (8^1)–(8^3))',
    status: 'located',
    summary:
      'Introduce amortizarea superaccelerată pentru activele noi din subgrupele 2.1 și 2.4 puse în funcțiune în 2026.',
  },
  {
    id: 'OUG8/2026:art.6.pct.12,14',
    source: 'OUG8/2026',
    locator: 'art. 6 pct. 12 (art. 42 alin. (1)–(2)) și pct. 14 (art. 45 alin. (21^4))',
    status: 'located',
    summary:
      'Declarația anuală de impozit pe profit se depune până la 25 iunie inclusiv a anului următor (pentru anul fiscal modificat, până la 25 a lunii a șasea), începând cu declarația pentru anul 2026.',
  },
  {
    id: 'OMF808/2026:art.1-5',
    source: 'OMF808/2026',
    locator: 'art. 1–5, 8 și anexa',
    status: 'located',
    summary:
      'Plătitorii de impozit pe profit întocmesc Registrul de evidență fiscală, în formă scrisă sau electronică, după modelul din anexă (nr. crt., explicații cu simbolul contului, valoarea în lei), completat cronologic trimestrial și/sau anual; abrogă OMF nr. 870/2005.',
  },
  {
    id: 'OPANAF206/2025:instr.pct.8',
    source: 'OPANAF206/2025',
    locator: 'anexa nr. 1, instrucțiunile de completare, pct. 6 și 8',
    status: 'located',
    summary:
      'Rândurile 1–7 se completează din contabilitate, cu impozitul pe profit în cheltuielile de exploatare (rd. 2); perioada începe în prima zi a trimestrului în care microîntreprinderea devine plătitoare de impozit pe profit; fiecare rând al secțiunii B are regula lui de completare.',
  },
  {
    id: 'ANAF/D101-2025:structura',
    source: 'ANAF/D101-2025',
    locator: 'structura fișierului XML, câmpurile 1–112 și validările V1–V8',
    status: 'located',
    summary:
      'Atributele declarației 101, formulele rândurilor, scadența (25 a lunii a șasea după sfârșitul anului), numărul de evidență a plății și suma de control (rândurile P1–P53, fără cele „din care”).',
  },
  {
    id: 'OMFP1802/2014:pct.66-67',
    source: 'OMFP1802/2014',
    locator: 'pct. 65–68',
    status: 'located',
    summary:
      'Erorile semnificative ale exercițiilor precedente se corectează la data constatării, pe seama rezultatului reportat (1174), fără a modifica situațiile financiare ale acelor exerciții; cele ale exercițiului curent, pe seama contului de profit și pierdere.',
  },
];
