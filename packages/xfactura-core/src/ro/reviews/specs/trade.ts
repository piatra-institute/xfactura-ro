import type { Evaluation } from '../../../kernel';
import { RuleContext, type ParameterRegister } from '../../../rules';
import {
  euSupplyInput,
  euSupplyRecognition,
  importInput,
  importRecognition,
  type CustomsDeclaration,
} from '../../trade';
import {
  goodsInvoice,
  presumedTransport,
  TRADE_IDS,
  tradeLoaded,
  withDeclaration,
  withVies,
} from '../../trade/world';
import type { CaseOutcome, ReviewCase, ReviewSpec } from '../types';
import { lei } from './world';

/*
 * Readings of goods across the border (src/ro/trade) the texts leave open: by which date the
 * buyer's VAT code must be checked in VIES for an intra-community supply, whether the transport
 * presumption of Regulation (EU) No 282/2011 art. 45a is the only proof of the transport, and the
 * rate an import's invoice in a currency is booked at. Each case runs the engine's code on a
 * fixed company.
 */

const CODE = 'ANAF/Cod-fiscal-consolidat';
const rulesOf = (register: ParameterRegister) => new RuleContext(register, 'preview');
const withValue = (register: ParameterRegister, key: string, value: unknown) =>
  register.withVersions(
    register.versions.map((version) =>
      version.key === key ? { ...version, value: value as never } : version,
    ),
  );
const parameterLines = (rules: RuleContext) =>
  [...rules.used.keys()].map((id) => `Parametru ${id}`);

function outcome(evaluation: Evaluation, rules: RuleContext): CaseOutcome {
  const issues = evaluation.issues
    .filter((issue) => issue.severity !== 'info')
    .map((issue) => `${issue.severity === 'block' ? 'Blocare' : 'De confirmat'} ${issue.code}`);
  if (!evaluation.effect)
    return { summary: `Blocat: ${issues.join(', ')}`, lines: parameterLines(rules) };
  return {
    summary: `Propus${issues.length ? ` (${issues.join(', ')})` : ''}: ${evaluation.effect.lines.map((line) => `${line.side === 'D' ? 'Dr' : 'Cr'} ${line.account} ${lei(line.bani)}`).join(' / ')}`,
    lines: [
      ...evaluation.effect.taxEntries.map(
        (entry) =>
          `${entry.code}: bază ${lei(entry.baseBani)} lei, TVA ${lei(entry.taxBani)} lei, exigibilă la ${entry.taxPoint}`,
      ),
      ...parameterLines(rules),
    ],
  };
}

// ---------------------------------------------------------------------------------------------
// The VIES check of an intra-community supply (art. 294 alin. (2) lit. a); OMFP nr. 103/2016)

const partner = { name: 'Partner GmbH', taxId: 'DE123456788', country: 'DE' };

function supplied(
  register: ParameterRegister,
  issueDate: string,
  checked: string,
  transport: ReturnType<typeof presumedTransport> | undefined,
): CaseOutcome {
  const rules = rulesOf(register);
  const invoice = goodsInvoice({
    direction: 'sale',
    number: 'IC-100',
    issueDate,
    deliveryDate: '2026-10-08',
    currency: 'RON',
    category: 'K',
    reason: 'VATEX-EU-IC',
    partner,
    lines: ['10000.00'],
  });
  const loaded = withVies(tradeLoaded(invoice, 'sale'), 'DE123456788', checked);
  return outcome(
    euSupplyRecognition.evaluate(
      euSupplyInput.parse({
        documentId: TRADE_IDS.invoice,
        account: '707',
        arrangement: 'standard',
        viesDocumentId: TRADE_IDS.vies,
        ...(transport ? { transport } : {}),
      }),
      loaded,
      rules,
    ),
    rules,
  );
}

function viesCase(title: string, facts: string, issueDate: string, checked: string): ReviewCase {
  return {
    title,
    facts,
    run: (register) => ({
      engine: supplied(register, issueDate, checked, presumedTransport('DE', '2026-10-08')),
      alternative: supplied(
        withValue(register, 'ro.vat.intra_eu.vies', { checkBy: 'supply' }),
        issueDate,
        checked,
        presumedTransport('DE', '2026-10-08'),
      ),
    }),
  };
}

