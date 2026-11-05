// ANAF's codes of taxes withheld at source (WHT) for D406, SAF-T.
// Extracted from ANAF RO_SAFT_SchemaDefCod_16.02.2026.xlsx (sha256 050508bf6eadbd6bb4684a0016296253c629d4e9b54a1118dd9b9bfd0c1d0f2d),
// sheet "WHT - nomenclator" (every code; the workbook of 05.02.2026 lacks 604040). `regime` is
// read from the sheet's comments: "Cota standard" or "Cf. CF" (domestic law), "Cf. CEDI" (a
// treaty), "Cf. Directiva" (an EU directive's exemption), "metoda sutei mărite" (the tax borne by
// the payer, grossed up); `individual` marks the codes the sheet names for individuals.

/** A TaxCode of the WHT nomenclator: its TaxType (the D100 obligation code of TAX-IMP), rate in
 * percent, regime and ANAF's description. */
export interface WhtTaxCode {
  type: string;
  percentage: string;
  regime: 'domestic' | 'treaty' | 'directive' | 'grossup';
  individual?: true;
  description: string;
}

export const whtTaxCodes: Readonly<Record<string, WhtTaxCode>> = {
  '150010': {
    type: '150',
    percentage: '5',
    regime: 'domestic',
    description: 'Impozit pe dividende distribuite persoanelor juridice',
  },
  '150020': {
    type: '150',
    percentage: '5.263158',
    regime: 'grossup',
    description: 'Impozit pe dividende distribuite persoanelor juridice',
  },
  '150030': {
    type: '150',
    percentage: '0',
    regime: 'domestic',
    description: 'Impozit pe dividende distribuite persoanelor juridice',
  },
  '150040': {
    type: '150',
    percentage: '8',
    regime: 'domestic',
    description: 'Impozit pe dividende distribuite persoanelor juridice',
  },
  '150050': {
    type: '150',
    percentage: '8.69',
    regime: 'grossup',
    description: 'Impozit pe dividende distribuite persoanelor juridice',
  },
  '150060': {
    type: '150',
    percentage: '10',
    regime: 'domestic',
    description: 'Impozit pe dividende distribuite persoanelor juridice',
  },
  '150070': {
    type: '150',
    percentage: '11.11',
    regime: 'grossup',
    description: 'Impozit pe dividende distribuite persoanelor juridice',
  },
  '150080': {
    type: '150',
    percentage: '16',
    regime: 'domestic',
    description: 'Impozit pe dividende distribuite persoanelor juridice',
  },
  '150090': {
    type: '150',
    percentage: '19.047619',
    regime: 'grossup',
    description: 'Impozit pe dividende distribuite persoanelor juridice',
  },
  '604010': {
    type: '604',
    percentage: '5',
    regime: 'domestic',
    description: 'Impozit pe veniturile din dividende distribuite persoanelor fizice',
  },
  '604020': {
    type: '604',
    percentage: '8',
    regime: 'domestic',
    description: 'Impozit pe veniturile din dividende distribuite persoanelor fizice',
  },
  '604030': {
    type: '604',
    percentage: '10',
    regime: 'domestic',
    description: 'Impozit pe veniturile din dividende distribuite persoanelor fizice',
  },
  '604040': {
    type: '604',
    percentage: '16',
    regime: 'domestic',
    description: 'Impozit pe veniturile din dividende distribuite persoanelor fizice',
  },
  '605010': {
    type: '605',
    percentage: '10',
    regime: 'domestic',
    description: 'Impozit pe veniturile din dobânzi',
  },
  '606010': {
    type: '606',
    percentage: '10',
    regime: 'domestic',
    description: 'Impozit pe veniturile din lichidarea unei persoane juridice',
  },
  '606020': {
    type: '606',
    percentage: '11.111111',
    regime: 'grossup',
    description: 'Impozit pe veniturile din lichidarea unei persoane juridice',
  },
  '607010': {
    type: '607',
    percentage: '10',
    regime: 'domestic',
    description: 'Impozit pe veniturile din pensii',
  },
  '607020': {
    type: '607',
    percentage: '11.111111',
    regime: 'grossup',
    description: 'Impozit pe veniturile din pensii',
  },
  '607050': {
    type: '607',
    percentage: '10',
    regime: 'domestic',
    description: 'Impozit pe veniturile din pensii',
  },
  '607060': {
    type: '607',
    percentage: '11.11',
    regime: 'grossup',
    description: 'Impozit pe veniturile din pensii',
  },
  '607070': {
    type: '607',
    percentage: '15',
    regime: 'domestic',
    description: 'Impozit pe veniturile din pensii',
  },
  '607080': {
    type: '607',
    percentage: '17.65',
    regime: 'grossup',
    description: 'Impozit pe veniturile din pensii',
  },
  '607090': {
    type: '607',
    percentage: '20',
    regime: 'domestic',
    description: 'Impozit pe veniturile din pensii',
  },
  '607100': {
    type: '607',
    percentage: '25',
    regime: 'grossup',
    description: 'Impozit pe veniturile din pensii',
  },
  '607110': {
    type: '607',
    percentage: '10',
    regime: 'domestic',
    description: 'Impozit pe veniturile din pensii',
  },
  '607120': {
    type: '607',
    percentage: '11.11',
    regime: 'grossup',
    description: 'Impozit pe veniturile din pensii',
  },
  '607130': {
    type: '607',
    percentage: '15',
    regime: 'domestic',
    description: 'Impozit pe veniturile din pensii',
  },
  '607140': {
    type: '607',
    percentage: '17.65',
    regime: 'grossup',
    description: 'Impozit pe veniturile din pensii',
  },
  '607150': {
    type: '607',
    percentage: '20',
    regime: 'domestic',
    description: 'Impozit pe veniturile din pensii',
  },
  '607160': {
    type: '607',
    percentage: '25',
    regime: 'grossup',
    description: 'Impozit pe veniturile din pensii',
  },
  '608010': {
    type: '608',
    percentage: '10',
    regime: 'domestic',
    description: 'Impozit pe veniturile din premii',
  },
  '608020': {
    type: '608',
    percentage: '11.11',
    regime: 'grossup',
    description:
      'Impozit pe veniturile obținute de persoane fizice nerezidente din premii acordate la concursuri organizate în România. (cu suta majorată aplicată)',
  },
  '621010': {
    type: '621',
    percentage: '1',
    regime: 'domestic',
    description: 'Impozit pe veniturile din jocuri de noroc',
  },
  '621020': {
    type: '621',
    percentage: '16',
    regime: 'domestic',
    description: 'Impozit pe veniturile din jocuri de noroc',
  },
  '621030': {
    type: '621',
    percentage: '25',
    regime: 'domestic',
    description: 'Impozit pe veniturile din jocuri de noroc',
  },
  '621040': {
    type: '621',
    percentage: '3',
    regime: 'domestic',
    description: 'Impozit pe veniturile din jocuri de noroc',
  },
  '621050': {
    type: '621',
    percentage: '20',
    regime: 'domestic',
    description: 'Impozit pe veniturile din jocuri de noroc',
  },
  '621060': {
    type: '621',
    percentage: '40',
    regime: 'domestic',
    description: 'Impozit pe veniturile din jocuri de noroc',
  },
  '628010': {
    type: '628',
    percentage: '10',
    regime: 'domestic',
    description:
      'Impozit pe veniturile din cedarea folosintei bunurilor, altele decât cele din arendarea bunurilor agricole si din închirierea în scop turistic a camerelor situate în locuinte proprietate personală, retinut la sursă de către persoanele juridice sau alte entităti care au obligatia de a conduce evidentă contabilă',
  },
  '628020': {
    type: '628',
    percentage: '11.11',
    regime: 'grossup',
    description:
      'Impozit pe veniturile din cedarea folosintei bunurilor, altele decât cele din arendarea bunurilor agricole si din închirierea în scop turistic a camerelor situate în locuinte proprietate personală, retinut la sursă de către persoanele juridice sau alte entităti care au obligatia de a conduce evidentă contabilă',
  },
  '631010': {
    type: '631',
    percentage: '5',
    regime: 'domestic',
    description: 'Impozit pe veniturile din dividende obţinute din România de persoane nerezidente',
  },
  '631011': {
    type: '631',
    percentage: '5.26',
    regime: 'grossup',
    description: 'Impozit pe veniturile din dividende obţinute din România de persoane nerezidente',
  },
  '631020': {
    type: '631',
    percentage: '0',
    regime: 'directive',
    description: 'Impozit pe veniturile din dividende obţinute din România de persoane nerezidente',
  },
  '631030': {
    type: '631',
    percentage: '0',
    regime: 'treaty',
    description: 'Impozit pe veniturile din dividende obţinute din România de persoane nerezidente',
  },
  '631040': {
    type: '631',
    percentage: '3',
    regime: 'treaty',
    description: 'Impozit pe veniturile din dividende obţinute din România de persoane nerezidente',
  },
  '631050': {
    type: '631',
    percentage: '8',
    regime: 'domestic',
    description: 'Impozit pe veniturile din dividende obţinute din România de persoane nerezidente',
  },
  '631060': {
    type: '631',
    percentage: '8.69',
    regime: 'grossup',
    description: 'Impozit pe veniturile din dividende obţinute din România de persoane nerezidente',
  },
  '631070': {
    type: '631',
    percentage: '10',
    regime: 'domestic',
    description: 'Impozit pe veniturile din dividende obţinute de persoane nerezidente',
  },
  '631080': {
    type: '631',
    percentage: '11.11',
    regime: 'grossup',
    description: 'Impozit pe veniturile din dividende obţinute de persoane nerezidente',
  },
  '631090': {
    type: '631',
    percentage: '16',
    regime: 'domestic',
    description: 'Impozit pe veniturile din dividende obţinute din România de persoane nerezidente',
  },
  '631100': {
    type: '631',
    percentage: '19.047619',
    regime: 'grossup',
    description: 'Impozit pe veniturile din dividende obţinute din România de persoane nerezidente',
  },
  '632010': {
    type: '632',
    percentage: '16',
    regime: 'domestic',
    description: 'Impozit pe veniturile din dobânzi obţinute din România de persoane nerezidente',
  },
  '632020': {
    type: '632',
    percentage: '19.047619',
    regime: 'grossup',
    description: 'Impozit pe veniturile din dobânzi obţinute din România de persoane nerezidente',
  },
  '632030': {
    type: '632',
    percentage: '0',
    regime: 'directive',
    description: 'Impozit pe veniturile din dobânzi obţinute din România de persoane nerezidente',
  },
  '632040': {
    type: '632',
    percentage: '0',
    regime: 'treaty',
    description: 'Impozit pe veniturile din dobânzi obţinute din România de persoane nerezidente',
  },
  '632050': {
    type: '632',
    percentage: '0',
    regime: 'treaty',
    description: 'Impozit pe veniturile din dobânzi obţinute din România de persoane nerezidente',
  },
  '632060': {
    type: '632',
    percentage: '1',
    regime: 'treaty',
    description: 'Impozit pe veniturile din dobânzi obţinute din România de persoane nerezidente',
  },
  '632070': {
    type: '632',
    percentage: '3',
    regime: 'treaty',
    description: 'Impozit pe veniturile din dobânzi obţinute din România de persoane nerezidente',
  },
  '632080': {
    type: '632',
    percentage: '5',
    regime: 'treaty',
    description: 'Impozit pe veniturile din dobânzi obţinute din România de persoane nerezidente',
  },
  '632090': {
    type: '632',
    percentage: '10',
    regime: 'treaty',
    description: 'Impozit pe veniturile din dobânzi obţinute din România de persoane nerezidente',
  },
  '632100': {
    type: '632',
    percentage: '12.5',
    regime: 'treaty',
    description: 'Impozit pe veniturile din dobânzi obţinute din România de persoane nerezidente',
  },
  '632110': {
    type: '632',
    percentage: '15',
    regime: 'treaty',
    description: 'Impozit pe veniturile din dobânzi obţinute din România de persoane nerezidente',
  },
  '632120': {
    type: '632',
    percentage: '7',
    regime: 'treaty',
    description:
      'Impozit pe veniturile obținute de persoane nerezidente din dobânzi, pentru Cehia si Bosnia Hertegovina',
  },
  '632130': {
    type: '632',
    percentage: '8',
    regime: 'treaty',
    description:
      'Impozit pe veniturile obținute de persoane nerezidente din dobânzi, pentru Azerbaidjan si Iran',
  },
  '632140': {
    type: '632',
    percentage: '10',
    regime: 'domestic',
    individual: true,
    description:
      'Impozit pe veniturile din dobânzi obţinute din România de persoane nerezidente - persoane fizice',
  },
  '632150': {
    type: '632',
    percentage: '11.11',
    regime: 'grossup',
    individual: true,
    description:
      'Impozit pe veniturile din dobânzi obţinute din România de persoane nerezidente - persoane fizice',
  },
  '633010': {
    type: '633',
    percentage: '16',
    regime: 'domestic',
    description: 'Impozit pe veniturile din redevenţe obţinute din România de persoane nerezidente',
  },
  '633020': {
    type: '633',
    percentage: '19.047619',
    regime: 'grossup',
    description: 'Impozit pe veniturile din redevenţe obţinute din România de persoane nerezidente',
  },
  '633030': {
    type: '633',
    percentage: '2.5',
    regime: 'treaty',
    description: 'Impozit pe veniturile din redevenţe obţinute din România de persoane nerezidente',
  },
  '633040': {
    type: '633',
    percentage: '3',
    regime: 'treaty',
    description: 'Impozit pe veniturile din redevenţe obţinute din România de persoane nerezidente',
  },
  '633050': {
    type: '633',
    percentage: '5',
    regime: 'treaty',
    description: 'Impozit pe veniturile din redevenţe obţinute din România de persoane nerezidente',
  },
  '633060': {
    type: '633',
    percentage: '7',
    regime: 'treaty',
    description: 'Impozit pe veniturile din redevenţe obţinute din România de persoane nerezidente',
  },
  '633070': {
    type: '633',
    percentage: '10',
    regime: 'treaty',
    description: 'Impozit pe veniturile din redevenţe obţinute din România de persoane nerezidente',
  },
  '633080': {
    type: '633',
    percentage: '12',
    regime: 'treaty',
    description: 'Impozit pe veniturile din redevenţe obţinute din România de persoane nerezidente',
  },
  '633090': {
    type: '633',
    percentage: '12.5',
    regime: 'treaty',
    description: 'Impozit pe veniturile din redevenţe obţinute din România de persoane nerezidente',
  },
  '633100': {
    type: '633',
    percentage: '15',
    regime: 'treaty',
    description: 'Impozit pe veniturile din redevenţe obţinute din România de persoane nerezidente',
  },
  '633110': {
    type: '633',
    percentage: '0',
    regime: 'directive',
    description: 'Impozit pe veniturile din redevenţe obţinute din România de persoane nerezidente',
  },
  '633120': {
    type: '633',
    percentage: '0',
    regime: 'treaty',
    description: 'Impozit pe veniturile din redevenţe obţinute din România de persoane nerezidente',
  },
  '633130': {
    type: '633',
    percentage: '10',
    regime: 'domestic',
    individual: true,
    description:
      'Impozit pe veniturile din redevenţe obţinute din România de persoane nerezidente - persoane fizice',
  },
  '633140': {
    type: '633',
    percentage: '11.11',
    regime: 'grossup',
    individual: true,
    description:
      'Impozit pe veniturile din redevenţe obţinute din România de persoane nerezidente - persoane fizice',
  },
  '634010': {
    type: '634',
    percentage: '16',
    regime: 'domestic',
    description:
      'Impozit pe veniturile din comisioane obţinute din România de persoane nerezidente',
  },
  '634020': {
    type: '634',
    percentage: '19.047619',
    regime: 'grossup',
    description:
      'Impozit pe veniturile din comisioane obţinute din România de persoane nerezidente',
  },
  '634030': {
    type: '634',
    percentage: '5',
    regime: 'treaty',
    description:
      'Impozit pe veniturile din comisioane obţinute din România de persoane nerezidente',
  },
  '634040': {
    type: '634',
    percentage: '0',
    regime: 'treaty',
    description:
      'Impozit pe veniturile din comisioane obţinute din România de persoane nerezidente',
  },
  '634050': {
    type: '634',
    percentage: '2',
    regime: 'treaty',
    description:
      'Impozit pe veniturile din comisioane obţinute din România de persoane nerezidente',
  },
  '634060': {
    type: '634',
    percentage: '4',
    regime: 'treaty',
    description:
      'Impozit pe veniturile din comisioane obţinute din România de persoane nerezidente',
  },
  '634070': {
    type: '634',
    percentage: '3',
    regime: 'treaty',
    description:
      'Impozit pe veniturile din comisioane obţinute din România de persoane nerezidente',
  },
  '634080': {
    type: '634',
    percentage: '6',
    regime: 'treaty',
    description:
      'Impozit pe veniturile din comisioane obţinute din România de persoane nerezidente',
  },
  '634090': {
    type: '634',
    percentage: '12.5',
    regime: 'treaty',
    description:
      'Impozit pe veniturile din comisioane obţinute din România de persoane nerezidente',
  },
  '634100': {
    type: '634',
    percentage: '15',
    regime: 'treaty',
    description:
      'Impozit pe veniturile din comisioane obţinute din România de persoane nerezidente',
  },
  '634110': {
    type: '634',
    percentage: '10',
    regime: 'treaty',
    description:
      'Impozit pe veniturile din comisioane obţinute din România de persoane nerezidente',
  },
  '634120': {
    type: '634',
    percentage: '10',
    regime: 'domestic',
    individual: true,
    description:
      'Impozit pe veniturile din comisioane obţinute din România de persoane nerezidente - persoane fizice',
  },
  '634130': {
    type: '634',
    percentage: '11.11',
    regime: 'grossup',
    individual: true,
    description:
      'Impozit pe veniturile din comisioane obţinute din România de persoane nerezidente - persoane fizice',
  },
  '635010': {
    type: '635',
    percentage: '11.111111',
    regime: 'grossup',
    description:
      'Impozit pe veniturile obţinute din România de persoane nerezidente din activităţi sportive şi de divertisment',
  },
  '635020': {
    type: '635',
    percentage: '10',
    regime: 'domestic',
    description:
      'Impozit pe veniturile obţinute din România de persoane nerezidente din activităţi sportive şi de divertisment',
  },
  '636010': {
    type: '636',
    percentage: '16',
    regime: 'domestic',
    description: 'Impozit pe veniturile din servicii prestate de persoane nerezidente',
  },
  '636020': {
    type: '636',
    percentage: '19.047619',
    regime: 'grossup',
    description: 'Impozit pe veniturile din servicii prestate de persoane nerezidente',
  },
  '636030': {
    type: '636',
    percentage: '0',
    regime: 'treaty',
    description: 'Impozit pe veniturile din servicii prestate de persoane nerezidente',
  },
  '636040': {
    type: '636',
    percentage: '10',
    regime: 'domestic',
    individual: true,
    description:
      'Impozit pe veniturile din servicii prestate de persoane nerezidente - persoane fizice',
  },
  '636050': {
    type: '636',
    percentage: '11.11',
    regime: 'grossup',
    individual: true,
    description:
      'Impozit pe veniturile din servicii prestate de persoane nerezidente - persoane fizice',
  },
  '637010': {
    type: '637',
    percentage: '10',
    regime: 'domestic',
    individual: true,
    description:
      'Impozit pe veniturile obţinute de persoane fizice nerezidente din premii acordate la concursuri organizate în România',
  },
  '637020': {
    type: '637',
    percentage: '11.111111',
    regime: 'grossup',
    individual: true,
    description:
      'Impozit pe veniturile obţinute de persoane fizice nerezidente din premii acordate la concursuri organizate în România',
  },
  '637030': {
    type: '637',
    percentage: '16',
    regime: 'domestic',
    individual: true,
    description:
      'Impozit pe veniturile obţinute de persoane fizice nerezidente din premii acordate la concursuri organizate în România',
  },
  '637040': {
    type: '637',
    percentage: '19.05',
    regime: 'grossup',
    individual: true,
    description:
      'Impozit pe veniturile obţinute de persoane fizice nerezidente din premii acordate la concursuri organizate în România',
  },
  '639010': {
    type: '639',
    percentage: '16',
    regime: 'domestic',
    description:
      'Impozit pe venituri din lichidarea unei persoane juridice române realizate de persoane nerezidente',
  },
  '639020': {
    type: '639',
    percentage: '19.047619',
    regime: 'grossup',
    description:
      'Impozit pe venituri din lichidarea unei persoane juridice române realizate de persoane nerezidente',
  },
  '639030': {
    type: '639',
    percentage: '0',
    regime: 'treaty',
    description:
      'Impozit pe venituri din lichidarea unei persoane juridice române realizate de persoane nerezidente',
  },
  '639040': {
    type: '639',
    percentage: '10',
    regime: 'domestic',
    individual: true,
    description:
      'Impozit pe venituri din lichidarea unei persoane juridice române realizate de persoane nerezidente - persoane fizice',
  },
  '639050': {
    type: '639',
    percentage: '11.11',
    regime: 'grossup',
    individual: true,
    description:
      'Impozit pe venituri din lichidarea unei persoane juridice române realizate de persoane nerezidente - persoane fizice',
  },
  '640010': {
    type: '640',
    percentage: '16',
    regime: 'domestic',
    description:
      'Impozit pe veniturile reprezentând remuneraţii primite de persoane juridice nerezidente care actioneaza în calitate de administrator, fondator sau membru al consiliului de administraţie al unei persoane juridice române',
  },
  '640020': {
    type: '640',
    percentage: '19.047619',
    regime: 'grossup',
    description:
      'Impozit pe veniturile reprezentând remuneraţii primite de persoane juridice nerezidente care actioneaza în calitate de administrator, fondator sau membru al consiliului de administraţie al unei persoane juridice române',
  },
  '640030': {
    type: '640',
    percentage: '0',
    regime: 'treaty',
    description:
      'Impozit pe veniturile reprezentând remuneraţii primite de persoane juridice nerezidente care actioneaza în calitate de administrator, fondator sau membru al consiliului de administraţie al unei persoane juridice române',
  },
  '641010': {
    type: '641',
    percentage: '10',
    regime: 'domestic',
    description:
      'Impozit pe veniturile realizate din transferul masei patrimoniale fiduciare de la fiduciar la beneficiarul nerezident - care este persoană fizică',
  },
  '641020': {
    type: '641',
    percentage: '11.11',
    regime: 'grossup',
    description:
      'Impozit pe veniturile realizate din transferul masei patrimoniale fiduciare de la fiduciar la beneficiarul nerezident - care este persoană fizică (cu suta majorată aplicată)',
  },
  '641030': {
    type: '641',
    percentage: '16',
    regime: 'domestic',
    description:
      'Impozit pe veniturile realizate din transferul masei patrimoniale fiduciare de la fiduciar la beneficiarul nerezident - care este persoană juridică',
  },
  '641040': {
    type: '641',
    percentage: '19.047619',
    regime: 'grossup',
    description:
      'Impozit pe veniturile realizate din transferul masei patrimoniale fiduciare de la fiduciar la beneficiarul nerezident - care este persoană juridică (cu suta majorată aplicată)',
  },
  '642010': {
    type: '642',
    percentage: '1',
    regime: 'domestic',
    description: 'Impozit pe veniturile din transferul titlurilor de valoare',
  },
  '642020': {
    type: '642',
    percentage: '3',
    regime: 'domestic',
    description: 'Impozit pe veniturile din transferul titlurilor de valoare',
  },
  '642030': {
    type: '642',
    percentage: '1',
    regime: 'domestic',
    description: 'Impozit pe veniturile din operațiuni cu instrumente financiare derivate',
  },
  '642040': {
    type: '642',
    percentage: '3',
    regime: 'domestic',
    description: 'Impozit pe veniturile din operațiuni cu instrumente financiare derivate',
  },
  '642050': {
    type: '642',
    percentage: '3',
    regime: 'domestic',
    description: 'Impozit pe veniturile din transferul titlurilor de valoare',
  },
  '642060': {
    type: '642',
    percentage: '6',
    regime: 'domestic',
    description: 'Impozit pe veniturile din transferul titlurilor de valoare',
  },
  '690010': {
    type: '690',
    percentage: '10',
    regime: 'domestic',
    description: 'Impozit pe veniturile din alte surse',
  },
  '690020': {
    type: '690',
    percentage: '11.111111',
    regime: 'grossup',
    description: 'Impozit pe veniturile din alte surse',
  },
};

