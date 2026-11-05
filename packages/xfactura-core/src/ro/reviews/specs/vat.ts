import type { ParameterRegister } from '../../../rules';
import type { ReviewCase, ReviewSpec } from '../types';
import {
  purchaseInvoice,
  recognizePurchase,
  recognizeSale,
  saleInvoice,
  vehicleAnswerRecord,
} from './world';

/*
 * Readings from the clauses as ANAF's consolidated Fiscal Code gives them (snapshot
 * ANAF/Cod-fiscal-consolidat, sha256 aba0c753…): art. 281 alin. (1), (8) and (12), art. 282
 * alin. (1) and (2), art. 291 alin. (1), (2) and (4)–(6), the norms' pct. 24 alin. (6), and Legea
 * nr. 141/2025 art. III as reproduced under art. 291; ANAF's D300 v12.0.0 rows 9–11 and the ANAF
 * Ploiești note on the 2025 rates.
 */

const FACTS =
  'Companie înregistrată în scopuri de TVA (regim normal, perioadă fiscală lunară), care facturează servicii unui client din România; baza 1.000,00 lei.';

/** A sale invoiced on `issued`, stating its supply date (BT-72) or invoiced period (BG-14). */
function saleCase(options: {
  title: string;
  facts: string;
  issued: string;
  rate: string;
  taxPoint?: string;
  delivery?: string;
  period?: { start: string; end: string };
}): ReviewCase {
  const body = (deliveryDate: string | undefined) =>
    saleInvoice({
      issueDate: options.issued,
      ...(options.taxPoint ? { taxPointDate: options.taxPoint } : {}),
      ...(deliveryDate ? { deliveryDate } : {}),
      ...(options.period ? { invoicePeriod: options.period } : {}),
      net: '1000.00',
      rate: options.rate,
    });
  // The alternative: without BT-72, the end of the invoiced period, when before the issue date,
  // is the supply's date (art. 281 alin. (12)): the same treatment, given it as BT-72.
  const periodEnd =
    options.period && options.period.end < options.issued ? options.period.end : undefined;
  return {
    title: options.title,
    facts: `${FACTS} ${options.facts}`,
    run: (register: ParameterRegister) => ({
      engine: recognizeSale(register, body(options.delivery)),
      alternative: recognizeSale(register, body(options.delivery ?? periodEnd)),
    }),
  };
}

