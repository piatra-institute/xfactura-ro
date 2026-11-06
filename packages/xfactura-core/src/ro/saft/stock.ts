import { DomainError } from '../../errors';
import { formatQuantity } from '../../kernel';
import { formatScaled } from '../../money';
import { element, leaf, serializeXml } from '../../xml/write';
import { d406AccountId, d406AccountType, d406StandardAccount } from './accounts';
import { units } from './data/codes';
import {
  address,
  balance,
  checkHeader,
  d406Namespace,
  headerElement,
  prefixed,
  type D406HeaderInput,
} from './d406';

/*
 * D406's on-demand stock file (HeaderComment C, "pentru declarații la cerere"; OPANAF nr.
 * 1.783/2021 anexa nr. 4 pct. 9–10, ANAF's guide sec. 4.6 and its answers): for the month or the
 * quarter ANAF asks for, the stock accounts with their balances, the units, the movement types,
 * the products, the physical stock per warehouse, product and (FIFO, LIFO) lot with its opening and
 * closing quantity and value, the company as the owner, and every stock movement on its
 * documents. The other sections are present and empty, as the structure wants them (xlsx column
 * U: Customers, Suppliers, the entries and the invoices are N/A; AnalysisTypeTable empty).
 */

/** The movement types of the register, as the nomenclator codes them (sheet Nomenclator stocuri;
 * any other value is a fatal error). */
export const stockMovementTypes: Readonly<Record<string, string>> = {
  '10': 'Achiziție',
  '20': 'Producție',
  '30': 'Vânzare',
  '40': 'Retur produse vândute',
  '50': 'Retur produse achiziționate',
  '60': 'Reduceri comerciale primite',
  '70': 'Consum',
  '80': 'Transfer intern',
  '100': 'Diferențe de preț pozitive',
  '101': 'Diferențe de preț negative',
  '110': 'Plus de inventar',
  '120': 'Minus de inventar',
  '180': 'Alte tranzacții',
};

export type D406StockAccount = {
  code: string;
  description: string;
  /** Debit positive, in bani. */
  opening: bigint;
  closing: bigint;
};

export type D406StockProduct = {
  code: string;
  description: string;
  /** NC8, or 0 where none applies. */
  commodityCode: string;
  /** ValuationMethod: FIFO, LIFO or CMP, the weighted average (ANAF's guide, sec. 2.9: "metoda
   * de evaluare (FIFO, LIFO, CMP)"; the structure's "Cost mediu" exceeds the 9 characters of
   * SAFcodeType, which ANAF's validator refuses). */
  valuation: 'FIFO' | 'LIFO' | 'CMP';
  unit: string;
};

export type D406PhysicalStock = {
  warehouse: string;
  product: string;
  /** StockAccountNo: the lot, when an item has several in the warehouse (FIFO, LIFO). */
  lot?: string;
  /** ProductType: what the stock account holds (mărfuri, materii prime, …). */
  type: string;
  commodityCode: string;
  owner: string;
  unit: string;
  /** In bani per unit, to two decimals: the lot's cost, or the average's. */
  unitPrice: bigint;
  /** Thousandths and bani. */
  opening: { quantity: bigint; bani: bigint };
  closing: { quantity: bigint; bani: bigint };
};

export type D406StockMovementLine = {
  account: string;
  transaction?: string;
  customer: string;
  supplier: string;
  product: string;
  lot?: string;
  /** Signed thousandths; BookValue signed bani. */
  quantity: bigint;
  unit: string;
  bookValue: bigint;
  subType: string;
  comments?: string;
};

export type D406StockMovement = {
  reference: string;
  date: string;
  type: string;
  document?: { type: string; number: string };
  lines: D406StockMovementLine[];
};

export type D406Stock = D406HeaderInput & {
  period: { start: string; end: string };
  /** The company as the owner of its stock (OwnerID 00 + CUI) and the account it answers on. */
  owner: { id: string; account: string };
  accounts: D406StockAccount[];
  products: D406StockProduct[];
  stock: D406PhysicalStock[];
  movements: D406StockMovement[];
};

export type D406StockCheck = { code: string; path: string; message: string };

const money = (bani: bigint) => formatScaled(bani, 2);
const quantity = (milli: bigint) => formatQuantity(milli);

/** The file's own checks: the header, each movement type and unit coded, each product's NC8. */
export function checkD406Stock(model: D406Stock): D406StockCheck[] {
  const checks: D406StockCheck[] = [];
  const error = (code: string, path: string, message: string) =>
    checks.push({ code, path, message });
  checkHeader(error, model);
  model.products.forEach((product, index) => {
    if (!units[product.unit])
      error(
        'D406S_UNIT',
        `products.${index}.unit`,
        `Unitatea ${product.unit} nu este în nomenclatorul unităților de măsură.`,
      );
    if (product.commodityCode !== '0' && !/^\d{8}$/.test(product.commodityCode))
      error('D406S_NC8', `products.${index}.commodityCode`, 'Codul NC are opt cifre (sau 0).');
  });
  model.movements.forEach((movement, index) => {
    if (!stockMovementTypes[movement.type])
      error(
        'D406S_MOVEMENT_TYPE',
        `movements.${index}.type`,
        `Tipul de mișcare ${movement.type} nu este în nomenclatorul de stocuri.`,
      );
    if (!movement.lines.length)
      error(
        'D406S_MOVEMENT_LINES',
        `movements.${index}`,
        'O mișcare de stoc are cel puțin o linie.',
      );
  });
  return checks;
}