/** The regime a tax is withheld under: domestic law, or a double tax treaty's rate. */
export type WhtRegime = 'domestic' | 'treaty';

/**
 * The TaxCode of a tax withheld under a regime at a rate (percent): the type's code of that
 * percentage, the individuals' code where the sheet names one for them; for a treaty rate the
 * nomenclator lists no "Cf. CEDI" code of (dividends at 5% or 10%), the domestic code of the same
 * percentage. Never a gross-up or a directive's code. Null when the nomenclator has none.
 */
export function whtCode(
  type: string,
  regime: WhtRegime,
  rate: string,
  individual = false,
): string | null {
  const candidates = Object.entries(whtTaxCodes)
    .filter(
      ([, entry]) =>
        entry.type === type &&
        Number(entry.percentage) === Number(rate) &&
        (entry.regime === 'domestic' || entry.regime === 'treaty'),
    )
    .sort(([a], [b]) => (a < b ? -1 : 1));
  const pick = (test: (entry: WhtTaxCode) => boolean) =>
    candidates.find(([, entry]) => test(entry))?.[0] ?? null;
  return (
    pick((entry) => entry.regime === regime && Boolean(entry.individual) === individual) ??
    pick((entry) => entry.regime === regime) ??
    (regime === 'treaty' ? pick((entry) => entry.regime === 'domestic' && !entry.individual) : null)
  );
}

