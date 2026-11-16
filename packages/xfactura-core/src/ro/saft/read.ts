import { requireCondition } from '../../errors';
import { formatScaled, parseDecimal, parseScaled, roundRatio } from '../../money';
import { sourceXml, type XmlElement } from '../../xml/source-xml';
import {
  d406AccountId,
  d406AccountType,
  d406AmbiguousAccounts,
  d406InStandardChart,
  d406StandardAccount,
} from './accounts';
import { standardAccounts } from './data/accounts';
import { invoiceTypes, paymentMechanisms, units, vatRegimes } from './data/codes';
import { taxTypes, vatTaxCodes } from './data/tax';
import {
  calculateD406,
  checkD406,
  d406Namespace,
  d406Period,
  type D406,
  type D406Account,
  type D406Address,
  type D406Balance,
  type D406Calculation,
  type D406Currency,
  type D406Invoice,
  type D406InvoiceLine,
  type D406Journal,
  type D406Line,
  type D406Party,
  type D406Payment,
  type D406PaymentLine,
  type D406Product,
  type D406Tax,
  type D406Transaction,
} from './d406';
import { d406MemberStateRateCodes } from './tax-codes';
import { d406CodeReadings } from './tax-code-readings';
import { whtTaxCodes } from '../withholding/codes';

// Deliberate cap sized at about six times the largest real monthly file seen (~45,000 elements),
// so a much larger file is refused with XML_COMPLEXITY rather than read; it is not bounded by
// sourceXml's 10 MiB size limit (a dense synthetic document of 300,000 elements fits in ~1.2 MB).
// Raising it is a decision to take when a real larger file is seen.
const MAX_SAFT_NODES = 300_000;

/**
 * A consistency or conversion problem reported by `checkD406*` or `toD406`.
 * `path` is always a dot-separated property path into `D406Filed` (e.g.
 * `generalLedgerEntries.journals.0.transactions.0.lines.0.amount`, `unread.0`).
 */
export type D406FiledProblem = {
  code: string;
  path: string;
  message: string;
};

export type D406FiledUnread = {
  path: string;
  count: number;
};

export type D406FiledAddress = {
  street?: string;
  number?: string;
  details?: string;
  city?: string;
  postalCode?: string;
  county?: string;
  country?: string;
};

export type D406FiledTaxRegistration = {
  registrationNumber?: string;
  taxType?: string;
  taxAuthority?: string;
};

export type D406FiledHeader = {
  version?: string;
  country?: string;
  region?: string;
  created?: string;
  software: {
    company?: string;
    name?: string;
    version?: string;
  };
  company: {
    registrationNumber?: string;
    name?: string;
    address?: D406FiledAddress;
    contact?: {
      firstName?: string;
      lastName?: string;
      phone?: string;
      email?: string;
    };
    taxRegistrations: D406FiledTaxRegistration[];
    ibans: string[];
  };
  defaultCurrency?: string;
  selection: {
    start?: string;
    end?: string;
  };
  type?: string;
  segmentIndex?: string;
  totalSegments?: string;
  taxAccountingBasis?: string;
};

export type D406FiledAccount = {
  id?: string;
  description?: string;
  standard?: string;
  type?: string;
  openingDebit?: string;
  openingCredit?: string;
  closingDebit?: string;
  closingCredit?: string;
};

export type D406FiledParty = {
  id?: string;
  registrationNumber?: string;
  name?: string;
  address?: D406FiledAddress;
  account?: string;
  openingDebit?: string;
  openingCredit?: string;
  closingDebit?: string;
  closingCredit?: string;
};

export type D406FiledTaxCodeDetails = {
  code?: string;
  description?: string;
  percentage?: string;
  baseRates: string[];
  country?: string;
};

export type D406FiledTaxTableEntry = {
  type?: string;
  description?: string;
  codes: D406FiledTaxCodeDetails[];
};

export type D406FiledUnit = {
  unit?: string;
  description?: string;
};

export type D406FiledAnalysisType = {
  type?: string;
  typeDescription?: string;
  id?: string;
  idDescription?: string;
};

export type D406FiledMovementType = {
  type?: string;
  description?: string;
};

export type D406FiledProduct = {
  code?: string;
  kind?: string;
  description?: string;
  commodityCode?: string;
  valuationMethod?: string;
  uomBase?: string;
  uomStandard?: string;
  conversionFactor?: string;
};

export type D406FiledOwner = {
  id?: string;
  registrationNumber?: string;
  name?: string;
  address?: D406FiledAddress;
  account?: string;
};

export type D406FiledAssetSupplier = {
  id?: string;
  name?: string;
  address?: D406FiledAddress;
};

export type D406FiledAssetValuation = {
  valuationType?: string;
  valuationClass?: string;
  costBegin?: string;
  costEnd?: string;
  investmentSupport?: string;
  lifeYears?: string;
  lifeMonths?: string;
  addition?: string;
  transfers?: string;
  disposal?: string;
  bookValueBegin?: string;
  depreciationMethod?: string;
  depreciationPercentage?: string;
  depreciationForPeriod?: string;
  appreciationForPeriod?: string;
  extraordinaryDepreciations?: { method?: string; amount?: string }[];
  accumulatedDepreciation?: string;
  bookValueEnd?: string;
};

export type D406FiledAsset = {
  id?: string;
  account?: string;
  description?: string;
  supplier?: D406FiledAssetSupplier;
  acquired?: string;
  commissioned?: string;
  valuations: D406FiledAssetValuation[];
};

export type D406FiledPhysicalStockEntry = {
  warehouse?: string;
  product?: string;
  lot?: string;
  type?: string;
  commodityCode?: string;
  owner?: string;
  unit?: string;
  conversionFactor?: string;
  unitPrice?: string;
  openingQuantity?: string;
  openingValue?: string;
  closingQuantity?: string;
  closingValue?: string;
  characteristics?: { characteristic?: string; value?: string }[];
};

export type D406FiledMasterFiles = {
  accounts: D406FiledAccount[];
  customers: D406FiledParty[];
  suppliers: D406FiledParty[];
  taxTable: D406FiledTaxTableEntry[];
  units: D406FiledUnit[];
  analysisTypes?: D406FiledAnalysisType[];
  movementTypes?: D406FiledMovementType[];
  products: D406FiledProduct[];
  owners?: D406FiledOwner[];
  assets?: D406FiledAsset[];
  physicalStock?: D406FiledPhysicalStockEntry[];
};

export type D406FiledAmount = {
  amount?: string;
  currencyCode?: string;
  currencyAmount?: string;
  exchangeRate?: string;
};

export type D406FiledTax = {
  type?: string;
  code?: string;
  percentage?: string;
  base?: string;
  amount?: string;
  currencyCode?: string;
  currencyAmount?: string;
  exchangeRate?: string;
};

export type D406FiledTransactionLine = {
  id?: string;
  account?: string;
  document?: string;
  customer?: string;
  supplier?: string;
  description?: string;
  side?: 'debit' | 'credit';
  amount?: D406FiledAmount;
  tax?: D406FiledTax[];
};

export type D406FiledTransaction = {
  id?: string;
  period?: string;
  periodYear?: string;
  date?: string;
  source?: string;
  description?: string;
  entered?: string;
  posted?: string;
  customer?: string;
  supplier?: string;
  lines: D406FiledTransactionLine[];
};

export type D406FiledJournal = {
  id?: string;
  description?: string;
  type?: string;
  transactions: D406FiledTransaction[];
};

export type D406FiledGeneralLedger = {
  numberOfEntries?: string;
  totalDebit?: string;
  totalCredit?: string;
  journals: D406FiledJournal[];
};

export type D406FiledInvoiceLine = {
  lineNumber?: string;
  account?: string;
  goodsServicesId?: string;
  product?: string;
  productDescription?: string;
  quantity?: string;
  unit?: string;
  unitPrice?: string;
  taxPointDate?: string;
  description?: string;
  amount?: D406FiledAmount;
  side?: 'debit' | 'credit';
  rawSide?: string;
  tax: D406FiledTax[];
};

export type D406FiledInvoiceTotals = {
  taxes: D406FiledTax[];
  netTotal?: string;
  grossTotal?: string;
};

export type D406FiledInvoice = {
  number?: string;
  party?: {
    id?: string;
    billingAddress?: D406FiledAddress;
  };
  account?: string;
  period?: string;
  periodYear?: string;
  date?: string;
  type?: string;
  paymentTerms?: string;
  selfBilling?: string;
  transaction?: string;
  lines: D406FiledInvoiceLine[];
  totals?: D406FiledInvoiceTotals;
};

export type D406FiledInvoicesSection = {
  numberOfEntries?: string;
  totalDebit?: string;
  totalCredit?: string;
  invoices: D406FiledInvoice[];
};

export type D406FiledPaymentLine = {
  lineNumber?: string;
  document?: string;
  account?: string;
  customer?: string;
  supplier?: string;
  description?: string;
  side?: 'debit' | 'credit';
  rawSide?: string;
  amount?: D406FiledAmount;
  tax?: D406FiledTax[];
};

export type D406FiledPayment = {
  reference?: string;
  period?: string;
  periodYear?: string;
  transaction?: string;
  date?: string;
  method?: string;
  mechanism?: string;
  description?: string;
  lines: D406FiledPaymentLine[];
  totals?: { grossTotal?: string };
};

export type D406FiledPaymentsSection = {
  numberOfEntries?: string;
  totalDebit?: string;
  totalCredit?: string;
  payments: D406FiledPayment[];
};

export type D406FiledStockMovementLine = {
  lineNumber?: string;
  account?: string;
  transaction?: string;
  customer?: string;
  supplier?: string;
  product?: string;
  lot?: string;
  quantity?: string;
  unit?: string;
  conversionFactor?: string;
  bookValue?: string;
  subType?: string;
  comments?: string;
};

export type D406FiledStockMovement = {
  reference?: string;
  date?: string;
  type?: string;
  document?: { type?: string; number?: string };
  lines: D406FiledStockMovementLine[];
};

export type D406FiledMovementOfGoodsSection = {
  numberOfMovementLines?: string;
  totalQuantityReceived?: string;
  totalQuantityIssued?: string;
  movements: D406FiledStockMovement[];
};

export type D406FiledAssetTransaction = {
  id?: string;
  asset?: string;
  type?: string;
  description?: string;
  date?: string;
  supplier?: D406FiledAssetSupplier;
  transaction?: string;
  valuations: {
    valuationType?: string;
    cost?: string;
    bookValue?: string;
    amount?: string;
  }[];
};

export type D406FiledAssetTransactionsSection = {
  numberOfAssetTransactions?: string;
  transactions: D406FiledAssetTransaction[];
};

export type D406FiledSourceDocuments = {
  salesInvoices?: D406FiledInvoicesSection;
  purchaseInvoices?: D406FiledInvoicesSection;
  payments?: D406FiledPaymentsSection;
  movementOfGoods?: D406FiledMovementOfGoodsSection;
  assetTransactions?: D406FiledAssetTransactionsSection;
};

export type D406Filed = {
  namespace: string;
  header: D406FiledHeader;
  masterFiles: D406FiledMasterFiles;
  generalLedgerEntries: D406FiledGeneralLedger;
  sourceDocuments: D406FiledSourceDocuments;
  unread: D406FiledUnread[];
};

const elementSegment = (node: XmlElement): string =>
  node.uri === d406Namespace ? node.local : `{${node.uri}}${node.local}`;

class XmlReader {
  private readonly unreadCounts = new Map<string, number>();

  unread(): D406FiledUnread[] {
    return [...this.unreadCounts.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([path, count]) => ({ path, count }));
  }

  private bump(path: string): void {
    this.unreadCounts.set(path, (this.unreadCounts.get(path) ?? 0) + 1);
  }

  bumpPath(path: string): void {
    this.bump(path);
  }

  private recordAttributes(node: XmlElement, path: string): void {
    for (const name of Object.keys(node.attributes)) {
      this.bump(`${path}/@${name}`);
    }
    for (const attr of node.namespacedAttributes ?? []) {
      this.bump(`${path}/@{${attr.uri}}${attr.local}`);
    }
  }

  private recordUnread(node: XmlElement, path: string): void {
    this.bump(path);
    this.recordAttributes(node, path);
    if (node.children.length > 0 && !/^[ \t\r\n]*$/.test(node.text)) {
      this.bump(`${path}/#text`);
    }
    for (const child of node.children) {
      this.recordUnread(child, `${path}/${elementSegment(child)}`);
    }
  }

  /**
   * Visits a container element and tracks which child elements the callback consumes.
   * Any unconsumed child, attribute, or non-XML-whitespace container text is recorded in `unread`.
   */
  scope<T>(
    node: XmlElement,
    path: string,
    fn: (cursor: {
      has(local: string): boolean;
      one(local: string): XmlElement | undefined;
      many(local: string): XmlElement[];
      text(local: string): string | undefined;
      texts(local: string): string[];
      read<U>(local: string, reader: (child: XmlElement, childPath: string) => U): U | undefined;
      readMany<U>(local: string, reader: (child: XmlElement, childPath: string) => U): U[];
    }) => T,
  ): T {
    this.recordAttributes(node, path);
    if (!/^[ \t\r\n]*$/.test(node.text)) {
      this.bump(`${path}/#text`);
    }
    const consumed = new Set<XmlElement>();
    const has = (local: string): boolean =>
      node.children.some(
        (child) => child.uri === d406Namespace && child.local === local && !consumed.has(child),
      );
    const one = (local: string): XmlElement | undefined => {
      const found = node.children.find(
        (child) => child.uri === d406Namespace && child.local === local && !consumed.has(child),
      );
      if (found) consumed.add(found);
      return found;
    };
    const many = (local: string): XmlElement[] => {
      const found = node.children.filter(
        (child) => child.uri === d406Namespace && child.local === local && !consumed.has(child),
      );
      for (const child of found) consumed.add(child);
      return found;
    };
    const leafText = (el: XmlElement, childPath: string): string => {
      this.recordAttributes(el, childPath);
      for (const grand of el.children) {
        this.recordUnread(grand, `${childPath}/${elementSegment(grand)}`);
      }
      return el.text;
    };
    const text = (local: string): string | undefined => {
      const el = one(local);
      return el ? leafText(el, `${path}/${local}`) : undefined;
    };
    const texts = (local: string): string[] =>
      many(local).map((el) => leafText(el, `${path}/${local}`));
    const read = <U>(
      local: string,
      reader: (child: XmlElement, childPath: string) => U,
    ): U | undefined => {
      const el = one(local);
      return el ? reader(el, `${path}/${local}`) : undefined;
    };
    const readMany = <U>(local: string, reader: (child: XmlElement, childPath: string) => U): U[] =>
      many(local).map((el) => reader(el, `${path}/${local}`));

    const result = fn({ has, one, many, text, texts, read, readMany });
    for (const child of node.children) {
      if (!consumed.has(child)) this.recordUnread(child, `${path}/${elementSegment(child)}`);
    }
    return result;
  }
}

function definedFields<T extends Record<string, unknown>>(obj: T): T {
  return Object.fromEntries(Object.entries(obj).filter(([, value]) => value !== undefined)) as T;
}

function readAddress(reader: XmlReader, node: XmlElement, path: string): D406FiledAddress {
  return reader.scope(node, path, (c) =>
    definedFields({
      street: c.text('StreetName'),
      number: c.text('Number'),
      details: c.text('AdditionalAddressDetail'),
      city: c.text('City'),
      postalCode: c.text('PostalCode'),
      county: c.text('Region'),
      country: c.text('Country'),
    }),
  );
}

function readAmount(reader: XmlReader, node: XmlElement, path: string): D406FiledAmount {
  return reader.scope(node, path, (c) =>
    definedFields({
      amount: c.text('Amount'),
      currencyCode: c.text('CurrencyCode'),
      currencyAmount: c.text('CurrencyAmount'),
      exchangeRate: c.text('ExchangeRate'),
    }),
  );
}

function readTax(reader: XmlReader, node: XmlElement, path: string): D406FiledTax {
  return reader.scope(node, path, (c) => {
    const taxAmount = c.read('TaxAmount', (el, p) => {
      const amt = readAmount(reader, el, p);
      if (
        amt.amount === undefined &&
        amt.currencyCode === undefined &&
        amt.currencyAmount === undefined &&
        amt.exchangeRate === undefined
      ) {
        reader.bumpPath(p);
      }
      return amt;
    });
    return definedFields({
      type: c.text('TaxType'),
      code: c.text('TaxCode'),
      percentage: c.text('TaxPercentage'),
      base: c.text('TaxBase'),
      amount: taxAmount?.amount,
      currencyCode: taxAmount?.currencyCode,
      currencyAmount: taxAmount?.currencyAmount,
      exchangeRate: taxAmount?.exchangeRate,
    });
  });
}

function readParty(
  reader: XmlReader,
  node: XmlElement,
  path: string,
  idElement: 'CustomerID' | 'SupplierID',
): D406FiledParty {
  return reader.scope(node, path, (c) => {
    const company = c.read('CompanyStructure', (el, p) =>
      reader.scope(el, p, (cc) => {
        const fields = definedFields({
          registrationNumber: cc.text('RegistrationNumber'),
          name: cc.text('Name'),
          address: cc.read('Address', (a, ap) => readAddress(reader, a, ap)),
        });
        if (
          fields.registrationNumber === undefined &&
          fields.name === undefined &&
          fields.address === undefined
        ) {
          reader.bumpPath(p);
        }
        return fields;
      }),
    );
    return definedFields({
      id: c.text(idElement),
      registrationNumber: company?.registrationNumber,
      name: company?.name,
      address: company?.address,
      account: c.text('AccountID'),
      openingDebit: c.text('OpeningDebitBalance'),
      openingCredit: c.text('OpeningCreditBalance'),
      closingDebit: c.text('ClosingDebitBalance'),
      closingCredit: c.text('ClosingCreditBalance'),
    });
  });
}

function readAssetSupplier(
  reader: XmlReader,
  node: XmlElement,
  path: string,
): D406FiledAssetSupplier {
  return reader.scope(node, path, (c) =>
    definedFields({
      id: c.text('SupplierID'),
      name: c.text('SupplierName'),
      address: c.read('PostalAddress', (el, p) => readAddress(reader, el, p)),
    }),
  );
}

function decodeSide(raw: string | undefined): { side?: 'debit' | 'credit'; rawSide?: string } {
  if (raw === undefined) return {};
  if (raw === 'D') return { side: 'debit' };
  if (raw === 'C') return { side: 'credit' };
  return { rawSide: raw };
}

