import { describe, expect, test } from 'bun:test';
import { checkMapping, proposeMapping } from '../src/mapping';
import {
  mappingChart,
  mappingFiled,
  sourceAccount,
  sourceLine,
  sourcePartner,
} from './fixtures/mapping';

const customer = '0090000002';
const other = '0090000003';
const transactionPath = 'filed.0.generalLedgerEntries.journals.0.transactions.0';
const salePath = 'filed.0.sourceDocuments.salesInvoices.invoices.0';
const purchasePath = 'filed.0.sourceDocuments.purchaseInvoices.invoices.0';
const paymentPath = 'filed.0.sourceDocuments.payments.payments.0.lines.0';
const stockPath = 'filed.0.sourceDocuments.movementOfGoods.movements.0.lines.0';

function scenario() {
  const ids = [
    'GENERAL',
    'BASE',
    'SALE',
    'SALE-LINE',
    'PURCHASE',
    'PURCHASE-LINE',
    'PAYMENT',
    'STOCK',
    'ASSET',
  ];
  const file = mappingFiled({
    accounts: ids.map((id) => sourceAccount(id, '628')).join(''),
    customers:
      sourcePartner('Customer', customer, 'BASE') + sourcePartner('Customer', other, 'BASE'),
    suppliers:
      sourcePartner('Supplier', customer, 'BASE') + sourcePartner('Supplier', other, 'BASE'),
    transaction: `<CustomerID>${other}</CustomerID><SupplierID>${other}</SupplierID>`,
    lines: sourceLine(
      'GENERAL',
      `<CustomerID>${customer}</CustomerID><SupplierID>${customer}</SupplierID>`,
    ),
    documents: `<SalesInvoices><Invoice><CustomerInfo><CustomerID>${customer}</CustomerID></CustomerInfo>
      <AccountID>SALE</AccountID><InvoiceLine><AccountID>SALE-LINE</AccountID></InvoiceLine></Invoice></SalesInvoices>
      <PurchaseInvoices><Invoice><SupplierInfo><SupplierID>${customer}</SupplierID></SupplierInfo>
      <AccountID>PURCHASE</AccountID><InvoiceLine><AccountID>PURCHASE-LINE</AccountID></InvoiceLine></Invoice></PurchaseInvoices>
      <Payments><Payment><PaymentLine><AccountID>PAYMENT</AccountID><CustomerID>${customer}</CustomerID>
      <SupplierID>${customer}</SupplierID></PaymentLine></Payment></Payments>`,
  });
  file.sourceDocuments.movementOfGoods = {
    movements: [{ lines: [{ account: 'STOCK', customer, supplier: customer }] }],
  };
  file.masterFiles.assets = [
    { id: 'A', account: 'ASSET', supplier: { id: customer }, valuations: [] },
  ];
  file.sourceDocuments.assetTransactions = {
    transactions: [{ supplier: { id: customer }, valuations: [] }],
  };
  const mapping = proposeMapping([file], mappingChart, []);
  expect(checkMapping(mapping, [file])).toEqual([]);
  return { file, mapping };
}

describe('every removed mapping reference blocks at its exact path', () => {
  test.each([
    ['GENERAL', 'filed.0.masterFiles.accounts.0'],
    ['BASE', 'filed.0.masterFiles.accounts.1'],
    ['SALE', 'filed.0.masterFiles.accounts.2'],
    ['SALE-LINE', 'filed.0.masterFiles.accounts.3'],
    ['PURCHASE', 'filed.0.masterFiles.accounts.4'],
    ['PURCHASE-LINE', 'filed.0.masterFiles.accounts.5'],
    ['PAYMENT', 'filed.0.masterFiles.accounts.6'],
    ['STOCK', 'filed.0.masterFiles.accounts.7'],
    ['ASSET', 'filed.0.masterFiles.accounts.8'],
    ['BASE', 'filed.0.masterFiles.customers.0.account'],
    ['BASE', 'filed.0.masterFiles.customers.1.account'],
    ['BASE', 'filed.0.masterFiles.suppliers.0.account'],
    ['BASE', 'filed.0.masterFiles.suppliers.1.account'],
    ['GENERAL', `${transactionPath}.lines.0.account`],
    ['SALE', `${salePath}.account`],
    ['SALE-LINE', `${salePath}.lines.0.account`],
    ['PURCHASE', `${purchasePath}.account`],
    ['PURCHASE-LINE', `${purchasePath}.lines.0.account`],
    ['PAYMENT', `${paymentPath}.account`],
    ['STOCK', `${stockPath}.account`],
    ['ASSET', 'filed.0.masterFiles.assets.0.account'],
  ])('removed account %s blocks %s', (id, path) => {
    const { file, mapping } = scenario();
    mapping.accounts = mapping.accounts.filter((account) => account.sourceId !== id);
    expect(checkMapping(mapping, [file])).toContainEqual({ code: 'ACCOUNT_UNMAPPED', path });
  });

  test.each([
    ['customer', customer, 'filed.0.masterFiles.customers.0.id'],
    ['customer', other, 'filed.0.masterFiles.customers.1.id'],
    ['supplier', customer, 'filed.0.masterFiles.suppliers.0.id'],
    ['supplier', other, 'filed.0.masterFiles.suppliers.1.id'],
    ['customer', other, `${transactionPath}.customer`],
    ['supplier', other, `${transactionPath}.supplier`],
    ['customer', customer, `${transactionPath}.lines.0.customer`],
    ['supplier', customer, `${transactionPath}.lines.0.supplier`],
    ['customer', customer, `${salePath}.party.id`],
    ['supplier', customer, `${purchasePath}.party.id`],
    ['customer', customer, `${paymentPath}.customer`],
    ['supplier', customer, `${paymentPath}.supplier`],
    ['customer', customer, `${stockPath}.customer`],
    ['supplier', customer, `${stockPath}.supplier`],
    ['supplier', customer, 'filed.0.masterFiles.assets.0.supplier.id'],
    ['supplier', customer, 'filed.0.sourceDocuments.assetTransactions.transactions.0.supplier.id'],
  ] as const)('removed %s %s blocks %s', (role, id, path) => {
    const { file, mapping } = scenario();
    mapping.partners = mapping.partners.filter(
      (partner) => partner.source.id !== id || partner.source.role !== role,
    );
    expect(checkMapping(mapping, [file])).toContainEqual({ code: 'PARTNER_UNMAPPED', path });
  });
});