export const vatRateSpec: ReviewSpec = {
  key: 'ro.vat.rate',
  kind: 'interpretation',
  act: 'ANAF/Cod-fiscal-consolidat',
  minutes: 25,
  readings: {
    engine:
      'Cota TVA și exigibilitatea, deci și perioada TVA, sunt cele de la data faptului generator, pe care factura o înscrie ca dată a livrării (BT-72), afară de cazul în care factura sau avansul înscris ca dată a exigibilității (BT-7) sunt anterioare (art. 282 alin. (1)–(2), art. 291 alin. (4)); fără BT-72 țin locul ei data exigibilității înscrisă (BT-7) sau data emiterii, iar dacă cota standard s-a schimbat din prima zi a lunii anterioare emiterii, persoana care aprobă confirmă data livrării. Perioada facturată (BG-14) nu este folosită.',
    alternative:
      'Fără BT-72, sfârșitul perioadei facturate (BG-14), dacă este înaintea emiterii, este data faptului generator pentru un serviciu încheiat la acea dată (art. 281 alin. (12)): cota și exigibilitatea se citesc la ea.',
  },
  question:
    'La o factură fără data livrării (BT-72), care înscrie perioada facturată (BG-14) încheiată înainte de emitere, se poate lua sfârșitul perioadei ca dată a faptului generator, pentru cotă și pentru perioada TVA?',
  context: [
    'ANAF/Cod-fiscal-consolidat:art.291(4)-(6)',
    'ANAF/Cod-fiscal-consolidat:art.281(1)',
    'ANAF/Cod-fiscal-consolidat:art.281(8)',
    'ANAF/Cod-fiscal-consolidat:art.281(12)',
    'ANAF/Cod-fiscal-consolidat:art.282(1)',
    'ANAF/Cod-fiscal-consolidat:art.282(2)',
  ],
  cases: [
    saleCase({
      title: 'Prestare în iulie, factură în august cu data prestării (BT-72), cu 19%',
      facts:
        'Serviciul este prestat pe 28.07.2025; factura emisă pe 05.08.2025 înscrie data prestării 28.07.2025 (BT-72) și cota de 19%.',
      issued: '2025-08-05',
      delivery: '2025-07-28',
      rate: '19',
    }),
    saleCase({
      title: 'Prestare în iulie, factură în august fără BT-72, cu 19%',
      facts:
        'Serviciul este prestat pe 28.07.2025; factura este emisă pe 05.08.2025, fără data prestării (BT-72) și fără data exigibilității (BT-7), cu 19%.',
      issued: '2025-08-05',
      rate: '19',
    }),
    saleCase({
      title: 'Prestare în iulie, factură în august fără BT-72, cu 21%',
      facts:
        'Serviciul este prestat pe 28.07.2025; factura este emisă pe 05.08.2025, fără BT-72 și fără BT-7, cu 21%.',
      issued: '2025-08-05',
      rate: '21',
    }),
    saleCase({
      title: 'Perioada iulie facturată în august (BG-14), fără BT-72, cu 19%',
      facts:
        'Un serviciu prestat între 01.07.2025 și 31.07.2025, încheiat la sfârșitul lunii (nu o prestare continuă cu termene de plată în contract), este facturat pe 05.08.2025 cu perioada 01.07–31.07.2025 (BG-14), fără BT-72, cu 19%.',
      issued: '2025-08-05',
      period: { start: '2025-07-01', end: '2025-07-31' },
      rate: '19',
    }),
    saleCase({
      title: 'Factură emisă înainte de prestare (art. 282 alin. (2) lit. a))',
      facts:
        'Factura este emisă pe 25.07.2025, cu 19%, pentru un serviciu prestat pe 10.08.2025, data pe care o înscrie ca dată a prestării (BT-72). Factura de regularizare de la art. 291 alin. (6), la data prestării, nu este calculată în niciuna dintre lecturi.',
      issued: '2025-07-25',
      delivery: '2025-08-10',
      rate: '19',
    }),
  ],
  gaps: [
    'Regularizarea de la art. 291 alin. (6) (factură sau avans înainte de livrare, cu schimbarea cotei până la livrare) este doar semnalată (RATE_REGULARIZATION), nu calculată. Factura finală care stornează după 01.08.2025 un avans facturat cu 19% se blochează (VAT_RATE): motorul nu citește încă cota avansului pe care îl regularizează.',
    'Motorul nu are o cale de a primi data livrării când factura nu o înscrie: o factură emisă în august cu 19% pentru o livrare din iulie, fără BT-72, rămâne blocată până la o factură care o înscrie.',
    'Fără BT-72, o dată a exigibilității (BT-7) ulterioară emiterii este luată cum o înscrie factura, deși art. 282 alin. (2) lit. a) ar pune exigibilitatea la emitere; cu BT-72, motorul ia data cea mai veche și cere confirmarea (TAX_POINT_DATES).',
    'Versiunea de 19% (01.01.2024–31.07.2025) se sprijină doar pe materialul ANAF Ploiești („de la 19% la 21%”): forma art. 291 în vigoare înainte de 01.08.2025 nu este în .sources/, iar textul consolidat ANAF arată doar forma actuală.',
    'Textul Legii nr. 141/2025 nu are snapshot înregistrat; o copie există în .sources/pfa-research/, neînregistrată. Data de 01.08.2025 se sprijină pe textul consolidat ANAF (nota de sub art. 291) și pe materialul ANAF Ploiești.',
    'Cazurile folosesc doar categoria S; versiunea categoriei O (0%, neplătitori) este citată din ghidul ANAF al codurilor e-Factura, fără caz separat.',
  ],
};