export const viesSpec: ReviewSpec = {
  key: 'ro.vat.intra_eu.vies',
  kind: 'interpretation',
  act: CODE,
  minutes: 10,
  readings: {
    engine:
      'Codul de TVA al cumpărătorului se verifică în VIES cel târziu la exigibilitatea livrării (data facturii sau a 15-a zi a lunii următoare, art. 283 alin. (1)); o verificare după livrare, dar înainte de exigibilitate, se confirmă de cel care aprobă.',
    alternative:
      'Codul trebuie verificat în VIES cel târziu la data livrării (faptul generator): o verificare ulterioară nu justifică scutirea.',
  },
  question:
    'Până la ce dată trebuie verificat în VIES codul de TVA al cumpărătorului pentru ca livrarea intracomunitară să fie scutită (art. 294 alin. (2) lit. a))?',
  context: ['OMFP103/2016:art.10(6)'],
  cases: [
    viesCase(
      'Verificare în ziua livrării',
      'Livrare de 10.000,00 lei către Partner GmbH (DE123456788) la 08.10.2026, factura din 09.10.2026, verificare VIES la 08.10.2026, CMR și asigurare.',
      '2026-10-09',
      '2026-10-08',
    ),
    viesCase(
      'Verificare după livrare, înaintea facturii',
      'Aceeași livrare, factura din 20.10.2026, verificare VIES la 12.10.2026.',
      '2026-10-20',
      '2026-10-12',
    ),
    viesCase(
      'Verificare după factură',
      'Aceeași livrare, factura din 09.10.2026, verificare VIES la 12.10.2026.',
      '2026-10-09',
      '2026-10-12',
    ),
  ],
  gaps: [
    'Codul fiscal cere ca cumpărătorul să comunice un cod valabil, fără să spună când se verifică; OMFP nr. 103/2016 art. 10 nu numește VIES.',
    'VIES răspunde doar pentru ziua cererii: o verificare la o dată trecută nu există.',
  ],
};

// ---------------------------------------------------------------------------------------------
// The transport presumption (Regulation (EU) No 282/2011 art. 45a; OMFP nr. 103/2016 art. 10)

function transportCase(
  title: string,
  facts: string,
  transport: ReturnType<typeof presumedTransport>,
): ReviewCase {
  return {
    title,
    facts,
    run: (register) => ({
      engine: supplied(register, '2026-10-09', '2026-10-08', transport),
      alternative: supplied(
        withValue(register, 'ro.vat.intra_eu.transport', {
          presumption: 'required',
          documents: 2,
          buyerStatementDay: 10,
        }),
        '2026-10-09',
        '2026-10-08',
        transport,
      ),
    }),
  };
}

const oneDocument = () => {
  const proof = presumedTransport('DE', '2026-10-08');
  proof.documents.pop();
  return proof;
};
const ownTruck = () => {
  const proof = presumedTransport('DE', '2026-10-08');
  proof.documents = [
    { ...proof.documents[0]!, issuer: 'Exemplu Comerț SRL (mijloc propriu)', independent: false },
  ];
  return proof;
};

export const transportSpec: ReviewSpec = {
  key: 'ro.vat.intra_eu.transport',
  kind: 'interpretation',
  act: 'REG282/2011-A',
  minutes: 15,
  readings: {
    engine:
      'Prezumția art. 45a este una dintre căile de dovadă: fără ea, scutirea se sprijină pe documentele OMFP nr. 103/2016 art. 10, care atestă neechivoc transportul (inclusiv cu mijloace proprii), confirmate de cel care aprobă.',
    alternative:
      'Fără cele două dovezi independente ale art. 45a, transportul nu este dovedit și livrarea nu se înregistrează ca scutită.',
  },
  question:
    'Dacă prezumția transportului din art. 45a al Regulamentului (UE) nr. 282/2011 nu este îndeplinită, poate fi dovedit transportul în alt stat membru cu documentele OMFP nr. 103/2016 art. 10?',
  context: ['OMFP103/2016:art.1(4)', `${CODE}:art.294(2)`],
  cases: [
    transportCase(
      'CMR și asigurare de la emitenți independenți',
      'Livrare de 10.000,00 lei în Germania, CMR semnat al transportatorului și polița de asigurare a transportului.',
      presumedTransport('DE', '2026-10-08'),
    ),
    transportCase(
      'Numai CMR-ul transportatorului',
      'Aceeași livrare, cu un singur document: CMR-ul semnat.',
      oneDocument(),
    ),
    transportCase(
      'Transport cu mijloace proprii',
      'Aceeași livrare, transportată cu camionul vânzătorului: foaia de parcurs și CMR-ul întocmit de vânzător.',
      ownTruck(),
    ),
  ],
  gaps: [
    'Regulamentul spune că autoritatea poate respinge prezumția (alin. (2)), nu ce se întâmplă când ea lipsește.',
    'Textul OMFP nr. 103/2016 citit este cel din Monitorul Oficial nr. 106/2016, neconsolidat.',
  ],
};

// ---------------------------------------------------------------------------------------------
// The rate an import's invoice is booked at (OMFP nr. 1.802/2014; art. 290 alin. (1))

