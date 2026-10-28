import { Commands, type Actor } from './commands';
import { Companies } from './companies';
import { Books } from './books';
import { Corrections } from './corrections';
import { Bank } from './bank';
import { Documents } from './documents';
import { Exports } from './exports';
import { Periods } from './periods';
import { overview } from './queries';
import { Agents } from './agents';
import { AgentQueries } from './agent-queries';
import { Reviews } from './reviews';
import { Capabilities } from './capabilities';
import { Foundation } from './foundation';
import { GeneralLedger } from './general-ledger';
import { Invoices } from './invoices';
import { Treasury } from './treasury';
import { InvoicePositions } from './invoice-positions';
import { Settlements } from './settlements';
import { VatRegisters } from './vat-registers';
import { Accruals } from './accruals';
import { UnbilledSales } from './unbilled-sales';
import { Deferrals } from './deferrals';
import type { Database } from './db';
import type { ObjectStore } from './object-store';

export class Accounting {
  readonly commands: Commands;
  readonly companies: Companies;
  readonly books: Books;
  readonly corrections: Corrections;
  readonly bank: Bank;
  readonly documents: Documents;
  readonly exports: Exports;
  readonly periods: Periods;
  readonly agents: Agents;
  readonly queries: AgentQueries;
  readonly reviews: Reviews;
  readonly capabilities: Capabilities;
  readonly foundation: Foundation;
  readonly ledger: GeneralLedger;
  readonly invoices: Invoices;
  readonly treasury: Treasury;
  readonly positions: InvoicePositions;
  readonly settlements: Settlements;
  readonly vat: VatRegisters;
  readonly accruals: Accruals;
  readonly unbilledSales: UnbilledSales;
  readonly deferrals: Deferrals;

  constructor(
    readonly db: Database,
    objects: ObjectStore,
    invitationSecret: string,
  ) {
    this.commands = new Commands(db);
    this.companies = new Companies(this.commands, invitationSecret);
    this.books = new Books(this.commands);
    this.corrections = new Corrections(this.commands);
    this.bank = new Bank(this.commands, objects);
    this.documents = new Documents(this.commands, objects);
    this.exports = new Exports(this.commands, objects);
    this.periods = new Periods(this.commands);
    this.agents = new Agents(this.commands, invitationSecret);
    this.queries = new AgentQueries(this.commands);
    this.reviews = new Reviews(this.commands, this.bank, this.periods);
    this.foundation = new Foundation(this.commands);
    this.ledger = new GeneralLedger(this.commands);
    this.invoices = new Invoices(this.commands, objects);
    this.treasury = new Treasury(this.commands);
    this.positions = new InvoicePositions(this.commands);
    this.settlements = new Settlements(this.commands);
    this.vat = new VatRegisters(this.commands);
    this.accruals = new Accruals(this.commands);
    this.unbilledSales = new UnbilledSales(this.commands);
    this.deferrals = new Deferrals(this.commands);
    this.capabilities = new Capabilities(this);
  }
  overview(actor: Actor, financialYearId?: string) {
    return overview(this.commands, actor, financialYearId);
  }
}
