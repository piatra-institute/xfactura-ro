import type { Clause, LegalSource } from './index';

/*
 * The sources of the tax account (T2): ANAF's methodology of distributing the sums paid into the
 * single account and its nomenclator, the payment record number, the models of the decisions on
 * accessories and of the VAT refund, the D710 package, and what ANAF publishes about the
 * statement of the taxpayer's account; and the clauses of the consolidated Codul de procedură
 * fiscală (L207/2015, whose snapshot the register's main list records) and of OMFP nr. 1.802/2014
 * the parameters cite. Every ANAF copy is the original order: the versions in force are read with
 * their amending orders, as noted. Kept apart from the register's main list, which spreads them in.
 */

const legislation = 'https://static.anaf.ro/static/10/Anaf/legislatie';
const CPF = 'L207/2015';

const order = (
  id: string,
  title: string,
  publication: string | null,
  file: string,
  sha256: string,
): LegalSource => ({
  id,
  kind: 'act',
  title,
  issuer: 'ANAF',
  publication,
  urls: [`${legislation}/${file}`],
  fetch: true,
  snapshots: [
    {
      url: `${legislation}/${file}`,
      sha256,
      retrievedOn: '2026-11-05',
      mediaType: 'application/pdf',
    },
  ],
});

export const taxAccountSources: readonly LegalSource[] = [
  order(
    'OPANAF1613/2018',
    'Ordinul președintelui ANAF nr. 1.613/2018 pentru aprobarea Metodologiei de distribuire a sumelor plătite de contribuabili în contul unic și de stingere a obligațiilor fiscale (textul inițial; modificat de OPANAF nr. 2.892/2018 și nr. 146/2025)',
    'Monitorul Oficial nr. 545 din 29 iunie 2018',
    'OPANAF_1613_2018.pdf',
    '33b4b0f43a0e4ef7bb6d4e5ce605c369d22d4882f58f9aa21b2feb9df5797c82',
  ),
  order(
    'OPANAF146/2025',
    'Ordinul președintelui ANAF nr. 146/2025 pentru modificarea și completarea Metodologiei aprobate prin OPANAF nr. 1.613/2018',
    'Monitorul Oficial nr. 114 din 7 februarie 2025',
    'OPANAF_146_2025.pdf',
    'ab0180bd269ae591192621de3337bcd3ac96a53bf8528133172e49412d40f92c',
  ),
  order(
    'OPANAF1612/2018',
    'Ordinul președintelui ANAF nr. 1.612/2018 pentru aprobarea Nomenclatorului obligațiilor fiscale care se plătesc în contul unic (textul inițial; anexa înlocuită de OPANAF nr. 551/2021)',
    'Monitorul Oficial nr. 544 din 29 iunie 2018',
    'OPANAF_1612_2018.pdf',
    'c833d88a3d513064524ed2475c91f8c298526c8252c90d5057d5d8f03e429626',
  ),
  order(
    'OPANAF551/2021',
    'Ordinul președintelui ANAF nr. 551/2021 pentru modificarea anexei la OPANAF nr. 1.612/2018 (Nomenclatorul obligațiilor fiscale care se plătesc în contul unic; completat de OPANAF nr. 1.985/2022 și 170/2023, modificat de OPANAF nr. 874/2024)',
    'Monitorul Oficial nr. 377 din 12 aprilie 2021',
    'OPANAF_551_2021.pdf',
    '6a1a65978645537850b01062a4a9a978df8f247ba3a52e00dea9e56a28e33084',
  ),
  order(
    'OPANAF874/2024',
    'Ordinul președintelui ANAF nr. 874/2024 pentru modificarea și completarea anexei la OPANAF nr. 1.612/2018',
    'Monitorul Oficial nr. 422 din 9 mai 2024',
    'OPANAF_874_2024.pdf',
    'a58de0fad3bbb024e10bc8cdef822c3f2cda5da506991972d2e60eed358a9c03',
  ),
  order(
    'OPANAF2937/2018',
    'Ordinul președintelui ANAF nr. 2.937/2018 pentru aprobarea Metodologiei de distribuire a sumelor plătite de persoanele fizice în contul unic (textul inițial; modificat de OPANAF nr. 121/2025)',
    'Monitorul Oficial nr. 1005 din 27 noiembrie 2018',
    'OPANAF_2937_2018.pdf',
    '428d31393d33b5d97b69df9a89ae182f7c63b7a12610427e5d4e82b304cc9f2e',
  ),
  {
    ...order(
      'OMFP3832/2015',
      'Ordinul ministrului finanțelor publice nr. 3.832/2015 privind numărul de evidență a plății (modificarea OMFP nr. 1.870/2004)',
      'Monitorul Oficial nr. 870 din 20 noiembrie 2015',
      'OMFP_3832_2015.pdf',
      '24187b15979247837e38db5fc41e1573c19b6b4e0384f27573ed91cfb4c38080',
    ),
    issuer: 'Ministerul Finanțelor Publice',
  },
  order(
    'OPANAF967/2017',
    'Ordinul președintelui ANAF nr. 967/2017 pentru aprobarea modelului și conținutului unor formulare utilizate în colectarea creanțelor fiscale (anexa nr. 3: decizia referitoare la obligațiile fiscale accesorii)',
    'Monitorul Oficial nr. 208 din 27 martie 2017',
    'OPANAF_967_2017.pdf',
    '1b1f23fc3dcdf5893a6c40858677f00a6d2ba1fe2316d806aac79e6e7ff613e6',
  ),
  order(
    'OPANAF727/2019',
    'Ordinul președintelui ANAF nr. 727/2019 privind emiterea deciziilor referitoare la obligațiile fiscale accesorii',
    'Monitorul Oficial nr. 220 din 21 martie 2019',
    'OPANAF_727_2019.pdf',
    '9a19f12498e78f81d370dfb16ae3755d7d7eb64282ed87cb1a1cc6ce9b69e823',
  ),
  order(
    'OPANAF352/2022',
    'Ordinul președintelui ANAF nr. 352/2022 pentru aprobarea Procedurii de soluționare a deconturilor cu sume negative de taxă pe valoarea adăugată cu opțiune de rambursare',
    'Monitorul Oficial nr. 242 din 11 martie 2022',
    'OPANAF_352_2022.pdf',
    'ae7d1e2a608ce9282854d2610eb30a25babb7277c7ed6323facadc09d035918f',
  ),
  order(
    'OPANAF587/2016',
    'Ordinul președintelui ANAF nr. 587/2016 pentru aprobarea modelului și conținutului formularelor 100 și 710 (textul inițial; modificat, între altele, de OPANAF nr. 57/2026)',
    'Monitorul Oficial nr. 94 din 8 februarie 2016',
    'OPANAF_587_2016.pdf',
    'f9f09a5a0b395490e7fa5c9539a608524b81fa71b69a21fd6a6f0afc9e8a0714',
  ),
  order(
    'OPANAF57/2026',
    'Ordinul președintelui ANAF nr. 57/2026 pentru modificarea și completarea OPANAF nr. 587/2016 (formularele 100 și 710)',
    'Monitorul Oficial nr. 55 din 23 ianuarie 2026',
    'OPANAF_57_2026.pdf',
    'adeb4c1967ae2315f9df0b1ae3992eff9017979a350217f2232eb5391e203516',
  ),
  {
    id: 'ANAF/D710',
    kind: 'official_document',
    title:
      'Declarația 710 (rectificativă): pagina ANAF, structura XML (comună cu D100, 14.09.2026), schema și validatorul J20.0.7',
    issuer: 'ANAF',
    publication: null,
    urls: ['https://static.anaf.ro/static/10/Anaf/Declaratii_R/710.html'],
    fetch: true,
    snapshots: [
      {
        url: 'https://static.anaf.ro/static/10/Anaf/Declaratii_R/710.html',
        sha256: 'e2eed4f3b0efb6fcef4ed89bf01e661d0858008f8650eec50a84221fba983454',
        retrievedOn: '2026-11-05',
        mediaType: 'text/html',
      },
      {
        url: 'https://static.anaf.ro/static/10/Anaf/Declaratii_R/AplicatiiDec/D710_14092026.zip',
        sha256: 'e03773ba955ac14881cbc797d1235c17686ca025c855711e6329cad0f84d668c',
        retrievedOn: '2026-11-05',
        mediaType: 'application/zip',
      },
    ],
  },
  {
    id: 'ANAF/legenda_fisa_platitor',
    kind: 'official_document',
    title: 'Legenda abrevierilor cuprinse în fișa pe plătitor (ANAF, SPV)',
    issuer: 'ANAF',
    publication: null,
    urls: ['https://static.anaf.ro/static/10/SPV/legenda_fisa_platitor.pdf'],
    fetch: true,
    snapshots: [
      {
        url: 'https://static.anaf.ro/static/10/SPV/legenda_fisa_platitor.pdf',
        sha256: '4528009e6fb9fc741ece4f66da2f41eefbde89ed3a8a76fb05d6a62d05781574',
        retrievedOn: '2026-11-05',
        mediaType: 'application/pdf',
      },
    ],
  },
  {
    id: 'ANAF/AJFP_Bacau_SPV_2022',
    kind: 'official_document',
    title:
      'Spațiul Privat Virtual: înregistrare și servicii oferite (DGRFP Iași, AJFP Bacău; OPANAF nr. 1.090/2022)',
    issuer: 'ANAF',
    publication: null,
    urls: [
      'https://static.anaf.ro/static/10/Iasi/Spatiul_Privat_Virtual_Inregistrare_si_servicii_oferite_O.P.A.N.A.F._nr._1090_din_09_iunie_2022.pdf',
    ],
    fetch: true,
    snapshots: [
      {
        url: 'https://static.anaf.ro/static/10/Iasi/Spatiul_Privat_Virtual_Inregistrare_si_servicii_oferite_O.P.A.N.A.F._nr._1090_din_09_iunie_2022.pdf',
        sha256: '088ca918a491adb7ec4c94a46db98d952aa5d6de7400b76c8c539269d569162f',
        retrievedOn: '2026-11-05',
        mediaType: 'application/pdf',
      },
    ],
  },
  // Downloaded by the owner from the legislative portal, which refuses automated requests.
  {
    id: 'OMFP1899/2004',
    kind: 'act',
    title:
      'Procedura de restituire și de rambursare a sumelor de la buget, precum și de acordare a dobânzilor cuvenite contribuabililor pentru sumele restituite sau rambursate cu depășirea termenului legal, aprobată prin OMFP nr. 1.899/2004 (textul inițial; trimite la OG nr. 92/2003, înlocuită de L207/2015 ale cărei art. 168 și 182 reglementează acum restituirea și dobânzile)',
    issuer: 'Ministerul Finanțelor Publice',
    publication: 'Monitorul Oficial nr. 13 din 5 ianuarie 2005',
    urls: ['https://legislatie.just.ro/Public/DetaliiDocument/58349'],
    fetch: false,
    snapshots: [
      {
        url: 'https://legislatie.just.ro/Public/DetaliiDocument/58349',
        sha256: '113faad70d43b1d8666e791f8a71609ccc0a05d9307d9b223a3fc94d486ecc41',
        retrievedOn: '2026-11-05',
        mediaType: 'application/pdf',
      },
    ],
  },
];