/** A sale at a rate other than the standard one, on `date`, with the reduced rate it admits. */
function reducedCase(options: {
  title: string;
  facts: string;
  date: string;
  rate: string;
  net?: string;
  /** The alternative admits 9% for the housing of Legea nr. 141/2025 art. III on this date. */
  housing: boolean;
}): ReviewCase {
  const body = () =>
    saleInvoice({ issueDate: options.date, net: options.net ?? '1000.00', rate: options.rate });
  return {
    title: options.title,
    facts: options.facts,
    run: (register: ParameterRegister) => ({
      engine: recognizeSale(register, body()),
      // The same treatment, with the reduced rate in force on the date read as 9% for a delivery
      // art. III covers: what admitting the transitional rate would let through.
      alternative: recognizeSale(
        options.housing
          ? register.withVersions(
              register.versions.map((version) =>
                version.key === 'ro.vat.rate.reduced' &&
                version.from <= options.date &&
                (version.to === null || options.date <= version.to)
                  ? { ...version, value: '9' }
                  : version,
              ),
            )
          : register,
        body(),
      ),
    }),
  };
}

export const vatReducedRateSpec: ReviewSpec = {
  key: 'ro.vat.rate.reduced',
  kind: 'mechanical',
  act: 'ANAF/Cod-fiscal-consolidat',
  minutes: 8,
  readings: {
    engine:
      'De la 01.08.2025 singura cotă redusă admisă este 11% (art. 291 alin. (2)): o factură cu altă cotă decât 21% sau 11% se blochează, iar 11% cere confirmarea că operațiunea este una dintre cele de la art. 291 alin. (2).',
    alternative:
      'Între 01.08.2025 și 31.07.2026 parametrul admite, pe lângă 11%, și cota de 9% pentru livrările de locuințe de la art. III din Legea nr. 141/2025 (rândul 11 din D300).',
  },
  question:
    'Este 11% (de la 01.08.2025) singura cotă redusă pe care parametrul trebuie să o admită, cota de 9% pentru locuințe rămânând un caz tratat separat?',
  context: [
    'ANAF/Cod-fiscal-consolidat:L141/2025.art.III',
    'ANAF/D300-12.0.0:rd.11',
    'ANAF/Cod-fiscal-consolidat:art.291(2)(e)-(f)',
    'OMFP1155/2016:art.1(1)-(2)',
    'OMFP1155/2016:anexa',
  ],
  cases: [
    reducedCase({
      title: 'Livrare de alimente cu 11%',
      facts:
        'Companie plătitoare de TVA; livrare de alimente pe 15.09.2025, baza 1.000,00 lei, cu 11%.',
      date: '2025-09-15',
      rate: '11',
      housing: false,
    }),
    reducedCase({
      title: 'Locuință cu 9%, în fereastra art. III',
      facts:
        'Companie plătitoare de TVA; livrarea pe 10.03.2026 a unei locuințe către o persoană fizică care îndeplinește condițiile art. III alin. (1) din Legea nr. 141/2025 (act de avans încheiat până la 01.08.2025), baza 500.000,00 lei, cu 9%.',
      date: '2026-03-10',
      rate: '9',
      net: '500000.00',
      housing: true,
    }),
    reducedCase({
      title: 'Locuință cu 9%, după 31.07.2026',
      facts:
        'Aceeași livrare, făcută pe 15.08.2026, după fereastra art. III (1 august 2025 – 31 iulie 2026), cu 9%.',
      date: '2026-08-15',
      rate: '9',
      net: '500000.00',
      housing: false,
    }),
    reducedCase({
      title: 'Alimente cu 9% înainte de 01.08.2025',
      facts:
        'Livrare de alimente pe 20.07.2025, cu 9%: registrul nu are cotă redusă înainte de 01.08.2025.',
      date: '2025-07-20',
      rate: '9',
      housing: false,
    }),
  ],
  gaps: [
    'Cotele reduse de 9% și 5% în vigoare înainte de 01.08.2025 nu sunt în registru: forma art. 291 alin. (2) de dinainte nu este în .sources/ (textul consolidat ANAF arată doar forma actuală); facturile cu cotă redusă de dinainte se blochează.',
    'Motorul nu clasifică operațiunile cărora li se aplică cota redusă: confirmarea REDUCED_RATE rămâne la persoana care aprobă.',
    'Inputurile și serviciile agricole de la art. 291 alin. (2) lit. e) și f) sunt cele „prevăzute prin ordin comun”: în registru este Ordinul nr. 1.155/868/2016 (codurile NC ale îngrășămintelor, pesticidelor și semințelor și cele 34 de servicii din anexă), emis pentru fosta lit. h), cu cota de 9%; dacă un ordin comun mai nou, emis după Legea nr. 141/2025, înlocuiește lista sau separă îngrășămintele și pesticidele chimice (lit. f), până la 31.12.2031) nu este verificat. Normele (pct. 87^1 alin. (3)) citează aceeași anexă pentru serviciile agricole ale regimului forfetar.',
    'Cota de 9% pentru clădirile livrate primăriilor (art. III alin. (4) din Legea nr. 141/2025) nu are caz separat.',
  ],
};