function readHeader(reader: XmlReader, node: XmlElement, path: string): D406FiledHeader {
  return reader.scope(node, path, (c) => {
    const company = c.read('Company', (el, p) =>
      reader.scope(el, p, (cc) => ({
        ...definedFields({
          registrationNumber: cc.text('RegistrationNumber'),
          name: cc.text('Name'),
          address: cc.read('Address', (a, ap) => readAddress(reader, a, ap)),
          contact: cc.read('Contact', (ct, cp) =>
            reader.scope(ct, cp, (ctc) => {
              const person = ctc.read('ContactPerson', (pe, pp) =>
                reader.scope(pe, pp, (pc) => {
                  const fields = definedFields({
                    firstName: pc.text('FirstName'),
                    lastName: pc.text('LastName'),
                  });
                  if (fields.firstName === undefined && fields.lastName === undefined) {
                    reader.bumpPath(pp);
                  }
                  return fields;
                }),
              );
              return definedFields({
                firstName: person?.firstName,
                lastName: person?.lastName,
                phone: ctc.text('Telephone'),
                email: ctc.text('Email'),
              });
            }),
          ),
        }),
        taxRegistrations: cc.readMany('TaxRegistration', (tr, tp) =>
          reader.scope(tr, tp, (trc) =>
            definedFields({
              registrationNumber: trc.text('TaxRegistrationNumber'),
              taxType: trc.text('TaxType'),
              taxAuthority: trc.text('TaxAuthority'),
            }),
          ),
        ),
        ibans: cc
          .readMany('BankAccount', (ba, bp) =>
            reader.scope(ba, bp, (bac) => {
              const iban = bac.text('IBANNumber');
              if (iban === undefined) reader.bumpPath(bp);
              return iban;
            }),
          )
          .filter((iban): iban is string => iban !== undefined),
      })),
    ) ?? { taxRegistrations: [], ibans: [] };

    const selection =
      c.read('SelectionCriteria', (el, p) =>
        reader.scope(el, p, (sc) =>
          definedFields({
            start: sc.text('SelectionStartDate'),
            end: sc.text('SelectionEndDate'),
          }),
        ),
      ) ?? {};

    return definedFields({
      version: c.text('AuditFileVersion'),
      country: c.text('AuditFileCountry'),
      region: c.text('AuditFileRegion'),
      created: c.text('AuditFileDateCreated'),
      software: definedFields({
        company: c.text('SoftwareCompanyName'),
        name: c.text('SoftwareID'),
        version: c.text('SoftwareVersion'),
      }),
      company,
      defaultCurrency: c.text('DefaultCurrencyCode'),
      selection,
      type: c.text('HeaderComment'),
      segmentIndex: c.text('SegmentIndex'),
      totalSegments: c.text('TotalSegmentsInsequence'),
      taxAccountingBasis: c.text('TaxAccountingBasis'),
    });
  });
}

function readMasterFiles(reader: XmlReader, node: XmlElement, path: string): D406FiledMasterFiles {
  return reader.scope(node, path, (c) => {
    const accounts =
      c.read('GeneralLedgerAccounts', (el, p) =>
        reader.scope(el, p, (ac) =>
          ac.readMany('Account', (acc, ap) =>
            reader.scope(acc, ap, (lc) =>
              definedFields({
                id: lc.text('AccountID'),
                description: lc.text('AccountDescription'),
                standard: lc.text('StandardAccountID'),
                type: lc.text('AccountType'),
                openingDebit: lc.text('OpeningDebitBalance'),
                openingCredit: lc.text('OpeningCreditBalance'),
                closingDebit: lc.text('ClosingDebitBalance'),
                closingCredit: lc.text('ClosingCreditBalance'),
              }),
            ),
          ),
        ),
      ) ?? [];

    const customers =
      c.read('Customers', (el, p) =>
        reader.scope(el, p, (cc) =>
          cc.readMany('Customer', (cu, cp) => readParty(reader, cu, cp, 'CustomerID')),
        ),
      ) ?? [];

    const suppliers =
      c.read('Suppliers', (el, p) =>
        reader.scope(el, p, (sc) =>
          sc.readMany('Supplier', (su, sp) => readParty(reader, su, sp, 'SupplierID')),
        ),
      ) ?? [];

    const taxTable =
      c.read('TaxTable', (el, p) =>
        reader.scope(el, p, (tc) =>
          tc.readMany('TaxTableEntry', (entry, ep) =>
            reader.scope(entry, ep, (ec) =>
              definedFields({
                type: ec.text('TaxType'),
                description: ec.text('Description'),
                codes: ec.readMany('TaxCodeDetails', (det, dp) =>
                  reader.scope(det, dp, (dc) =>
                    definedFields({
                      code: dc.text('TaxCode'),
                      description: dc.text('Description'),
                      percentage: dc.text('TaxPercentage'),
                      baseRates: dc.texts('BaseRate'),
                      country: dc.text('Country'),
                    }),
                  ),
                ),
              }),
            ),
          ),
        ),
      ) ?? [];

    const unitsList =
      c.read('UOMTable', (el, p) =>
        reader.scope(el, p, (uc) =>
          uc.readMany('UOMTableEntry', (entry, ep) =>
            reader.scope(entry, ep, (ec) =>
              definedFields({
                unit: ec.text('UnitOfMeasure'),
                description: ec.text('Description'),
              }),
            ),
          ),
        ),
      ) ?? [];

    const analysisTypes = c.read('AnalysisTypeTable', (el, p) =>
      reader.scope(el, p, (ac) =>
        ac.readMany('AnalysisTypeTableEntry', (entry, ep) =>
          reader.scope(entry, ep, (ec) =>
            definedFields({
              type: ec.text('AnalysisType'),
              typeDescription: ec.text('AnalysisTypeDescription'),
              id: ec.text('AnalysisID'),
              idDescription: ec.text('AnalysisIDDescription'),
            }),
          ),
        ),
      ),
    );

    const movementTypes = c.read('MovementTypeTable', (el, p) =>
      reader.scope(el, p, (mc) =>
        mc.readMany('MovementTypeTableEntry', (entry, ep) =>
          reader.scope(entry, ep, (ec) =>
            definedFields({
              type: ec.text('MovementType'),
              description: ec.text('Description'),
            }),
          ),
        ),
      ),
    );

    const products =
      c.read('Products', (el, p) =>
        reader.scope(el, p, (pc) =>
          pc.readMany('Product', (prod, pp) =>
            reader.scope(prod, pp, (dc) =>
              definedFields({
                code: dc.text('ProductCode'),
                kind: dc.text('GoodsServicesID'),
                description: dc.text('Description'),
                commodityCode: dc.text('ProductCommodityCode'),
                valuationMethod: dc.text('ValuationMethod'),
                uomBase: dc.text('UOMBase'),
                uomStandard: dc.text('UOMStandard'),
                conversionFactor: dc.text('UOMToUOMBaseConversionFactor'),
              }),
            ),
          ),
        ),
      ) ?? [];

    const owners = c.read('Owners', (el, p) =>
      reader.scope(el, p, (oc) =>
        oc.readMany('Owner', (owner, op) =>
          reader.scope(owner, op, (lc) => {
            const company = lc.read('CompanyStructure', (cs, csp) =>
              reader.scope(cs, csp, (csc) => {
                const fields = definedFields({
                  registrationNumber: csc.text('RegistrationNumber'),
                  name: csc.text('Name'),
                  address: csc.read('Address', (a, ap) => readAddress(reader, a, ap)),
                });
                if (
                  fields.registrationNumber === undefined &&
                  fields.name === undefined &&
                  fields.address === undefined
                ) {
                  reader.bumpPath(csp);
                }
                return fields;
              }),
            );
            return definedFields({
              id: lc.text('OwnerID'),
              registrationNumber: company?.registrationNumber,
              name: company?.name,
              address: company?.address,
              account: lc.text('AccountID'),
            });
          }),
        ),
      ),
    );

    const assets = c.read('Assets', (el, p) =>
      reader.scope(el, p, (ac) =>
        ac.readMany('Asset', (asset, ap) =>
          reader.scope(asset, ap, (lc) =>
            definedFields({
              id: lc.text('AssetID'),
              account: lc.text('AccountID'),
              description: lc.text('Description'),
              supplier: lc.read('AssetSupplier', (s, sp) => readAssetSupplier(reader, s, sp)),
              acquired: lc.text('DateOfAcquisition'),
              commissioned: lc.text('StartUpDate'),
              valuations:
                lc.read('Valuations', (vs, vsp) =>
                  reader.scope(vs, vsp, (vsc) =>
                    vsc.readMany('Valuation', (val, vp) =>
                      reader.scope(val, vp, (vc) => {
                        const extraordinary = vc.read(
                          'ExtraordinaryDepreciationsForPeriod',
                          (ed, edp) =>
                            reader.scope(ed, edp, (edc) =>
                              edc.readMany('ExtraordinaryDepreciationForPeriod', (item, ip) =>
                                reader.scope(item, ip, (ic) =>
                                  definedFields({
                                    method: ic.text('ExtraordinaryDepreciationMethod'),
                                    amount: ic.text('ExtraordinaryDepreciationAmountForPeriod'),
                                  }),
                                ),
                              ),
                            ),
                        );
                        return definedFields({
                          valuationType: vc.text('AssetValuationType'),
                          valuationClass: vc.text('ValuationClass'),
                          costBegin: vc.text('AcquisitionAndProductionCostsBegin'),
                          costEnd: vc.text('AcquisitionAndProductionCostsEnd'),
                          investmentSupport: vc.text('InvestmentSupport'),
                          lifeYears: vc.text('AssetLifeYear'),
                          lifeMonths: vc.text('AssetLifeMonth'),
                          addition: vc.text('AssetAddition'),
                          transfers: vc.text('Transfers'),
                          disposal: vc.text('AssetDisposal'),
                          bookValueBegin: vc.text('BookValueBegin'),
                          depreciationMethod: vc.text('DepreciationMethod'),
                          depreciationPercentage: vc.text('DepreciationPercentage'),
                          depreciationForPeriod: vc.text('DepreciationForPeriod'),
                          appreciationForPeriod: vc.text('AppreciationForPeriod'),
                          extraordinaryDepreciations: extraordinary,
                          accumulatedDepreciation: vc.text('AccumulatedDepreciation'),
                          bookValueEnd: vc.text('BookValueEnd'),
                        });
                      }),
                    ),
                  ),
                ) ?? [],
            }),
          ),
        ),
      ),
    );

    const physicalStock = c.read('PhysicalStock', (el, p) =>
      reader.scope(el, p, (pc) =>
        pc.readMany('PhysicalStockEntry', (entry, ep) =>
          reader.scope(entry, ep, (ec) => {
            const characteristics = ec.readMany('StockCharacteristics', (sc, sp) =>
              reader.scope(sc, sp, (scc) =>
                definedFields({
                  characteristic: scc.text('StockCharacteristic'),
                  value: scc.text('StockCharacteristicValue'),
                }),
              ),
            );
            return definedFields({
              warehouse: ec.text('WarehouseID'),
              product: ec.text('ProductCode'),
              lot: ec.text('StockAccountNo'),
              type: ec.text('ProductType'),
              commodityCode: ec.text('StockAccountCommodityCode'),
              owner: ec.text('OwnerID'),
              unit: ec.text('UOMPhysicalStock'),
              conversionFactor: ec.text('UOMToUOMBaseConversionFactor'),
              unitPrice: ec.text('UnitPrice'),
              openingQuantity: ec.text('OpeningStockQuantity'),
              openingValue: ec.text('OpeningStockValue'),
              closingQuantity: ec.text('ClosingStockQuantity'),
              closingValue: ec.text('ClosingStockValue'),
              ...(characteristics.length > 0 ? { characteristics } : {}),
            });
          }),
        ),
      ),
    );

    return definedFields({
      accounts,
      customers,
      suppliers,
      taxTable,
      units: unitsList,
      analysisTypes,
      movementTypes,
      products,
      owners,
      assets,
      physicalStock,
    });
  });
}

function readGeneralLedger(
  reader: XmlReader,
  node: XmlElement,
  path: string,
): D406FiledGeneralLedger {
  return reader.scope(node, path, (c) =>
    definedFields({
      numberOfEntries: c.text('NumberOfEntries'),
      totalDebit: c.text('TotalDebit'),
      totalCredit: c.text('TotalCredit'),
      journals: c.readMany('Journal', (j, jp) =>
        reader.scope(j, jp, (jc) =>
          definedFields({
            id: jc.text('JournalID'),
            description: jc.text('Description'),
            type: jc.text('Type'),
            transactions: jc.readMany('Transaction', (t, tp) =>
              reader.scope(t, tp, (tc) =>
                definedFields({
                  id: tc.text('TransactionID'),
                  period: tc.text('Period'),
                  periodYear: tc.text('PeriodYear'),
                  date: tc.text('TransactionDate'),
                  source: tc.text('SourceID'),
                  description: tc.text('Description'),
                  entered: tc.text('SystemEntryDate'),
                  posted: tc.text('GLPostingDate'),
                  customer: tc.text('CustomerID'),
                  supplier: tc.text('SupplierID'),
                  lines: tc.readMany('TransactionLine', (l, lp) =>
                    reader.scope(l, lp, (lc) => {
                      const bothSides = lc.has('DebitAmount') && lc.has('CreditAmount');
                      const debit = !bothSides
                        ? lc.read('DebitAmount', (a, ap) => readAmount(reader, a, ap))
                        : undefined;
                      const credit = !bothSides
                        ? lc.read('CreditAmount', (a, ap) => readAmount(reader, a, ap))
                        : undefined;
                      const taxes = lc.readMany('TaxInformation', (ti, tip) =>
                        readTax(reader, ti, tip),
                      );
                      const side = debit ? 'debit' : credit ? 'credit' : undefined;
                      const amount = debit ?? credit;
                      return definedFields({
                        id: lc.text('RecordID'),
                        account: lc.text('AccountID'),
                        document: lc.text('SourceDocumentID'),
                        customer: lc.text('CustomerID'),
                        supplier: lc.text('SupplierID'),
                        description: lc.text('Description'),
                        side,
                        amount,
                        ...(taxes.length > 0 ? { tax: taxes } : {}),
                      });
                    }),
                  ),
                }),
              ),
            ),
          }),
        ),
      ),
    }),
  );
}

function readInvoicesSection(
  reader: XmlReader,
  node: XmlElement,
  path: string,
  sales: boolean,
): D406FiledInvoicesSection {
  const infoTag = sales ? 'CustomerInfo' : 'SupplierInfo';
  const partyTag = sales ? 'CustomerID' : 'SupplierID';
  return reader.scope(node, path, (c) =>
    definedFields({
      numberOfEntries: c.text('NumberOfEntries'),
      totalDebit: c.text('TotalDebit'),
      totalCredit: c.text('TotalCredit'),
      invoices: c.readMany('Invoice', (inv, ip) =>
        reader.scope(inv, ip, (ic) =>
          definedFields({
            number: ic.text('InvoiceNo'),
            party: ic.read(infoTag, (pi, pp) =>
              reader.scope(pi, pp, (pc) =>
                definedFields({
                  id: pc.text(partyTag),
                  billingAddress: pc.read('BillingAddress', (ba, bp) =>
                    readAddress(reader, ba, bp),
                  ),
                }),
              ),
            ),
            account: ic.text('AccountID'),
            period: ic.text('Period'),
            periodYear: ic.text('PeriodYear'),
            date: ic.text('InvoiceDate'),
            type: ic.text('InvoiceType'),
            paymentTerms: ic.text('PaymentTerms'),
            selfBilling: ic.text('SelfBillingIndicator'),
            transaction: ic.text('TransactionID'),
            lines: ic.readMany('InvoiceLine', (line, lp) =>
              reader.scope(line, lp, (lc) =>
                definedFields({
                  lineNumber: lc.text('LineNumber'),
                  account: lc.text('AccountID'),
                  goodsServicesId: lc.text('GoodsServicesID'),
                  product: lc.text('ProductCode'),
                  productDescription: lc.text('ProductDescription'),
                  quantity: lc.text('Quantity'),
                  unit: lc.text('InvoiceUOM'),
                  unitPrice: lc.text('UnitPrice'),
                  taxPointDate: lc.text('TaxPointDate'),
                  description: lc.text('Description'),
                  amount: lc.read('InvoiceLineAmount', (a, ap) => readAmount(reader, a, ap)),
                  ...decodeSide(lc.text('DebitCreditIndicator')),
                  tax: lc.readMany('TaxInformation', (ti, tip) => readTax(reader, ti, tip)),
                }),
              ),
            ),
            totals: ic.read('InvoiceDocumentTotals', (tot, tp) =>
              reader.scope(tot, tp, (tc) =>
                definedFields({
                  taxes: tc.readMany('TaxInformationTotals', (ti, tip) => readTax(reader, ti, tip)),
                  netTotal: tc.text('NetTotal'),
                  grossTotal: tc.text('GrossTotal'),
                }),
              ),
            ),
          }),
        ),
      ),
    }),
  );
}

function readPaymentsSection(
  reader: XmlReader,
  node: XmlElement,
  path: string,
): D406FiledPaymentsSection {
  return reader.scope(node, path, (c) =>
    definedFields({
      numberOfEntries: c.text('NumberOfEntries'),
      totalDebit: c.text('TotalDebit'),
      totalCredit: c.text('TotalCredit'),
      payments: c.readMany('Payment', (pay, pp) =>
        reader.scope(pay, pp, (pc) => {
          const mechanism = pc.read('PaymentSettlement', (ps, psp) =>
            reader.scope(ps, psp, (psc) => {
              const value = psc.text('PaymentMechanism');
              if (value === undefined) reader.bumpPath(psp);
              return value;
            }),
          );
          return definedFields({
            reference: pc.text('PaymentRefNo'),
            period: pc.text('Period'),
            periodYear: pc.text('PeriodYear'),
            transaction: pc.text('TransactionID'),
            date: pc.text('TransactionDate'),
            method: pc.text('PaymentMethod'),
            mechanism,
            description: pc.text('Description'),
            lines: pc.readMany('PaymentLine', (line, lp) =>
              reader.scope(line, lp, (lc) => {
                const taxes = lc.readMany('TaxInformation', (ti, tip) => readTax(reader, ti, tip));
                return definedFields({
                  lineNumber: lc.text('LineNumber'),
                  document: lc.text('SourceDocumentID'),
                  account: lc.text('AccountID'),
                  customer: lc.text('CustomerID'),
                  supplier: lc.text('SupplierID'),
                  description: lc.text('Description'),
                  ...decodeSide(lc.text('DebitCreditIndicator')),
                  amount: lc.read('PaymentLineAmount', (a, ap) => readAmount(reader, a, ap)),
                  ...(taxes.length > 0 ? { tax: taxes } : {}),
                });
              }),
            ),
            totals: pc.read('PaymentDocumentTotals', (tot, tp) =>
              reader.scope(tot, tp, (tc) => definedFields({ grossTotal: tc.text('GrossTotal') })),
            ),
          });
        }),
      ),
    }),
  );
}

