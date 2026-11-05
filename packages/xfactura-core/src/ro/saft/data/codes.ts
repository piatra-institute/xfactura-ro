// ANAF code lists for invoices, payments, units of measure and VAT regimes.
// Extracted from ANAF RO_SAFT_SchemaDefCod_05.02.2026.xlsx (sha256 d0981202182438e4597ff3bc27d2c41dec06c60bc32b86620c1de29a9cb8436d),
// sheets Nom_Tipuri_facturi (the six codes S.I.9 allows), Nom_Mecanisme_plati, Unitati_masura (a subset of common units), Nomenclator_Regim_fiscal
// and Nomenclator imobilizari.

/** InvoiceType: the codes the structure allows (S.I.9). */
export const invoiceTypes: Readonly<Record<string, string>> = {
  '380': 'Factură',
  '381': 'Notă de credit',
  '384': 'Factura corectată',
  '389': 'Autofactură',
  '575': 'Factura asigurătorului',
  '751': 'Factură - informații în scopuri contabile',
};

/** PaymentMechanism and the PaymentMethod it corresponds to (01 cash, 02 offset, 03 non-cash,
 * 98 mutually defined, 99 undefined). */
export const paymentMechanisms: Readonly<Record<string, { method: string; description: string }>> =
  {
    '1': { method: '99', description: 'Instrument nedefinit' },
    '2': { method: '03', description: 'Credit prin casa automată de compensare (ACH)' },
    '3': { method: '03', description: 'Debit prin casa automată de compensare (ACH)' },
    '4': {
      method: '03',
      description:
        'Cerere pentru inversarea debitului transmis la casa automată de compensare (ACH)',
    },
    '5': {
      method: '03',
      description:
        'Cerere pentru inversarea creditului transmis la casa automată de compensare (ACH)',
    },
    '6': { method: '03', description: 'Cerere de credit prin casa automată de compensare (ACH)' },
    '7': { method: '03', description: 'Cerere de debit prin casa automată de compensare (ACH)' },
    '8': { method: '03', description: 'Sumă reținută (Reținere)' },
    '9': { method: '03', description: 'Compensare națională sau regională' },
    '10': { method: '01', description: 'În numerar' },
    '11': { method: '03', description: 'Inversarea creditului de economii transmis la ACH' },
    '12': { method: '03', description: 'Inversarea debitului de economii transmis la ACH' },
    '13': { method: '03', description: 'Credit de economii transmis către ACH' },
    '14': { method: '03', description: 'Debit de economii transmis către ACH' },
    '15': { method: '03', description: 'Înregistrare de credit' },
    '16': { method: '03', description: 'Înregistrare de debit' },
    '17': { method: '03', description: 'Creditul de concentrare/despăgubire (CCD) la cererea ACH' },
    '18': {
      method: '03',
      description: 'Concentrarea/decontarea cererii de numerar ACH (CCD) debit',
    },
    '19': {
      method: '03',
      description: 'ACH solicită credite pentru plata comerțului corporativ (CTP)',
    },
    '20': { method: '03', description: 'Cec' },
    '21': { method: '03', description: 'Bilet la ordin' },
    '22': { method: '03', description: 'Bilet la ordin avalizat' },
    '23': { method: '03', description: 'Cec bancar (emis de o bancă sau de o unitate similară)' },
    '24': { method: '03', description: 'Scrisoare de schimb în așteptarea acceptării' },
    '25': { method: '03', description: 'Cec certificat' },
    '26': { method: '03', description: 'Cec local' },
    '27': {
      method: '02',
      description: 'Solicitare la ACH pentru plata comerțului corporativ (CTP) debit',
    },
    '28': {
      method: '02',
      description: 'Solicitare la ACH pentru credite de schimb comercial corporativ (CTX)',
    },
    '29': {
      method: '02',
      description: 'Solicitare la ACH pentru debitarea schimburilor comerciale corporative (CTX)',
    },
    '30': { method: '03', description: 'Transfer de credit' },
    '31': { method: '03', description: 'Transfer de debit' },
    '32': { method: '02', description: 'Concentrarea/plata cererii de numerar ACH plus (CCD+)' },
    '33': { method: '02', description: 'Concentrarea/plata cererii de numerar ACH plus (CCD+)' },
    '34': { method: '02', description: 'Plăți și depozit prestabilite ACH (PPD)' },
    '35': {
      method: '02',
      description: 'Creditul de concentrare/despăgubire a economiilor ACH (CCD)',
    },
    '36': { method: '02', description: 'Concentrarea/decontarea (CCD) a economiilor ACH' },
    '37': {
      method: '02',
      description: 'Credit ACH pentru plata comerțului cu societăți de economii (CTP)',
    },
    '38': {
      method: '02',
      description: 'Debit ACH pentru economii plăți comerciale corporative (CTP)',
    },
    '39': {
      method: '02',
      description: 'Credit ACH de schimb comercial cu societăți de economii (CTX)',
    },
    '40': { method: '02', description: 'Debit ACH de schimb cu societăți de economii (CTX)' },
    '41': {
      method: '02',
      description: 'Concentrarea/plata în numerar a sumelor din economii prin ACH plus (CCD+)',
    },
    '42': { method: '03', description: 'Plata în contul bancar' },
    '43': {
      method: '02',
      description: 'Concentrarea/plata în numerar a economiilor înregistrate în ACH plus (CCD+)',
    },
    '44': { method: '03', description: 'Scrisoare de schimb (Cambie) acceptată' },
    '45': { method: '03', description: 'Transfer de credit prin facilitatea de Home Banking' },
    '46': { method: '03', description: 'Transfer interbancar de debit' },
    '47': { method: '03', description: 'Transfer de debit prin facilitatea de Home Banking' },
    '48': { method: '03', description: 'Card bancar' },
    '49': { method: '03', description: 'Debitare directă' },
    '50': { method: '03', description: 'Plata prin Postgiro' },
    '51': {
      method: '03',
      description:
        'Plată prin compensare la distanță conform norma 6 97 CFONB (Organizația franceză pentru standarde bancare)',
    },
    '52': { method: '03', description: 'Plată comercială rapidă' },
    '53': { method: '03', description: 'Plată rapidă din Trezorerie' },
    '54': { method: '03', description: 'Card de credit' },
    '55': { method: '03', description: 'Card de debit' },
    '56': { method: '03', description: 'BankGiro' },
    '57': { method: '03', description: 'Acord permanent' },
    '58': { method: '02', description: 'Transferul de credit SEPA' },
    '59': { method: '02', description: 'Debitare directă SEPA' },
    '60': { method: '03', description: 'Bilet la ordin' },
    '61': { method: '03', description: 'Bilet la ordin semnat de debitor' },
    '62': { method: '03', description: 'Bilet la ordin semnat de debitor și aprobat de o bancă' },
    '63': {
      method: '03',
      description: 'Bilet la ordin semnat de debitor și aprobat de o terță parte',
    },
    '64': { method: '03', description: 'Bilet la ordin semnat de o bancă' },
    '65': {
      method: '03',
      description: 'Bilet la ordin semnat de o bancă și aprobat de o altă bancă',
    },
    '66': { method: '03', description: 'Bilet la ordin semnat de un terț' },
    '67': { method: '03', description: 'Bilet la ordin semnat de un terț și aprobat de o bancă' },
    '68': { method: '03', description: 'Serviciul de plată online' },
    '69': { method: '03', description: 'Consiliere de transfer' },
    '70': {
      method: '03',
      description: 'Scrisoare de schimb întocmită de creditor cu privire la debitor',
    },
    '74': { method: '03', description: 'Scrisoare de schimb întocmită de creditor pentru o bancă' },
    '75': {
      method: '03',
      description: 'Scrisoare de schimb elaborată de creditor, aprobată de o altă bancă',
    },
    '76': {
      method: '03',
      description:
        'Scrisoare de schimb elaborată de creditor pentru o bancă și aprobat de o terță parte',
    },
    '77': {
      method: '03',
      description: 'Scrisoare de schimb întocmită de creditor pentru o terță parte',
    },
    '78': {
      method: '03',
      description:
        'Scrisoare de schimb întocmită de creditor pentru o terță parte, acceptat și aprobată de o bancă',
    },
    '91': { method: '03', description: 'Bilet la ordin netransferabil' },
    '92': { method: '03', description: 'Cec local netransferabil' },
    '93': { method: '03', description: 'Referința Giro' },
    '94': { method: '03', description: 'Giro rapid' },
    '95': { method: '03', description: 'Giro format liber - care nu este prestabilit' },
    '96': { method: '03', description: 'Metoda solicitată de plată nu a fost utilizată' },
    '97': { method: '03', description: 'Compensarea între parteneri' },
    ZZZ: { method: '98', description: 'Definit de comun acord' },
  };

