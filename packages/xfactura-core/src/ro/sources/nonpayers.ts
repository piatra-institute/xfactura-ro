import type { Clause, LegalSource } from './index';

/*
 * The sources of the non-payers' module (V1): registration after the small-enterprise threshold
 * (Codul fiscal art. 310, 316) and the VAT owed when it comes late, the special registration of
 * art. 317 with the special return (D301, OPANAF nr. 592/2016) and the recapitulative statement
 * (art. 325), leaving the VAT system (art. 310 alin. (7), art. 316 alin. (11) and (13)) with the
 * capital goods' adjustment (art. 305), the first VAT period after registration (art. 322 alin.
 * (4)–(5)) and the D300 rows the adjustments go on (OPANAF nr. 174/2026). Kept apart from the
 * register's main list, which spreads them in.
 */

const legislation = 'https://static.anaf.ro/static/10/Anaf/legislatie';
const declarations = 'https://static.anaf.ro/static/10/Anaf/Declaratii_R/AplicatiiDec';

export const nonpayerSources: readonly LegalSource[] = [
  {
    id: 'OPANAF592/2016',
    kind: 'act',
    title:
      'Ordinul președintelui ANAF nr. 592/2016 pentru aprobarea modelului și conținutului formularului (301) „Decont special de taxă pe valoarea adăugată” (text publicat de ANAF)',
    issuer: 'ANAF',
    publication: 'Monitorul Oficial nr. 94 din 8 februarie 2016',
    urls: [`${legislation}/OPANAF_592_2016.pdf`],
    fetch: true,
    snapshots: [
      {
        url: `${legislation}/OPANAF_592_2016.pdf`,
        sha256: '4c801357002ebee5760fbf2dc254f094b1823a25d02efc6b5792bcfc32f54ad0',
        retrievedOn: '2026-11-05',
        mediaType: 'application/pdf',
      },
    ],
  },
  {
    id: 'ANAF/D301-A2.0.0',
    kind: 'official_document',
    title:
      'Structura fișierului XML pentru declarația 301, UniversalCode D301_A2.0.0 (din 01.01.2016), cu schema d301_20200130.xsd',
    issuer: 'ANAF',
    publication: null,
    urls: [`${declarations}/structura_D301_2016.pdf`, `${declarations}/d301_20200130.xsd`],
    fetch: true,
    snapshots: [
      {
        url: `${declarations}/structura_D301_2016.pdf`,
        sha256: '80ed3f2b0087bca9b7e23d69a6fe18ca77da9631db93144b5a025cebae928307',
        retrievedOn: '2026-11-05',
        mediaType: 'application/pdf',
      },
      {
        url: `${declarations}/d301_20200130.xsd`,
        sha256: '9d395174528559a7b38dfc3e8b375837643f462ec50110663c960dfcbc1ea970',
        retrievedOn: '2026-11-05',
        mediaType: 'application/xml',
      },
    ],
  },
  {
    id: 'OPANAF174/2026',
    kind: 'act',
    title:
      'Ordinul președintelui ANAF nr. 174/2026 privind modelul, conținutul și instrucțiunile de completare a decontului de taxă pe valoarea adăugată (300), utilizat de la declararea obligațiilor lunii ianuarie 2026 (text publicat de ANAF)',
    issuer: 'ANAF',
    publication: null,
    urls: [`${legislation}/OPANAF_174_2026.pdf`],
    fetch: true,
    snapshots: [
      {
        url: `${legislation}/OPANAF_174_2026.pdf`,
        sha256: 'b2af283078e04dd799a7b311b0d2ca3aac91bf2a1cacc10949d5726ad22ccf02',
        retrievedOn: '2026-11-05',
        mediaType: 'application/pdf',
      },
    ],
  },
];

const CODE = 'ANAF/Cod-fiscal-consolidat';
const fiscal = (id: string, locator: string, summary: string): Clause => ({
  id: `${CODE}:${id}`,
  source: CODE,
  locator,
  status: 'located',
  summary,
});