function readSourceDocuments(
  reader: XmlReader,
  node: XmlElement,
  path: string,
): D406FiledSourceDocuments {
  return reader.scope(node, path, (c) =>
    definedFields({
      salesInvoices: c.read('SalesInvoices', (el, p) => readInvoicesSection(reader, el, p, true)),
      purchaseInvoices: c.read('PurchaseInvoices', (el, p) =>
        readInvoicesSection(reader, el, p, false),
      ),
      payments: c.read('Payments', (el, p) => readPaymentsSection(reader, el, p)),
      movementOfGoods: c.read('MovementOfGoods', (el, p) =>
        reader.scope(el, p, (mc) =>
          definedFields({
            numberOfMovementLines: mc.text('NumberOfMovementLines'),
            totalQuantityReceived: mc.text('TotalQuantityReceived'),
            totalQuantityIssued: mc.text('TotalQuantityIssued'),
            movements: mc.readMany('StockMovement', (sm, sp) =>
              reader.scope(sm, sp, (sc) =>
                definedFields({
                  reference: sc.text('MovementReference'),
                  date: sc.text('MovementDate'),
                  type: sc.text('MovementType'),
                  document: sc.read('DocumentReference', (dr, drp) =>
                    reader.scope(dr, drp, (dc) =>
                      definedFields({
                        type: dc.text('DocumentType'),
                        number: dc.text('DocumentNumber'),
                      }),
                    ),
                  ),
                  lines: sc.readMany('StockMovementLine', (sml, smlp) =>
                    reader.scope(sml, smlp, (lc) =>
                      definedFields({
                        lineNumber: lc.text('LineNumber'),
                        account: lc.text('AccountID'),
                        transaction: lc.text('TransactionID'),
                        customer: lc.text('CustomerID'),
                        supplier: lc.text('SupplierID'),
                        product: lc.text('ProductCode'),
                        lot: lc.text('StockAccountNo'),
                        quantity: lc.text('Quantity'),
                        unit: lc.text('UnitOfMeasure'),
                        conversionFactor: lc.text('UOMToUOMPhysicalStockConversionFactor'),
                        bookValue: lc.text('BookValue'),
                        subType: lc.text('MovementSubType'),
                        comments: lc.text('MovementComments'),
                      }),
                    ),
                  ),
                }),
              ),
            ),
          }),
        ),
      ),
      assetTransactions: c.read('AssetTransactions', (el, p) =>
        reader.scope(el, p, (ac) =>
          definedFields({
            numberOfAssetTransactions: ac.text('NumberOfAssetTransactions'),
            transactions: ac.readMany('AssetTransaction', (at, atp) =>
              reader.scope(at, atp, (atc) =>
                definedFields({
                  id: atc.text('AssetTransactionID'),
                  asset: atc.text('AssetID'),
                  type: atc.text('AssetTransactionType'),
                  description: atc.text('Description'),
                  date: atc.text('AssetTransactionDate'),
                  supplier: atc.read('AssetSupplier', (s, sp) => readAssetSupplier(reader, s, sp)),
                  transaction: atc.text('TransactionID'),
                  valuations:
                    atc.read('AssetTransactionValuations', (vs, vsp) =>
                      reader.scope(vs, vsp, (vsc) =>
                        vsc.readMany('AssetTransactionValuation', (val, vp) =>
                          reader.scope(val, vp, (vc) =>
                            definedFields({
                              valuationType: vc.text('AssetValuationType'),
                              cost: vc.text('AcquisitionAndProductionCostsOnTransaction'),
                              bookValue: vc.text('BookValueOnTransaction'),
                              amount: vc.text('AssetTransactionAmount'),
                            }),
                          ),
                        ),
                      ),
                    ) ?? [],
                }),
              ),
            ),
          }),
        ),
      ),
    }),
  );
}

/**
 * Reads a filed D406 (SAF-T) XML document into a lossless representation (`D406Filed`),
 * preserving decimal strings as written, keeping absent optional elements absent, and
 * listing every unmodeled element path with its occurrence count in `unread`.
 */
export function readD406(bytes: Uint8Array): D406Filed {
  const root = sourceXml(bytes, { maxNodes: MAX_SAFT_NODES, namespacedAttributes: true });
  requireCondition(
    root.local === 'AuditFile' && root.uri === d406Namespace,
    'D406_FORMAT',
    'Documentul XML nu este un fișier D406 (AuditFile în namespace-ul mfp:anaf:dgti:d406:declaratie:v1).',
  );
  const reader = new XmlReader();
  const parsed = reader.scope(root, 'AuditFile', (c) => ({
    header: c.read('Header', (el, p) => readHeader(reader, el, p)) ?? {
      software: {},
      company: { taxRegistrations: [], ibans: [] },
      selection: {},
    },
    masterFiles: c.read('MasterFiles', (el, p) => readMasterFiles(reader, el, p)) ?? {
      accounts: [],
      customers: [],
      suppliers: [],
      taxTable: [],
      units: [],
      products: [],
    },
    generalLedgerEntries: c.read('GeneralLedgerEntries', (el, p) =>
      readGeneralLedger(reader, el, p),
    ) ?? { journals: [] },
    sourceDocuments: c.read('SourceDocuments', (el, p) => readSourceDocuments(reader, el, p)) ?? {},
  }));
  return {
    namespace: root.uri,
    ...parsed,
    unread: reader.unread(),
  };
}

function tryBani(value: string | undefined): bigint | undefined {
  if (value === undefined) return undefined;
  try {
    return parseScaled(value, 2);
  } catch {
    return undefined;
  }
}

function tryCanonicalDecimal(value: string): string | undefined {
  try {
    parseDecimal(value);
    const stripped = value.includes('.') ? value.replace(/\.?0+$/, '') : value;
    return stripped === '-0' ? '0' : stripped;
  } catch {
    return undefined;
  }
}

function checkedScaled(
  value: string | undefined,
  scale: number,
  path: string,
  problems: D406FiledProblem[],
  code: string,
  label: string,
): bigint | undefined {
  if (value !== undefined) {
    try {
      return parseScaled(value, scale);
    } catch {
      // Reported below as an invalid decimal.
    }
  }
  problems.push({
    code,
    path,
    message:
      value === undefined
        ? `${label} lipsește.`
        : `${label} (${value}) nu este un decimal valid cu cel mult ${scale} zecimale.`,
  });
  return undefined;
}

const checkedBani = (
  value: string | undefined,
  path: string,
  problems: D406FiledProblem[],
  label = 'Suma',
) => checkedScaled(value, 2, path, problems, 'D406_AMOUNT', label);

const fmtBani = (bani: bigint) => formatScaled(bani, 2);

function sumLedgerTransaction(
  transaction: D406FiledTransaction,
  txPath: string,
  problems: D406FiledProblem[],
): { debit: bigint; credit: bigint; valid: boolean } {
  let debit = 0n;
  let credit = 0n;
  let valid = true;
  transaction.lines.forEach((line, l) => {
    const linePath = `${txPath}.lines.${l}`;
    const cents = checkedBani(
      line.amount?.amount,
      line.amount ? `${linePath}.amount.amount` : `${linePath}.amount`,
      problems,
      `Suma liniei ${line.id ?? l + 1}`,
    );
    if (cents === undefined) valid = false;
    if (line.side === 'debit') {
      if (cents !== undefined) debit += cents;
    } else if (line.side === 'credit') {
      if (cents !== undefined) credit += cents;
    } else {
      valid = false;
      problems.push({
        code: 'D406_SIDE',
        path: `${linePath}.side`,
        message: 'Linia din registrul jurnal nu indică debitul sau creditul.',
      });
    }
  });
  return { debit, credit, valid };
}

function parseTaxEntry(
  tax: D406FiledTax,
  tPath: string,
  fallbackBase: bigint | undefined,
  problems: D406FiledProblem[],
): { amount: bigint | undefined; base: bigint | undefined; pctKey: string; pctValid: boolean } {
  const amount = checkedBani(tax.amount, `${tPath}.amount`, problems, 'Suma taxei');
  const base =
    tax.base !== undefined
      ? checkedBani(tax.base, `${tPath}.base`, problems, 'Baza taxei')
      : fallbackBase;
  let pctKey = '';
  let pctValid = true;
  if (tax.percentage !== undefined) {
    const normalized = tryCanonicalDecimal(tax.percentage);
    if (normalized === undefined) {
      pctValid = false;
      problems.push({
        code: 'D406_TAX_PERCENTAGE',
        path: `${tPath}.percentage`,
        message: `Cota de taxă (${tax.percentage}) nu este un decimal valid.`,
      });
    } else {
      pctKey = normalized;
    }
  }
  return { amount, base, pctKey, pctValid };
}

function addTaxEntry(
  map: Map<string, { base: bigint; amount: bigint }>,
  tax: D406FiledTax,
  pctKey: string,
  sign: bigint,
  base: bigint,
  amount: bigint,
): void {
  const taxKey = `${tax.type ?? ''}|${tax.code ?? ''}|${pctKey}`;
  const prev = map.get(taxKey) ?? { base: 0n, amount: 0n };
  prev.base += sign * base;
  prev.amount += sign * amount;
  map.set(taxKey, prev);
}

function pairedVatCodesMatch(dedCode: string, nondedCode: string): boolean {
  const dedReadings = d406CodeReadings(dedCode);
  const nondedReadings = d406CodeReadings(nondedCode);
  return dedReadings.some(
    (dr) =>
      'direction' in dr &&
      dr.direction === 'input' &&
      dr.deduction === 'full' &&
      nondedReadings.some(
        (nr) =>
          'direction' in nr &&
          nr.direction === 'input' &&
          nr.deduction === 'none' &&
          dr.source === nr.source &&
          dr.code === nr.code &&
          (dr.rate ?? undefined) === (nr.rate ?? undefined) &&
          (dr.cashVat ?? false) === (nr.cashVat ?? false) &&
          (dr.distance ?? false) === (nr.distance ?? false) &&
          (dr.special ?? false) === (nr.special ?? false),
      ),
  );
}

function expectedVatAmount(base: bigint, ratePct: string): bigint {
  const pctRatio = parseDecimal(ratePct);
  return roundRatio(
    {
      numerator: base * pctRatio.numerator,
      denominator: pctRatio.denominator * 100n,
    },
    0,
    'halfAwayFromZero',
  );
}

type VatBlockParsed = {
  tax: D406FiledTax;
  amount: bigint | undefined;
  base: bigint | undefined;
  pctValid: boolean;
};

/**
 * Resolves the VAT total on a purchase line that carries both 30xxxx (deductible) and 35xxxx
 * (non-deductible) blocks. Overlap vs split is decided from rate/base/amount evidence against
 * `expectedVatAmount` and code compatibility via `d406CodeReadings`, never from equal amounts
 * alone; otherwise `D406_TAX_PAIR` is reported.
 */
function resolvePairedPurchaseVat(
  vatBlocks: VatBlockParsed[],
  lineNet: bigint | undefined,
  taxPath: string,
  problems: D406FiledProblem[],
): bigint | undefined {
  const failPair = (message: string) => {
    problems.push({ code: 'D406_TAX_PAIR', path: taxPath, message });
    return undefined;
  };
  if (vatBlocks.length !== 2) {
    return failPair('Linia combină mai mult de două blocuri de TVA 30xxxx și 35xxxx.');
  }
  const ded = vatBlocks.find((b) => /^30\d{4}$/.test(b.tax.code ?? ''));
  const nonded = vatBlocks.find((b) => /^35\d{4}$/.test(b.tax.code ?? ''));
  if (!ded || !nonded) {
    return failPair('Blocurile de TVA nu formează o pereche 30xxxx și 35xxxx.');
  }
  if (
    ded.amount === undefined ||
    nonded.amount === undefined ||
    (ded.tax.base !== undefined && ded.base === undefined) ||
    (nonded.tax.base !== undefined && nonded.base === undefined) ||
    !ded.pctValid ||
    !nonded.pctValid ||
    (lineNet === undefined && (ded.base === undefined || nonded.base === undefined))
  ) {
    return undefined;
  }
  if (!pairedVatCodesMatch(ded.tax.code!, nonded.tax.code!)) {
    return failPair(
      `Codurile de TVA ${ded.tax.code} și ${nonded.tax.code} nu formează o pereche deductibil/nedeductibil pentru aceeași cotă.`,
    );
  }
  const blockRate = (b: VatBlockParsed): string | undefined => {
    const nomPct = vatTaxCodes[b.tax.code!]?.percentage ?? undefined;
    const statedPct =
      b.tax.percentage !== undefined ? tryCanonicalDecimal(b.tax.percentage) : undefined;
    if (statedPct !== undefined && nomPct !== undefined && statedPct !== nomPct) return undefined;
    return statedPct ?? nomPct;
  };
  const pctDed = blockRate(ded);
  const pctNonded = blockRate(nonded);
  if (pctDed === undefined || pctNonded === undefined || pctDed !== pctNonded) {
    return failPair('Blocurile de TVA deductibil și nedeductibil au cote lipsă sau diferite.');
  }
  const effBaseDed = ded.base ?? lineNet!;
  const effBaseNonded = nonded.base ?? lineNet!;
  const abs = (x: bigint) => (x < 0n ? -x : x);

  // Disjoint bases partitioning the line net amount (each block applies the rate to its own base).
  if (
    ded.tax.base !== undefined &&
    nonded.tax.base !== undefined &&
    lineNet !== undefined &&
    effBaseDed + effBaseNonded === lineNet &&
    (effBaseDed !== lineNet || effBaseNonded !== lineNet)
  ) {
    const expDed = expectedVatAmount(effBaseDed, pctDed);
    const expNonded = expectedVatAmount(effBaseNonded, pctDed);
    if (abs(ded.amount - expDed) <= 1n && abs(nonded.amount - expNonded) <= 1n) {
      return ded.amount + nonded.amount;
    }
    return failPair(
      'Nu se poate stabili suma unică de TVA din blocurile 30xxxx și 35xxxx ale liniei.',
    );
  }

  if (effBaseDed !== effBaseNonded) {
    return failPair('Blocurile de TVA 30xxxx și 35xxxx au baze diferite care nu însumează linia.');
  }

  const expected = expectedVatAmount(effBaseDed, pctDed);
  if (ded.amount === expected && nonded.amount === expected) {
    // Overlapping disclosure of the full VAT under both codes: count once.
    return ded.amount;
  }
  const sum = ded.amount + nonded.amount;
  if (sum === expected) {
    // Split of one VAT amount between deductible and non-deductible parts: count both.
    return sum;
  }
  const isOverlapTol =
    ded.amount === nonded.amount && abs(ded.amount - expected) <= 1n && ded.amount !== 0n;
  const isSplitTol = abs(sum - expected) <= 1n && ded.amount !== 0n && nonded.amount !== 0n;
  if (isOverlapTol && !isSplitTol) return ded.amount;
  if (isSplitTol && !isOverlapTol) return sum;

  return failPair(
    'Nu se poate stabili suma unică de TVA din blocurile 30xxxx și 35xxxx ale liniei.',
  );
}

/**
 * Checks that the sum of debits equals the sum of credits in every journal transaction and
 * across the entire general ledger.
 */
export function checkD406Balances(filed: D406Filed): D406FiledProblem[] {
  const problems: D406FiledProblem[] = [];
  let fileDebit = 0n;
  let fileCredit = 0n;
  let fileValid = true;

  filed.generalLedgerEntries.journals.forEach((journal, j) => {
    journal.transactions.forEach((transaction, t) => {
      const txPath = `generalLedgerEntries.journals.${j}.transactions.${t}`;
      const { debit, credit, valid } = sumLedgerTransaction(transaction, txPath, problems);
      if (valid) {
        if (debit !== credit) {
          const diff = debit > credit ? debit - credit : credit - debit;
          problems.push({
            code: 'D406_UNBALANCED',
            path: txPath,
            message: `Nota ${transaction.id ?? t + 1} nu este echilibrată: debitul (${fmtBani(debit)}) diferă de credit (${fmtBani(credit)}) cu ${fmtBani(diff)} lei.`,
          });
        }
        fileDebit += debit;
        fileCredit += credit;
      } else {
        fileValid = false;
        problems.push({
          code: 'D406_TOTAL_UNCHECKED',
          path: txPath,
          message: `Echilibrul notei ${transaction.id ?? t + 1} nu a putut fi verificat din cauza unei linii cu date lipsă sau invalide.`,
        });
      }
    });
  });

  if (!fileValid) {
    problems.push({
      code: 'D406_TOTAL_UNCHECKED',
      path: 'generalLedgerEntries',
      message:
        'Echilibrul registrului jurnal pe fișier nu a putut fi verificat din cauza unor linii cu date lipsă sau invalide.',
    });
  } else if (fileDebit !== fileCredit) {
    const diff = fileDebit > fileCredit ? fileDebit - fileCredit : fileCredit - fileDebit;
    problems.push({
      code: 'D406_FILE_UNBALANCED',
      path: 'generalLedgerEntries',
      message: `Registrul jurnal nu este echilibrat pe fișier: total debit (${fmtBani(fileDebit)}) diferă de total credit (${fmtBani(fileCredit)}) cu ${fmtBani(diff)} lei.`,
    });
  }
  return problems;
}

/**
 * Checks that every stated total and entry count in the file matches the sum of its lines
 * and entries (GeneralLedgerEntries, SalesInvoices, PurchaseInvoices, Payments, MovementOfGoods,
 * AssetTransactions).
 */