/*
 * Art. 298 alin. (1)–(4) and the norms' pct. 68 alin. (1)–(5) and (7), as ANAF's consolidated
 * Fiscal Code gives them (snapshot ANAF/Cod-fiscal-consolidat).
 */

const LOG = '00000000-0000-4000-8000-0000000000e3';
const CERTIFICATE = '00000000-0000-4000-8000-0000000000e4';
const PURCHASE =
  'Companie înregistrată în scopuri de TVA (regim normal, perioadă fiscală lunară), care cumpără de la un furnizor din România, cu 21%.';

/** A purchase about a vehicle, the same under both readings unless `alternative` books it
 * otherwise. */
function vehicleCase(options: {
  title: string;
  facts: string;
  description: string;
  net: string;
  input: Record<string, unknown>;
  answers?: Parameters<typeof vehicleAnswerRecord>[];
  alternative?: Record<string, unknown>;
}): ReviewCase {
  const body = () =>
    purchaseInvoice({
      issueDate: '2026-10-05',
      net: options.net,
      rate: '21',
      description: options.description,
    });
  const answers = (options.answers ?? []).map((args) => vehicleAnswerRecord(...args));
  return {
    title: options.title,
    facts: `${PURCHASE} ${options.facts}`,
    run: (register: ParameterRegister) => ({
      engine: recognizePurchase(register, body(), options.input, answers),
      alternative: recognizePurchase(
        register,
        body(),
        options.alternative ?? options.input,
        answers,
      ),
    }),
  };
}