const located = (id: string, source: string, locator: string, summary: string): Clause => ({
  id,
  source,
  locator,
  status: 'located',
  summary,
});

export const taxAccountClauses: readonly Clause[] = [
  located(
    `${CPF}:art.154(3)`,
    CPF,
    'art. 154 alin. (3)',
    'Creanțele administrate de organul fiscal central stabilite prin declarații de impunere, plătite în contul unic, cu scadența în altă zi decât 25, devin scadente pe 25 a lunii prevăzute de actul care le reglementează.',
  ),
  located(
    `${CPF}:art.156(1)`,
    CPF,
    'art. 156 alin. (1)',
    'Diferențele de obligații principale și accesoriile stabilite prin decizie se plătesc până pe 5 a lunii următoare, dacă decizia a fost comunicată între 1 și 15 ale lunii, și până pe 20 a lunii următoare, dacă a fost comunicată între 16 și 31.',
  ),
  located(
    `${CPF}:art.163(2)`,
    CPF,
    'art. 163 alin. (2)',
    'Creanțele administrate de organul fiscal central se plătesc într-un cont unic, cu un ordin de plată pentru Trezoreria Statului; tipurile de obligații plătite astfel se aprobă prin ordin al președintelui ANAF (în vigoare de la 1 iulie 2018, OG nr. 30/2017).',
  ),
  located(
    `${CPF}:art.163(2)-(5)`,
    CPF,
    'art. 163 alin. (2)–(5)',
    'Plata în contul unic se distribuie de organul fiscal pe fiecare buget sau fond, proporțional cu obligațiile datorate; dacă nu acoperă obligațiile unui buget, mai întâi impozitele și contribuțiile cu reținere la sursă, apoi celelalte obligații principale, apoi accesoriile; în cadrul unei categorii neacoperite, proporțional.',
  ),
  located(
    `${CPF}:art.163(3)-(5)`,
    CPF,
    'art. 163 alin. (3)–(5)',
    'Distribuirea sumelor din contul unic: pe fiecare buget sau fond proporțional cu obligațiile datorate; în cadrul bugetului neacoperit, în ordinea: reținere la sursă, alte obligații principale, accesorii; în cadrul categoriei neacoperite, proporțional cu obligațiile datorate.',
  ),
  located(
    `${CPF}:art.163(7)`,
    CPF,
    'art. 163 alin. (7)',
    'Obligațiile care nu se plătesc în contul unic se plătesc distinct pe fiecare tip de creanță fiscală.',
  ),
  located(
    `${CPF}:art.163(10)`,
    CPF,
    'art. 163 alin. (10)',
    'Pentru debitorii cu înlesniri la plată sau în insolvență, sumele din contul unic se distribuie în ordinea art. 165 alin. (1) sau (6), indiferent de tipul de creanță.',
  ),
  located(
    `${CPF}:art.165(1)`,
    CPF,
    'art. 165 alin. (1)',
    'Când suma plătită nu stinge toate obligațiile, se stinge obligația indicată de debitor potrivit legii sau distribuită potrivit art. 163, de drept: întâi obligațiile principale în ordinea vechimii, apoi accesoriile în ordinea vechimii; obligațiile cu scadențe viitoare, la solicitarea debitorului.',
  ),
  located(
    `${CPF}:art.165(1),(3)`,
    CPF,
    'art. 165 alin. (1) și (3)',
    'Stingerea de drept: obligațiile principale în ordinea vechimii, apoi accesoriile în ordinea vechimii; vechimea se stabilește după scadență pentru obligațiile principale, după data comunicării pentru diferențele stabilite de organul fiscal și pentru accesorii, după data depunerii pentru diferențele din declarațiile rectificative.',
  ),
  located(
    `${CPF}:art.165(8)`,
    CPF,
    'art. 165 alin. (8)',
    'Pentru obligațiile stabilite de organele de inspecție fiscală și pentru amenzi, se stinge cu prioritate obligația sau amenda pe care o alege contribuabilul.',
  ),
  located(
    `${CPF}:art.167(1)-(2)`,
    CPF,
    'art. 167 alin. (1)–(2), (4)–(5)',
    'Compensarea stinge creanțele bugetului cu sumele de rambursat, de restituit sau de plată de la buget ale debitorului, până la concurența celei mai mici; întâi cu obligațiile aceluiași buget, apoi, din diferență, proporțional cu obligațiile altor bugete; operează de drept când creanțele sunt deodată certe, lichide și exigibile.',
  ),
  located(
    `${CPF}:art.168(1),(8)-(10)`,
    CPF,
    'art. 168 alin. (1) și (8)–(10)',
    'Se restituie, la cerere, orice sumă plătită fără a fi datorată; restituirea sau rambursarea se face numai după compensarea obligațiilor restante, diferența rămasă restituindu-se.',
  ),
  located(
    `${CPF}:art.173(1),(4)-(5)`,
    CPF,
    'art. 173 alin. (1), (4) și (5)',
    'Pentru neachitarea la scadență a obligațiilor principale se datorează dobânzi și penalități de întârziere; ele se fac venit la bugetul creanței principale și se stabilesc prin decizii.',
  ),
  located(
    `${CPF}:art.173(3)`,
    CPF,
    'art. 173 alin. (3)',
    'Nu se datorează accesorii pentru suma plătită înainte de stabilirea obligației, dacă nu a stins alte obligații, pentru obligațiile stabilite ulterior prin declarații de impunere, declarații rectificative sau decizii de impunere.',
  ),
  located(
    `${CPF}:art.174(1),(5)`,
    CPF,
    'art. 174 alin. (1) și (5)',
    'Dobânzile se calculează pentru fiecare zi de întârziere, de la ziua următoare scadenței până la data stingerii inclusiv; nivelul dobânzii este de 0,02% pe zi.',
  ),
  located(
    `${CPF}:art.176(1)-(2)`,
    CPF,
    'art. 176 alin. (1)–(2) și (4)',
    'Penalitățile de întârziere se calculează pentru fiecare zi de întârziere, ca dobânzile; nivelul este de 0,01% pe zi; nu se aplică obligațiilor pentru care se datorează penalitate de nedeclarare.',
  ),
  located(
    `${CPF}:art.181(1)`,
    CPF,
    'art. 181 alin. (1)–(2), (5)',
    'Penalitatea de nedeclarare: 0,08% pe zi din obligațiile principale nedeclarate ori declarate incorect și stabilite de inspecția fiscală, de la ziua următoare scadenței; redusă cu 75% dacă diferența este stinsă până la termenul art. 156 alin. (1); se face venit la bugetul de stat.',
  ),
  located(
    'OPANAF1613/2018:pct.4-7',
    'OPANAF1613/2018',
    'anexa, cap. I pct. 4–7 (pct. 4 modificat de OPANAF nr. 146/2025)',
    'Sumele din contul unic se distribuie pe fiecare buget sau fond proporțional cu sumele datorate; în cadrul bugetului, în ordinea art. 163 alin. (4); în cadrul categoriei neacoperite, proporțional; apoi se sting obligațiile potrivit art. 165 alin. (1) și (3), cu înștiințarea contribuabilului care a optat.',
  ),
  located(
    'OPANAF1613/2018:pct.8-10',
    'OPANAF1613/2018',
    'anexa, cap. I pct. 8.1–10.2',
    'Sumele rămase nedistribuite se distribuie în ultima zi lucrătoare a lunii în conturile în curs de distribuire ale celor trei bugete, după ponderea veniturilor din legile bugetare; ele sting obligațiile înregistrate ulterior în ordinea vechimii plăților, iar în primele 10 zile ale lunii următoare sting prin compensare, proporțional, obligațiile celorlalte bugete.',
  ),
  located(
    'OPANAF1613/2018:pct.12-13',
    'OPANAF1613/2018',
    'anexa, cap. I pct. 12–13',
    'Compensarea se constată prin „Decizia privind compensarea obligațiilor fiscale”, comunicată în 7 zile; suma rămasă după compensare se restituie la cerere (art. 168).',
  ),
  located(
    'OPANAF146/2025:art.I',
    'OPANAF146/2025',
    'art. I pct. 1–3',
    'Plățile în contul unic sting cu prioritate ajutoarele de stat de recuperat (pct. 3^1); după aceea sumele se distribuie pe bugete proporțional cu sumele datorate (pct. 4 rescris).',
  ),
  located(
    'OPANAF551/2021:anexa',
    'OPANAF551/2021',
    'anexa (Nomenclatorul obligațiilor fiscale care se plătesc în contul unic)',
    'Se plătesc în contul unic, între altele: impozitul pe salarii (poz. 1), impozitul pe profit (5–6), impozitul pe dividende (7, 13), impozitul pe veniturile microîntreprinderilor (8), impozitul pe dobânzi (14), CAS (34–39) și CASS (40–47). TVA și contribuția asiguratorie pentru muncă nu sunt în nomenclator: se plătesc distinct (art. 163 alin. (7)).',
  ),
  located(
    'OPANAF551/2021:anexa.poz.11',
    'OPANAF551/2021',
    'anexa, poz. 11',
    'Impozitul pe veniturile din drepturi de proprietate intelectuală (art. 2 alin. (1) și art. 72 din Codul fiscal) se plătește în contul unic.',
  ),
  located(
    'OPANAF551/2021:anexa.poz.18-24',
    'OPANAF551/2021',
    'anexa, poz. 18–24',
    'Se plătesc în contul unic impozitele pe veniturile obținute din România de nerezidenți: din dividende (poz. 18, art. 223 alin. (1) lit. a)), dobânzi (19, lit. b)–c)), redevențe (20, lit. d)–e)), comisioane (21, lit. f)–g)), activități sportive și de divertisment (22), remunerațiile administratorilor persoane juridice (23) și servicii prestate de nerezidenți (24, lit. i), k), l)).',
  ),
  located(
    'OPANAF874/2024:art.I.pct.2',
    'OPANAF874/2024',
    'art. I pct. 2 (poz. 33^1–33^5 introduse în anexă)',
    'Se introduce în nomenclator poz. 33^3: impozitul pe veniturile din cedarea folosinței bunurilor (altele decât arendarea bunurilor agricole și închirierea în scop turistic a camerelor din locuințe proprietate personală), reținut la sursă de persoanele juridice și celelalte entități care conduc evidență contabilă (art. 84^1 din Codul fiscal): se plătește în contul unic.',
  ),
  located(
    'OPANAF2937/2018:pct.2-4',
    'OPANAF2937/2018',
    'anexa, pct. 2–4',
    'Persoanele fizice plătesc în contul unic 55.04, deschis pe CNP sau NIF; sumele se distribuie proporțional cu obligațiile din declarația unică și se sting întâi obligațiile principale, apoi accesoriile.',
  ),
  located(
    'OMFP3832/2015:art.I',
    'OMFP3832/2015',
    'art. I alin. (2) și anexa B',
    'Numărul de evidență a plății se folosește de contribuabilii care aleg să plătească o obligație stabilită de inspecția fiscală, amenzi sau o obligație accesorie dintr-o decizie referitoare la obligațiile de plată accesorii.',
  ),
  located(
    'OPANAF967/2017:anexa3',
    'OPANAF967/2017',
    'anexa nr. 3',
    'Decizia referitoare la obligațiile fiscale accesorii reprezentând dobânzi și penalități de întârziere: pe obligație, cuantumul dobânzilor și al penalităților și contul în care se virează; în anexa ei, documentul care a individualizat suma, perioada, suma principală, zilele de întârziere, cota și suma.',
  ),
  located(
    'OPANAF727/2019:anexa1.pct.11',
    'OPANAF727/2019',
    'anexa nr. 1 cap. I pct. 3, 5 și 11',
    'Deciziile de accesorii se emit trimestrial, sau după 180 de zile sub pragurile de 3.000, 1.500, 500 sau 100 lei; sumele se rotunjesc la leu, 50 de bani și peste prin majorare.',
  ),
  located(
    'OPANAF352/2022:anexa2',
    'OPANAF352/2022',
    'art. 2 și anexa nr. 2',
    'Decizia de rambursare a TVA arată perioada și decontul, TVA solicitată și TVA aprobată la rambursare; suma aprobată urmează procedura art. 165, 167 sau 168 (stingere, compensare, restituire).',
  ),
  located(
    'OPANAF587/2016:anexa5.pct.I',
    'OPANAF587/2016',
    'art. 1 alin. (1) lit. b) și anexa nr. 5 pct. I',
    'Declarația rectificativă (710) corectează impozitele și taxele declarate în formularul 100, câte o declarație pe perioadă de raportare, cu suma inițială și suma corectată a fiecărei obligații.',
  ),
  located(
    'ANAF/D710:page',
    'ANAF/D710',
    'pagina declarației 710 și pachetul D710_14092026.zip',
    'Versiunea curentă a D710 (OPANAF nr. 57/2026, perioade din 01/2024): structura XML comună cu D100, namespace mfp:anaf:dgti:d710:declaratie:v2, validatorul J20.0.7.',
  ),
  located(
    'ANAF/legenda_fisa_platitor:legenda',
    'ANAF/legenda_fisa_platitor',
    'legenda',
    'Fișa pe plătitor: documentul care a stabilit suma (DEC., DEC.IMP., DEC.ACC. …) și operațiunile de stingere: încasări (I), restituiri (RST), rambursări (RMB), compensări (C_D de unde pleacă banii, C_C unde ajung), plăți în plus (SS).',
  ),
  located(
    'ANAF/AJFP_Bacau_SPV_2022:cereri',
    'ANAF/AJFP_Bacau_SPV_2022',
    'p. 22 (tipurile de cereri ale persoanelor juridice)',
    'Prin SPV persoanele juridice cer, între altele, Fișă Rol Completă, Fișă Rol Simplificată, Rezumat Fișă Rol cu XLS atașat, Situație Sintetică și Vectorul fiscal; răspunsurile se văd ca PDF.',
  ),
  located(
    'OMFP1802/2014:conturi.448',
    'OMFP1802/2014',
    'funcțiunea contului 448',
    'În creditul contului 448 se înregistrează despăgubirile, amenzile și penalitățile datorate bugetului (658) și sumele restituite de la buget reprezentând vărsăminte efectuate în plus; în debit, sumele virate bugetului; soldul debitor reprezintă sumele cuvenite de la buget.',
  ),
  located(
    'OMFP1802/2014:conturi.658',
    'OMFP1802/2014',
    'funcțiunea contului 658',
    'În debitul contului 658 se înregistrează valoarea despăgubirilor, amenzilor și penalităților datorate sau plătite terților și bugetului (401, 404, 448, 462, 408, 512).',
  ),
  located(
    'OMFP1802/2014:conturi.442',
    'OMFP1802/2014',
    'funcțiunea conturilor 441, 4423 și 4424',
    'În debitul conturilor de impozit (441, 4423) se înregistrează plățile către buget; soldul debitor al lui 441 reprezintă sumele vărsate în plus. 4424 ține TVA de recuperat, creditat cu TVA încasată de la buget și cu cea compensată cu TVA de plată sau cu alte impozite.',
  ),
  located(
    'OMFP1802/2014:pct.352',
    'OMFP1802/2014',
    'pct. 352 și funcțiunea contului 473',
    'Operațiunile care nu se pot înregistra direct în conturile lor, pentru care sunt necesare clarificări, se înregistrează provizoriu în 473, clarificat în cel mult trei luni.',
  ),
  located(
    'ANAF/Cod-fiscal-consolidat:art.2(2)',
    'ANAF/Cod-fiscal-consolidat',
    'art. 2 alin. (2)',
    'Contribuțiile de asigurări sociale sunt datorate bugetului asigurărilor sociale de stat, contribuția de asigurări sociale de sănătate bugetului Fondului național unic de asigurări sociale de sănătate, contribuția asiguratorie pentru muncă bugetului general consolidat.',
  ),
  located(
    'ANAF/Cod-fiscal-consolidat:art.220^6(1)',
    'ANAF/Cod-fiscal-consolidat',
    'art. 220^6 alin. (1)',
    'Contribuția asiguratorie pentru muncă se plătește la bugetul de stat, într-un cont distinct, până pe 25 a lunii (sau a trimestrului) următoare.',
  ),
  located(
    'ANAF/Cod-fiscal-consolidat:art.303(7)',
    'ANAF/Cod-fiscal-consolidat',
    'art. 303 alin. (7)–(8)',
    'Soldul sumei negative a TVA se rambursează la cerere, prin bifarea casetei din decont, sau se reportează; un sold de cel mult 5.000 lei se reportează obligatoriu; cererea se poate retrage până la comunicarea deciziei.',
  ),
  located(
    'OMFP1899/2004:cap.I',
    'OMFP1899/2004',
    'anexa, cap. I pct. 1–4',
    'Restituirea se face la cerere, în 45 de zile de la înregistrarea ei (pct. 2), cerută în termenul de prescripție de 5 ani de la 1 ianuarie a anului următor celui în care s-a născut dreptul (pct. 3), după verificarea și compensarea cu obligațiile restante (pct. 4). Text din 2004: se citește împreună cu L207/2015 art. 168.',
  ),
];