export function checkD406Totals(filed: D406Filed): D406FiledProblem[] {
  const problems: D406FiledProblem[] = [];
  const mismatch = (path: string, label: string, stated: string, computed: string) =>
    problems.push({
      code: 'D406_TOTAL_MISMATCH',
      path,
      message: `${label} declarat (${stated}) diferă de suma calculată (${computed}).`,
    });
  const unchecked = (path: string, label: string) =>
    problems.push({
      code: 'D406_TOTAL_UNCHECKED',
      path,
      message: `${label} nu a putut fi verificat din cauza unei linii cu date lipsă sau invalide.`,
    });

  // GeneralLedgerEntries totals.
  let glDebit = 0n;
  let glCredit = 0n;
  let glTransactions = 0;
  let glLines = 0;
  let glValid = true;
  filed.generalLedgerEntries.journals.forEach((journal, j) => {
    journal.transactions.forEach((transaction, t) => {
      glTransactions += 1;
      glLines += transaction.lines.length;
      const txPath = `generalLedgerEntries.journals.${j}.transactions.${t}`;
      const { debit, credit, valid } = sumLedgerTransaction(transaction, txPath, problems);
      if (valid) {
        glDebit += debit;
        glCredit += credit;
      } else {
        glValid = false;
      }
    });
  });
  const gl = filed.generalLedgerEntries;
  if (gl.numberOfEntries !== undefined) {
    if (
      !/^\d+$/.test(gl.numberOfEntries) ||
      (Number(gl.numberOfEntries) !== glLines && Number(gl.numberOfEntries) !== glTransactions)
    ) {
      mismatch(
        'generalLedgerEntries.numberOfEntries',
        'NumberOfEntries (registrul jurnal)',
        gl.numberOfEntries,
        `${glLines} linii / ${glTransactions} tranzacții`,
      );
    }
  }
  if (gl.totalDebit !== undefined) {
    const stated = checkedBani(
      gl.totalDebit,
      'generalLedgerEntries.totalDebit',
      problems,
      'TotalDebit',
    );
    if (!glValid) unchecked('generalLedgerEntries.totalDebit', 'TotalDebit');
    else if (stated !== undefined && stated !== glDebit)
      mismatch('generalLedgerEntries.totalDebit', 'TotalDebit', gl.totalDebit, fmtBani(glDebit));
  }
  if (gl.totalCredit !== undefined) {
    const stated = checkedBani(
      gl.totalCredit,
      'generalLedgerEntries.totalCredit',
      problems,
      'TotalCredit',
    );
    if (!glValid) unchecked('generalLedgerEntries.totalCredit', 'TotalCredit');
    else if (stated !== undefined && stated !== glCredit)
      mismatch(
        'generalLedgerEntries.totalCredit',
        'TotalCredit',
        gl.totalCredit,
        fmtBani(glCredit),
      );
  }

  // SalesInvoices & PurchaseInvoices totals.
  for (const [key, normal] of [
    ['salesInvoices', 'credit'],
    ['purchaseInvoices', 'debit'],
  ] as const) {
    const section = filed.sourceDocuments[key];
    if (!section) continue;
    const sales = key === 'salesInvoices';
    const basePath = `sourceDocuments.${key}`;
    let secDebit = 0n;
    let secCredit = 0n;
    let secValid = true;
    if (
      section.numberOfEntries !== undefined &&
      (!/^\d+$/.test(section.numberOfEntries) ||
        Number(section.numberOfEntries) !== section.invoices.length)
    ) {
      mismatch(
        `${basePath}.numberOfEntries`,
        `NumberOfEntries (${key})`,
        section.numberOfEntries,
        String(section.invoices.length),
      );
    }
    section.invoices.forEach((invoice, i) => {
      const invPath = `${basePath}.invoices.${i}`;
      let net = 0n;
      let vat = 0n;
      let invNetValid = true;
      let invVatValid = true;
      let invTaxSummaryValid = true;
      const lineTaxes = new Map<string, { base: bigint; amount: bigint }>();
      invoice.lines.forEach((line, l) => {
        const lPath = `${invPath}.lines.${l}`;
        const cents = checkedBani(
          line.amount?.amount,
          line.amount ? `${lPath}.amount.amount` : `${lPath}.amount`,
          problems,
        );
        if (cents === undefined) {
          secValid = false;
          invNetValid = false;
          invVatValid = false;
          invTaxSummaryValid = false;
        }
        const sideValid =
          line.rawSide === undefined && (line.side === 'debit' || line.side === 'credit');
        if (!sideValid) {
          problems.push({
            code: 'D406_SIDE',
            path: `${lPath}.side`,
            message:
              line.rawSide !== undefined
                ? `DebitCreditIndicator invalid: ${line.rawSide}.`
                : 'DebitCreditIndicator lipsește.',
          });
          secValid = false;
          invNetValid = false;
          invVatValid = false;
          invTaxSummaryValid = false;
        } else if (line.side === 'debit') {
          if (cents !== undefined) secDebit += cents;
        } else {
          if (cents !== undefined) secCredit += cents;
        }
        const sign = line.side === normal ? 1n : -1n;
        if (cents !== undefined && sideValid) net += sign * cents;

        const vatBlocks: VatBlockParsed[] = [];
        line.tax.forEach((tax, tIdx) => {
          const tPath = `${lPath}.tax.${tIdx}`;
          const parsed = parseTaxEntry(tax, tPath, cents, problems);
          if (
            parsed.amount === undefined ||
            parsed.base === undefined ||
            !parsed.pctValid ||
            cents === undefined ||
            !sideValid
          ) {
            invTaxSummaryValid = false;
          } else {
            addTaxEntry(lineTaxes, tax, parsed.pctKey, sign, parsed.base, parsed.amount);
          }
          if (tax.type === '300') {
            vatBlocks.push({
              tax,
              amount: parsed.amount,
              base: parsed.base,
              pctValid: parsed.pctValid,
            });
          }
        });

        const hasDed = vatBlocks.some((b) => /^30\d{4}$/.test(b.tax.code ?? ''));
        const hasNonded = vatBlocks.some((b) => /^35\d{4}$/.test(b.tax.code ?? ''));
        if (!sales && hasDed && hasNonded) {
          const pairedVat = resolvePairedPurchaseVat(vatBlocks, cents, `${lPath}.tax`, problems);
          if (pairedVat === undefined) invVatValid = false;
          else if (sideValid) vat += sign * pairedVat;
        } else {
          for (const b of vatBlocks) {
            if (b.amount === undefined) invVatValid = false;
            else if (sideValid) vat += sign * b.amount;
          }
        }
      });

      if (invoice.totals) {
        if (invoice.totals.netTotal !== undefined) {
          const statedNet = checkedBani(
            invoice.totals.netTotal,
            `${invPath}.totals.netTotal`,
            problems,
            'NetTotal',
          );
          if (!invNetValid) unchecked(`${invPath}.totals.netTotal`, 'NetTotal');
          else if (statedNet !== undefined && statedNet !== net)
            mismatch(
              `${invPath}.totals.netTotal`,
              'NetTotal',
              invoice.totals.netTotal,
              fmtBani(net),
            );
        }
        if (invoice.totals.grossTotal !== undefined) {
          const statedGross = checkedBani(
            invoice.totals.grossTotal,
            `${invPath}.totals.grossTotal`,
            problems,
            'GrossTotal',
          );
          if (!invNetValid || !invVatValid) unchecked(`${invPath}.totals.grossTotal`, 'GrossTotal');
          else if (statedGross !== undefined && statedGross !== net + vat)
            mismatch(
              `${invPath}.totals.grossTotal`,
              'GrossTotal',
              invoice.totals.grossTotal,
              fmtBani(net + vat),
            );
        }
        const statedTaxes = new Map<string, { base: bigint; amount: bigint }>();
        let statedTaxesValid = true;
        invoice.totals.taxes.forEach((tax, tIdx) => {
          const tPath = `${invPath}.totals.taxes.${tIdx}`;
          const parsed = parseTaxEntry(tax, tPath, undefined, problems);
          if (parsed.base === undefined || parsed.amount === undefined || !parsed.pctValid) {
            statedTaxesValid = false;
          } else {
            addTaxEntry(statedTaxes, tax, parsed.pctKey, 1n, parsed.base, parsed.amount);
          }
        });
        if (!invTaxSummaryValid || !statedTaxesValid) {
          if (
            invoice.totals.taxes.length > 0 ||
            invoice.lines.some((line) => line.tax.length > 0)
          ) {
            unchecked(`${invPath}.totals.taxes`, 'TaxInformationTotals');
          }
        } else if (
          statedTaxes.size !== lineTaxes.size ||
          [...lineTaxes].some(([k, v]) => {
            const s = statedTaxes.get(k);
            return !s || s.base !== v.base || s.amount !== v.amount;
          })
        ) {
          problems.push({
            code: 'D406_TOTAL_MISMATCH',
            path: `${invPath}.totals.taxes`,
            message: `TaxInformationTotals al facturii ${invoice.number ?? i + 1} diferă de suma taxelor de pe linii.`,
          });
        }
      }
    });
    if (section.totalDebit !== undefined) {
      const stated = checkedBani(
        section.totalDebit,
        `${basePath}.totalDebit`,
        problems,
        `TotalDebit (${key})`,
      );
      if (!secValid) unchecked(`${basePath}.totalDebit`, `TotalDebit (${key})`);
      else if (stated !== undefined && stated !== secDebit)
        mismatch(
          `${basePath}.totalDebit`,
          `TotalDebit (${key})`,
          section.totalDebit,
          fmtBani(secDebit),
        );
    }
    if (section.totalCredit !== undefined) {
      const stated = checkedBani(
        section.totalCredit,
        `${basePath}.totalCredit`,
        problems,
        `TotalCredit (${key})`,
      );
      if (!secValid) unchecked(`${basePath}.totalCredit`, `TotalCredit (${key})`);
      else if (stated !== undefined && stated !== secCredit)
        mismatch(
          `${basePath}.totalCredit`,
          `TotalCredit (${key})`,
          section.totalCredit,
          fmtBani(secCredit),
        );
    }
  }

  // Payments totals.
  const paymentsSection = filed.sourceDocuments.payments;
  if (paymentsSection) {
    let payDebit = 0n;
    let payCredit = 0n;
    let secValid = true;
    if (
      paymentsSection.numberOfEntries !== undefined &&
      (!/^\d+$/.test(paymentsSection.numberOfEntries) ||
        Number(paymentsSection.numberOfEntries) !== paymentsSection.payments.length)
    ) {
      mismatch(
        'sourceDocuments.payments.numberOfEntries',
        'NumberOfEntries (payments)',
        paymentsSection.numberOfEntries,
        String(paymentsSection.payments.length),
      );
    }
    paymentsSection.payments.forEach((payment, p) => {
      const pPath = `sourceDocuments.payments.payments.${p}`;
      let gross = 0n;
      let payValid = true;
      payment.lines.forEach((line, l) => {
        const lPath = `${pPath}.lines.${l}`;
        const cents = checkedBani(
          line.amount?.amount,
          line.amount ? `${lPath}.amount.amount` : `${lPath}.amount`,
          problems,
        );
        if (cents === undefined) {
          secValid = false;
          payValid = false;
        } else {
          gross += cents;
        }
        if (line.rawSide !== undefined || (line.side !== 'debit' && line.side !== 'credit')) {
          problems.push({
            code: 'D406_SIDE',
            path: `${lPath}.side`,
            message:
              line.rawSide !== undefined
                ? `DebitCreditIndicator invalid: ${line.rawSide}.`
                : 'DebitCreditIndicator lipsește.',
          });
          secValid = false;
        } else if (line.side === 'debit') {
          if (cents !== undefined) payDebit += cents;
        } else {
          if (cents !== undefined) payCredit += cents;
        }
      });
      if (payment.totals?.grossTotal !== undefined) {
        const statedGross = checkedBani(
          payment.totals.grossTotal,
          `${pPath}.totals.grossTotal`,
          problems,
          'GrossTotal (plată)',
        );
        if (!payValid) unchecked(`${pPath}.totals.grossTotal`, 'GrossTotal (plată)');
        else if (statedGross !== undefined && statedGross !== gross)
          mismatch(
            `${pPath}.totals.grossTotal`,
            'GrossTotal (plată)',
            payment.totals.grossTotal,
            fmtBani(gross),
          );
      }
    });
    if (paymentsSection.totalDebit !== undefined) {
      const stated = checkedBani(
        paymentsSection.totalDebit,
        'sourceDocuments.payments.totalDebit',
        problems,
        'TotalDebit (payments)',
      );
      if (!secValid) unchecked('sourceDocuments.payments.totalDebit', 'TotalDebit (payments)');
      else if (stated !== undefined && stated !== payDebit)
        mismatch(
          'sourceDocuments.payments.totalDebit',
          'TotalDebit (payments)',
          paymentsSection.totalDebit,
          fmtBani(payDebit),
        );
    }
    if (paymentsSection.totalCredit !== undefined) {
      const stated = checkedBani(
        paymentsSection.totalCredit,
        'sourceDocuments.payments.totalCredit',
        problems,
        'TotalCredit (payments)',
      );
      if (!secValid) unchecked('sourceDocuments.payments.totalCredit', 'TotalCredit (payments)');
      else if (stated !== undefined && stated !== payCredit)
        mismatch(
          'sourceDocuments.payments.totalCredit',
          'TotalCredit (payments)',
          paymentsSection.totalCredit,
          fmtBani(payCredit),
        );
    }
  }

  // MovementOfGoods totals.
  const movementsSection = filed.sourceDocuments.movementOfGoods;
  if (movementsSection) {
    let linesCount = 0;
    let received = 0n;
    let issued = 0n;
    let movValid = true;
    movementsSection.movements.forEach((movement, m) => {
      movement.lines.forEach((line, l) => {
        linesCount += 1;
        const q = checkedScaled(
          line.quantity,
          6,
          `sourceDocuments.movementOfGoods.movements.${m}.lines.${l}.quantity`,
          problems,
          'D406_QUANTITY',
          'Cantitatea',
        );
        if (q === undefined) {
          movValid = false;
        } else if (q > 0n) {
          received += q;
        } else if (q < 0n) {
          issued += -q;
        }
      });
    });
    if (
      movementsSection.numberOfMovementLines !== undefined &&
      (!/^\d+$/.test(movementsSection.numberOfMovementLines) ||
        Number(movementsSection.numberOfMovementLines) !== linesCount)
    ) {
      mismatch(
        'sourceDocuments.movementOfGoods.numberOfMovementLines',
        'NumberOfMovementLines',
        movementsSection.numberOfMovementLines,
        String(linesCount),
      );
    }
    if (movementsSection.totalQuantityReceived !== undefined) {
      const stated = checkedScaled(
        movementsSection.totalQuantityReceived,
        6,
        'sourceDocuments.movementOfGoods.totalQuantityReceived',
        problems,
        'D406_QUANTITY',
        'TotalQuantityReceived',
      );
      if (!movValid)
        unchecked('sourceDocuments.movementOfGoods.totalQuantityReceived', 'TotalQuantityReceived');
      else if (stated !== undefined && stated !== received)
        mismatch(
          'sourceDocuments.movementOfGoods.totalQuantityReceived',
          'TotalQuantityReceived',
          movementsSection.totalQuantityReceived,
          formatScaled(received, 6),
        );
    }
    if (movementsSection.totalQuantityIssued !== undefined) {
      const stated = checkedScaled(
        movementsSection.totalQuantityIssued,
        6,
        'sourceDocuments.movementOfGoods.totalQuantityIssued',
        problems,
        'D406_QUANTITY',
        'TotalQuantityIssued',
      );
      if (!movValid)
        unchecked('sourceDocuments.movementOfGoods.totalQuantityIssued', 'TotalQuantityIssued');
      else if (stated !== undefined && stated !== issued)
        mismatch(
          'sourceDocuments.movementOfGoods.totalQuantityIssued',
          'TotalQuantityIssued',
          movementsSection.totalQuantityIssued,
          formatScaled(issued, 6),
        );
    }
  }

  // AssetTransactions totals.
  const assetTxSection = filed.sourceDocuments.assetTransactions;
  if (
    assetTxSection?.numberOfAssetTransactions !== undefined &&
    (!/^\d+$/.test(assetTxSection.numberOfAssetTransactions) ||
      Number(assetTxSection.numberOfAssetTransactions) !== assetTxSection.transactions.length)
  ) {
    mismatch(
      'sourceDocuments.assetTransactions.numberOfAssetTransactions',
      'NumberOfAssetTransactions',
      assetTxSection.numberOfAssetTransactions,
      String(assetTxSection.transactions.length),
    );
  }

  return problems;
}

/**
 * Checks that every account referenced on master-file entries, general-ledger lines,
 * invoices, payments and stock movements exists in `MasterFiles/GeneralLedgerAccounts`.
 */
export function checkD406Accounts(filed: D406Filed): D406FiledProblem[] {
  const problems: D406FiledProblem[] = [];
  const accounts = new Set(
    filed.masterFiles.accounts.map((a) => a.id).filter((id): id is string => id !== undefined),
  );
  const check = (path: string, accountId: string | undefined) => {
    if (accountId === undefined || !accounts.has(accountId)) {
      problems.push({
        code: 'D406_ACCOUNT_UNKNOWN',
        path,
        message: `Contul ${accountId ?? '(lipsă)'} nu figurează în lista conturilor (GeneralLedgerAccounts).`,
      });
    }
  };

  filed.masterFiles.customers.forEach((party, i) =>
    check(`masterFiles.customers.${i}.account`, party.account),
  );
  filed.masterFiles.suppliers.forEach((party, i) =>
    check(`masterFiles.suppliers.${i}.account`, party.account),
  );
  filed.masterFiles.owners?.forEach((owner, i) =>
    check(`masterFiles.owners.${i}.account`, owner.account),
  );
  filed.masterFiles.assets?.forEach((asset, i) =>
    check(`masterFiles.assets.${i}.account`, asset.account),
  );
  filed.generalLedgerEntries.journals.forEach((journal, j) =>
    journal.transactions.forEach((transaction, t) =>
      transaction.lines.forEach((line, l) =>
        check(
          `generalLedgerEntries.journals.${j}.transactions.${t}.lines.${l}.account`,
          line.account,
        ),
      ),
    ),
  );
  for (const key of ['salesInvoices', 'purchaseInvoices'] as const) {
    filed.sourceDocuments[key]?.invoices.forEach((invoice, i) => {
      if (invoice.account !== undefined)
        check(`sourceDocuments.${key}.invoices.${i}.account`, invoice.account);
      invoice.lines.forEach((line, l) =>
        check(`sourceDocuments.${key}.invoices.${i}.lines.${l}.account`, line.account),
      );
    });
  }
  filed.sourceDocuments.payments?.payments.forEach((payment, p) =>
    payment.lines.forEach((line, l) =>
      check(`sourceDocuments.payments.payments.${p}.lines.${l}.account`, line.account),
    ),
  );
  filed.sourceDocuments.movementOfGoods?.movements.forEach((movement, m) =>
    movement.lines.forEach((line, l) =>
      check(`sourceDocuments.movementOfGoods.movements.${m}.lines.${l}.account`, line.account),
    ),
  );
  return problems;
}

function ownCompanyPartyId(filed: D406Filed): string | undefined {
  const reg = filed.header.company.registrationNumber;
  if (!reg) return undefined;
  return `00${reg.replace(/^RO/, '')}`;
}

/**
 * Checks that every customer or supplier ID referenced on transactions, invoices, payments,
 * assets, physical stock owners and stock movements exists in the corresponding master file
 * (allowing the sentinel `'0'` and the filing company's own `00<CUI>` identifier).
 */
export function checkD406Partners(filed: D406Filed): D406FiledProblem[] {
  const problems: D406FiledProblem[] = [];
  const customers = new Set(
    filed.masterFiles.customers.map((c) => c.id).filter((id): id is string => id !== undefined),
  );
  const suppliers = new Set(
    filed.masterFiles.suppliers.map((s) => s.id).filter((id): id is string => id !== undefined),
  );
  const owners = new Set(
    (filed.masterFiles.owners ?? [])
      .map((o) => o.id)
      .filter((id): id is string => id !== undefined),
  );
  const partners = new Set([...customers, ...suppliers]);
  const own = ownCompanyPartyId(filed);

  const isKnown = (id: string, set: Set<string>, allowSpecial: boolean) =>
    set.has(id) || (allowSpecial && (id === '0' || (own !== undefined && id === own)));

  const checkOptional = (
    path: string,
    id: string | undefined,
    set: Set<string>,
    label: string,
    allowSpecial = true,
  ) => {
    if (id !== undefined && !isKnown(id, set, allowSpecial)) {
      problems.push({
        code: 'D406_PARTY_UNKNOWN',
        path,
        message: `${label} ${id} nu figurează în datele de bază.`,
      });
    }
  };

  filed.generalLedgerEntries.journals.forEach((journal, j) =>
    journal.transactions.forEach((transaction, t) => {
      const txPath = `generalLedgerEntries.journals.${j}.transactions.${t}`;
      checkOptional(`${txPath}.customer`, transaction.customer, customers, 'Clientul');
      checkOptional(`${txPath}.supplier`, transaction.supplier, suppliers, 'Furnizorul');
      transaction.lines.forEach((line, l) => {
        const linePath = `${txPath}.lines.${l}`;
        checkOptional(`${linePath}.customer`, line.customer, customers, 'Clientul');
        checkOptional(`${linePath}.supplier`, line.supplier, suppliers, 'Furnizorul');
      });
    }),
  );

  for (const [key, set, label] of [
    ['salesInvoices', customers, 'Clientul'],
    ['purchaseInvoices', suppliers, 'Furnizorul'],
  ] as const) {
    filed.sourceDocuments[key]?.invoices.forEach((invoice, i) => {
      const id = invoice.party?.id;
      if (id === undefined || !set.has(id)) {
        problems.push({
          code: 'D406_PARTY_UNKNOWN',
          path: invoice.party
            ? `sourceDocuments.${key}.invoices.${i}.party.id`
            : `sourceDocuments.${key}.invoices.${i}.party`,
          message: `${label} ${id ?? '(lipsă)'} nu figurează în lista ${label === 'Clientul' ? 'clienților' : 'furnizorilor'}.`,
        });
      }
    });
  }

  filed.sourceDocuments.payments?.payments.forEach((payment, p) =>
    payment.lines.forEach((line, l) => {
      const path = `sourceDocuments.payments.payments.${p}.lines.${l}`;
      checkOptional(`${path}.customer`, line.customer, partners, 'Partenerul');
      checkOptional(`${path}.supplier`, line.supplier, partners, 'Partenerul');
    }),
  );

  filed.masterFiles.assets?.forEach((asset, i) => {
    if (asset.supplier?.id !== undefined) {
      checkOptional(
        `masterFiles.assets.${i}.supplier.id`,
        asset.supplier.id,
        suppliers,
        'Furnizorul',
      );
    }
  });
  filed.masterFiles.physicalStock?.forEach((entry, i) => {
    checkOptional(`masterFiles.physicalStock.${i}.owner`, entry.owner, owners, 'Proprietarul');
  });
  filed.sourceDocuments.assetTransactions?.transactions.forEach((tx, i) => {
    if (tx.supplier?.id !== undefined) {
      checkOptional(
        `sourceDocuments.assetTransactions.transactions.${i}.supplier.id`,
        tx.supplier.id,
        suppliers,
        'Furnizorul',
      );
    }
  });
  filed.sourceDocuments.movementOfGoods?.movements.forEach((movement, m) =>
    movement.lines.forEach((line, l) => {
      const path = `sourceDocuments.movementOfGoods.movements.${m}.lines.${l}`;
      checkOptional(`${path}.customer`, line.customer, customers, 'Clientul');
      checkOptional(`${path}.supplier`, line.supplier, suppliers, 'Furnizorul');
    }),
  );

  return problems;
}