/** UnitOfMeasure: common units of UN/ECE recommendations 20 and 21, with their Romanian names. */
export const units: Readonly<Record<string, string>> = {
  H87: 'bucată',
  C62: 'one',
  E48: 'unitate de service',
  HUR: 'oră',
  DAY: 'zi',
  WEE: 'săptămână',
  MON: 'lună',
  ANN: 'an',
  MIN: 'minut [unitate de timp]',
  KGM: 'kilogram',
  GRM: 'gram',
  TNE: 'tonă (tonă metrică)',
  LTR: 'litru',
  MTR: 'metru',
  KMT: 'kilometru',
  MTK: 'metru pătrat',
  MTQ: 'metru cub',
  KWH: 'kilowatt oră',
  SET: 'set',
  PR: 'pereche',
  LS: 'sumă forfetară',
  ACT: 'activitate',
  EA: 'fiecare',
  NAR: 'număr de articole',
  XPP: 'Bucată',
  XBX: 'Cutie',
  XPK: 'Pachet',
};

/** TaxType of TaxIDStructure: the VAT regime of the company. */
export const vatRegimes: Readonly<Record<string, string>> = {
  '100010': 'Persoană impozabilă înregistrată în scopuri de TVA',
  '100020': 'Persoană impozabilă ce aplică regimul special de scutire pentru întreprinderile mici',
  '100030':
    'Persoană impozabilă ce are codul de TVA anulat ex-oficio, în baza art. 316 alin. (11) din Legea 227/2015 privind Codul Fiscal',
  '100040':
    'Persoană impozabilă înregistrată în scopuri de TVA, ce aplică sistemul de TVA la încasare',
  '100050': 'Persoană neimpozabilă',
};

/** AssetTransactionType (SD.AT.5): the asset movements of sheet Nomenclator imobilizari; any other
 * value is a fatal error that rejects the file. */
export const assetTransactionTypes: Readonly<Record<string, string>> = {
  '10': 'Achiziție',
  '20': 'Vânzare',
  '30': 'Amortizare',
  '40': 'Transfer intern',
  '50': 'Casare mijloace fixe',
  '60': 'Reevaluare negativă',
  '70': 'Reevaluare pozitivă',
  '80': 'Plus de inventar',
  '90': 'Minus de inventar',
  '100': 'Ajustare de valoare negativă',
  '110': 'Reversare ajustare de valoare',
  '120': 'Bunuri acordate cu titlu gratuit',
  '130': 'Alte tranzacții',
};
