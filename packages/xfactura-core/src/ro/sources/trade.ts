import type { Clause, LegalSource } from './index';

/*
 * The sources of EU goods, imports and exports (G3): the Fiscal Code in ANAF's consolidated text
 * (intra-community acquisitions and supplies of goods, imports, the tax point of each, the import
 * base and its exchange rate, the documents of the right of deduction, the deferral of import VAT
 * and the recapitulative statement), OMFP nr. 103/2016 (the documents that justify the exemption
 * of exports and intra-community supplies, as ANAF publishes its text of MO 106/2016), Regulation
 * (EU) No 282/2011 art. 45a (the presumption of transport to another Member State, in EUR-Lex's
 * consolidation of 14.04.2025 the owner downloaded), OPANAF nr. 174/2026 (the D300 rows), the
 * functions of accounts 446 and 442 (OMFP nr. 1.802/2014), ANAF's SAF-T codes of the acquisitions
 * and imports, INS's Intrastat orders, norms, deadline and XML guide (www.intrastat.ro), OUG nr.
 * 41/2022 on RO e-Transport as ANAF publishes its 2022 text, and the Commission's VIES REST
 * contract. Read on 5 and 6 November 2026.
 */

const intrastat = 'http://www.intrastat.ro';

export const tradeSources: readonly LegalSource[] = [
  {
    id: 'OMFP103/2016',
    kind: 'act',
    title:
      'Ordinul ministrului finanțelor publice nr. 103/2016 privind aprobarea Instrucțiunilor de aplicare a scutirii de taxă pe valoarea adăugată pentru operațiunile prevăzute la art. 294 alin. (1) lit. a)–i), art. 294 alin. (2) și art. 296 din Codul fiscal (textul publicat de ANAF, din Monitorul Oficial nr. 106 din 11 februarie 2016, neconsolidat)',
    issuer: 'Ministerul Finanțelor Publice',
    publication: 'Monitorul Oficial nr. 106 din 11 februarie 2016',
    urls: ['https://static.anaf.ro/static/10/Anaf/legislatie/OMFP_103_2016.pdf'],
    fetch: true,
    snapshots: [
      {
        url: 'https://static.anaf.ro/static/10/Anaf/legislatie/OMFP_103_2016.pdf',
        sha256: '07c29d03bbd358b7a5a6c89dc51045b8ce22291b898affb2ac4af9302478b14e',
        retrievedOn: '2026-11-05',
        mediaType: 'application/pdf',
      },
    ],
  },
  {
    // INS's Intrastat site: the yearly thresholds' orders, the norms of the declaration, the
    // deadline and the XML guide. The law (Legea nr. 422/2006) and OG nr. 5/2022 it publishes are
    // scans without a text layer, so they are not registered.
    id: 'INS/Intrastat',
    kind: 'official_document',
    title:
      'Institutul Național de Statistică, sistemul Intrastat: Ordinul nr. 1.604/2025 privind pragurile pentru 2026 (M.Of. nr. 1022/05.11.2025), Ordinul nr. 2.353/2024 privind pragurile pentru 2025 (M.Of. nr. 1101/04.11.2024), Ordinul nr. 1.623/2022 privind Normele de completare a Declarației statistice Intrastat (M.Of. nr. 1265/29.12.2022), Ghidul de implementare XML 2026 și pagina „Declarația Intrastat” (www.intrastat.ro)',
    issuer: 'Institutul Național de Statistică',
    publication: null,
    urls: [
      `${intrastat}/doc/OPINS_PRAGURI_1604_2026.pdf`,
      `${intrastat}/doc/OPINS_PRAGURI_2353_2025.pdf`,
      `${intrastat}/doc/OPINS_NORME_1623_2023.pdf`,
      `${intrastat}/doc/Ghid_implementare_XML_Intrastat_2026_v1.pdf`,
      `${intrastat}/di2.php`,
    ],
    fetch: true,
    snapshots: [
      {
        url: `${intrastat}/doc/OPINS_PRAGURI_1604_2026.pdf`,
        sha256: '93562d591c737c2631e396c6e7f30146971dc13ad38429f3c3544d83b409f1b4',
        retrievedOn: '2026-11-05',
        mediaType: 'application/pdf',
      },
      {
        url: `${intrastat}/doc/OPINS_PRAGURI_2353_2025.pdf`,
        sha256: 'd012d77ec82dc503f5e3b695b29dff326e32b9bae31c7ea8c11ba4aa8f89c2f2',
        retrievedOn: '2026-11-05',
        mediaType: 'application/pdf',
      },
      {
        url: `${intrastat}/doc/OPINS_NORME_1623_2023.pdf`,
        sha256: 'c42bd35b4719beda8a32e26664215b2f705abf0e071d0cdc1cc4b26817bcc482',
        retrievedOn: '2026-11-05',
        mediaType: 'application/pdf',
      },
      {
        url: `${intrastat}/doc/Ghid_implementare_XML_Intrastat_2026_v1.pdf`,
        sha256: '76a9a32c465b64a187b0d83f59eecc99611c0b09fe5c49807efe1334661283b5',
        retrievedOn: '2026-11-05',
        mediaType: 'application/pdf',
      },
      {
        url: `${intrastat}/di2.php`,
        sha256: 'c0f2ee6a53e7fe5a87db1d6fa909661bc96383c13f578196139234946671250f',
        retrievedOn: '2026-11-05',
        mediaType: 'text/html',
      },
    ],
  },
  {
    // The ordinance as ANAF publishes it: its text of April 2022, not consolidated. The later
    // amendments (the international transports, the validity of the UIT code, the fines) are in
    // the portal's consolidation, which refuses automated access: the owner downloads it.
    id: 'OUG41/2022',
    kind: 'act',
    title:
      'Ordonanța de urgență a Guvernului nr. 41/2022 pentru instituirea Sistemului național privind monitorizarea transporturilor rutiere de bunuri cu risc fiscal ridicat RO e-Transport (textul publicat de ANAF, aprilie 2022, neconsolidat)',
    issuer: 'Guvernul României',
    publication: null,
    urls: ['https://static.anaf.ro/static/10/Anaf/legislatie/OUG_41_2022.pdf'],
    fetch: true,
    snapshots: [
      {
        url: 'https://static.anaf.ro/static/10/Anaf/legislatie/OUG_41_2022.pdf',
        sha256: '175c84f62a7ebfe41150e03ee95f4616ba2c908d93d80d786c8b42d62b06541e',
        retrievedOn: '2026-11-05',
        mediaType: 'application/pdf',
      },
    ],
  },
  {
    // The REST contract of VIES on-the-Web; the service itself (…/vies/rest-api/check-vat-number)
    // is called only from the owner's session, never by the sources script.
    id: 'EC/VIES',
    kind: 'official_document',
    title:
      'Comisia Europeană, VIES on-the-Web: contractul serviciului REST checkVatNumber (swagger_publicVAT.yaml, versiunea 1.0.0)',
    issuer: 'Comisia Europeană (DG TAXUD)',
    publication: null,
    urls: ['https://ec.europa.eu/assets/taxud/vow-information/swagger_publicVAT.yaml'],
    fetch: true,
    snapshots: [
      {
        url: 'https://ec.europa.eu/assets/taxud/vow-information/swagger_publicVAT.yaml',
        sha256: 'f8e15e184c009da31bcceb01be494aaf79cbb6b8f770c1ec680695eadd8848d5',
        retrievedOn: '2026-11-05',
        mediaType: 'text/yaml',
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
const located = (source: string, id: string, locator: string, summary: string): Clause => ({
  id: `${source}:${id}`,
  source,
  locator,
  status: 'located',
  summary,
});
const pending = (source: string, id: string, locator: string, summary: string): Clause => ({
  id: `${source}:${id}`,
  source,
  locator,
  status: 'pending',
  summary,
});

export const tradeClauses: readonly Clause[] = [
  // The Fiscal Code.
  fiscal(
    'art.268(3)-(4)',
    'art. 268 alin. (3) și (4)',
    'Achiziția intracomunitară de bunuri cu plată, cu locul în România (art. 276), efectuată de o persoană impozabilă, este operațiune impozabilă; excepția persoanelor cu operațiuni fără drept de deducere și a persoanelor juridice neimpozabile sub plafonul de 10.000 euro.',
  ),
  fiscal(
    'art.270^1',
    'art. 270^1',
    'Regimul stocurilor la dispoziția clientului: transferul bunurilor în alt stat membru pentru livrarea ulterioară către un client cunoscut nu este livrare cu plată în condițiile articolului, cu registrul și declarația recapitulativă ale lui.',
  ),
  fiscal(
    'art.273(1)',
    'art. 273 alin. (1)',
    'Achiziția intracomunitară de bunuri este obținerea dreptului de a dispune, ca proprietar, de bunuri mobile corporale expediate sau transportate către un stat membru, altul decât cel de plecare.',
  ),
  fiscal(
    'art.276(1),(5)',
    'art. 276 alin. (1) și (5)',
    'Locul achiziției intracomunitare este locul unde se găsesc bunurile la încheierea expedierii sau transportului; operațiunile triunghiulare au regulile alin. (5) și ale normelor.',
  ),
  fiscal(
    'art.283(1)',
    'art. 283 alin. (1)',
    'Pentru livrarea intracomunitară scutită (art. 294 alin. (2)), exigibilitatea intervine la emiterea facturii sau în a 15-a zi a lunii următoare celei a faptului generator, dacă nu s-a emis factură până atunci.',
  ),
  fiscal(
    'art.284(1)-(2)',
    'art. 284 alin. (1) și (2)',
    'Pentru achiziția intracomunitară, faptul generator intervine la data la care ar interveni pentru livrări similare în statul membru al achiziției; exigibilitatea intervine la data facturii (art. 222 din Directiva 112) sau, dacă nu s-a emis factură, în a 15-a zi a lunii următoare faptului generator.',
  ),
  fiscal(
    'art.285(1)-(2)',
    'art. 285 alin. (1) și (2)',
    'La import, faptul generator și exigibilitatea TVA intervin la data la care intervin pentru taxele vamale (sau ar interveni, dacă bunurile nu le datorează).',
  ),
  fiscal(
    'art.289(1)-(2)',
    'art. 289 alin. (1) și (2)',
    'Baza de impozitare a importului este valoarea în vamă, plus taxele, impozitele și comisioanele datorate în afara României și ca urmare a importului (fără TVA), plus cheltuielile accesorii (comisioane, ambalare, transport, asigurare) până la primul loc de destinație din România.',
  ),
  fiscal(
    'art.290(1)',
    'art. 290 alin. (1)',
    'Pentru import, cursul de schimb al elementelor bazei exprimate în valută este cel al prevederilor europene privind valoarea în vamă.',
  ),
  fiscal(
    'art.294(2^1)',
    'art. 294 alin. (2^1)',
    'Scutirea livrării intracomunitare nu se aplică furnizorului care nu a depus declarația recapitulativă (art. 325) sau a declarat-o incorect, cu excepția cazului în care justifică deficiența.',
  ),
  fiscal(
    'art.299(1)(c)-(e)',
    'art. 299 alin. (1) lit. c)–e)',
    'Deducerea TVA de import plătite cere declarația vamală de import, cu persoana impozabilă ca importator, și dovada plății; a celei datorate cu amânare (art. 326 alin. (4)–(5)), declarația vamală și înscrierea ca taxă colectată în decont; a achiziției intracomunitare, factura.',
  ),
  fiscal(
    'art.307(4)',
    'art. 307 alin. (4)',
    'În operațiunea triunghiulară, taxa este datorată de beneficiarul livrării ulterioare înregistrat în România, desemnat de cumpărătorul revânzător înregistrat în alt stat membru.',
  ),
  fiscal(
    'art.326(2)-(5)',
    'art. 326 alin. (2)–(5)',
    'Persoana înregistrată evidențiază în decont, ca taxă colectată și deductibilă, taxa achizițiilor intracomunitare și a operațiunilor cu taxare inversă; TVA de import se plătește în vamă, cu excepția importurilor cu certificat de amânare (lit. a), a vămuirii centralizate (lit. b), a înscrierii în evidențele declarantului (lit. c) și a bunurilor art. 331 (lit. d)), înscrise în decont ca taxă colectată și deductibilă.',
  ),
  // OMFP nr. 103/2016 (the text of MO 106/2016).
  located(
    'OMFP103/2016',
    'art.1(4)',
    'anexa, art. 1 alin. (4)–(7)',
    'Documentele de justificare a scutirii care nu pot exista la faptul generator se prezintă în cel mult 90 de zile calendaristice de la acesta; după termen, la inspecție, taxa se colectează de la faptul generator.',
  ),
  located(
    'OMFP103/2016',
    'art.2(2)',
    'anexa, art. 2 alin. (2)',
    'Exportul de bunuri se justifică cu factura și cu certificarea încheierii operațiunii de export de către biroul vamal de export (sau notificarea de export certificată, pentru declarația electronică), ori cu exemplarul 3 al DAU certificat de biroul vamal de ieșire.',
  ),
  located(
    'OMFP103/2016',
    'art.10(1),(7)',
    'anexa, art. 10 alin. (1) și (7)',
    'Livrarea intracomunitară se justifică cu factura care menționează codul de TVA al cumpărătorului din alt stat membru, cu documentul care atestă transportul din România în alt stat membru și, după caz, cu alte documente (contract, comandă, asigurare); documentele de transport atestă în mod neechivoc transportul de către furnizor, beneficiar sau o persoană care acționează în numele lor.',
  ),
  located(
    'OMFP103/2016',
    'art.10(6)',
    'anexa, art. 10 alin. (6)',
    'Scutirea nu se refuză pentru simplul motiv că statul membru al cumpărătorului i-a radiat retroactiv codul de TVA de la o dată anterioară livrării (C-273/11, Mecsek Gabona).',
  ),
  // Regulation (EU) No 282/2011.
  located(
    'REG282/2011-A',
    'art.45a',
    'art. 45a alin. (1)–(3)',
    'Bunurile se prezumă expediate în alt stat membru când vânzătorul le-a transportat (el sau un terț în numele lui) și deține două dovezi necontradictorii din lit. (a) (CMR semnat, conosament, factură de transport aerian, factura transportatorului) sau una din lit. (a) cu una din lit. (b) (asigurarea transportului, documente bancare de plată a transportului, documente oficiale ale unei autorități, chitanța antrepozitarului), emise de două părți independente de vânzător, de cumpărător și între ele; sau când cumpărătorul le-a transportat, cu aceleași dovezi și declarația scrisă a cumpărătorului, primită cel târziu în a zecea zi a lunii următoare livrării; autoritatea fiscală poate respinge prezumția.',
  ),
  // OPANAF nr. 174/2026: the D300 rows of goods across the border.
  located(
    'OPANAF174/2026',
    'rd.5-6',
    'anexa nr. 2, instrucțiunile rândurilor 5 și 6, cu nota **',
    'Rândul 5 cuprinde baza și TVA achizițiilor intracomunitare de bunuri taxabile în România (și ale beneficiarului din operațiunea triunghiulară, art. 307 alin. (4)) cu exigibilitatea în perioadă; rândul 5.1 pe cele de la furnizori înregistrați în statul de livrare; rândul 6 regularizările; exigibilitatea achiziției este la data facturii emise după legislația celuilalt stat membru, a autofacturii sau în a 15-a zi a lunii următoare faptului generator.',
  ),
  located(
    'OPANAF174/2026',
    'rd.7',
    'anexa nr. 2, instrucțiunile rândului 7',
    'Rândul 7 cuprinde baza și TVA achizițiilor pentru care beneficiarul este obligat la plata taxei (art. 307 alin. (2)–(6)) și ale importurilor de bunuri cu art. 326 alin. (4) și (5), cu exigibilitatea în perioadă.',
  ),
  located(
    'OPANAF174/2026',
    'rd.20-22',
    'anexa nr. 2, instrucțiunile rândurilor 20–22',
    'Rândurile 20, 20.1, 21 și 22 cuprind aceleași informații ca rândurile 5, 5.1, 6 și 7: taxa autolichidată este și deductibilă.',
  ),
  located(
    'OPANAF174/2026',
    'rd.24-25',
    'anexa nr. 2, instrucțiunile rândurilor 24 și 25',
    'Rândurile 24 (21%) și 25 (11%) cuprind, pe lângă achizițiile din țară, baza și TVA importurilor care nu se încadrează în art. 326 alin. (4) și (5), cu exigibilitatea în perioadă.',
  ),
  located(
    'OMFP1802/2014',
    'conturi.446',
    'anexa, funcțiunea contului 446 „Alte impozite, taxe și vărsăminte asimilate”',
    'Contul 446 se creditează cu taxele vamale aferente aprovizionărilor din import (213, 214, 301, 302, 303, 371, 381) și se debitează cu plățile la bugetul statului (512).',
  ),
  located(
    'ANAF/D406',
    'Achizitii.AIC-import',
    'RO_SAFT_SchemaDefCod_16.02.2026.xlsx, foile Achizitii ded 100% și Achizitii neded, codurile 3002xx, 3006xx, 3012xx (cu 3502xx, 3506xx, 3512xx)',
    'Achizițiile intracomunitare de bunuri de la furnizori înregistrați în statul de livrare (300204 la 21%, 300205 la 11%, 300201 la 19%; D300 5/5.1/20/20.1), importurile cu TVA supusă măsurilor de simplificare (300604, 300605, 300601; D300 7/22) și importurile cu TVA plătită în vamă (301204, 301205, 301201; D300 24/25); cele nedeductibile pe foaia Achizitii neded (35xxxx).',
  ),
  // INS: Intrastat.
  located(
    'INS/Intrastat',
    'praguri.2026',
    'Ordinul președintelui INS nr. 1.604/2025, art. 1–3',
    'Pragurile Intrastat pentru anul de referință 2026 sunt 1.000.000 lei pentru expedieri și 1.000.000 lei pentru introduceri; operatorii care au depășit în 2025 pragurile pentru 2025 declară din ianuarie 2026; cei care le depășesc în 2026 declară din luna în care valoarea cumulată de la începutul anului depășește pragul, separat pe fluxuri.',
  ),
  located(
    'INS/Intrastat',
    'praguri.2025',
    'Ordinul președintelui INS nr. 2.353/2024, art. 1–3',
    'Pragurile Intrastat pentru anul de referință 2025 sunt 1.000.000 lei pentru expedieri și 1.000.000 lei pentru introduceri, cu aceleași reguli pentru anul anterior și pentru depășirea în cursul anului.',
  ),
  located(
    'INS/Intrastat',
    'norme.obligati',
    'Ordinul președintelui INS nr. 1.623/2022, anexa: furnizorii de date și modalitățile de transmitere',
    'Declarația statistică Intrastat o depun operatorii înregistrați în scopuri de TVA cu schimburi intra-UE de bunuri peste pragul anual, separat pentru introduceri și expedieri; numai electronic, prin aplicația online, aplicația offline sau un fișier XML în formatul predefinit al INS; cuprinde pe linii codul NC8, țara parteneră, natura tranzacției, termenii de livrare, modul de transport, valoarea facturată și statistică, masa netă și unitățile suplimentare.',
  ),
  located(
    'INS/Intrastat',
    'termen',
    'pagina „Declarația Intrastat” (www.intrastat.ro/di2.php)',
    'Termenul-limită de transmitere a datelor Intrastat la INS este întotdeauna data de 15 a lunii următoare celei de referință.',
  ),
  located(
    'INS/Intrastat',
    'xml',
    'Ghidul de implementare pentru fișierul XML de transmitere a declarației Intrastat (2026), schema intrastat4.xsd',
    'Formatul XML predefinit al INS (spațiul de nume http://www.intrastat.ro/xml/InsSchema): declarații noi, revizuite și nule pentru introduceri și expedieri, cu antetul (cod fiscal, perioada, persoana de contact, versiunile nomenclatoarelor) și liniile (NC8, valori, masă netă, natura tranzacției, termeni de livrare, mod de transport, unități suplimentare, țări).',
  ),
  // OUG nr. 41/2022 (RO e-Transport), its 2022 text.
  located(
    'OUG41/2022',
    'art.2',
    'art. 2 pct. 2, 9–12',
    'Transportul de bunuri cu risc fiscal ridicat este cel al bunurilor stabilite prin ordin al președintelui ANAF; transportul pe teritoriul național cuprinde, între altele, bunurile din achiziții intracomunitare de la frontieră la descărcare, din livrări intracomunitare de la încărcare la frontieră, din import de la locul importului și din export până la biroul vamal; codul UIT identifică bunurile fiecărei relații comerciale și însoțește transportul.',
  ),
  located(
    'OUG41/2022',
    'art.8',
    'art. 8 alin. (1)–(2)',
    'Declară în RO e-Transport destinatarul din declarația vamală de import, expeditorul din cea de export, beneficiarul din România al achiziției intracomunitare și furnizorul din România al livrării intracomunitare sau interne; codul UIT se dă transportatorului până la intrarea în țară, la locul importului sau la punerea în mișcare a vehiculului și se înscrie pe documentul de transport.',
  ),
  located(
    'OUG41/2022',
    'art.11',
    'art. 11 alin. (1)–(3)',
    'Datele se declară cu cel mult 3 zile calendaristice înainte de data declarată pentru începerea transportului, dar până la intrarea în țară, la locul importului sau la punerea în mișcare a vehiculului; codul UIT este valabil 5 zile calendaristice de la data declarată; datele nu se modifică după începerea transportului.',
  ),
  pending(
    'OUG41/2022',
    'consolidat',
    'forma consolidată a ordonanței (portalul legislativ) și ordinele președintelui ANAF privind bunurile cu risc fiscal ridicat (art. 15)',
    'Modificările ulterioare ale ordonanței (transporturile internaționale, valabilitatea codului UIT, sancțiunile) și lista bunurilor cu risc fiscal ridicat nu au fost citite: forma consolidată se descarcă de proprietar.',
  ),
  // VIES.
  located(
    'EC/VIES',
    'checkVatNumber',
    'swagger_publicVAT.yaml, operația checkVatNumber și CheckVatResponse',
    'Serviciul checkVatNumber primește țara și codul de TVA (și, opțional, codul solicitantului, pentru un număr de consultare) și răspunde cu data cererii, valabilitatea codului, denumirea și adresa înregistrate și identificatorul cererii.',
  ),
];