/** Runs all consistency checks (`balances`, `totals`, `accounts`, `partners`) on a filed D406. */
export function checkD406Filed(filed: D406Filed): D406FiledProblem[] {
  return [
    ...checkD406Balances(filed),
    ...checkD406Totals(filed),
    ...checkD406Accounts(filed),
    ...checkD406Partners(filed),
  ];
}

const isDate = (text: string | undefined): text is string => {
  if (text === undefined || !/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const date = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(text);
};

const decimalText = (value: string) => (value.includes('.') ? value.replace(/\.?0+$/, '') : value);

function convertOpening(
  debit: string | undefined,
  credit: string | undefined,
  path: string,
  push: (code: string, path: string, message: string) => void,
): string {
  if (debit !== undefined && credit !== undefined) {
    push(
      'D406_BALANCE',
      `${path}.openingDebit`,
      'Soldul inițial nu poate fi simultan debitor și creditor.',
    );
    return '0.00';
  }
  if (debit !== undefined) {
    if (tryBani(debit) === undefined) {
      push('D406_AMOUNT', `${path}.openingDebit`, 'Soldul inițial debitor nu este valid.');
      return '0.00';
    }
    return debit;
  }
  if (credit !== undefined) {
    const cents = tryBani(credit);
    if (cents === undefined) {
      push('D406_AMOUNT', `${path}.openingCredit`, 'Soldul inițial creditor nu este valid.');
      return '0.00';
    }
    if (cents === 0n) return credit;
    return credit.startsWith('-') ? credit.slice(1) : `-${credit}`;
  }
  push('D406_BALANCE', path, 'Soldul inițial lipsește.');
  return '0.00';
}

function convertAddress(
  value: D406FiledAddress | undefined,
  path: string,
  push: (code: string, path: string, message: string) => void,
): D406Address {
  if (!value) {
    push('D406_ADDRESS', path, 'Adresa lipsește.');
    return { city: '', country: '' };
  }
  if (!value.city) push('D406_ADDRESS', `${path}.city`, 'Localitatea lipsește.');
  if (!value.country) push('D406_ADDRESS', `${path}.country`, 'Țara lipsește.');
  return definedFields({
    street: value.street,
    number: value.number,
    details: value.details,
    city: value.city ?? '',
    postalCode: value.postalCode,
    county: value.county,
    country: value.country ?? '',
  });
}

function resolveAccountCode(
  account: D406FiledAccount,
  path: string,
  push: (code: string, path: string, message: string) => void,
): { code: string; id?: string; standard?: string } | undefined {
  const rawId = account.id;
  const rawStd = account.standard;
  if (!rawId) {
    push('D406_ACCOUNT_ID', `${path}.id`, 'Lipsește AccountID.');
    return undefined;
  }
  if (!rawStd || standardAccounts[rawStd] === undefined) {
    push(
      'D406_STANDARD_ACCOUNT',
      `${path}.standard`,
      `Contul standard ${rawStd ?? '(lipsă)'} nu există în PlanConturiBalSocCom.`,
    );
    return undefined;
  }
  if (rawId === rawStd) {
    if (!d406AccountType(rawId) || d406StandardAccount(rawId) === undefined) {
      push(
        'D406_ACCOUNT',
        path,
        `Contul ${rawId} nu are un corespondent unic în planul de conturi.`,
      );
      return undefined;
    }
    return { code: rawId };
  }
  // Ambiguous synthetic (e.g. AccountID=646, StandardAccountID=6461) or its analytical (64601 -> 646.01).
  if (d406AmbiguousAccounts[rawId]?.includes(rawStd)) {
    return { code: rawId, standard: rawStd };
  }
  const ambiguousSyn = Object.keys(d406AmbiguousAccounts).find(
    (syn) => rawId.startsWith(syn) && d406AmbiguousAccounts[syn]!.includes(rawStd),
  );
  if (ambiguousSyn && rawId.length > ambiguousSyn.length) {
    const dotted = `${ambiguousSyn}.${rawId.slice(ambiguousSyn.length)}`;
    if (d406AccountId(dotted) === rawId && d406AccountType(dotted)) {
      return { code: dotted, standard: rawStd };
    }
    if (d406AccountType(ambiguousSyn) && d406InStandardChart(rawId)) {
      return { code: dotted, id: rawId, standard: rawStd };
    }
  }
  if (rawId.startsWith(rawStd) && rawId.length > rawStd.length) {
    const dotted = `${rawStd}.${rawId.slice(rawStd.length)}`;
    if (
      d406AccountId(dotted) === rawId &&
      d406AccountType(dotted) &&
      d406StandardAccount(dotted) === rawStd
    ) {
      return { code: dotted };
    }
    if (d406AccountType(rawStd) && d406InStandardChart(rawId)) {
      return { code: dotted, id: rawId };
    }
  }
  push(
    'D406_ACCOUNT_ID',
    `${path}.id`,
    `AccountID ${rawId} cu StandardAccountID ${rawStd} nu se poate mapa la planul OMFP 1802/2014.`,
  );
  return undefined;
}

const isNoTax = (taxes: D406FiledTax[] | undefined): boolean =>
  taxes !== undefined &&
  taxes.length === 1 &&
  taxes[0]!.type === '000' &&
  taxes[0]!.code === '000000' &&
  taxes[0]!.base === undefined &&
  taxes[0]!.percentage === undefined &&
  taxes[0]!.amount === '0.00' &&
  taxes[0]!.currencyCode === 'RON' &&
  taxes[0]!.currencyAmount === '0.00' &&
  taxes[0]!.exchangeRate === undefined;

function expectedTaxPercentage(
  type: string,
  code: string,
  percentage?: string,
): string | undefined {
  if (type === '300') {
    return percentage !== undefined
      ? decimalText(percentage)
      : (vatTaxCodes[code]?.percentage ?? undefined);
  }
  return whtTaxCodes[code]?.percentage;
}

function filedPathFromModelPath(path: string, filed: D406Filed, accountIndices: number[]): string {
  const mapLineFields = (
    prefix: string,
    rest: string,
    line: { amount?: D406FiledAmount; tax?: D406FiledTax[] } | undefined,
  ): string => {
    if (rest === 'amount') return line?.amount ? `${prefix}.amount.amount` : `${prefix}.amount`;
    if (rest === 'currency') return `${prefix}.amount`;
    if (rest === 'currency.code')
      return line?.amount ? `${prefix}.amount.currencyCode` : `${prefix}.amount`;
    if (rest === 'currency.amount')
      return line?.amount ? `${prefix}.amount.currencyAmount` : `${prefix}.amount`;
    if (rest === 'currency.rate')
      return line?.amount ? `${prefix}.amount.exchangeRate` : `${prefix}.amount`;
    const taxMatch = /^tax\.(\d+)\.(.+)$/.exec(rest);
    if (taxMatch) {
      const tIdx = Number(taxMatch[1]);
      const field = taxMatch[2]!;
      if (!line?.tax?.[tIdx]) return `${prefix}.tax`;
      const mappedField = field === 'rate' ? 'exchangeRate' : field;
      return `${prefix}.tax.${tIdx}.${mappedField}`;
    }
    return `${prefix}.${rest}`;
  };

  if (path === 'created') return 'header.created';
  if (path === 'type') return 'header.type';
  if (path === 'period') return 'header.selection';
  if (path.startsWith('software.')) return `header.${path}`;
  if (path === 'company.cui') return 'header.company.registrationNumber';
  if (path === 'company.vatRegime') {
    return filed.header.company.taxRegistrations.length > 0
      ? 'header.company.taxRegistrations.0.taxType'
      : 'header.company.taxRegistrations';
  }
  if (path.startsWith('company.address.') && !filed.header.company.address) {
    return 'header.company.address';
  }
  if (path.startsWith('company.contact.') && !filed.header.company.contact) {
    return 'header.company.contact';
  }
  if (path.startsWith('company.')) return `header.${path}`;
  if (path === 'accounts') return 'masterFiles.accounts';
  const accMatch = /^accounts\.(\d+)(?:\.(.+))?$/.exec(path);
  if (accMatch) {
    const modelIdx = Number(accMatch[1]);
    const filedIdx = accountIndices[modelIdx] ?? modelIdx;
    const rest = accMatch[2];
    const acc = filed.masterFiles.accounts[filedIdx];
    const base = `masterFiles.accounts.${filedIdx}`;
    if (!rest) return base;
    if (rest === 'opening') {
      return acc?.openingDebit !== undefined
        ? `${base}.openingDebit`
        : acc?.openingCredit !== undefined
          ? `${base}.openingCredit`
          : base;
    }
    return `${base}.${rest}`;
  }
  const partyMatch = /^(customers|suppliers)\.(\d+)(?:\.(.+))?$/.exec(path);
  if (partyMatch) {
    const section = partyMatch[1] as 'customers' | 'suppliers';
    const idx = Number(partyMatch[2]);
    const rest = partyMatch[3];
    const party = filed.masterFiles[section][idx];
    const base = `masterFiles.${section}.${idx}`;
    if (!rest) return base;
    if (rest === 'opening') {
      return party?.openingDebit !== undefined
        ? `${base}.openingDebit`
        : party?.openingCredit !== undefined
          ? `${base}.openingCredit`
          : base;
    }
    if (rest.startsWith('address.') && !party?.address) return `${base}.address`;
    return `${base}.${rest}`;
  }
  if (path.startsWith('products.')) {
    const mapped = `masterFiles.${path}`;
    return mapped.endsWith('.unit') ? `${mapped.slice(0, -5)}.uomBase` : mapped;
  }
  if (path === 'journals') return 'generalLedgerEntries.journals';
  const glLineMatch = /^journals\.(\d+)\.transactions\.(\d+)\.lines\.(\d+)\.(.+)$/.exec(path);
  if (glLineMatch) {
    const [, j, t, l, rest] = glLineMatch;
    const line =
      filed.generalLedgerEntries.journals[Number(j)]?.transactions[Number(t)]?.lines[Number(l)];
    return mapLineFields(
      `generalLedgerEntries.journals.${j}.transactions.${t}.lines.${l}`,
      rest!,
      line,
    );
  }
  if (path.startsWith('journals.')) return `generalLedgerEntries.${path}`;
  const invLineMatch = /^(salesInvoices|purchaseInvoices)\.(\d+)\.lines\.(\d+)\.(.+)$/.exec(path);
  if (invLineMatch) {
    const [, kind, i, l, rest] = invLineMatch;
    const inv =
      filed.sourceDocuments[kind as 'salesInvoices' | 'purchaseInvoices']?.invoices[Number(i)];
    const line = inv?.lines[Number(l)];
    return mapLineFields(`sourceDocuments.${kind}.invoices.${i}.lines.${l}`, rest!, line);
  }
  if (path.startsWith('salesInvoices.') || path.startsWith('purchaseInvoices.')) {
    const dot = path.indexOf('.');
    const kind = path.slice(0, dot) as 'salesInvoices' | 'purchaseInvoices';
    const rest = path.slice(dot + 1);
    const mapped = `sourceDocuments.${kind}.invoices.${rest}`;
    const partyFieldMatch = /^(\d+)\.party$/.exec(rest);
    if (partyFieldMatch) {
      const inv = filed.sourceDocuments[kind]?.invoices[Number(partyFieldMatch[1])];
      return inv?.party ? `${mapped}.id` : mapped;
    }
    return mapped;
  }
  const payLineMatch = /^payments\.(\d+)\.lines\.(\d+)\.(.+)$/.exec(path);
  if (payLineMatch) {
    const [, p, l, rest] = payLineMatch;
    const line = filed.sourceDocuments.payments?.payments[Number(p)]?.lines[Number(l)];
    return mapLineFields(`sourceDocuments.payments.payments.${p}.lines.${l}`, rest!, line);
  }
  if (path.startsWith('payments.')) return `sourceDocuments.payments.${path}`;
  if (path === 'baseRates' || path.startsWith('baseRates.')) return 'masterFiles.taxTable';
  return path;
}

function checkAddressMatches(
  filed: D406FiledAddress | undefined,
  expected: D406Address,
  path: string,
  push: (code: string, path: string, message: string) => void,
): void {
  if (!filed) {
    push('D406_ADDRESS', path, 'Adresa lipsește.');
    return;
  }
  for (const field of [
    'street',
    'number',
    'details',
    'city',
    'postalCode',
    'county',
    'country',
  ] as const) {
    if (filed[field] !== expected[field]) {
      push(
        'D406_ADDRESS',
        `${path}.${field}`,
        `Câmpul adresei (${filed[field] ?? 'lipsă'}) diferă de cel din datele de bază (${expected[field] ?? 'lipsă'}).`,
      );
    }
  }
}

function checkBalanceFields(
  debit: string | undefined,
  credit: string | undefined,
  expectedCents: bigint,
  creditWhenZero: boolean,
  basePath: string,
  label: string,
  push: (code: string, path: string, message: string) => void,
): void {
  const isCredit = expectedCents < 0n || (expectedCents === 0n && creditWhenZero);
  const expectedText = fmtBani(isCredit ? -expectedCents : expectedCents);
  const expectedDebit = isCredit ? undefined : expectedText;
  const expectedCredit = isCredit ? expectedText : undefined;
  if (debit !== expectedDebit) {
    push(
      'D406_BALANCE',
      `${basePath}Debit`,
      `${label} debitor (${debit ?? 'lipsă'}) diferă de valoarea calculată (${expectedDebit ?? 'lipsă'}).`,
    );
  }
  if (credit !== expectedCredit) {
    push(
      'D406_BALANCE',
      `${basePath}Credit`,
      `${label} creditor (${credit ?? 'lipsă'}) diferă de valoarea calculată (${expectedCredit ?? 'lipsă'}).`,
    );
  }
}

function checkTaxElementMatches(
  filed: D406FiledTax,
  expected: {
    type: string;
    code: string;
    percentage?: string;
    base?: string;
    amount: string;
    currencyCode: string;
    currencyAmount: string;
    exchangeRate?: string;
  },
  path: string,
  push: (code: string, path: string, message: string) => void,
): void {
  if (filed.type !== expected.type)
    push(
      'D406_TAX_TYPE',
      `${path}.type`,
      `TaxType (${filed.type ?? 'lipsă'}) diferă de ${expected.type}.`,
    );
  if (filed.code !== expected.code)
    push(
      'D406_TAX_CODE',
      `${path}.code`,
      `TaxCode (${filed.code ?? 'lipsă'}) diferă de ${expected.code}.`,
    );
  if (filed.percentage !== expected.percentage) {
    push(
      'D406_TAX_PERCENTAGE',
      `${path}.percentage`,
      `TaxPercentage (${filed.percentage ?? 'lipsă'}) diferă de ${expected.percentage ?? 'lipsă'}.`,
    );
  }
  if (filed.base !== expected.base) {
    push(
      'D406_TAX',
      `${path}.base`,
      `TaxBase (${filed.base ?? 'lipsă'}) diferă de ${expected.base ?? 'lipsă'}.`,
    );
  }
  if (filed.amount !== expected.amount) {
    push(
      'D406_TAX_AMOUNT',
      `${path}.amount`,
      `TaxAmount (${filed.amount ?? 'lipsă'}) diferă de ${expected.amount}.`,
    );
  }
  if (filed.currencyCode !== expected.currencyCode) {
    push(
      'D406_CURRENCY',
      `${path}.currencyCode`,
      `CurrencyCode al taxei (${filed.currencyCode ?? 'lipsă'}) diferă de ${expected.currencyCode}.`,
    );
  }
  if (filed.currencyAmount !== expected.currencyAmount) {
    push(
      'D406_CONVERSION',
      `${path}.currencyAmount`,
      `CurrencyAmount al taxei (${filed.currencyAmount ?? 'lipsă'}) diferă de ${expected.currencyAmount}.`,
    );
  }
  if (filed.exchangeRate !== expected.exchangeRate) {
    push(
      'D406_RATE',
      `${path}.exchangeRate`,
      `ExchangeRate al taxei (${filed.exchangeRate ?? 'lipsă'}) diferă de ${expected.exchangeRate ?? 'lipsă'}.`,
    );
  }
}

/**
 * Converts a `D406Filed` structure into the periodic writer's `D406` model where that model
 * can hold the file, returning `{ model, problems }`.
 *
 * Contract: XML equivalence. For the periodic writer's own models, `readD406(writeD406(model))`
 * converted via `toD406` reproduces byte-identical XML through `writeD406` with no problems;
 * exact in-memory `D406` model equality is not required because `writeD406` normalizes zeros and
 * trailing digits. Every impossibility, inconsistency, or filed fact that `writeD406` cannot
 * reproduce in XML is reported with a stable `code`, a `D406Filed` property `path`, and a
 * Romanian `message`. Periodic conversions still return the best-effort `model` alongside
 * `problems` so callers can inspect it.
 */
export function toD406(filed: D406Filed): {
  model: D406 | undefined;
  problems: D406FiledProblem[];
} {
  const problems: D406FiledProblem[] = [];
  const seenProblems = new Set<string>();
  const push = (code: string, path: string, message: string) => {
    const key = `${code}|${path}`;
    if (seenProblems.has(key)) return;
    seenProblems.add(key);
    problems.push({ code, path, message });
  };

  for (const p of checkD406Filed(filed)) push(p.code, p.path, p.message);

  if (filed.namespace !== d406Namespace) {
    push(
      'D406_FORMAT',
      'namespace',
      `Namespace invalid: ${filed.namespace} (așteptat ${d406Namespace}).`,
    );
  }

  filed.unread.forEach((item, index) => {
    push(
      'D406_UNREAD',
      `unread.${index}`,
      `Elementul ${item.path} (x${item.count}) nu este susținut de modelul periodic D406.`,
    );
  });

  // Sections belonging to annual assets (A) or on-demand stock (C) files.
  if (filed.masterFiles.owners?.length)
    push('D406_UNSUPPORTED_SECTION', 'masterFiles.owners', 'Fișierul periodic nu conține Owners.');
  if (filed.masterFiles.assets?.length)
    push('D406_UNSUPPORTED_SECTION', 'masterFiles.assets', 'Fișierul periodic nu conține Assets.');
  if (filed.masterFiles.physicalStock !== undefined)
    push(
      'D406_UNSUPPORTED_SECTION',
      'masterFiles.physicalStock',
      'Fișierul periodic nu conține PhysicalStock.',
    );
  if (filed.masterFiles.analysisTypes?.length)
    push(
      'D406_UNSUPPORTED_SECTION',
      'masterFiles.analysisTypes',
      'Modelul D406 nu cuprinde AnalysisTypeTable.',
    );
  if (filed.masterFiles.movementTypes?.length)
    push(
      'D406_UNSUPPORTED_SECTION',
      'masterFiles.movementTypes',
      'Fișierul periodic nu conține MovementTypeTable.',
    );
  const mog = filed.sourceDocuments.movementOfGoods;
  if (
    mog &&
    (mog.movements.length > 0 ||
      mog.numberOfMovementLines !== undefined ||
      mog.totalQuantityReceived !== undefined ||
      mog.totalQuantityIssued !== undefined)
  ) {
    push(
      'D406_UNSUPPORTED_SECTION',
      'sourceDocuments.movementOfGoods',
      'Fișierul periodic nu conține MovementOfGoods.',
    );
  }
  if (filed.sourceDocuments.assetTransactions !== undefined)
    push(
      'D406_UNSUPPORTED_SECTION',
      'sourceDocuments.assetTransactions',
      'Fișierul periodic nu conține AssetTransactions.',
    );

  // Header & period.
  const rawType = filed.header.type;
  const type = rawType === 'L' || rawType === 'T' ? rawType : undefined;
  if (!type)
    push(
      'D406_TYPE',
      'header.type',
      `Modelul D406 cuprinde doar declarații periodice L sau T (primit: ${rawType ?? 'lipsă'}).`,
    );

  const start = filed.header.selection.start;
  const end = filed.header.selection.end;
  let period = { year: 0, month: 0 };
  if (!isDate(start) || !isDate(end)) {
    push('D406_PERIOD', 'header.selection', 'Criteriile de selecție nu sunt date valide.');
  } else if (type) {
    const candidate = { year: Number(end.slice(0, 4)), month: Number(end.slice(5, 7)) };
    const expected = d406Period({ type, period: candidate });
    if (expected.start !== start || expected.end !== end) {
      push(
        'D406_PERIOD',
        'header.selection',
        `Intervalul ${start} – ${end} nu corespunde unei perioade ${type}.`,
      );
    } else {
      period = candidate;
    }
  }

  if (filed.header.version !== '2.0') {
    push(
      'D406_HEADER',
      'header.version',
      `AuditFileVersion (${filed.header.version ?? 'lipsă'}) diferă de 2.0.`,
    );
  }
  if (filed.header.country !== 'RO') {
    push(
      'D406_HEADER',
      'header.country',
      `AuditFileCountry (${filed.header.country ?? 'lipsă'}) diferă de RO.`,
    );
  }
  if (filed.header.defaultCurrency !== 'RON') {
    push(
      'D406_CURRENCY',
      'header.defaultCurrency',
      'Modelul D406 folosește RON ca monedă implicită.',
    );
  }
  if (filed.header.segmentIndex !== '1') {
    push(
      'D406_HEADER',
      'header.segmentIndex',
      `SegmentIndex (${filed.header.segmentIndex ?? 'lipsă'}) diferă de 1.`,
    );
  }
  if (filed.header.totalSegments !== '1') {
    push(
      'D406_HEADER',
      'header.totalSegments',
      `TotalSegmentsInsequence (${filed.header.totalSegments ?? 'lipsă'}) diferă de 1.`,
    );
  }
  if (filed.header.taxAccountingBasis !== 'A') {
    push(
      'D406_HEADER',
      'header.taxAccountingBasis',
      `TaxAccountingBasis (${filed.header.taxAccountingBasis ?? 'lipsă'}) diferă de A.`,
    );
  }
  if (!isDate(filed.header.created)) {
    push('D406_DATE', 'header.created', 'Data creării fișierului lipsește sau este invalidă.');
  }
  const sw = filed.header.software;
  if (!sw.company) push('D406_TEXT', 'header.software.company', 'Lipsește SoftwareCompanyName.');
  if (!sw.name) push('D406_TEXT', 'header.software.name', 'Lipsește SoftwareID.');
  if (!sw.version) push('D406_TEXT', 'header.software.version', 'Lipsește SoftwareVersion.');

  const comp = filed.header.company;
  if (comp.taxRegistrations.length !== 1) {
    push(
      'D406_REGIME',
      'header.company.taxRegistrations',
      'Modelul D406 așteaptă exact o înregistrare fiscală (TaxRegistration).',
    );
  }
  const taxReg = comp.taxRegistrations[0];
  const cui =
    taxReg?.registrationNumber && /^\d{2,10}$/.test(taxReg.registrationNumber)
      ? taxReg.registrationNumber
      : comp.registrationNumber?.replace(/^RO/, '');
  if (!cui || !/^\d{2,10}$/.test(cui)) {
    push('D406_CUI', 'header.company.registrationNumber', 'Lipsește CUI-ul valid al companiei.');
  }
  const vatRegime = taxReg?.taxType ?? '';
  if (taxReg && !vatRegimes[vatRegime]) {
    push('D406_REGIME', 'header.company.taxRegistrations.0.taxType', 'Regim de TVA necunoscut.');
  }
  if (cui && vatRegime) {
    const vatRegistered = vatRegime === '100010' || vatRegime === '100040';
    const expectedRegNo = vatRegistered ? `RO${cui}` : cui;
    if (comp.registrationNumber !== expectedRegNo) {
      push(
        'D406_CUI',
        'header.company.registrationNumber',
        `RegistrationNumber (${comp.registrationNumber ?? 'lipsă'}) diferă de ${expectedRegNo}.`,
      );
    }
    if (taxReg && taxReg.registrationNumber !== cui) {
      push(
        'D406_CUI',
        'header.company.taxRegistrations.0.registrationNumber',
        `TaxRegistrationNumber (${taxReg.registrationNumber ?? 'lipsă'}) diferă de ${cui}.`,
      );
    }
  }
  if (taxReg && taxReg.taxAuthority !== 'ANAF') {
    push(
      'D406_REGIME',
      'header.company.taxRegistrations.0.taxAuthority',
      `TaxAuthority (${taxReg.taxAuthority ?? 'lipsă'}) diferă de ANAF.`,
    );
  }
  if (!comp.name) push('D406_TEXT', 'header.company.name', 'Lipsește denumirea companiei.');
  const companyAddress = convertAddress(comp.address, 'header.company.address', push);
  if (filed.header.region !== companyAddress.county) {
    push(
      'D406_HEADER',
      'header.region',
      `AuditFileRegion (${filed.header.region ?? 'lipsă'}) diferă de județul adresei (${companyAddress.county ?? 'lipsă'}).`,
    );
  }
  if (!comp.contact?.firstName || !comp.contact?.lastName || !comp.contact?.phone) {
    push(
      'D406_TEXT',
      'header.company.contact',
      'Datele persoanei de contact (prenume, nume, telefon) sunt incomplete.',
    );
  }

  // Accounts.
  const accountCodeById = new Map<string, string>();
  const accounts: D406Account[] = [];
  const accountIndices: number[] = [];
  filed.masterFiles.accounts.forEach((acc, index) => {
    const path = `masterFiles.accounts.${index}`;
    const resolved = resolveAccountCode(acc, path, push);
    const opening = convertOpening(acc.openingDebit, acc.openingCredit, path, push);
    if (!acc.description) push('D406_TEXT', `${path}.description`, 'Lipsește descrierea contului.');
    if (resolved) {
      const expectedId = resolved.id ?? d406AccountId(resolved.code);
      const expectedStd = d406StandardAccount(resolved.code, resolved.standard);
      const expectedType = d406AccountType(resolved.code);
      if (acc.id !== expectedId) {
        push(
          'D406_ACCOUNT_ID',
          `${path}.id`,
          `AccountID (${acc.id ?? 'lipsă'}) diferă de ${expectedId ?? 'lipsă'}.`,
        );
      }
      if (acc.standard !== expectedStd) {
        push(
          'D406_STANDARD_ACCOUNT',
          `${path}.standard`,
          `StandardAccountID (${acc.standard ?? 'lipsă'}) diferă de ${expectedStd ?? 'lipsă'}.`,
        );
      }
      if (acc.type !== expectedType) {
        push(
          'D406_ACCOUNT',
          `${path}.type`,
          `AccountType (${acc.type ?? 'lipsă'}) diferă de ${expectedType ?? 'lipsă'}.`,
        );
      }
      const openCents = tryBani(opening);
      if (openCents !== undefined && expectedType !== undefined) {
        checkBalanceFields(
          acc.openingDebit,
          acc.openingCredit,
          openCents,
          expectedType === 'Pasiv',
          `${path}.opening`,
          'Soldul inițial al contului',
          push,
        );
      }
      accountCodeById.set(acc.id!, resolved.code);
      accounts.push(
        definedFields({
          code: resolved.code,
          id: resolved.id,
          description: acc.description ?? '',
          standard: resolved.standard,
          opening,
        }),
      );
      accountIndices.push(index);
    }
  });

  const resolveAccountRef = (accountId: string | undefined, path: string): string => {
    if (!accountId || !accountCodeById.has(accountId)) {
      push('D406_ACCOUNT_UNKNOWN', path, `Contul ${accountId ?? '(lipsă)'} nu este mapat.`);
      return accountId ?? '';
    }
    return accountCodeById.get(accountId)!;
  };

  const convertPartyList = (
    parties: D406FiledParty[],
    section: 'customers' | 'suppliers',
  ): D406Party[] =>
    parties.map((party, index) => {
      const path = `masterFiles.${section}.${index}`;
      if (!party.id) push('D406_PARTY_ID', `${path}.id`, 'Lipsește codul partenerului.');
      else if (party.registrationNumber !== party.id) {
        push(
          'D406_PARTY_ID',
          `${path}.registrationNumber`,
          `RegistrationNumber (${party.registrationNumber ?? 'lipsă'}) diferă de ${party.id}.`,
        );
      }
      if (!party.name) push('D406_TEXT', `${path}.name`, 'Lipsește denumirea partenerului.');
      const opening = convertOpening(party.openingDebit, party.openingCredit, path, push);
      const openCents = tryBani(opening);
      if (openCents !== undefined) {
        checkBalanceFields(
          party.openingDebit,
          party.openingCredit,
          openCents,
          section === 'suppliers',
          `${path}.opening`,
          'Soldul inițial al partenerului',
          push,
        );
      }
      return {
        id: party.id ?? '',
        name: party.name ?? '',
        address: convertAddress(party.address, `${path}.address`, push),
        account: resolveAccountRef(party.account, `${path}.account`),
        opening,
      };
    });

  const customers = convertPartyList(filed.masterFiles.customers, 'customers');
  const suppliers = convertPartyList(filed.masterFiles.suppliers, 'suppliers');

  // TaxTable -> baseRates and Member State rate lookup.
  const baseRates: Record<string, number[]> = {};
  const stateCountries = new Map<string, Set<string>>();
  filed.masterFiles.taxTable.forEach((entry, eIdx) => {
    const entryPath = `masterFiles.taxTable.${eIdx}`;
    if (!entry.type || !taxTypes[entry.type]) {
      push(
        'D406_TAX_TYPE',
        `${entryPath}.type`,
        `Tip de taxă necunoscut: ${entry.type ?? 'lipsă'}.`,
      );
      return;
    }
    if (entry.type === '300') {
      entry.codes.forEach((detail, dIdx) => {
        const dPath = `${entryPath}.codes.${dIdx}`;
        const vatEntry = detail.code ? vatTaxCodes[detail.code] : undefined;
        if (!detail.code || !vatEntry) {
          push('D406_TAX_CODE', `${dPath}.code`, `Cod TVA necunoscut: ${detail.code ?? 'lipsă'}.`);
          return;
        }
        if (vatEntry.kind === 'baserate') {
          const rates: number[] = [];
          detail.baseRates.forEach((rawRate, rIdx) => {
            try {
              const scaled = parseScaled(rawRate, 4);
              if (scaled < 0n || scaled > 10000n || scaled % 100n !== 0n) {
                push(
                  'D406_BASE_RATE',
                  `${dPath}.baseRates.${rIdx}`,
                  `Pro-rata ${rawRate} nu este un procent întreg între 0 și 100.`,
                );
              } else {
                rates.push(Number(scaled / 100n));
              }
            } catch {
              push('D406_BASE_RATE', `${dPath}.baseRates.${rIdx}`, `BaseRate invalid: ${rawRate}.`);
            }
          });
          baseRates[detail.code] = [...(baseRates[detail.code] ?? []), ...rates];
        } else {
          detail.baseRates.forEach((rawRate, rIdx) => {
            try {
              if (parseScaled(rawRate, 4) !== 10000n) {
                push(
                  'D406_BASE_RATE',
                  `${dPath}.baseRates.${rIdx}`,
                  `Codul ${detail.code} nu admite BaseRate ${rawRate} diferit de 1.`,
                );
              }
            } catch {
              push('D406_BASE_RATE', `${dPath}.baseRates.${rIdx}`, `BaseRate invalid: ${rawRate}.`);
            }
          });
        }
        if (vatEntry.percentage === null && detail.percentage !== undefined && detail.country) {
          const key = `${detail.code}|${decimalText(detail.percentage)}`;
          const set = stateCountries.get(key) ?? new Set<string>();
          set.add(detail.country);
          stateCountries.set(key, set);
        }
      });
    } else {
      entry.codes.forEach((detail, dIdx) => {
        const dPath = `${entryPath}.codes.${dIdx}`;
        if (!detail.code || !whtTaxCodes[detail.code]) {
          push(
            'D406_TAX_CODE',
            `${dPath}.code`,
            `Codul ${detail.code ?? 'lipsă'} pentru tipul ${entry.type} nu este acoperit de modelul D406.`,
          );
        }
      });
    }
  });

  // Products.
  const products: D406Product[] = filed.masterFiles.products.map((prod, index) => {
    const path = `masterFiles.products.${index}`;
    const kind = prod.kind === '01' ? 'goods' : prod.kind === '02' ? 'services' : undefined;
    if (!kind) {
      push('D406_PRODUCT', `${path}.kind`, `GoodsServicesID invalid: ${prod.kind ?? 'lipsă'}.`);
    }
    if (!prod.uomBase) {
      push('D406_UNIT', `${path}.uomBase`, 'Lipsește UOMBase.');
    }
    if (prod.uomStandard !== prod.uomBase) {
      push(
        'D406_UNIT',
        `${path}.uomStandard`,
        `UOMStandard (${prod.uomStandard ?? 'lipsă'}) diferă de UOMBase (${prod.uomBase ?? 'lipsă'}).`,
      );
    }
    if (prod.conversionFactor !== '1') {
      push(
        'D406_UNIT',
        `${path}.conversionFactor`,
        `Factorul de conversie (${prod.conversionFactor ?? 'lipsă'}) diferă de 1.`,
      );
    }
    if (prod.valuationMethod !== undefined) {
      push(
        'D406_PRODUCT',
        `${path}.valuationMethod`,
        'Modelul periodic D406 nu cuprinde ValuationMethod pe produse.',
      );
    }
    const commodityCode =
      prod.commodityCode === undefined || prod.commodityCode === '0'
        ? undefined
        : prod.commodityCode;
    if (prod.commodityCode !== (commodityCode ?? '0')) {
      push(
        'D406_COMMODITY',
        `${path}.commodityCode`,
        `ProductCommodityCode (${prod.commodityCode ?? 'lipsă'}) diferă de ${commodityCode ?? '0'}.`,
      );
    }
    return definedFields({
      code: prod.code ?? '',
      description: prod.description ?? '',
      kind: kind ?? 'goods',
      unit: prod.uomBase ?? '',
      commodityCode,
    });
  });
  const productMap = new Map(products.map((p) => [p.code, p]));

  // Unified currency conversion for both line amounts and tax amounts so RON currency checks
  // and foreign-currency checks never diverge.
  const convertFiledAmount = (
    amt: D406FiledAmount | undefined,
    path: string,
    options: { lineCurrency?: D406Currency; missingCode?: string; missingMessage?: string } = {},
  ): { amount: string; currency?: D406Currency } => {
    const isTax = options.lineCurrency !== undefined || options.missingCode === 'D406_TAX_AMOUNT';
    if (amt?.amount === undefined) {
      push(
        options.missingCode ?? 'D406_AMOUNT',
        `${path}.amount`,
        options.missingMessage ?? 'Lipsește suma.',
      );
      return { amount: '0.00' };
    }
    const cents = tryBani(amt.amount);
    if (cents === undefined) {
      push('D406_AMOUNT', `${path}.amount`, `Sumă invalidă: ${amt.amount}.`);
      return { amount: '0.00' };
    }
    const formatted = fmtBani(cents);
    if (amt.amount !== formatted) {
      push(
        'D406_AMOUNT',
        `${path}.amount`,
        `Formatul sumei (${amt.amount}) diferă de ${formatted}.`,
      );
    }
    if (!amt.currencyCode || amt.currencyCode === 'RON') {
      if (amt.currencyCode === undefined) {
        push('D406_CURRENCY', `${path}.currencyCode`, 'Lipsește CurrencyCode (RON).');
      }
      if (amt.exchangeRate !== undefined) {
        try {
          if (parseScaled(amt.exchangeRate, 4) !== 10000n) {
            push(
              'D406_RATE',
              `${path}.exchangeRate`,
              `Sumă în RON cu curs diferit de 1 (${amt.exchangeRate}).`,
            );
          } else {
            push(
              'D406_RATE',
              `${path}.exchangeRate`,
              'Modelul D406 nu scrie ExchangeRate pentru RON.',
            );
          }
        } catch {
          push('D406_RATE', `${path}.exchangeRate`, `Curs invalid: ${amt.exchangeRate}.`);
        }
      }
      if (amt.currencyAmount === undefined) {
        push('D406_CONVERSION', `${path}.currencyAmount`, 'Lipsește CurrencyAmount pentru RON.');
      } else {
        const curCents = tryBani(amt.currencyAmount);
        if (curCents === undefined || curCents !== cents || amt.currencyAmount !== formatted) {
          push(
            'D406_CONVERSION',
            `${path}.currencyAmount`,
            `CurrencyAmount (${amt.currencyAmount}) diferă de Amount (${amt.amount}) pentru RON.`,
          );
        }
      }
      return { amount: formatted };
    }
    if (isTax && (!options.lineCurrency || options.lineCurrency.code !== amt.currencyCode)) {
      push(
        'D406_CONVERSION',
        `${path}.currencyCode`,
        `Valuta taxei (${amt.currencyCode}) diferă de valuta liniei.`,
      );
    }
    if (amt.currencyAmount === undefined || amt.exchangeRate === undefined) {
      push(
        'D406_CONVERSION',
        amt.currencyAmount === undefined ? `${path}.currencyAmount` : `${path}.exchangeRate`,
        `Suma în valută ${amt.currencyCode} nu are CurrencyAmount sau ExchangeRate.`,
      );
      return { amount: formatted };
    }
    const curCents = tryBani(amt.currencyAmount);
    if (curCents === undefined || amt.currencyAmount !== fmtBani(curCents)) {
      push(
        'D406_AMOUNT',
        `${path}.currencyAmount`,
        `CurrencyAmount invalid: ${amt.currencyAmount}.`,
      );
    }
    return {
      amount: formatted,
      currency: {
        code: amt.currencyCode,
        amount: curCents !== undefined ? fmtBani(curCents) : amt.currencyAmount,
        rate: amt.exchangeRate,
      },
    };
  };

  const convertTaxList = (
    taxes: D406FiledTax[],
    lineCurrency: D406Currency | undefined,
    path: string,
  ): D406Tax[] =>
    taxes.map((t, idx) => {
      const tPath = `${path}.${idx}`;
      if (!t.type) push('D406_TAX_TYPE', `${tPath}.type`, 'Lipsește TaxType.');
      if (!t.code) push('D406_TAX_CODE', `${tPath}.code`, 'Lipsește TaxCode.');
      const { amount, currency: taxCurrency } = convertFiledAmount(t, tPath, {
        lineCurrency,
        missingCode: 'D406_TAX_AMOUNT',
        missingMessage: 'Lipsește TaxAmount.',
      });

      let percentage: string | undefined;
      let country: string | undefined;
      if (t.type === '300' && t.code) {
        const entry = vatTaxCodes[t.code];
        if (!entry) {
          push('D406_TAX_CODE', `${tPath}.code`, `Cod TVA necunoscut: ${t.code}.`);
        } else if (entry.percentage === null) {
          if (!d406MemberStateRateCodes.includes(t.code)) {
            push('D406_TAX_CODE', `${tPath}.code`, `Codul TVA ${t.code} nu este acoperit.`);
          } else if (t.percentage === undefined) {
            push('D406_TAX_CODE', `${tPath}.percentage`, `Lipsește cota pentru codul ${t.code}.`);
          } else {
            percentage = t.percentage;
            const countries = stateCountries.get(`${t.code}|${decimalText(t.percentage)}`);
            if (!countries || countries.size !== 1) {
              push(
                'D406_TAX_CODE',
                `${tPath}.code`,
                `Nu se poate determina univoc statul membru pentru ${t.code} la cota ${t.percentage}%.`,
              );
            } else {
              country = [...countries][0];
            }
          }
        } else if (t.percentage !== undefined && decimalText(t.percentage) !== entry.percentage) {
          push(
            'D406_TAX_CODE',
            `${tPath}.percentage`,
            `Cota ${t.percentage} diferă de cota codului ${t.code} (${entry.percentage}%).`,
          );
        }
      }

      if (t.base !== undefined) {
        const baseCents = tryBani(t.base);
        if (baseCents === undefined) {
          push('D406_AMOUNT', `${tPath}.base`, `TaxBase invalid: ${t.base}.`);
        } else if (t.base !== fmtBani(baseCents)) {
          push(
            'D406_AMOUNT',
            `${tPath}.base`,
            `Formatul TaxBase (${t.base}) diferă de ${fmtBani(baseCents)}.`,
          );
        }
      }
      const expectedPct = expectedTaxPercentage(t.type ?? '', t.code ?? '', percentage);
      if (t.percentage !== expectedPct) {
        push(
          'D406_TAX_PERCENTAGE',
          `${tPath}.percentage`,
          `TaxPercentage (${t.percentage ?? 'lipsă'}) diferă de ${expectedPct ?? 'lipsă'}.`,
        );
      }

      let currencyAmount: string | undefined;
      let rate: string | undefined;
      if (taxCurrency) {
        currencyAmount = taxCurrency.amount;
        if (taxCurrency.rate !== lineCurrency?.rate) {
          rate = taxCurrency.rate;
        }
      }

      return definedFields({
        type: t.type ?? '',
        code: t.code ?? '',
        base: t.base,
        amount,
        currencyAmount,
        rate,
        percentage,
        country,
      });
    });

  const own = cui ? `00${cui}` : '';
  const resolveLinePartners = (
    customer: string | undefined,
    supplier: string | undefined,
    path: string,
  ): { customer?: string; supplier?: string } => {
    if (customer === own && supplier === own) return {};
    const out: { customer?: string; supplier?: string } = {};
    if (customer !== undefined && customer !== '0') {
      if (customer === own) {
        push('D406_PARTY', `${path}.customer`, 'Partenerul liniei nu este consistent.');
      } else {
        out.customer = customer;
      }
    }
    if (supplier !== undefined && supplier !== '0') {
      if (supplier === own) {
        push('D406_PARTY', `${path}.supplier`, 'Partenerul liniei nu este consistent.');
      } else {
        out.supplier = supplier;
      }
    }
    if (out.customer !== undefined && supplier !== '0') {
      push('D406_PARTY', `${path}.supplier`, `SupplierID (${supplier ?? 'lipsă'}) diferă de 0.`);
    }
    if (out.supplier !== undefined && customer !== '0') {
      push('D406_PARTY', `${path}.customer`, `CustomerID (${customer ?? 'lipsă'}) diferă de 0.`);
    }
    if (out.customer === undefined && out.supplier === undefined) {
      if (customer !== own)
        push(
          'D406_PARTY',
          `${path}.customer`,
          `CustomerID (${customer ?? 'lipsă'}) diferă de ${own}.`,
        );
      if (supplier !== own)
        push(
          'D406_PARTY',
          `${path}.supplier`,
          `SupplierID (${supplier ?? 'lipsă'}) diferă de ${own}.`,
        );
    }
    return out;
  };

  const checkDateField = (value: string | undefined, path: string, label: string) => {
    if (value !== undefined && !isDate(value)) {
      push('D406_DATE', path, `${label} (${value}) nu este o dată validă AAAA-LL-ZZ.`);
    }
  };

  // Journals.
  const journals: D406Journal[] = filed.generalLedgerEntries.journals.map((j, jIdx) => {
    const jPath = `generalLedgerEntries.journals.${jIdx}`;
    const transactions: D406Transaction[] = j.transactions.map((tx, tIdx) => {
      const tPath = `${jPath}.transactions.${tIdx}`;
      if (!isDate(tx.date)) {
        push('D406_DATE', `${tPath}.date`, 'TransactionDate lipsește sau este invalidă.');
      }
      checkDateField(tx.posted, `${tPath}.posted`, 'GLPostingDate');
      checkDateField(tx.entered, `${tPath}.entered`, 'SystemEntryDate');
      const posted = tx.posted && tx.posted !== tx.date ? tx.posted : undefined;
      const effectivePosted = tx.posted ?? tx.date;
      const entered = tx.entered && tx.entered !== effectivePosted ? tx.entered : undefined;
      if (tx.posted !== effectivePosted) {
        push('D406_DATE', `${tPath}.posted`, `Lipsește GLPostingDate (${effectivePosted ?? ''}).`);
      }
      if (tx.entered !== (entered ?? effectivePosted)) {
        push(
          'D406_DATE',
          `${tPath}.entered`,
          `Lipsește SystemEntryDate (${entered ?? effectivePosted ?? ''}).`,
        );
      }
      if (isDate(effectivePosted)) {
        const expectedPeriod = String(Number(effectivePosted.slice(5, 7)));
        const expectedYear = effectivePosted.slice(0, 4);
        if (tx.period !== expectedPeriod) {
          push(
            'D406_PERIOD',
            `${tPath}.period`,
            `Period (${tx.period ?? 'lipsă'}) diferă de ${expectedPeriod}.`,
          );
        }
        if (tx.periodYear !== expectedYear) {
          push(
            'D406_PERIOD',
            `${tPath}.periodYear`,
            `PeriodYear (${tx.periodYear ?? 'lipsă'}) diferă de ${expectedYear}.`,
          );
        }
      }
      const lines: D406Line[] = tx.lines.map((l, lIdx) => {
        const lPath = `${tPath}.lines.${lIdx}`;
        if (l.side !== 'debit' && l.side !== 'credit') {
          push('D406_SIDE', `${lPath}.side`, 'Linia nu indică debitul sau creditul.');
        }
        const { amount, currency } = convertFiledAmount(l.amount, `${lPath}.amount`);
        if (!l.tax || l.tax.length === 0) {
          push('D406_TAX', `${lPath}.tax`, 'Lipsește TaxInformation.');
        }
        const tax =
          l.tax && l.tax.length > 0 && !isNoTax(l.tax)
            ? convertTaxList(l.tax, currency, `${lPath}.tax`)
            : undefined;
        return definedFields({
          id: l.id ?? '',
          account: resolveAccountRef(l.account, `${lPath}.account`),
          side: l.side ?? 'debit',
          amount,
          currency,
          ...resolveLinePartners(l.customer, l.supplier, lPath),
          document: l.document,
          description: l.description ?? '',
          tax,
        });
      });

      // Check transaction-level CustomerID / SupplierID against what writeD406 derives from lines.
      if (own) {
        const linePartners = lines.map((line) =>
          line.customer !== undefined
            ? { customer: line.customer, supplier: '0' }
            : line.supplier !== undefined
              ? { customer: '0', supplier: line.supplier }
              : { customer: own, supplier: own },
        );
        const distinct = (ids: string[]) => [
          ...new Set(ids.filter((id) => id !== '0' && id !== own)),
        ];
        const txCusts = distinct(linePartners.map((p) => p.customer));
        const txSups = distinct(linePartners.map((p) => p.supplier));
        const expectedHeader =
          txCusts.length === 1 && txSups.length === 0
            ? { customer: txCusts[0]!, supplier: '0' }
            : txSups.length === 1 && txCusts.length === 0
              ? { customer: '0', supplier: txSups[0]! }
              : { customer: own, supplier: own };
        if (tx.customer !== expectedHeader.customer) {
          push(
            'D406_PARTY',
            `${tPath}.customer`,
            `CustomerID al tranzacției (${tx.customer ?? 'lipsă'}) diferă de ${expectedHeader.customer}.`,
          );
        }
        if (tx.supplier !== expectedHeader.supplier) {
          push(
            'D406_PARTY',
            `${tPath}.supplier`,
            `SupplierID al tranzacției (${tx.supplier ?? 'lipsă'}) diferă de ${expectedHeader.supplier}.`,
          );
        }
      }

      return definedFields({
        id: tx.id ?? '',
        date: tx.date ?? '',
        posted,
        entered,
        description: tx.description ?? '',
        source: tx.source,
        lines,
      });
    });
    return {
      id: j.id ?? '',
      description: j.description ?? '',
      type: j.type ?? '',
      transactions,
    };
  });

  const convertInvoices = (
    section: D406FiledInvoicesSection | undefined,
    parties: D406Party[],
    sales: boolean,
  ): D406Invoice[] => {
    if (!section) return [];
    const name = sales ? 'salesInvoices' : 'purchaseInvoices';
    if (section.invoices.length === 0) {
      push(
        'D406_UNSUPPORTED_SECTION',
        `sourceDocuments.${name}`,
        `Secțiunea ${name} fără documente nu este scrisă de modelul D406.`,
      );
      return [];
    }
    const partyById = new Map(parties.map((p) => [p.id, p] as const).reverse());
    const normalSide = sales ? 'credit' : 'debit';
    return section.invoices.map((inv, iIdx) => {
      const iPath = `sourceDocuments.${name}.invoices.${iIdx}`;
      const party = inv.party?.id ?? '';
      if (!party)
        push(
          'D406_PARTY_UNKNOWN',
          inv.party ? `${iPath}.party.id` : `${iPath}.party`,
          'Lipsește partenerul facturii.',
        );
      const partner = partyById.get(party);
      if (partner) {
        checkAddressMatches(
          inv.party?.billingAddress,
          partner.address,
          `${iPath}.party.billingAddress`,
          push,
        );
      }
      if (inv.period !== undefined) {
        push('D406_PERIOD', `${iPath}.period`, 'Modelul D406 nu scrie Period pe facturi.');
      }
      if (inv.periodYear !== undefined) {
        push('D406_PERIOD', `${iPath}.periodYear`, 'Modelul D406 nu scrie PeriodYear pe facturi.');
      }
      const mappedAccount =
        inv.account !== undefined ? resolveAccountRef(inv.account, `${iPath}.account`) : undefined;
      if (inv.account === undefined) {
        push('D406_ACCOUNT_ID', `${iPath}.account`, 'Lipsește AccountID pe factură.');
      }
      const account =
        mappedAccount !== undefined && mappedAccount !== partner?.account
          ? mappedAccount
          : undefined;
      if (inv.selfBilling !== '0' && inv.selfBilling !== '389') {
        push(
          'D406_INVOICE_TYPE',
          `${iPath}.selfBilling`,
          `SelfBillingIndicator invalid sau lipsă: ${inv.selfBilling ?? 'lipsă'}.`,
        );
      }
      if (!inv.type || !invoiceTypes[inv.type]) {
        push(
          'D406_INVOICE_TYPE',
          `${iPath}.type`,
          `Tip de factură necunoscut: ${inv.type ?? 'lipsă'}.`,
        );
      }
      if (!isDate(inv.date)) {
        push('D406_DATE', `${iPath}.date`, 'InvoiceDate lipsește sau este invalidă.');
      }
      const lines: D406InvoiceLine[] = inv.lines.map((line, lIdx) => {
        const lPath = `${iPath}.lines.${lIdx}`;
        if (line.lineNumber !== String(lIdx + 1)) {
          push(
            'D406_LINE_NUMBER',
            `${lPath}.lineNumber`,
            `LineNumber (${line.lineNumber ?? 'lipsă'}) diferă de ${lIdx + 1}.`,
          );
        }
        if (line.rawSide !== undefined || line.side === undefined) {
          push(
            'D406_SIDE',
            `${lPath}.side`,
            `DebitCreditIndicator invalid sau lipsă: ${line.rawSide ?? 'lipsă'}.`,
          );
        }
        if (line.product === undefined && line.productDescription !== undefined) {
          push(
            'D406_PRODUCT_UNKNOWN',
            `${lPath}.product`,
            'Linia are ProductDescription fără ProductCode.',
          );
        }
        const product = line.product ? productMap.get(line.product) : undefined;
        const expectedGoodsServicesId = product
          ? product.kind === 'goods'
            ? '01'
            : '02'
          : undefined;
        if (line.goodsServicesId !== expectedGoodsServicesId) {
          push(
            'D406_PRODUCT',
            `${lPath}.goodsServicesId`,
            `GoodsServicesID (${line.goodsServicesId ?? 'lipsă'}) diferă de ${expectedGoodsServicesId ?? 'lipsă'}.`,
          );
        }
        if (line.productDescription !== product?.description) {
          push(
            'D406_PRODUCT',
            `${lPath}.productDescription`,
            `ProductDescription (${line.productDescription ?? 'lipsă'}) diferă de ${product?.description ?? 'lipsă'}.`,
          );
        }
        const expectedUnit = line.unit ?? product?.unit;
        if (line.unit !== expectedUnit) {
          push(
            'D406_UNIT',
            `${lPath}.unit`,
            `InvoiceUOM (${line.unit ?? 'lipsă'}) diferă de ${expectedUnit ?? 'lipsă'}.`,
          );
        }
        const unit =
          line.unit !== undefined && (!product || line.unit !== product.unit)
            ? line.unit
            : undefined;
        if (line.unitPrice === undefined) {
          push('D406_AMOUNT', `${lPath}.unitPrice`, 'Lipsește UnitPrice.');
        } else {
          const upCents = tryBani(line.unitPrice);
          if (upCents === undefined) {
            push('D406_AMOUNT', `${lPath}.unitPrice`, `UnitPrice invalid: ${line.unitPrice}.`);
          } else if (line.unitPrice !== fmtBani(upCents)) {
            push(
              'D406_AMOUNT',
              `${lPath}.unitPrice`,
              `Formatul UnitPrice (${line.unitPrice}) diferă de ${fmtBani(upCents)}.`,
            );
          }
        }
        checkDateField(line.taxPointDate, `${lPath}.taxPointDate`, 'TaxPointDate');
        if (line.taxPointDate === undefined) {
          push('D406_DATE', `${lPath}.taxPointDate`, 'Lipsește TaxPointDate.');
        }
        const taxPointDate =
          line.taxPointDate !== undefined && line.taxPointDate !== inv.date
            ? line.taxPointDate
            : undefined;
        const side = line.side !== undefined && line.side !== normalSide ? line.side : undefined;
        const { amount, currency } = convertFiledAmount(line.amount, `${lPath}.amount`);
        const tax = convertTaxList(line.tax, currency, `${lPath}.tax`);
        return definedFields({
          account: resolveAccountRef(line.account, `${lPath}.account`),
          product: line.product,
          description: line.description ?? '',
          quantity: line.quantity ?? '',
          unit,
          unitPrice: line.unitPrice ?? '',
          amount,
          currency,
          taxPointDate,
          side,
          tax,
        });
      });
      if (!inv.totals) {
        push('D406_TOTAL_MISMATCH', `${iPath}.totals`, 'Lipsește InvoiceDocumentTotals.');
      }
      return definedFields({
        number: inv.number ?? '',
        party,
        account,
        date: inv.date ?? '',
        type: inv.type ?? '',
        selfBilling: inv.selfBilling === '389' ? true : undefined,
        transaction: inv.transaction,
        paymentTerms: inv.paymentTerms,
        lines,
      });
    });
  };

  const salesInvoices = convertInvoices(filed.sourceDocuments.salesInvoices, customers, true);
  const purchaseInvoices = convertInvoices(
    filed.sourceDocuments.purchaseInvoices,
    suppliers,
    false,
  );

  const paymentsSection = filed.sourceDocuments.payments;
  if (paymentsSection && paymentsSection.payments.length === 0) {
    push(
      'D406_UNSUPPORTED_SECTION',
      'sourceDocuments.payments',
      'Secțiunea payments fără documente nu este scrisă de modelul D406.',
    );
  }
  const payments: D406Payment[] = (paymentsSection?.payments ?? []).map((pay, pIdx) => {
    const pPath = `sourceDocuments.payments.payments.${pIdx}`;
    if (!isDate(pay.date)) {
      push('D406_DATE', `${pPath}.date`, 'TransactionDate a plății lipsește sau este invalidă.');
    } else {
      const expectedPeriod = String(Number(pay.date.slice(5, 7)));
      const expectedYear = pay.date.slice(0, 4);
      if (pay.period !== expectedPeriod) {
        push(
          'D406_PERIOD',
          `${pPath}.period`,
          `Period (${pay.period ?? 'lipsă'}) diferă de ${expectedPeriod}.`,
        );
      }
      if (pay.periodYear !== expectedYear) {
        push(
          'D406_PERIOD',
          `${pPath}.periodYear`,
          `PeriodYear (${pay.periodYear ?? 'lipsă'}) diferă de ${expectedYear}.`,
        );
      }
    }
    if (!pay.mechanism) {
      push(
        'D406_MECHANISM',
        `${pPath}.mechanism`,
        `Plata ${pay.reference ?? pIdx + 1} nu are PaymentMechanism (doar PaymentMethod ${pay.method ?? 'lipsă'}).`,
      );
    } else {
      const expectedMethod = paymentMechanisms[pay.mechanism]?.method;
      if (!expectedMethod) {
        push(
          'D406_MECHANISM',
          `${pPath}.mechanism`,
          `Mecanism de plată necunoscut: ${pay.mechanism}.`,
        );
      } else if (pay.method !== expectedMethod) {
        push(
          'D406_MECHANISM',
          `${pPath}.method`,
          `PaymentMethod (${pay.method ?? 'lipsă'}) diferă de ${expectedMethod}.`,
        );
      }
    }
    const firstSide = pay.lines[0]?.side;
    const direction: 'collection' | 'payment' = firstSide === 'credit' ? 'payment' : 'collection';
    const defaultSide = direction === 'collection' ? 'debit' : 'credit';
    const lines: D406PaymentLine[] = pay.lines.map((line, lIdx) => {
      const lPath = `${pPath}.lines.${lIdx}`;
      if (line.lineNumber !== String(lIdx + 1)) {
        push(
          'D406_LINE_NUMBER',
          `${lPath}.lineNumber`,
          `LineNumber (${line.lineNumber ?? 'lipsă'}) diferă de ${lIdx + 1}.`,
        );
      }
      if (line.rawSide !== undefined || line.side === undefined) {
        push(
          'D406_SIDE',
          `${lPath}.side`,
          `DebitCreditIndicator invalid sau lipsă: ${line.rawSide ?? 'lipsă'}.`,
        );
      }
      const { amount, currency } = convertFiledAmount(line.amount, `${lPath}.amount`);
      const side = line.side !== undefined && line.side !== defaultSide ? line.side : undefined;
      if (!line.tax || line.tax.length === 0) {
        push('D406_TAX', `${lPath}.tax`, 'Lipsește TaxInformation pe linia de plată.');
      }
      const tax =
        line.tax && line.tax.length > 0 && !isNoTax(line.tax)
          ? convertTaxList(line.tax, currency, `${lPath}.tax`)
          : undefined;
      return definedFields({
        account: resolveAccountRef(line.account, `${lPath}.account`),
        ...resolveLinePartners(line.customer, line.supplier, lPath),
        document: line.document,
        description: line.description,
        amount,
        currency,
        side,
        tax,
      });
    });
    if (!pay.totals?.grossTotal) {
      push('D406_TOTAL_MISMATCH', `${pPath}.totals`, 'Lipsește PaymentDocumentTotals/GrossTotal.');
    }
    return definedFields({
      reference: pay.reference ?? '',
      date: pay.date ?? '',
      mechanism: pay.mechanism ?? '',
      description: pay.description ?? '',
      direction,
      transaction: pay.transaction,
      lines,
    });
  });

  // Validate units on products against writer's supported unit table.
  products.forEach((product, index) => {
    if (product.unit && !units[product.unit]) {
      push(
        'D406_UNIT',
        `masterFiles.products.${index}.uomBase`,
        `Unitate necunoscută: ${product.unit}.`,
      );
    }
  });

  const model: D406 = definedFields({
    type: type ?? 'L',
    period,
    created: filed.header.created ?? '',
    software: {
      company: sw.company ?? '',
      name: sw.name ?? '',
      version: sw.version ?? '',
    },
    company: {
      cui: cui ?? '',
      name: comp.name ?? '',
      address: companyAddress,
      contact: definedFields({
        firstName: comp.contact?.firstName ?? '',
        lastName: comp.contact?.lastName ?? '',
        phone: comp.contact?.phone ?? '',
        email: comp.contact?.email,
      }),
      ibans: comp.ibans,
      vatRegime,
    },
    accounts,
    customers,
    suppliers,
    products,
    journals,
    salesInvoices,
    purchaseInvoices,
    payments,
    baseRates: Object.keys(baseRates).length > 0 ? baseRates : undefined,
  });

  // Sanitize invalid dates only on the temporary checkD406 copy so d406.ts never throws RangeError.
  const safeDate = (value: string) => (isDate(value) ? value : '');
  const safeOptDate = (value: string | undefined) =>
    value === undefined || isDate(value) ? value : '';
  const modelForCheck: D406 = {
    ...model,
    created: safeDate(model.created),
    journals: model.journals.map((j) => ({
      ...j,
      transactions: j.transactions.map((tx) => ({
        ...tx,
        date: safeDate(tx.date),
        posted: safeOptDate(tx.posted),
        entered: safeOptDate(tx.entered),
      })),
    })),
    salesInvoices: model.salesInvoices.map((inv) => ({
      ...inv,
      date: safeDate(inv.date),
      lines: inv.lines.map((l) => ({ ...l, taxPointDate: safeOptDate(l.taxPointDate) })),
    })),
    purchaseInvoices: model.purchaseInvoices.map((inv) => ({
      ...inv,
      date: safeDate(inv.date),
      lines: inv.lines.map((l) => ({ ...l, taxPointDate: safeOptDate(l.taxPointDate) })),
    })),
    payments: model.payments.map((p) => ({ ...p, date: safeDate(p.date) })),
  };
  for (const check of checkD406(modelForCheck)) {
    if (check.severity === 'error') {
      push(check.code, filedPathFromModelPath(check.path, filed, accountIndices), check.message);
    }
  }

  // Compare writer-computed outputs (closing balances, totals, TaxTable, UOMTable) against filed.
  let calculation: D406Calculation | undefined;
  try {
    calculation = calculateD406(model);
  } catch {
    calculation = undefined;
  }
  if (calculation) {
    const calcAccountsByCode = new Map(calculation.accounts.map((a) => [a.code, a]));
    accountIndices.forEach((filedIdx, calcIdx) => {
      const acc = filed.masterFiles.accounts[filedIdx];
      const modelAcc = accounts[calcIdx];
      const calcAcc = modelAcc ? calcAccountsByCode.get(modelAcc.code) : undefined;
      if (!acc || !calcAcc) return;
      checkBalanceFields(
        acc.closingDebit,
        acc.closingCredit,
        calcAcc.closing,
        calcAcc.type === 'Pasiv',
        `masterFiles.accounts.${filedIdx}.closing`,
        'Soldul final al contului',
        push,
      );
    });
    const calcPartyByKey = (parties: D406Party[], calculated: (D406Balance & { id: string })[]) => {
      const uniqueKeys: string[] = [];
      const seen = new Set<string>();
      for (const party of parties) {
        const key = `${party.id}|${party.account}`;
        if (!seen.has(key)) {
          seen.add(key);
          uniqueKeys.push(key);
        }
      }
      const map = new Map<string, D406Balance & { id: string }>();
      uniqueKeys.forEach((key, idx) => {
        const entry = calculated[idx];
        if (entry) map.set(key, entry);
      });
      return map;
    };
    const calcCustomers = calcPartyByKey(customers, calculation.customers);
    filed.masterFiles.customers.forEach((cust, i) => {
      const modelParty = customers[i];
      const calcCust = modelParty
        ? calcCustomers.get(`${modelParty.id}|${modelParty.account}`)
        : undefined;
      if (!calcCust) return;
      checkBalanceFields(
        cust.closingDebit,
        cust.closingCredit,
        calcCust.closing,
        false,
        `masterFiles.customers.${i}.closing`,
        'Soldul final al clientului',
        push,
      );
    });
    const calcSuppliers = calcPartyByKey(suppliers, calculation.suppliers);
    filed.masterFiles.suppliers.forEach((sup, i) => {
      const modelParty = suppliers[i];
      const calcSup = modelParty
        ? calcSuppliers.get(`${modelParty.id}|${modelParty.account}`)
        : undefined;
      if (!calcSup) return;
      checkBalanceFields(
        sup.closingDebit,
        sup.closingCredit,
        calcSup.closing,
        true,
        `masterFiles.suppliers.${i}.closing`,
        'Soldul final al furnizorului',
        push,
      );
    });

    // GeneralLedgerEntries totals.
    const gl = filed.generalLedgerEntries;
    if (gl.numberOfEntries !== String(calculation.ledger.lines)) {
      push(
        'D406_TOTAL_MISMATCH',
        'generalLedgerEntries.numberOfEntries',
        `NumberOfEntries (${gl.numberOfEntries ?? 'lipsă'}) diferă de ${calculation.ledger.lines}.`,
      );
    }
    if (gl.totalDebit !== fmtBani(calculation.ledger.debit)) {
      push(
        'D406_TOTAL_MISMATCH',
        'generalLedgerEntries.totalDebit',
        `TotalDebit (${gl.totalDebit ?? 'lipsă'}) diferă de ${fmtBani(calculation.ledger.debit)}.`,
      );
    }
    if (gl.totalCredit !== fmtBani(calculation.ledger.credit)) {
      push(
        'D406_TOTAL_MISMATCH',
        'generalLedgerEntries.totalCredit',
        `TotalCredit (${gl.totalCredit ?? 'lipsă'}) diferă de ${fmtBani(calculation.ledger.credit)}.`,
      );
    }

    // Invoices totals & TaxInformationTotals against writer output.
    for (const [key, calcSection] of [
      ['salesInvoices', calculation.sales],
      ['purchaseInvoices', calculation.purchases],
    ] as const) {
      const filedSection = filed.sourceDocuments[key];
      if (!filedSection || filedSection.invoices.length === 0) continue;
      const basePath = `sourceDocuments.${key}`;
      if (filedSection.numberOfEntries !== String(calcSection.count)) {
        push(
          'D406_TOTAL_MISMATCH',
          `${basePath}.numberOfEntries`,
          `NumberOfEntries (${filedSection.numberOfEntries ?? 'lipsă'}) diferă de ${calcSection.count}.`,
        );
      }
      if (filedSection.totalDebit !== fmtBani(calcSection.debit)) {
        push(
          'D406_TOTAL_MISMATCH',
          `${basePath}.totalDebit`,
          `TotalDebit (${filedSection.totalDebit ?? 'lipsă'}) diferă de ${fmtBani(calcSection.debit)}.`,
        );
      }
      if (filedSection.totalCredit !== fmtBani(calcSection.credit)) {
        push(
          'D406_TOTAL_MISMATCH',
          `${basePath}.totalCredit`,
          `TotalCredit (${filedSection.totalCredit ?? 'lipsă'}) diferă de ${fmtBani(calcSection.credit)}.`,
        );
      }
      filedSection.invoices.forEach((inv, i) => {
        const calcInv = calcSection.invoices[i];
        const totals = inv.totals;
        if (!calcInv || !totals) return;
        const tPath = `${basePath}.invoices.${i}.totals`;
        if (totals.netTotal !== fmtBani(calcInv.net)) {
          push(
            'D406_TOTAL_MISMATCH',
            `${tPath}.netTotal`,
            `NetTotal (${totals.netTotal ?? 'lipsă'}) diferă de ${fmtBani(calcInv.net)}.`,
          );
        }
        if (totals.grossTotal !== fmtBani(calcInv.gross)) {
          push(
            'D406_TOTAL_MISMATCH',
            `${tPath}.grossTotal`,
            `GrossTotal (${totals.grossTotal ?? 'lipsă'}) diferă de ${fmtBani(calcInv.gross)}.`,
          );
        }
        if (totals.taxes.length !== calcInv.taxes.length) {
          push(
            'D406_TOTAL_MISMATCH',
            `${tPath}.taxes`,
            `Numărul de blocuri TaxInformationTotals (${totals.taxes.length}) diferă de ${calcInv.taxes.length}.`,
          );
        } else {
          totals.taxes.forEach((tax, tIdx) => {
            const expected = calcInv.taxes[tIdx];
            if (!expected) return;
            const amtText = fmtBani(expected.amount);
            checkTaxElementMatches(
              tax,
              {
                type: expected.type,
                code: expected.code,
                percentage: expectedTaxPercentage(
                  expected.type,
                  expected.code,
                  expected.percentage,
                ),
                base: fmtBani(expected.base),
                amount: amtText,
                currencyCode: 'RON',
                currencyAmount: amtText,
                exchangeRate: undefined,
              },
              `${tPath}.taxes.${tIdx}`,
              push,
            );
          });
        }
      });
    }

    // Payments totals against writer output.
    if (paymentsSection && paymentsSection.payments.length > 0) {
      const pBase = 'sourceDocuments.payments';
      if (paymentsSection.numberOfEntries !== String(calculation.payments.count)) {
        push(
          'D406_TOTAL_MISMATCH',
          `${pBase}.numberOfEntries`,
          `NumberOfEntries (${paymentsSection.numberOfEntries ?? 'lipsă'}) diferă de ${calculation.payments.count}.`,
        );
      }
      if (paymentsSection.totalDebit !== fmtBani(calculation.payments.debit)) {
        push(
          'D406_TOTAL_MISMATCH',
          `${pBase}.totalDebit`,
          `TotalDebit (${paymentsSection.totalDebit ?? 'lipsă'}) diferă de ${fmtBani(calculation.payments.debit)}.`,
        );
      }
      if (paymentsSection.totalCredit !== fmtBani(calculation.payments.credit)) {
        push(
          'D406_TOTAL_MISMATCH',
          `${pBase}.totalCredit`,
          `TotalCredit (${paymentsSection.totalCredit ?? 'lipsă'}) diferă de ${fmtBani(calculation.payments.credit)}.`,
        );
      }
      paymentsSection.payments.forEach((pay, pIdx) => {
        const gross = calculation.payments.gross[pIdx];
        if (gross === undefined) return;
        const expectedGross = fmtBani(gross);
        if (pay.totals && pay.totals.grossTotal !== expectedGross) {
          push(
            'D406_TOTAL_MISMATCH',
            `${pBase}.payments.${pIdx}.totals.grossTotal`,
            `GrossTotal (${pay.totals.grossTotal ?? 'lipsă'}) diferă de ${expectedGross}.`,
          );
        }
      });
    }

    // TaxTable against writer output (skipped when an unknown tax code was already reported).
    const allKnownVat = calculation.vatCodes.every((code) => vatTaxCodes[code] !== undefined);
    const allKnownWht = calculation.whtCodes.every((code) => whtTaxCodes[code] !== undefined);
    if (allKnownVat && allKnownWht) {
      const expectedTaxTable: D406FiledTaxTableEntry[] = [];
      if (calculation.vatCodes.length > 0) {
        expectedTaxTable.push({
          type: '300',
          description: taxTypes['300'],
          codes: calculation.vatCodes.flatMap((code) => {
            const entry = vatTaxCodes[code]!;
            const items =
              entry.percentage === null
                ? calculation!.stateRates.filter((r) => r.code === code)
                : [{ country: 'RO', percentage: entry.percentage }];
            return items.map(({ country, percentage }) => ({
              code,
              description: entry.description.slice(0, 256),
              percentage,
              baseRates:
                entry.kind === 'baserate'
                  ? (model.baseRates?.[code] ?? []).map((p) => (p / 100).toFixed(4))
                  : ['1'],
              country,
            }));
          }),
        });
      }
      for (const whtType of [...new Set(calculation.whtCodes.map((c) => whtTaxCodes[c]!.type))]) {
        expectedTaxTable.push({
          type: whtType,
          description: taxTypes[whtType]?.slice(0, 256),
          codes: calculation.whtCodes
            .filter((c) => whtTaxCodes[c]!.type === whtType)
            .map((code) => ({
              code,
              description: whtTaxCodes[code]!.description.slice(0, 256),
              percentage: whtTaxCodes[code]!.percentage,
              baseRates: ['1'],
              country: 'RO',
            })),
        });
      }
      const filedTaxTable = filed.masterFiles.taxTable;
      if (filedTaxTable.length !== expectedTaxTable.length) {
        push(
          'D406_TAX_TABLE',
          'masterFiles.taxTable',
          `TaxTable are ${filedTaxTable.length} intrări în loc de ${expectedTaxTable.length}.`,
        );
      } else {
        filedTaxTable.forEach((entry, eIdx) => {
          const exp = expectedTaxTable[eIdx];
          if (!exp) return;
          const ePath = `masterFiles.taxTable.${eIdx}`;
          if (entry.type !== exp.type)
            push(
              'D406_TAX_TYPE',
              `${ePath}.type`,
              `TaxType (${entry.type ?? 'lipsă'}) diferă de ${exp.type}.`,
            );
          if (entry.description !== exp.description)
            push(
              'D406_TAX_TABLE',
              `${ePath}.description`,
              `Descrierea TaxTable (${entry.description ?? 'lipsă'}) diferă de ${exp.description ?? 'lipsă'}.`,
            );
          if (entry.codes.length !== exp.codes.length) {
            push(
              'D406_TAX_TABLE',
              `${ePath}.codes`,
              `Numărul de coduri din TaxTable (${entry.codes.length}) diferă de ${exp.codes.length}.`,
            );
          } else {
            entry.codes.forEach((detail, dIdx) => {
              const expDet = exp.codes[dIdx];
              if (!expDet) return;
              const dPath = `${ePath}.codes.${dIdx}`;
              if (detail.code !== expDet.code)
                push(
                  'D406_TAX_CODE',
                  `${dPath}.code`,
                  `TaxCode (${detail.code ?? 'lipsă'}) diferă de ${expDet.code}.`,
                );
              if (detail.description !== expDet.description)
                push(
                  'D406_TAX_TABLE',
                  `${dPath}.description`,
                  `Descrierea codului ${detail.code ?? ''} diferă de nomenclator.`,
                );
              if (detail.percentage !== expDet.percentage)
                push(
                  'D406_TAX_PERCENTAGE',
                  `${dPath}.percentage`,
                  `TaxPercentage (${detail.percentage ?? 'lipsă'}) diferă de ${expDet.percentage ?? 'lipsă'}.`,
                );
              if (detail.country !== expDet.country)
                push(
                  'D406_TAX_CODE',
                  `${dPath}.country`,
                  `Country (${detail.country ?? 'lipsă'}) diferă de ${expDet.country ?? 'lipsă'}.`,
                );
              if (
                detail.baseRates.length !== expDet.baseRates.length ||
                detail.baseRates.some((r, idx) => r !== expDet.baseRates[idx])
              ) {
                push(
                  'D406_BASE_RATE',
                  `${dPath}.baseRates`,
                  `BaseRate (${detail.baseRates.join(', ')}) diferă de ${expDet.baseRates.join(', ')}.`,
                );
              }
            });
          }
        });
      }
    }

    // UOMTable against writer output.
    const expectedUnits = calculation.units.map((unit) => ({ unit, description: units[unit] }));
    const filedUnits = filed.masterFiles.units;
    if (filedUnits.length !== expectedUnits.length) {
      push(
        'D406_UNIT',
        'masterFiles.units',
        `UOMTable are ${filedUnits.length} unități în loc de ${expectedUnits.length}.`,
      );
    } else {
      filedUnits.forEach((u, uIdx) => {
        const exp = expectedUnits[uIdx];
        if (!exp) return;
        if (u.unit !== exp.unit)
          push(
            'D406_UNIT',
            `masterFiles.units.${uIdx}.unit`,
            `UnitOfMeasure (${u.unit ?? 'lipsă'}) diferă de ${exp.unit}.`,
          );
        if (u.description !== exp.description)
          push(
            'D406_UNIT',
            `masterFiles.units.${uIdx}.description`,
            `Descrierea unității (${u.description ?? 'lipsă'}) diferă de ${exp.description ?? 'lipsă'}.`,
          );
      });
    }
  }

  return { model: type ? model : undefined, problems };
}
