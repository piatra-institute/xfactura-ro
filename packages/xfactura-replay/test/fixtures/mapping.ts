import { readD406 } from 'xfactura-core/ro/saft/read';
import type { MappingChartAccount } from '../../src/mapping';

export const mappingChart: MappingChartAccount[] = [
  { code: '401', name: 'Furnizori', postable: true, book: 'general' },
  { code: '4111', name: 'Clienți', postable: true, book: 'general' },
  { code: '421', name: 'Personal', postable: true, book: 'general' },
  { code: '4427', name: 'TVA colectată', postable: true, book: 'general' },
  { code: '5121', name: 'Bănci', postable: true, book: 'general' },
  { code: '628', name: 'Servicii', postable: true, book: 'general' },
  { code: '41', name: 'Clienți și conturi asimilate', postable: false, book: 'general' },
];

export const sourceAccount = (id: string, standard: string, name = 'Cont inventat') => `
  <Account><AccountID>${id}</AccountID><AccountDescription>${name}</AccountDescription>
  <StandardAccountID>${standard}</StandardAccountID><AccountType>A</AccountType>
  <OpeningDebitBalance>10.00</OpeningDebitBalance><ClosingDebitBalance>20.00</ClosingDebitBalance></Account>`;

export const sourcePartner = (
  role: 'Customer' | 'Supplier',
  id: string,
  account: string,
  options: { name?: string; country?: string; registration?: string } = {},
) => `<${role}><${role}ID>${id}</${role}ID><CompanyStructure><Name>${options.name ?? 'Partener inventat'}</Name>
  <RegistrationNumber>${options.registration ?? id}</RegistrationNumber>
  <Address><Country>${options.country ?? 'RO'}</Country></Address></CompanyStructure>
  <AccountID>${account}</AccountID></${role}>`;

export const sourceLine = (account: string, extra = '') => `
  <TransactionLine><RecordID>LINE</RecordID><AccountID>${account}</AccountID>${extra}
  <DebitAmount><Amount>17.00</Amount></DebitAmount></TransactionLine>`;

export const mappingXml = (
  options: {
    accounts?: string;
    customers?: string;
    suppliers?: string;
    lines?: string;
    transaction?: string;
    documents?: string;
    company?: string;
    period?: { start: string; end: string };
  } = {},
) => `<AuditFile xmlns="mfp:anaf:dgti:d406:declaratie:v1">
  <Header><Company><RegistrationNumber>${options.company ?? '90000001'}</RegistrationNumber></Company>
  ${options.period ? `<SelectionCriteria><SelectionStartDate>${options.period.start}</SelectionStartDate><SelectionEndDate>${options.period.end}</SelectionEndDate></SelectionCriteria>` : ''}</Header>
  <MasterFiles><GeneralLedgerAccounts>${options.accounts ?? sourceAccount('628', '628')}</GeneralLedgerAccounts>
  <Customers>${options.customers ?? ''}</Customers><Suppliers>${options.suppliers ?? ''}</Suppliers></MasterFiles>
  <GeneralLedgerEntries><Journal><Transaction>${options.transaction ?? ''}${options.lines ?? ''}</Transaction></Journal></GeneralLedgerEntries>
  <SourceDocuments>${options.documents ?? ''}</SourceDocuments></AuditFile>`;

export const mappingFiled = (options: Parameters<typeof mappingXml>[0] = {}) =>
  readD406(new TextEncoder().encode(mappingXml(options)));