export const nonpayerClauses: readonly Clause[] = [
  fiscal(
    'art.310(4)-(5)',
    'art. 310 alin. (4) și (5)',
    'O persoană impozabilă nou-înființată aplică regimul special de scutire dacă declară la începerea activității o cifră de afaceri estimată sub plafon și nu optează pentru regimul normal; pentru cea care începe activitatea în cursul anului, plafonul este cel de la alin. (1), neproporționalizat.',
  ),
  fiscal(
    'art.310(6^1)-(6^3)',
    'art. 310 alin. (6^1)–(6^3)',
    'Când înregistrarea nu s-a solicitat sau s-a solicitat cu întârziere, organul fiscal înregistrează persoana de la data depășirii plafonului și stabilește taxa de plată (colectată minus deductibilă) pe perioada în care trebuia aplicat regimul normal; persoana care constată singură întârzierea solicită înregistrarea de la acea dată, calculează aceeași diferență și o înscrie în primul decont depus după înregistrare sau într-unul ulterior.',
  ),
  fiscal(
    'art.310(7)',
    'art. 310 alin. (7)',
    'Persoana înregistrată după art. 316 care nu a depășit plafonul în anul precedent și nici în anul curent la data cererii poate cere scoaterea din evidență (între 1 și 10 ale lunii următoare perioadei fiscale); anularea e valabilă de la comunicarea deciziei; ultimul decont, cu toate ajustările, se depune până la 25 a lunii următoare comunicării.',
  ),
  fiscal(
    'art.316(1)(b),(1^1)',
    'art. 316 alin. (1) lit. b) și alin. (1^1)',
    'Persoana care depășește plafonul de scutire în cursul anului solicită înregistrarea cel târziu la data depășirii; înregistrarea este valabilă de la data depășirii plafonului, inclusiv la înregistrarea întârziată a art. 310 alin. (6^2) lit. a) și la cea din oficiu, iar înregistrarea prin opțiune de la data solicitării.',
  ),
  fiscal(
    'art.316(11)(g),(13)',
    'art. 316 alin. (11) lit. g) și alin. (13)',
    'Organul fiscal anulează înregistrarea persoanei care cere scoaterea din evidență pentru a aplica regimul special de scutire; persoana depune ultimul decont până la 25 a lunii următoare celei în care i s-a comunicat decizia de anulare, indiferent de perioada fiscală.',
  ),
  fiscal(
    'art.317(1)',
    'art. 317 alin. (1) lit. b) și c)',
    'Persoana impozabilă neînregistrată și neobligată să se înregistreze după art. 316 se înregistrează după art. 317 înainte de a presta servicii cu locul în alt stat membru pentru care beneficiarul datorează taxa, sau înainte de a primi de la un prestator stabilit în alt stat membru servicii pentru care datorează taxa în România (art. 307 alin. (2)).',
  ),
  fiscal(
    'art.307(2)',
    'art. 307 alin. (2)',
    'Taxa este datorată de orice persoană impozabilă beneficiară a serviciilor cu locul prestării în România după art. 278 alin. (2), furnizate de o persoană impozabilă nestabilită în România: și de cea neînregistrată în scopuri de TVA.',
  ),
  fiscal(
    'art.324(1)-(2)',
    'art. 324 alin. (1) și (2)',
    'Persoanele neînregistrate și neobligate să se înregistreze după art. 316 depun decontul special pentru taxa datorată după art. 307 alin. (2)–(4) și (6), până la 25 a lunii următoare celei în care ia naștere exigibilitatea, numai pentru perioadele în care ia naștere exigibilitatea.',
  ),
  fiscal(
    'art.325(1)',
    'art. 325 alin. (1) lit. c) și e)',
    'Orice persoană înregistrată după art. 316 sau 317 depune declarația recapitulativă pentru serviciile de la art. 278 alin. (2) prestate unor persoane impozabile stabilite în alt stat membru și pentru cele achiziționate de la prestatori stabiliți în alt stat membru, pe luna în care ia naștere exigibilitatea.',
  ),
  fiscal(
    'art.305(2)-(5)',
    'art. 305 alin. (2), (3) și (5) lit. a) și c)',
    'Taxa deductibilă a bunurilor de capital se ajustează pe 5 ani (20 pentru bunurile imobile), de la 1 ianuarie a anului achiziției; la trecerea de la regimul normal la scutirea întreprinderilor mici, și invers, ajustarea se face o singură dată pentru întreaga perioadă rămasă, inclusiv anul schimbării, pentru o cincime (o douăzecime) din taxa dedusă, respectiv nededusă, inițial pe an.',
  ),
  fiscal(
    'art.322(4)-(5)',
    'art. 322 alin. (4) și (5)',
    'Întreprinderea mică ce se înregistrează în cursul anului declară cifra de afaceri obținută, recalculată pentru un an calendaristic întreg: peste 100.000 euro, perioada fiscală a anului este luna, altfel trimestrul (fără achiziții intracomunitare de bunuri înainte de înregistrare); anul următor, după cifra efectivă a anului înregistrării, recalculată la fel.',
  ),
  fiscal(
    'norme.art.291.pct.36(b)',
    'normele metodologice, titlul VII pct. 36 lit. b)',
    'Contrapartida se consideră ca incluzând TVA (procedeul sutei mărite, 21 × 100 / 121) și când prețul a fost stabilit fără mențiunea TVA, iar furnizorul obligat la plata taxei nu o poate recupera de la beneficiar; dovada poate fi și o declarație pe propria răspundere a furnizorului.',
  ),
  fiscal(
    'norme.art.310.pct.83(7)-(8),(11)-(12)',
    'normele metodologice, titlul VII pct. 83 alin. (7), (8), (11) și (12)',
    'La scoaterea din evidență se ajustează taxa dedusă pentru stocuri, servicii neutilizate și active în curs (art. 304), bunurile de capital (art. 305), activele de dinainte de 2016 (art. 306) și avansuri; valoarea se înscrie în ultimul decont. La înregistrarea prin opțiune sau la timp după depășire, persoana are dreptul la aceleași ajustări, înscrise în primul decont după înregistrare.',
  ),
  fiscal(
    'norme.art.310.pct.84(2)-(3)',
    'normele metodologice, titlul VII pct. 84 alin. (2) și (3)',
    'Organul fiscal stabilește taxa de plată, cu accesoriile, de la data la care persoana ar fi fost înregistrată dacă solicita la termen, sau suma negativă; taxa deductibilă cuprinde stocurile, activele în curs și serviciile neutilizate, ajustarea pozitivă a bunurilor de capital și achizițiile din perioada până la înregistrare; constatarea înainte de înregistrare aduce înregistrarea din oficiu, valabilă de la comunicarea deciziei (lit. c)).',
  ),
  fiscal(
    'norme.art.317.pct.90(4)',
    'normele metodologice, titlul VII pct. 90 alin. (4)',
    'Înregistrarea după art. 317 alin. (1) lit. b) și c) se solicită numai pentru serviciile intracomunitare ale art. 278 alin. (2) și e valabilă de la data solicitării; nu o cer cei care prestează sau primesc servicii doar de la sau către persoane stabilite în afara Uniunii.',
  ),
  {
    id: 'L82/1991:art.27(8)',
    source: 'L82/1991',
    locator: 'art. 27 alin. (8)',
    status: 'located',
    summary: 'Exercițiul financiar al unităților nou-înființate începe la data înființării.',
  },
  {
    id: 'OMFP1802/2014:cont.4423',
    source: 'OMFP1802/2014',
    locator: 'funcțiunea contului 4423 „Taxa pe valoarea adăugată de plată”',
    status: 'located',
    summary:
      'Contul 4423 ține evidența TVA de plătit la bugetul statului: în credit diferența dintre taxa colectată și cea deductibilă, în debit plățile și compensările.',
  },
  {
    id: 'OPANAF592/2016:anexa2.pct.I',
    source: 'OPANAF592/2016',
    locator: 'anexa nr. 2 pct. I, secțiunile 4 și 4.1',
    status: 'located',
    summary:
      'Secțiunea 4 o completează persoanele obligate la plata taxei după art. 307 alin. (2), neînregistrate după art. 316, înregistrate sau nu după art. 317, pentru serviciile prestate de persoane nestabilite în România; secțiunea 4.1 preia din secțiunea 4 serviciile prestate de persoane stabilite în Uniune.',
  },
  {
    id: 'OPANAF592/2016:anexa2.pct.II',
    source: 'OPANAF592/2016',
    locator: 'anexa nr. 2 pct. II lit. a)',
    status: 'located',
    summary:
      'Decontul special se depune până la 25 inclusiv a lunii următoare celei în care ia naștere exigibilitatea operațiunilor din secțiunile 1, 3, 4 și 4.1, numai pentru perioadele în care ia naștere exigibilitatea.',
  },
  {
    id: 'OPANAF592/2016:anexa2.pct.III',
    source: 'OPANAF592/2016',
    locator: 'anexa nr. 2 pct. III',
    status: 'located',
    summary:
      'Cine e înregistrat după art. 317 completează codul de TVA și bifează caseta acestor persoane; coloana 4 este cursul BNR (sau al băncii) de la data exigibilității, coloana 5 baza (valoarea în valută × curs), coloana 6 TVA (baza × cota).',
  },
  {
    id: 'ANAF/D301-A2.0.0:structura',
    source: 'ANAF/D301-A2.0.0',
    locator: 'structura D301_A2.0.0, câmpurile 1–42',
    status: 'located',
    summary:
      'Atributele declarației 301: perioada, rectificativa, temeiul, identificarea, pers_inreg (1 neînregistrat, 2 înregistrat după art. 317), nr_evid, totalurile pe secțiuni, suma de control INT(baza1…tva5) și secțiunile cu tip_operatie 1–5.',
  },
  {
    id: 'OPANAF174/2026:rd.16',
    source: 'OPANAF174/2026',
    locator: 'anexa nr. 2, instrucțiunile rândului 16',
    status: 'located',
    summary:
      'Rândul 16 cuprinde regularizările taxei colectate: corecturile deconturilor anterioare și orice alte sume din regularizările prevăzute de lege, ca nedeclararea din eroare a operațiunii în perioada exigibilității.',
  },
  {
    id: 'OPANAF174/2026:rd.33-34',
    source: 'OPANAF174/2026',
    locator: 'anexa nr. 2, instrucțiunile rândurilor 33 și 34',
    status: 'located',
    summary:
      'Rândul 33 cuprinde regularizările taxei deduse (corecturi ale deconturilor anterioare și alte regularizări prevăzute de lege); rândul 34 ajustările pro rata și ajustările taxei deductibile, cu plus sau minus.',
  },
];