/** What a posting withheld, as D100, D205, D207 and D406 read it (`explanation.details.withholding`
 * of the withholding treatments): the D100 obligation (TaxType), the WHT TaxCode (null for a tax
 * declared in D112, which D406 reports under the generic 000), the base and the tax in bani. */
export interface Withheld {
  /** cod_oblig of D100 and TaxType of D406: 604, 150, 605, 628, 631–636; 611 for intellectual
   * property, declared in D112 and not in D100. */
  type: string;
  taxCode: string | null;
  regime: WhtRegime;
  /** In percent, as applied. */
  rate: string;
  /** The base the rate applies to (the gross income, or the net income for rent and
   * intellectual property), in bani. */
  base: string;
  /** The gross income paid, in bani. */
  gross: string;
  /** The tax withheld, in bani. */
  tax: string;
  /** The return that declares the beneficiary: D205 for residents, D207 for non-residents, D112
   * for intellectual property. */
  annual: 'D205' | 'D207' | 'D112';
}

/**
 * What a posted withholding declares, from the treatment that booked it: the record its
 * explanation keeps (`withholding`), or, for the dividend and interest postings that predate
 * it, from their beneficiary and rate. Null when the treatment withholds nothing.
 */
export function withheldOf(
  treatmentId: string,
  details: Record<string, unknown> | undefined,
  gross: bigint,
  tax: bigint,
): Withheld | null {
  const recorded = details?.withholding as Withheld | undefined;
  if (recorded && typeof recorded === 'object' && typeof recorded.type === 'string')
    return recorded;
  const make = (type: string, rate: string): Withheld => ({
    type,
    taxCode: whtCode(type, 'domestic', rate),
    regime: 'domestic',
    rate,
    base: String(gross),
    gross: String(gross),
    tax: String(tax),
    annual: 'D205',
  });
  if (treatmentId === 'dividends.withhold') {
    const rate = String(details?.rate ?? '');
    return details?.beneficiary === 'company'
      ? make('150', rate)
      : details?.beneficiary === 'individual'
        ? make('604', rate)
        : null;
  }
  if (treatmentId === 'loans.withhold') return make('605', String(details?.rate ?? ''));
  return null;
}
