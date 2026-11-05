import type { Clause, LegalSource } from './index';

/*
 * The sources of the distance sales and the One Stop Shop (V4): the place of supply of
 * intra-community distance sales of goods (Codul fiscal art. 266 alin. (1) pct. 35, art. 275 alin.
 * (2)) and of telecommunications, broadcasting and electronic services to consumers (art. 278 alin.
 * (5) lit. h), the norms' pct. 21), the €10,000 threshold and the option for the destination (art.
 * 278^1), the Union scheme (art. 315), the non-Union one (art. 314) and the import one (art.
 * 315^2), invoicing under them (art. 319 alin. (5) lit. d), (6) lit. b)), where D300 reports them
 * (OPANAF nr. 174/2026), ANAF's form 398 (structure, schema and validator), the Member States'
 * rates as the Commission's TEDB gives them, the ECB's reference rates the return converts at,
 * who reports to RO e-Factura and by when (OUG nr. 120/2021 art. 2, 10–10^10, in its consolidated
 * form of 01.06.2026, downloaded by the owner), the repeal of form 085 (OPANAF nr. 1.699/2021) and
 * Regulation (EU) No 282/2011 (the presumptions and evidence of the customer's place, art. 24a–24f;
 * the scheme's start, art. 57d; corrections, art. 61), in the consolidated version of 14.04.2025
 * the owner downloaded from EUR-Lex. Read on 5 and 6 November 2026.
 */

const declarations = 'https://static.anaf.ro/static/10/Anaf/Declaratii_R';
const tedb = 'https://ec.europa.eu/taxation_customs/tedb/ws/';

