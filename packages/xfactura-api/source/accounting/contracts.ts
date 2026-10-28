export type { Overview } from './queries';
export type { ProposalBody, PostingLine } from './domain';
import type { InvoiceArchives } from './invoice-archives';
export type InvoiceSourcePage = Awaited<ReturnType<InvoiceArchives['sources']>>;
import type { BankStatementFiles } from './bank-statement-files';
export type BankStatementEntryPage = Awaited<ReturnType<BankStatementFiles['entries']>>;