/** Writes the on-demand stock file. Throws on the errors checkD406Stock reports. */
export function writeD406Stock(model: D406Stock): string {
  const [blocking] = checkD406Stock(model);
  if (blocking) throw new DomainError(blocking.code, blocking.message);
  const usedTypes = [...new Set(model.movements.map((movement) => movement.type))].sort(
    (a, b) => Number(a) - Number(b),
  );
  const usedUnits = [
    ...new Set([
      ...model.products.map((product) => product.unit),
      ...model.stock.map((row) => row.unit),
    ]),
  ];
  const lines = model.movements.flatMap((movement) => movement.lines);
  const received = lines.reduce((sum, line) => sum + (line.quantity > 0n ? line.quantity : 0n), 0n);
  const issued = lines.reduce((sum, line) => sum + (line.quantity < 0n ? -line.quantity : 0n), 0n);
  const root = prefixed(
    element(
      'AuditFile',
      null,
      headerElement(model, model.period, 'C'),
      element(
        'MasterFiles',
        null,
        element(
          'GeneralLedgerAccounts',
          null,
          model.accounts.map((account) =>
            element(
              'Account',
              null,
              leaf('AccountID', d406AccountId(account.code)),
              leaf('AccountDescription', account.description),
              leaf('StandardAccountID', d406StandardAccount(account.code)),
              leaf('AccountType', d406AccountType(account.code)),
              balance('Opening', account.opening, false),
              balance('Closing', account.closing, false),
            ),
          ),
        ),
        element('Customers', null),
        element('Suppliers', null),
        element('TaxTable', null),
        element(
          'UOMTable',
          null,
          usedUnits.map((unit) =>
            element(
              'UOMTableEntry',
              null,
              leaf('UnitOfMeasure', unit),
              leaf('Description', units[unit] ?? unit),
            ),
          ),
        ),
        element('AnalysisTypeTable', null),
        element(
          'MovementTypeTable',
          null,
          usedTypes.map((type) =>
            element(
              'MovementTypeTableEntry',
              null,
              leaf('MovementType', type),
              leaf('Description', stockMovementTypes[type]),
            ),
          ),
        ),
        element(
          'Products',
          null,
          model.products.map((product) =>
            element(
              'Product',
              null,
              leaf('ProductCode', product.code),
              leaf('GoodsServicesID', '01'),
              leaf('Description', product.description),
              leaf('ProductCommodityCode', product.commodityCode),
              leaf('ValuationMethod', product.valuation),
              leaf('UOMBase', product.unit),
              leaf('UOMStandard', product.unit),
              leaf('UOMToUOMBaseConversionFactor', '1'),
            ),
          ),
        ),
        model.stock.length
          ? element(
              'PhysicalStock',
              null,
              model.stock.map((row) =>
                element(
                  'PhysicalStockEntry',
                  null,
                  leaf('WarehouseID', row.warehouse),
                  leaf('ProductCode', row.product),
                  leaf('StockAccountNo', row.lot),
                  leaf('ProductType', row.type),
                  leaf('StockAccountCommodityCode', row.commodityCode),
                  leaf('OwnerID', row.owner),
                  leaf('UOMPhysicalStock', row.unit),
                  leaf('UOMToUOMBaseConversionFactor', '1'),
                  leaf('UnitPrice', money(row.unitPrice)),
                  leaf('OpeningStockQuantity', quantity(row.opening.quantity)),
                  leaf('OpeningStockValue', money(row.opening.bani)),
                  leaf('ClosingStockQuantity', quantity(row.closing.quantity)),
                  leaf('ClosingStockValue', money(row.closing.bani)),
                  element(
                    'StockCharacteristics',
                    null,
                    leaf('StockCharacteristic', '0'),
                    leaf('StockCharacteristicValue', '0'),
                  ),
                ),
              ),
            )
          : null,
        element(
          'Owners',
          null,
          element(
            'Owner',
            null,
            element(
              'CompanyStructure',
              null,
              leaf('RegistrationNumber', model.owner.id),
              leaf('Name', model.company.name),
              address(model.company.address),
            ),
            leaf('OwnerID', model.owner.id),
            leaf('AccountID', d406AccountId(model.owner.account)),
          ),
        ),
        element('Assets', null),
      ),
      element('GeneralLedgerEntries', null),
      element(
        'SourceDocuments',
        null,
        element('SalesInvoices', null),
        element('PurchaseInvoices', null),
        element('Payments', null),
        element(
          'MovementOfGoods',
          null,
          leaf('NumberOfMovementLines', String(lines.length)),
          leaf('TotalQuantityReceived', quantity(received)),
          leaf('TotalQuantityIssued', quantity(issued)),
          model.movements.map((movement) =>
            element(
              'StockMovement',
              null,
              leaf('MovementReference', movement.reference),
              leaf('MovementDate', movement.date),
              leaf('MovementType', movement.type),
              movement.document &&
                element(
                  'DocumentReference',
                  null,
                  leaf('DocumentType', movement.document.type),
                  leaf('DocumentNumber', movement.document.number),
                ),
              movement.lines.map((line, index) =>
                element(
                  'StockMovementLine',
                  null,
                  leaf('LineNumber', String(index + 1)),
                  leaf('AccountID', d406AccountId(line.account)),
                  leaf('TransactionID', line.transaction),
                  leaf('CustomerID', line.customer),
                  leaf('SupplierID', line.supplier),
                  leaf('ProductCode', line.product),
                  leaf('StockAccountNo', line.lot),
                  leaf('Quantity', quantity(line.quantity)),
                  leaf('UnitOfMeasure', line.unit),
                  leaf('UOMToUOMPhysicalStockConversionFactor', '1'),
                  leaf('BookValue', money(line.bookValue)),
                  leaf('MovementSubType', line.subType),
                  leaf('MovementComments', line.comments),
                ),
              ),
            ),
          ),
        ),
      ),
    ),
  );
  return serializeXml({ ...root, attributes: [['xmlns:nsSAFT', d406Namespace]] });
}