export const vatDeductionLimitedSpec: ReviewSpec = {
  key: 'ro.vat.deduction.limited',
  kind: 'interpretation',
  act: 'ANAF/Cod-fiscal-consolidat',
  minutes: 15,
  readings: {
    engine:
      'Limitarea la 50% se aplică pe vehicul: partea unei achiziții care numește un vehicul rutier motorizat (cumpărarea, leasingul sau închirierea lui, combustibilul, reparațiile, întreținerea, piesele) deduce după răspunsul proprietarului despre folosirea lui la data exigibilității: integral dacă este folosit exclusiv în scopul activității economice, cu foaia de parcurs, ori dacă art. 298 alin. (2) sau alin. (3) lit. b)–f) îl exceptează; altfel 50% din TVA a părții, rotunjit la ban. O cheltuială nedefalcată pe vehicule, ca factura cardului de combustibil pentru mai multe autoturisme folosite și personal, se înregistrează tot limitat, cu confirmare.',
    alternative:
      'O cheltuială care nu poate fi atribuită direct unui anumit vehicul (factura cardului de combustibil pentru mai multe autoturisme, nedefalcată) nu este o cheltuială legată de vehicule în sensul normelor (pct. 68 alin. (1) teza a doua): TVA se deduce integral, după regulile generale.',
  },
  question:
    'O factură de combustibil pentru mai multe autoturisme folosite și în scop personal, care nu poate fi defalcată pe vehicule, se deduce limitat la 50% sau integral, ca o cheltuială pe care normele (pct. 68 alin. (1)) nu o socotesc legată de un anumit vehicul?',
  context: ['ANAF/Cod-fiscal-consolidat:norme.art.298.pct.68'],
  cases: [
    vehicleCase({
      title: 'Leasing operațional pentru un autoturism folosit și personal',
      facts:
        'Rata de leasing operațional din octombrie 2026 pentru autoturismul B-123-XFA, 1.500,00 lei plus TVA, pe 612; proprietarul a răspuns că autoturismul este folosit și în scop personal din 01.01.2026.',
      description: 'Rată leasing operațional autoturism B-123-XFA, octombrie 2026',
      net: '1500.00',
      input: { account: '612', deduction: 'limited', vehicle: 'B-123-XFA' },
      answers: [['B-123-XFA', { use: 'mixed', from: '2026-01-01' }]],
    }),
    vehicleCase({
      title: 'Combustibil pentru un autoturism folosit exclusiv, cu foaia de parcurs',
      facts:
        'Motorină pentru autoturismul B-456-XFA, 500,00 lei plus TVA, pe 6022; proprietarul a răspuns că autoturismul este folosit exclusiv în scopul activității din 01.01.2026 și a atașat foaia de parcurs.',
      description: 'Motorină autoturism B-456-XFA',
      net: '500.00',
      input: { account: '6022', deduction: 'full', vehicle: 'B-456-XFA' },
      answers: [['B-456-XFA', { use: 'business_only', from: '2026-01-01', logEvidenceId: LOG }]],
    }),
    vehicleCase({
      title: 'Cardul de combustibil pentru trei autoturisme, nedefalcat',
      facts:
        'Factura lunară a cardului de combustibil, 1.200,00 lei plus TVA, pe 6022, pentru trei autoturisme folosite și în scop personal, fără defalcare pe vehicule.',
      description: 'Carburant card flotă, octombrie 2026',
      net: '1200.00',
      input: { account: '6022', deduction: 'limited' },
      alternative: { account: '6022', deduction: 'full' },
    }),
    vehicleCase({
      title: 'Autoutilitară de 7,5 t (alin. (2))',
      facts:
        'Cumpărarea autoutilitarei B-789-XFA, cu masa maximă autorizată de 7.500 kg, 100.000,00 lei plus TVA, pe 2133; folosită și în scop personal, după certificatul de înmatriculare peste 3.500 kg.',
      description: 'Autoutilitară 7,5 t B-789-XFA',
      net: '100000.00',
      input: { account: '2133', deduction: 'full', vehicle: 'B-789-XFA' },
      answers: [
        [
          'B-789-XFA',
          {
            use: 'mixed',
            from: '2026-10-01',
            exception: 'over_3500kg_or_9_seats',
            exceptionEvidenceId: CERTIFICATE,
          },
        ],
      ],
    }),
    vehicleCase({
      title: 'Autoturismul unui agent de vânzări (alin. (3) lit. b))',
      facts:
        'Reparația autoturismului B-321-XFA, 800,00 lei plus TVA, pe 611; autoturismul este folosit de un agent de vânzări al companiei, și în scop personal.',
      description: 'Reparație autoturism B-321-XFA',
      net: '800.00',
      input: { account: '611', deduction: 'full', vehicle: 'B-321-XFA' },
      answers: [
        [
          'B-321-XFA',
          {
            use: 'mixed',
            from: '2026-01-01',
            exception: 'sales_or_purchasing_agent',
            exceptionEvidenceId: CERTIFICATE,
          },
        ],
      ],
    }),
  ],
  gaps: [
    'Folosirea vehiculului se citește la data exigibilității facturii, din ultimul răspuns al proprietarului (valabil până la schimbare): un răspuns nou înlocuiește istoria, iar o propunere deschisă de dinainte de data lui se întreabă din nou.',
    'Ajustarea TVA deduse la cumpărarea unui vehicul (bun de capital) când folosirea lui se schimbă ulterior (art. 305) nu este calculată.',
    'Facturile de stornare (invoices.credit), avansurile pentru vehicule și bonurile de combustibil din deconturi nu citesc răspunsul: stornarea păstrează deducerea indicată, un avans cu vehicul se blochează, iar bonurile nu se deduc încă.',
    'Limitarea la 50% a cheltuielilor cu vehiculele la impozitul pe profit (art. 25 alin. (3) lit. l)) nu este aplicată de acest tratament.',
    'Transportul angajaților la și de la locul de muncă (pct. 68 alin. (3)) și limita de un vehicul pe agent de vânzări sau de achiziții (alin. (6) lit. b)–c)) rămân în răspunsul proprietarului; motorul nu le verifică.',
    'Limitarea se aplică taxei deductibile după regulile generale (pct. 68 alin. (4) teza finală); pro rata (art. 300) nu este calculată.',
    'O achiziție care sugerează un vehicul fără să-l numească (VEHICLE_UNNAMED) este doar semnalată: conturile 6022 și 2133 întotdeauna, 611, 612, 6024 și 167 când liniile facturii numesc un vehicul.',
  ],
};