export const ossSources: readonly LegalSource[] = [
  {
    id: 'ANAF/D398',
    kind: 'official_document',
    title:
      'Formularul 398 „Declarație specială de TVA (VAT Return)” pentru regimurile speciale ale art. 314, 315 și 315^2: pagina ANAF, PDF-ul inteligent D398_v1.0.11, structura XML A1.0.10 (04.09.2024), schema d398_20211101.xsd (namespace mfp:anaf:dgti:d398:declaratie:v1) și validatorul J1.0.11 (29.04.2025)',
    issuer: 'ANAF',
    publication: null,
    urls: [
      `${declarations}/398.html`,
      `${declarations}/AplicatiiDec/d398_v1.0.10_structuraXML_04092024.pdf`,
      `${declarations}/AplicatiiDec/d398_20211101.xsd`,
      `${declarations}/AplicatiiDec/D398_v1.0.11_28042025.pdf`,
      `${declarations}/AplicatiiDec/D398_20250429.zip`,
    ],
    fetch: true,
    snapshots: [
      {
        url: `${declarations}/398.html`,
        sha256: 'be7994caeb7ed8efe0eecfee117880fd68e5316976adb8deab6cc43d0ed535da',
        retrievedOn: '2026-11-05',
        mediaType: 'text/html',
      },
      {
        url: `${declarations}/AplicatiiDec/d398_v1.0.10_structuraXML_04092024.pdf`,
        sha256: '36781d6b0fbc4e39a411d4fc99f79916708cceac396a19a0b64f1a8768e98e5a',
        retrievedOn: '2026-11-05',
        mediaType: 'application/pdf',
      },
      {
        url: `${declarations}/AplicatiiDec/d398_20211101.xsd`,
        sha256: 'dd9f3d0168c0ec7c6c4abf170f7d10ddba909ce911b5d6965d398fbafe0edcf5',
        retrievedOn: '2026-11-05',
        mediaType: 'application/xml',
      },
      {
        url: `${declarations}/AplicatiiDec/D398_v1.0.11_28042025.pdf`,
        sha256: 'bc3dc2d50facedcc22d937d38ea9b26c8c6a5bf52ab579493401162b77e87a93',
        retrievedOn: '2026-11-05',
        mediaType: 'application/pdf',
      },
      {
        url: `${declarations}/AplicatiiDec/D398_20250429.zip`,
        sha256: '153bfceda25743e014d3464ef94a6ae7d42cb9db46d05af15d05305999497bba',
        retrievedOn: '2026-11-05',
        mediaType: 'application/zip',
      },
    ],
  },
  {
    // TEDB's public SOAP service (retrieveVatRates, WSDL at …/tedb/ws/VatRetrievalService.wsdl),
    // asked for the 27 Member States at two dates; a POST, so the sources script cannot refetch
    // it: the responses are kept in .sources/EC_TEDB/.
    id: 'EC/TEDB',
    kind: 'official_document',
    title:
      'Comisia Europeană, Taxes in Europe Database (TEDB): cotele de TVA ale statelor membre, serviciul web retrieveVatRates, situația la 01.01.2026 și la 05.11.2026',
    issuer: 'Comisia Europeană (DG TAXUD)',
    publication: null,
    urls: [`${tedb}VatRetrievalService.wsdl`],
    fetch: false,
    snapshots: [
      {
        url: `${tedb}#retrieveVatRates-situationOn-2026-01-01`,
        sha256: 'ac30c9bd85670870bd98d9ee88450d0f84e2512aee3ad8190fcf259653f507d8',
        retrievedOn: '2026-11-05',
        mediaType: 'application/xml',
      },
      // The five Member States whose rates changed during 2026, asked the day before and on the
      // first day each change shows (the responses of 2026-03-31 and 2026-06-30 were byte for byte
      // those of 2026-03-01 and 2026-04-01): each change applies from the 1st of its month.
      {
        url: `${tedb}#retrieveVatRates-AT-BE-FR-IE-SE-situationOn-2026-02-28`,
        sha256: '61846120776e67a7827296935118fb691503360c3ef6b04052736f3115c89d59',
        retrievedOn: '2026-11-05',
        mediaType: 'application/xml',
      },
      {
        url: `${tedb}#retrieveVatRates-AT-BE-FR-IE-SE-situationOn-2026-03-01`,
        sha256: '3991a83c89a9572440c2ee7da3690f68020e489692e135b7b3c1764ed4777d53',
        retrievedOn: '2026-11-05',
        mediaType: 'application/xml',
      },
      {
        url: `${tedb}#retrieveVatRates-AT-BE-FR-IE-SE-situationOn-2026-04-01`,
        sha256: 'eb267462bd22b30adcfe9342eec99eacce3b851f0d4265733ac876005df80ff8',
        retrievedOn: '2026-11-05',
        mediaType: 'application/xml',
      },
      {
        url: `${tedb}#retrieveVatRates-AT-BE-FR-IE-SE-situationOn-2026-07-01`,
        sha256: 'e5bd2f7a689e0f6a3dc28ea66acb86a4504c75e714281bbe209469a64afdd629',
        retrievedOn: '2026-11-05',
        mediaType: 'application/xml',
      },
      {
        url: `${tedb}#retrieveVatRates-situationOn-2026-11-05`,
        sha256: 'a2bbf222ab57c1726f7eccdedac1014f48b96d718dc4822e5ddab4655a35d239',
        retrievedOn: '2026-11-05',
        mediaType: 'application/xml',
      },
    ],
  },
  {
    // The 90-day file changes every working day: what was read is kept, not refetched.
    id: 'ECB/eurofxref',
    kind: 'official_document',
    title:
      'Banca Centrală Europeană, cursurile de referință ale euro (euro foreign exchange reference rates), fișierul XML al ultimelor 90 de zile',
    issuer: 'Banca Centrală Europeană',
    publication: null,
    urls: ['https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist-90d.xml'],
    fetch: false,
    snapshots: [
      {
        url: 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist-90d.xml',
        sha256: '5505c5bd9b1a8883d62991ccde9ad9fadba9245d612ff635dce2a5c7e0cd1690',
        retrievedOn: '2026-11-05',
        mediaType: 'application/xml',
      },
    ],
  },
  {
    // The ordinance as the legislative portal consolidates it, downloaded by the owner (the portal
    // refuses automated requests). Kept in .sources/OUG120_2021-A/.
    id: 'OUG120/2021-A',
    kind: 'act',
    title:
      'Ordonanța de urgență a Guvernului nr. 120/2021 privind administrarea, funcționarea și implementarea sistemului național privind factura electronică RO e-Factura și factura electronică în România (forma consolidată a portalului legislativ, actualizată până la 01.06.2026)',
    issuer: 'Guvernul României',
    publication: 'Monitorul Oficial nr. 960 din 7 octombrie 2021',
    urls: [],
    fetch: false,
    snapshots: [
      {
        url: 'https://xfactura.invalid/owner-download/OUG_A_120_04_10_2021.pdf',
        sha256: 'f3c77291947d2d3a8e52f284e9a3e2e73c46469adbe9c43d47962b9608e7ae69',
        retrievedOn: '2026-11-06',
        mediaType: 'application/pdf',
      },
    ],
  },
  {
    // EUR-Lex's consolidation (►M1–►M8), downloaded by the owner in Romanian. It is not the
    // authentic text (the Official Journal's is): the Regulation applies directly, and the
    // Romanian norms (pct. 21) repeat only part of it. Kept in .sources/REG282_2011-A/.
    id: 'REG282/2011-A',
    kind: 'act',
    title:
      'Regulamentul de punere în aplicare (UE) nr. 282/2011 al Consiliului din 15 martie 2011 de stabilire a măsurilor de punere în aplicare a Directivei 2006/112/CE privind sistemul comun al taxei pe valoarea adăugată (versiunea consolidată din 14.04.2025, EUR-Lex, cu modificările ►M1–►M8)',
    issuer: 'Consiliul Uniunii Europene',
    publication: 'Jurnalul Oficial al Uniunii Europene L 77 din 23.3.2011, p. 1',
    urls: [],
    fetch: false,
    snapshots: [
      {
        url: 'https://xfactura.invalid/owner-download/CELEX_02011R0282-20250414_RO_TXT.pdf',
        sha256: '0b58aac7ff7cb32ad7ea3a0dadaa38553b6fa9bb42770ae368599edd504d1e24',
        retrievedOn: '2026-11-06',
        mediaType: 'application/pdf',
      },
    ],
  },
  {
    // ANAF's note reproduces art. 10 and 10^1 as OUG nr. 89/2025 left them; the ordinance itself
    // is OUG120/2021-A above.
    id: 'ANAF/eFactura-OUG89-2025',
    kind: 'official_document',
    title:
      'ANAF, DGRFP Brașov: „Modificări aduse OUG nr. 120/2021 privind … RO e-Factura … de OUG 89/2025” (material informativ din 08.01.2026), cu textul art. 10 și 10^1 înainte și după modificare',
    issuer: 'ANAF (DGRFP Brașov)',
    publication: null,
    urls: ['https://static.anaf.ro/static/10/Brasov/Brasov/facturare_electronica_89.pdf'],
    fetch: true,
    snapshots: [
      {
        url: 'https://static.anaf.ro/static/10/Brasov/Brasov/facturare_electronica_89.pdf',
        sha256: 'c73be84ea3e990fd62f262e01842c76aa6c2b6267785776908c43e02c80b8458',
        retrievedOn: '2026-11-05',
        mediaType: 'application/pdf',
      },
    ],
  },
  {
    id: 'OPANAF1699/2021',
    kind: 'act',
    title:
      'Ordinul președintelui ANAF nr. 1.699/2021 pentru aprobarea formularelor de înregistrare fiscală a contribuabililor și a tipurilor de obligații fiscale care formează vectorul fiscal (text publicat de ANAF, fără anexele din M.Of. nr. 1056 bis)',
    issuer: 'ANAF',
    publication: null,
    urls: ['https://static.anaf.ro/static/10/Anaf/legislatie/OPANAF_1699_2021.pdf'],
    fetch: true,
    snapshots: [
      {
        url: 'https://static.anaf.ro/static/10/Anaf/legislatie/OPANAF_1699_2021.pdf',
        sha256: '9e56d3f7d55c37d872da9efe2b9dd47cb5b880c16a2de71ef4148ce39b1534fc',
        retrievedOn: '2026-11-05',
        mediaType: 'application/pdf',
      },
    ],
  },
];