function imported(
  register: ParameterRegister,
  invoiceRate: string,
  customsRate: string,
): CaseOutcome {
  const rules = rulesOf(register);
  const invoice = goodsInvoice({
    direction: 'purchase',
    number: 'CN-100',
    issueDate: '2026-10-01',
    currency: 'USD',
    category: 'O',
    partner: { name: 'Shenzhen Ltd', taxId: 'CN91440300', country: 'CN' },
    lines: ['1000.00'],
  });
  const customsValue = (1000 * Number(customsRate)).toFixed(2);
  const base = (Number(customsValue) + 120).toFixed(2);
  const vat = ((Number(base) * 21) / 100).toFixed(2);
  const declaration: Omit<CustomsDeclaration, 'parserVersion'> = {
    procedure: 'import',
    mrn: '26RO1234567890ABCD',
    acceptedOn: '2026-10-06',
    office: 'Biroul vamal Constanța Sud',
    declarant: { name: 'Exemplu Comerț SRL', taxId: '18547290', country: 'RO' },
    partner: { name: 'Shenzhen Ltd', country: 'CN', taxId: null },
    invoices: [{ number: 'CN-100', currency: 'USD', amount: '1000.00' }],
    exchangeRate: customsRate,
    lines: [
      {
        description: 'Componente',
        commodity: '85423190',
        customsValue,
        duty: '120.00',
        otherTaxes: '0.00',
        ancillary: '0.00',
        vatBase: base,
        vatRate: '21',
        vat,
        origin: 'CN',
      },
    ],
    totals: { customsValue, duty: '120.00', otherTaxes: '0.00', vatBase: base, vat },
    vatPayment: { mode: 'paid' },
  };
  const loaded = withDeclaration(
    tradeLoaded(invoice, 'purchase', {
      rates: [{ currency: 'USD', date: '2026-10-01', rate: invoiceRate }],
    }),
    declaration,
  );
  return outcome(
    importRecognition.evaluate(
      importInput.parse({
        documentId: TRADE_IDS.invoice,
        declarationId: TRADE_IDS.declaration,
        account: '6028',
        deduction: 'full',
        authorityId: TRADE_IDS.customs,
      }),
      loaded,
      rules,
    ),
    rules,
  );
}

function importCase(
  title: string,
  facts: string,
  invoiceRate: string,
  customsRate: string,
): ReviewCase {
  return {
    title,
    facts,
    run: (register) => ({
      engine: imported(register, invoiceRate, customsRate),
      alternative: imported(
        withValue(register, 'ro.vat.import', {
          customsAccount: '446',
          invoiceRate: 'customs',
          deferral: ['art.326(4)(a)'],
        }),
        invoiceRate,
        customsRate,
      ),
    }),
  };
}

export const importSpec: ReviewSpec = {
  key: 'ro.vat.import',
  kind: 'interpretation',
  act: 'OMFP1802/2014',
  minutes: 15,
  readings: {
    engine:
      'Factura furnizorului în valută se înregistrează la cursul BNR din data ei, ca orice factură; declarația vamală dă taxele vamale și TVA de import în lei, la cursul vamal (art. 290 alin. (1)), înregistrate pe 446 și 4426.',
    alternative:
      'Bunurile importate și datoria față de furnizor se înregistrează la cursul vamal din declarația de import, aceeași dată cu taxele vamale și TVA.',
  },
  question:
    'La ce curs se înregistrează bunurile importate și datoria față de furnizorul din afara Uniunii: cursul BNR din data facturii sau cursul vamal al declarației de import?',
  context: [`${CODE}:art.290(1)`, 'OMFP1802/2014:pct.8(6)'],
  cases: [
    importCase(
      'Cursuri apropiate',
      'Factură de 1.000,00 USD din 01.10.2026 (BNR 4,5000), DVI din 06.10.2026 la cursul vamal 4,5500, taxe vamale 120,00 lei, TVA plătită în vamă.',
      '4.5000',
      '4.5500',
    ),
    importCase(
      'Cursuri depărtate',
      'Aceeași factură, BNR 4,4000 la data facturii, cursul vamal 4,6000.',
      '4.4000',
      '4.6000',
    ),
    importCase('Același curs', 'Aceeași factură, BNR și cursul vamal 4,5000.', '4.5000', '4.5000'),
  ],
  gaps: [
    'OMFP nr. 1.802/2014 cere cursul de la data tranzacției, fără să spună dacă la import aceasta este data facturii sau a declarației vamale.',
    'Contul pe care se înregistrează TVA plătită în vamă până la plată (446, ca datoria vamală) este al aplicației: funcțiunea contului 4426 numește plata directă (512).',
  ],
};