const CODE = 'ANAF/Cod-fiscal-consolidat';
const EFACTURA = 'OUG120/2021-A';
const REGULATION = 'REG282/2011-A';
const fiscal = (id: string, locator: string, summary: string): Clause => ({
  id: `${CODE}:${id}`,
  source: CODE,
  locator,
  status: 'located',
  summary,
});
const located = (source: string, id: string, locator: string, summary: string): Clause => ({
  id: `${source}:${id}`,
  source,
  locator,
  status: 'located',
  summary,
});

export const ossClauses: readonly Clause[] = [
  fiscal(
    'art.266(1)(35)',
    'art. 266 alin. (1) pct. 35',
    'Vânzarea intracomunitară de bunuri la distanță este livrarea de bunuri expediate sau transportate de furnizor (sau în numele lui, inclusiv cu intervenția lui indirectă) din alt stat membru decât cel în care se încheie transportul către client, unei persoane neimpozabile sau unei persoane ale cărei achiziții intracomunitare nu sunt impozabile, bunurile nefiind mijloace de transport noi sau bunuri montate ori instalate.',
  ),
  fiscal(
    'art.275(2)',
    'art. 275 alin. (2)',
    'Locul vânzării intracomunitare de bunuri la distanță este locul în care se află bunurile când se încheie expedierea sau transportul către client.',
  ),
  fiscal(
    'art.278(5)(h)',
    'art. 278 alin. (5) lit. h)',
    'Serviciile de telecomunicații, de radiodifuziune și televiziune și cele furnizate pe cale electronică prestate unei persoane neimpozabile au locul unde beneficiarul este stabilit sau își are domiciliul stabil ori reședința obișnuită.',
  ),
  fiscal(
    'norme.art.278.pct.21(4),(6)',
    'normele metodologice, titlul VII pct. 21 alin. (4) și (6)',
    'Pentru serviciile art. 278 alin. (5) lit. h) prestate unei persoane neimpozabile altfel decât prin linie fixă, rețea mobilă sau decodor, clientul se prezumă stabilit în locul identificat de prestator prin două elemente de probă necontradictorii: adresa de facturare, adresa IP sau altă geolocalizare, detaliile bancare, codul de țară al cartelei SIM, locul liniei fixe, alte informații relevante comercial.',
  ),
  fiscal(
    'art.278^1(1)-(2)',
    'art. 278^1 alin. (1) și (2)',
    'Art. 275 alin. (2) și art. 278 alin. (5) lit. h) nu se aplică furnizorului stabilit într-un singur stat membru ale cărui vânzări la distanță și servicii TBE către persoane neimpozabile din alte state membre nu depășesc, fără TVA, 10.000 euro în anul curent și nu au depășit în anul precedent; depășit în cursul anului, locul la destinație se aplică de la momentul depășirii.',
  ),
  fiscal(
    'art.278^1(3)',
    'art. 278^1 alin. (3)',
    'Furnizorul stabilit în România sub prag poate opta ca locul să fie la destinație (art. 275 alin. (2), art. 278 alin. (5) lit. h)); opțiunea se aplică cel puțin doi ani calendaristici.',
  ),
  fiscal(
    'art.278^1(5)',
    'art. 278^1 alin. (5)',
    'Echivalentul în lei al pragului de 10.000 euro, la cursul BCE din data adoptării Directivei (UE) 2017/2.455, este pentru România 46.337 lei.',
  ),
  fiscal(
    'art.314(1)-(2)',
    'art. 314 alin. (1) și (2)',
    'Regimul special non-Uniune îl poate utiliza numai persoana impozabilă care nu are sediul activității economice și nici un sediu fix în Uniunea Europeană, pentru serviciile prestate persoanelor neimpozabile din Uniune.',
  ),
  fiscal(
    'art.315(1)-(2^1)',
    'art. 315 alin. (1)–(2^1)',
    'Regimul special Uniune: statul membru de consum este, pentru servicii, cel al locului prestării după art. 278, iar pentru vânzările la distanță cel în care se încheie transportul; îl poate utiliza persoana impozabilă cu sediul activității economice în România pentru vânzările intracomunitare la distanță și pentru serviciile prestate persoanelor neimpozabile dintr-un stat membru în care nu este stabilită, pentru toate aceste operațiuni.',
  ),
  fiscal(
    'art.315(3)-(5)',
    'art. 315 alin. (3)–(5)',
    'Cu România stat membru de înregistrare, persoana depune electronic declarația de începere a activității în regim special și notifică încetarea sau modificările; folosește codul de TVA atribuit după art. 316 sau 317; este exclusă când nu mai efectuează operațiunile, nu mai îndeplinește condițiile sau încalcă repetat regulile.',
  ),
  fiscal(
    'art.315(6)-(6^1)',
    'art. 315 alin. (6) și (6^1)',
    'Declarația specială de TVA (modelul anexei III la Regulamentul de punere în aplicare (UE) 2020/194) se depune electronic trimestrial, până la sfârșitul lunii următoare trimestrului, chiar fără operațiuni; termenul este ultima zi calendaristică a lunii, chiar dacă este nelucrătoare.',
  ),
  fiscal(
    'art.315(7)-(10)',
    'art. 315 alin. (7)–(10)',
    'Declarația cuprinde codul special, pentru fiecare stat membru de consum valoarea fără TVA, cotele și TVA pe cote a vânzărilor la distanță, a livrărilor prin interfețe și a serviciilor, totalul datorat; separat bunurile expediate din alte state membre și serviciile prestate din sedii fixe din alte state membre.',
  ),
  fiscal(
    'art.315(11)',
    'art. 315 alin. (11)',
    'Modificările unei declarații depuse se includ într-o declarație ulterioară, în cel mult trei ani de la termenul declarației inițiale, identificând statul membru de consum, perioada fiscală și TVA rezultată din corecție, care poate fi negativă.',
  ),
  fiscal(
    'art.315(12)-(13)',
    'art. 315 alin. (12) și (13)',
    'Declarația se întocmește în euro; operațiunile plătite în alte monede se convertesc la cursul BCE publicat pentru ultima zi a perioadei de raportare sau din ziua următoare dacă nu e publicat; TVA se plătește în euro, într-un cont special indicat de organul fiscal, până la termenul declarației.',
  ),
  fiscal(
    'art.315^2(1)-(3)',
    'art. 315^2 alin. (1)–(3)',
    'Regimul de import (IOSS) privește vânzările la distanță de bunuri importate din teritorii sau țări terțe în loturi cu valoare intrinsecă de cel mult 150 euro, fără produse accizabile; îl poate aplica persoana stabilită în Uniune, direct sau printr-un intermediar stabilit în Uniune, pentru toate aceste vânzări.',
  ),
  fiscal(
    'art.315^2(18)-(23)',
    'art. 315^2 alin. (18)–(23)',
    'În regimul de import, persoana sau intermediarul depune lunar, până la sfârșitul lunii următoare (ultima zi calendaristică, chiar nelucrătoare), declarația specială de TVA în euro, la cursul BCE din ultima zi a perioadei, și plătește TVA într-un cont special în euro.',
  ),
  fiscal(
    'art.319(5)(d),(6)(b)',
    'art. 319 alin. (5) lit. d) și alin. (6) lit. b)',
    'Furnizorul care utilizează regimurile speciale ale art. 314, 315 și 315^2 facturează după normele statului membru în care este înregistrat; factura pentru vânzarea la distanță impozabilă în România nu este obligatorie când persoana aplică regimul special al art. 315.',
  ),
  located(
    'OPANAF174/2026',
    'rd.3',
    'anexa nr. 2, instrucțiunile rândului 3',
    'Rândul 3 cuprinde baza livrărilor de bunuri și prestărilor de servicii care nu sunt impozabile în România pentru că nu au locul în România după art. 275 și 278, precum și livrările intracomunitare scutite ale art. 294 alin. (2) lit. b) și c).',
  ),
  located(
    'OPANAF174/2026',
    'rd.17-18',
    'anexa nr. 2, instrucțiunile rândurilor 17 și 18',
    'Rândul 17 cuprinde baza și TVA colectată a vânzărilor intracomunitare de bunuri la distanță și a serviciilor TBE către persoane neimpozabile din alt stat membru cu locul în România după art. 278^1 alin. (1) (sub 46.337 lei în anul curent și în cel precedent, fără opțiune), avansurile incluse; rândul 18 regularizările lor.',
  ),
  located(
    'OPANAF174/2026',
    'informatii.278^1',
    'anexa nr. 2, secțiunea „Informații privind valoarea totală, fără TVA, a operațiunilor prevăzute la art. 278^1 alin. (1) lit. b)”',
    'Se înscrie baza operațiunilor declarate la rândurile 17 și 18, cumulat pentru anul precedent și cumulat pentru anul curent, perioada de raportare inclusă.',
  ),
  located(
    'ANAF/D406',
    'Livrari.310340-310346',
    'RO_SAFT_SchemaDefCod_16.02.2026.xlsx, foaia Livrari, codurile 310340 și 310346 (cu 310320, 310328, 310343, 310356)',
    'Codul 310340 („Livrări de bunuri expediate/transportate din RO sau servicii prestate din RO”, cota statului membru de livrare) corespunde declarației 398 (secțiunea 1), fără rând în D300; codurile 310346 (21%), 310356 (11%), 310320 (19%), 310343 (9%), 310328 (5%) sunt vânzările la distanță și serviciile TBE cu locul în România, D300 rd. 17.',
  ),
  located(
    'ANAF/D398',
    'structura',
    'structura XML A1.0.10 (04.09.2024), elementele d398, MS, SUPPLY, CORRECTION și listele LISTA_STATE_MS, LISTA_RATE_TVA',
    'Declarația are anul și luna de raportare (3, 6, 9, 12 pentru regimurile Uniune și non-Uniune), d_rec numai 0 (fără declarații rectificative), schema (1 Uniune, 2 non-Uniune, 3 import), declarația fără operațiuni, moneda EUR, codul (CUI pentru Uniune), pe stat membru de consum (nu RO) operațiunile pe tip (bunuri, servicii), tip de cotă și cotă cu baza și TVA în euro, totalurile și soldul cu corecțiile, corecțiile pe stat, perioadă și an (cel mult trei ani), suma de control schema + nil.',
  ),
  located(
    'EC/TEDB',
    'rates-2026',
    'răspunsurile retrieveVatRates pentru cele 27 de state membre, situația la 01.01.2026 și la 05.11.2026, și pentru AT, BE, FR, IE, SE la 28.02, 01.03, 01.04 și 01.07.2026',
    'Cota standard și cotele reduse, super-reduse și de parcare ale fiecărui stat membru, pe categoriile TEDB. Cotele standard nu se schimbă în 2026; se schimbă categoriile unor cote reduse: Belgia (cazarea la 12%) și Franța de la 01.03.2026, Suedia (alimentele la 6%) de la 01.04.2026, Austria (4,9% pentru alimente) și Irlanda (9% pentru restaurante, alimente, coafură) de la 01.07.2026.',
  ),
  located(
    'ECB/eurofxref',
    'reference-rates',
    'fișierul eurofxref-hist-90d.xml, elementele Cube cu time și rate pe monedă',
    'BCE publică, pentru fiecare zi lucrătoare, cursul de referință al euro: unitățile din fiecare monedă pentru un euro.',
  ),
  // RO e-Factura: who reports and by when (OUG nr. 120/2021, consolidated to 01.06.2026).
  located(
    EFACTURA,
    'art.2(1)(n^1)',
    'art. 2 alin. (1) lit. n^1)',
    'Relația B2C este tranzacția dintre un operator economic, persoană impozabilă stabilită în România (art. 266 alin. (2) din Codul fiscal), și o persoană neimpozabilă, alta decât autoritățile contractante (B2G) și instituțiile publice (art. 9^1).',
  ),
  located(
    EFACTURA,
    'art.10(1)-(1^2)',
    'art. 10 alin. (1), (1^1) și (1^2)',
    'În relația B2B între persoane impozabile stabilite în România, pentru livrările și prestările cu locul în România după titlul VII al Codului fiscal, emitentul transmite factura prin RO e-Factura; din 1 ianuarie 2026, și pe cele către persoane impozabile nestabilite, dar înregistrate în scopuri de TVA în România, pe care le transmite și destinatarului potrivit art. 319; fac excepție bonurile fiscale care îndeplinesc condițiile facturii simplificate (art. 319 alin. (12), (13), (21)) și facturile livrărilor intracomunitare pentru care cumpărătorul comunică un cod de TVA din alt stat membru.',
  ),
  located(
    EFACTURA,
    'art.10(7)',
    'art. 10 alin. (7)',
    'Termenul-limită de transmitere în RO e-Factura este de 5 zile lucrătoare de la data emiterii facturii, dar nu mai târziu de 5 zile lucrătoare de la data-limită de emitere a facturii din art. 319 alin. (16) din Codul fiscal; se calculează după Regulamentul (CEE, Euratom) nr. 1182/71.',
  ),
  located(
    EFACTURA,
    'art.10^1(2)',
    'art. 10^1 alin. (2) și (2^1)',
    'Din 1 ianuarie 2025, persoanele impozabile stabilite în România, înregistrate sau nu în scopuri de TVA, transmit în RO e-Factura facturile emise în relația B2C pentru livrările și prestările cu locul în România după titlul VII al Codului fiscal, cu excepția bonurilor fiscale care îndeplinesc condițiile facturii simplificate; termenul este de 5 zile lucrătoare de la emitere, cel mult 5 zile lucrătoare de la data-limită de emitere a facturii (art. 319 alin. (16)).',
  ),
  located(
    EFACTURA,
    'art.10^1(3)-(4)',
    'art. 10^1 alin. (3) și (4), modificate prin Legea nr. 88/2026 (de la 01.06.2026)',
    'Livrările și prestările către o persoană fizică ce nu se identifică prin niciun cod de identificare fiscală sau optează să se identifice prin codul numeric personal sunt în relația B2C, cu excepția beneficiarilor înscriși în Registrul RO e-Factura opțional; fără niciun cod, factura se emite cu un cod de 13 cifre de zero; factura se transmite și destinatarului, potrivit art. 319 din Codul fiscal.',
  ),
  located(
    EFACTURA,
    'art.10^3-10^10',
    'art. 10^3–10^7 și 10^10',
    'Nu transmit obligatoriu în RO e-Factura: facturile pentru operațiuni în afara sferei TVA sau sume în afara bazei, fără obligația de factură după art. 319 (10^3); persoanele de la art. 294 alin. (1) lit. j)–n) și institutele culturale ale altor state (10^5), agricultorii persoane fizice în regimul special al art. 315^1 (10^7) și furnizorii care se identifică fiscal prin CNP (10^10), care pot opta pentru sistem; furnizorii acestor persoane nu transmit nici ei facturile către ele prin sistem, cu excepția opțiunii lor; autofacturile emise după art. 319 alin. (8) sunt facturi B2B (10^4).',
  ),
  // Regulation (EU) No 282/2011, consolidated to 14.04.2025.
  located(
    REGULATION,
    'art.24a',
    'art. 24a',
    'Serviciile de telecomunicații, radiodifuziune și televiziune sau electronice furnizate într-un loc ca o cabină telefonică, un punct wi-fi, un internet café, un restaurant sau holul unui hotel, unde prezența fizică a clientului e necesară, se prezumă prestate clientului stabilit acolo; la bordul unei nave, aeronave sau unui tren, în țara unde începe transportul.',
  ),
  located(
    REGULATION,
    'art.24b',
    'art. 24b',
    'Clientul serviciilor TBE se presupune stabilit unde e instalată linia fixă prin care le primește, în țara codului mobil al cartelei SIM pentru rețelele mobile, unde e decodorul sau unde se trimite cartela de vizionare; altfel, în locul identificat de prestator prin două elemente de probă necontradictorii din art. 24f; dacă prestările de acest fel ale persoanei impozabile, de la sediul ei dintr-un stat membru, nu depășesc 100.000 EUR (sau echivalentul în moneda națională la cursul BCE din data adoptării Regulamentului (UE) 2017/2459) în anul curent și în cel precedent, ajunge un singur element de probă oferit de o persoană implicată în prestare, alta decât prestatorul sau clientul (art. 24f lit. (a)–(e)); din momentul depășirii pragului în cursul anului, regula nu se mai aplică.',
  ),
  located(
    REGULATION,
    'art.24d',
    'art. 24d',
    'Prestatorul poate răsturna prezumțiile art. 24a și art. 24b lit. (a)–(c) prin trei elemente de probă necontradictorii; autoritatea fiscală le poate răsturna la indicii de utilizare improprie sau abuz.',
  ),
  located(
    REGULATION,
    'art.24f',
    'art. 24f',
    'Elemente de probă pentru locul clientului serviciilor TBE: adresa de facturare, adresa IP sau altă geolocalizare, detaliile bancare (locul contului sau adresa de facturare cunoscută de bancă), codul mobil de țară (MCC) al cartelei SIM, locul liniei fixe prin care se prestează serviciul și alte informații relevante comercial.',
  ),
  located(
    REGULATION,
    'art.57d',
    'art. 57d alin. (1)',
    'Regimul UE se aplică din prima zi a trimestrului calendaristic următor informării statului membru de înregistrare; dacă prima livrare sau prestare în regim are loc înainte, regimul se aplică de la data ei, cu condiția ca persoana impozabilă să informeze statul de înregistrare cel târziu în a zecea zi a lunii următoare.',
  ),
  located(
    REGULATION,
    'art.61',
    'art. 61',
    'Cifrele unei declarații a regimului special pentru perioadele începând cu al treilea trimestru din 2021 se modifică, după depunere, numai prin ajustări într-o declarație ulterioară, transmise electronic statului de înregistrare în termen de trei ani de la data la care trebuia depusă declarația inițială.',
  ),
  located(
    'OPANAF1699/2021',
    'art.7(e)',
    'preambulul și art. 7 lit. e)',
    'Ordinul se emite și în temeiul art. 278^1 alin. (3) din Codul fiscal și abrogă OPANAF nr. 1.254/2021, care aproba formularul 085 de opțiune pentru aplicarea sau încetarea art. 275 alin. (2) și art. 278 alin. (5) lit. h): opțiunea se declară prin formularele de înregistrare (010, 700) ale anexelor, publicate în M.Of. nr. 1056 bis.',
  ),
];
