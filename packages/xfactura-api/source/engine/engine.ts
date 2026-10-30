import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { requireCondition } from 'xfactura-core/errors';
import type { Treatment } from 'xfactura-core/kernel';
import { vatDefinitions, vatVersions } from 'xfactura-core/ro/vat';
import { fxDefinitions, fxVersions } from 'xfactura-core/ro/fx';
import { obligationDefinitions, obligationVersions } from 'xfactura-core/ro/obligations';
import { procedureDefinitions, procedureVersions } from 'xfactura-core/ro/procedure';
import { payrollDefinitions, payrollVersions } from 'xfactura-core/ro/payroll';
import { sickLeaveDefinitions, sickLeaveVersions } from 'xfactura-core/ro/payroll/sick-leave';
import { generalJournal, reversal } from 'xfactura-core/ro/treatments/ledger';
import { creditRecognition, invoiceRecognition } from 'xfactura-core/ro/treatments/invoices';
import { settlement } from 'xfactura-core/ro/treatments/settlement';
import { revaluation } from 'xfactura-core/ro/treatments/revaluation';
import { vatSettlement } from 'xfactura-core/ro/treatments/vat-settlement';
import { crossBorderRecognition } from 'xfactura-core/ro/treatments/cross-border';
import { payrollRecognition } from 'xfactura-core/ro/treatments/payroll';
import { microTax } from 'xfactura-core/ro/treatments/micro-tax';
import { assetDepreciation, assetDerecognition } from 'xfactura-core/ro/treatments/assets';
import { legalReserve, resultClosing, resultTransfer } from 'xfactura-core/ro/treatments/year-end';
import { deferral, deferralRelease } from 'xfactura-core/ro/treatments/deferrals';
import { microDefinitions, microVersions } from 'xfactura-core/ro/micro';
import { dividendDefinitions, dividendVersions } from 'xfactura-core/ro/dividends';
import { etvaDefinitions, etvaVersions } from 'xfactura-core/ro/etva';
import { dividendDistribution, dividendWithholding } from 'xfactura-core/ro/treatments/dividends';
import { ParameterRegister } from 'xfactura-core/rules';
import { clause, sourceOf } from 'xfactura-core/ro/sources';
import { addDays, bucharestDate } from 'xfactura-core/time';
import type { Database } from './db/database';
import { agentGrants } from './db/schema';
import type { ObjectStore } from './adapters/object-store';
import { Actions } from './kernel/actions';
import { Commands, roleAllows, type Actor } from './kernel/commands';
import { define, OperationRegistry, type Operation } from './kernel/operations';
import {
  closeHandler,
  monthInput,
  periodStates,
  reopenHandler,
  reopenInput,
  type CloseCheck,
} from './kernel/periods';
import { PostingPolicies, policyInput, policyView } from './kernel/policies';
import { Proposals } from './kernel/proposals';
import {
  generalLedgerInput,
  inventoryInput,
  journalInput,
  Reports,
  trialBalanceInput,
  trialBalanceView,
} from './kernel/reports';
import { proposalView } from './kernel/views';
import { Agents, grantView, issueAgentInput } from './modules/agents';
import {
  accountInput,
  accountQuery,
  Companies,
  Configuration,
  inviteInput,
  partyInput,
  profileInput,
  yearInput,
} from './modules/company';
import { Evidence, evidenceInput, evidenceView } from './modules/evidence';
import { documentView, importInput, Invoices } from './modules/invoices';
import { InvoicerImport, invoicerImportInput, invoicerImportView } from './modules/invoicer-import';
import { VatRegisters, vatJournalInput, vatJournalView } from './modules/vat';
import { bnrImportInput, fxChecks, FxRates, rateQuery } from './modules/fx';
import { deferralChecks } from './modules/deferrals';
import { Exports } from './modules/exports';
import { positionQuery, Positions } from './modules/positions';
import {
  archiveInput,
  archiveView,
  Spv,
  spvChecks,
  submissionInput,
  submissionView,
  submitInput,
  syncInput,
  syncView,
} from './modules/spv';
import type { EFacturaPort } from './adapters/efactura';
import type { DeclarationValidator } from './adapters/declaration-validator';
import { d300Declaration } from './modules/d300';
import { d390Declaration } from './modules/d390';
import { d394Declaration } from './modules/d394';
import { d406Declaration } from './modules/d406';
import { d112Declaration } from './modules/d112';
import { d205Declaration } from './modules/d205';
import { d100Declaration } from './modules/d100';
import { calendarInput, obligationsCalendar, obligationView } from './modules/obligations';
import { s1005Declaration } from './modules/s1005';
import {
  artifactInput,
  artifactView,
  Declarations,
  outcomeInput,
  prepareInput,
  reopenInput as declarationReopenInput,
  signedInput,
  submissionInput as filingInput,
  type DeclarationKind,
} from './modules/declarations';
import {
  employeeInput,
  partyCnpInput,
  Payroll,
  runIdInput,
  runInput,
  termsInput,
} from './modules/payroll';
import { assetInput, Assets, disposalInput } from './modules/assets';
import { Etva, etvaInput } from './modules/etva';
import { AnafConnections, connectFinishInput } from './modules/anaf-connection';
import { AnafEFactura, type AnafClient, type AnafEnvironment } from './adapters/anaf-efactura';
import {
  issueInput,
  issueView,
  partyDetailsInput,
  previewView,
  Sales,
  sellerInput,
  seriesInput,
  seriesView,
} from './modules/sales';
import {
  bankImportInput,
  movementQuery,
  Treasury,
  treasuryAccountInput,
  treasuryChecks,
} from './modules/treasury';

const id = z.uuid();
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const reason = z.string().trim().min(10).max(1000);
const ok = <T extends z.ZodRawShape>(shape: T) => z.object(shape);
const actionView = z.object({
  id: z.string(),
  operation: z.string(),
  input: z.unknown(),
  preview: z.unknown(),
  previewHash: z.string(),
  status: z.enum(['requested', 'approved', 'rejected', 'executed']),
  result: z.unknown(),
});

const parameterView = z.object({
  id: z.string(),
  key: z.string(),
  scope: z.record(z.string(), z.string()),
  value: z.unknown(),
  from: z.string(),
  to: z.string().nullable(),
  reviewedThrough: z.string().nullable(),
  status: z.string(),
  citations: z.array(
    z.object({ clause: z.string(), source: z.string(), locator: z.string(), status: z.string() }),
  ),
});

/** Every parameter version with what it cites, for review and for agents explaining a value. */
function parameters(register: ParameterRegister) {
  return register.versions.map((version) => ({
    id: version.id,
    key: version.key,
    scope: version.scope,
    value: version.value,
    from: version.from,
    to: version.to,
    reviewedThrough: version.reviewedThrough,
    status: version.status,
    citations: version.clauses.map((id) => {
      const cited = clause(id);
      return cited
        ? {
            clause: id,
            source: sourceOf(cited).title,
            locator: cited.locator,
            status: cited.status,
          }
        : { clause: id, source: '', locator: '', status: 'unknown' };
    }),
  }));
}

export const defaultRegister = () =>
  new ParameterRegister(
    [
      ...vatDefinitions,
      ...fxDefinitions,
      ...procedureDefinitions,
      ...obligationDefinitions,
      ...payrollDefinitions,
      ...sickLeaveDefinitions,
      ...microDefinitions,
      ...dividendDefinitions,
      ...etvaDefinitions,
    ],
    [
      ...vatVersions,
      ...fxVersions,
      ...procedureVersions,
      ...obligationVersions,
      ...payrollVersions,
      ...sickLeaveVersions,
      ...microVersions,
      ...dividendVersions,
      ...etvaVersions,
    ],
  );

/** The accounting engine: one kernel, its modules and the operation catalogue they expose. */
export class Engine {
  readonly operations = new OperationRegistry();
  /** The legal parameters every proposal resolves from. */
  readonly register: ParameterRegister;
  readonly commands: Commands;
  readonly proposals: Proposals;
  readonly policies: PostingPolicies;
  readonly actions: Actions;
  readonly reports: Reports;
  readonly companies: Companies;
  readonly configuration: Configuration;
  readonly agents: Agents;
  readonly evidence: Evidence;
  readonly invoices: Invoices;
  readonly vat: VatRegisters;
  readonly treasury: Treasury;
  readonly fx: FxRates;
  readonly exports: Exports;
  readonly positions: Positions;
  readonly sales: Sales;
  readonly invoicerImport: InvoicerImport;
  readonly spv: Spv;
  readonly declarations: Declarations;
  readonly payroll: Payroll;
  /** The engine's time, for what depends on today (overdue returns). */
  private readonly clock: () => number;
  readonly assets: Assets;
  readonly etva: Etva;
  readonly anaf: AnafConnections | null;

  constructor(
    readonly db: Database,
    objects: ObjectStore,
    secret: string,
    options: {
      register?: ParameterRegister;
      treatments?: Treatment[];
      closeChecks?: CloseCheck[];
      /** The e-Factura connection; without it, SPV operations report it unavailable. */
      efactura?: EFacturaPort;
      /** The time the SPV module reasons with (upload horizons, synced windows). */
      clock?: () => number;
      /** ANAF's declaration validator; without it, returns stay prepared until validated. */
      declarationValidator?: DeclarationValidator;
      declarations?: DeclarationKind[];
      /** ANAF's OAuth application: with it, companies connect to ANAF and, unless `efactura` is
       * given, the SPV uses the live e-Factura API. */
      anaf?: { client: AnafClient; environment: AnafEnvironment; fetch?: typeof fetch };
    } = {},
  ) {
    this.clock = options.clock ?? Date.now;
    this.commands = new Commands(db, this.operations.policy);
    this.policies = new PostingPolicies(this.commands);
    this.register = options.register ?? defaultRegister();
    this.proposals = new Proposals(this.commands, this.register, this.policies);
    this.proposals.addTreatment(
      generalJournal,
      reversal,
      invoiceRecognition,
      creditRecognition,
      settlement,
      revaluation,
      vatSettlement,
      crossBorderRecognition,
      payrollRecognition,
      microTax,
      dividendDistribution,
      dividendWithholding,
      assetDepreciation,
      assetDerecognition,
      resultClosing,
      legalReserve,
      resultTransfer,
      deferral,
      deferralRelease,
      ...(options.treatments ?? []),
    );
    this.actions = new Actions(this.commands);
    this.actions.add(
      closeHandler([
        ...treasuryChecks,
        ...fxChecks,
        ...spvChecks,
        ...deferralChecks,
        ...(options.closeChecks ?? []),
      ]),
    );
    this.actions.add(reopenHandler);
    this.reports = new Reports(this.commands);
    this.companies = new Companies(this.commands, secret);
    this.configuration = new Configuration(this.commands);
    this.agents = new Agents(this.commands, secret, () =>
      this.operations
        .all()
        .filter((operation) => operation.agent && operation.id !== 'capabilities.list')
        .map((operation) => operation.id),
    );
    this.evidence = new Evidence(this.commands, objects);
    this.invoices = new Invoices(this.commands, objects);
    this.vat = new VatRegisters(this.commands);
    this.treasury = new Treasury(this.commands, objects);
    this.fx = new FxRates(this.commands, objects);
    this.exports = new Exports(this.commands, objects);
    this.positions = new Positions(this.commands);
    this.sales = new Sales(this.commands, objects, this.proposals);
    this.invoicerImport = new InvoicerImport(this.commands, objects);
    this.anaf = options.anaf
      ? new AnafConnections(
          this.commands,
          secret,
          options.anaf.client,
          options.anaf.environment,
          options.anaf.fetch,
          options.clock,
        )
      : null;
    const anaf = this.anaf;
    this.spv = new Spv(
      this.commands,
      objects,
      options.efactura ??
        (anaf && options.anaf
          ? new AnafEFactura({
              environment: options.anaf.environment,
              token: (cif) => anaf.tokenFor(cif),
              ...(options.anaf.fetch ? { fetch: options.anaf.fetch } : {}),
            })
          : undefined),
      options.clock,
    );
    this.declarations = new Declarations(this.commands, objects, options.declarationValidator);
    this.declarations.add(
      d300Declaration((tx, companyId) => this.proposals.ruleContext(tx, companyId)),
      d390Declaration((tx, companyId) => this.proposals.ruleContext(tx, companyId)),
      d394Declaration((tx, companyId) => this.proposals.ruleContext(tx, companyId)),
      d406Declaration(
        objects,
        (tx, companyId) => this.proposals.ruleContext(tx, companyId),
        secret,
      ),
      d112Declaration(secret),
      d205Declaration(secret),
      d100Declaration(),
      s1005Declaration(),
      ...(options.declarations ?? []),
    );
    this.actions.add(this.declarations.authorizeHandler());
    this.actions.add(this.declarations.reopenHandler());
    this.assets = new Assets(this.commands);
    this.etva = new Etva(this.commands, (tx, companyId) =>
      this.proposals.ruleContext(tx, companyId),
    );
    this.payroll = new Payroll(this.commands, secret, (tx, companyId) =>
      this.proposals.ruleContext(tx, companyId),
    );
    this.operations.add(...this.catalogue());
  }

  private anafConnections() {
    requireCondition(
      this.anaf,
      'ANAF_NOT_CONFIGURED',
      'Aplicația nu este înregistrată la ANAF (client OAuth).',
      503,
    );
    return this.anaf;
  }

  /** The operations available to this principal right now, with their contracts. */
  async capabilities(actor: Actor) {
    return this.db.read(async (tx) => {
      const { role } = await this.commands.authorize(tx, actor, 'read', 'capabilities.list');
      const [grant] = actor.agentId
        ? await tx.select().from(agentGrants).where(eq(agentGrants.id, actor.agentId))
        : [];
      return {
        version: '2' as const,
        capabilities: this.operations
          .all()
          .filter(
            (operation) =>
              roleAllows(role, operation.permission) &&
              (!grant ||
                (operation.agent &&
                  (operation.id === 'capabilities.list' || grant.scopes.includes(operation.id)))),
          )
          .map((operation) => describe(operation)),
      };
    });
  }

  /** Invokes an operation. Discovery is an affordance; each command rechecks live authority. */
  async invoke(actor: Actor, operationId: string, key: string, input: unknown) {
    const operation = this.operations.get(operationId);
    await this.db.read((tx) =>
      this.commands.authorize(tx, actor, operation.permission, operation.id),
    );
    return operation.invoke(actor, key, input);
  }

  private catalogue(): Operation[] {
    const treatments = this.proposals.allTreatments().flatMap((treatment) => [
      define({
        id: `${treatment.id}.propose`,
        description: `Propune: ${treatment.description}`,
        permission: 'write',
        agent: treatment.agent,
        effect: 'prepare',
        approval: 'none',
        input: treatment.input,
        output: proposalView,
        run: (actor, key, input) => this.proposals.propose(actor, key, treatment.id, input),
      }),
      define({
        id: `${treatment.id}.revise`,
        description: `Revizuiește o propunere deschisă: ${treatment.description}`,
        permission: 'write',
        agent: treatment.agent,
        effect: 'prepare',
        approval: 'none',
        input: z
          .object({ proposalId: id, version: z.number().int().positive(), input: treatment.input })
          .strict(),
        output: proposalView,
        run: (actor, key, input) =>
          this.proposals.propose(actor, key, treatment.id, input.input, {
            proposalId: input.proposalId,
            version: input.version,
          }),
      }),
    ]);
    return [
      define({
        id: 'rules.parameters',
        description:
          'Parametrii legali folosiți de motor: valoare, perioadă, stadiul verificării și sursele citate.',
        permission: 'read',
        agent: true,
        effect: 'read',
        approval: 'none',
        input: z.object({}).strict(),
        output: z.array(parameterView),
        run: (actor) =>
          this.commands.read(actor, 'rules.parameters', async () => parameters(this.register)),
      }),
      define({
        id: 'rules.horizon',
        description:
          'Parametrii a căror perioadă verificată se încheie în următoarele zile: trebuie confirmați sau înlocuiți la timp.',
        permission: 'read',
        agent: true,
        effect: 'read',
        approval: 'none',
        input: z.object({ days: z.number().int().min(1).max(366).default(90) }).strict(),
        output: z.array(parameterView),
        run: (actor, _key, input) =>
          this.commands.read(actor, 'rules.horizon', async () => {
            const until = addDays(bucharestDate(Date.now()), input.days);
            const expiring = new Set(this.register.horizon(until).map((version) => version.id));
            return parameters(this.register).filter((item) => expiring.has(item.id));
          }),
      }),
      define({
        id: 'capabilities.list',
        description: 'Operațiunile disponibile acestei identități, cu contractele lor.',
        permission: 'read',
        agent: true,
        effect: 'read',
        approval: 'none',
        input: z.object({}).strict(),
        output: z.object({ version: z.literal('2'), capabilities: z.array(z.unknown()) }),
        run: (actor) => this.capabilities(actor),
      }),
      ...treatments,
      define({
        id: 'proposals.get',
        description: 'O propunere cu efectul, problemele și starea ei.',
        permission: 'read',
        agent: true,
        effect: 'read',
        approval: 'none',
        input: ok({ id }).strict(),
        output: proposalView,
        run: (actor, _, input) => this.proposals.get(actor, input.id),
      }),
      define({
        id: 'proposals.list',
        description: 'Propunerile companiei, în ordinea creării.',
        permission: 'read',
        agent: true,
        effect: 'read',
        approval: 'none',
        input: ok({
          status: proposalView.shape.status.optional(),
          after: id.optional(),
          limit: z.number().int().min(1).max(200).default(50),
        }).strict(),
        output: ok({ items: z.array(proposalView), next: z.string().nullable() }),
        run: (actor, _, input) => this.proposals.list(actor, input),
      }),
      define({
        id: 'proposals.approve',
        description: 'Aprobarea umană a unei versiuni exacte, inclusiv a avertismentelor ei.',
        permission: 'review',
        agent: false,
        effect: 'authorize',
        approval: 'human',
        input: ok({
          proposalId: id,
          version: z.number().int().positive(),
          effectHash: hash,
          acknowledge: z.array(z.string()).max(50).default([]),
        }).strict(),
        output: proposalView,
        run: (actor, key, input) => this.proposals.approve(actor, key, input),
      }),
      define({
        id: 'proposals.withdraw',
        description: 'Retrage o propunere necontabilizată.',
        permission: 'write',
        agent: true,
        effect: 'prepare',
        approval: 'none',
        input: ok({ proposalId: id, reason }).strict(),
        output: proposalView,
        run: (actor, key, input) => this.proposals.withdraw(actor, key, input),
      }),
      define({
        id: 'ledger.post',
        description: 'Contabilizează versiunea aprobată după reevaluarea ei față de registre.',
        permission: 'review',
        agent: true,
        effect: 'execute',
        approval: 'exact-version',
        input: ok({
          proposalId: id,
          version: z.number().int().positive(),
          effectHash: hash,
        }).strict(),
        output: proposalView,
        run: (actor, key, input) => this.proposals.post(actor, key, input),
      }),
      define({
        id: 'openItems.list',
        description:
          'Pozițiile deschise (creanțe, datorii, avansuri) cu soldurile lor, pe partener.',
        permission: 'read',
        agent: true,
        effect: 'read',
        approval: 'none',
        input: positionQuery,
        output: z.array(z.unknown()),
        run: (actor, _, input) => this.positions.list(actor, input),
      }),
      define({
        id: 'ledger.trialBalance',
        description: 'Balanța de verificare a unui exercițiu financiar.',
        permission: 'read',
        agent: true,
        effect: 'read',
        approval: 'none',
        input: trialBalanceInput,
        output: trialBalanceView,
        run: (actor, _, input) => this.reports.trialBalance(actor, input),
      }),
      define({
        id: 'ledger.journal',
        description: 'Registrul-jurnal: înregistrările în ordinea contabilizării.',
        permission: 'read',
        agent: true,
        effect: 'read',
        approval: 'none',
        input: journalInput,
        output: ok({ entries: z.array(z.unknown()), next: z.number().nullable() }),
        run: (actor, _, input) => this.reports.journal(actor, input),
      }),
      define({
        id: 'ledger.generalLedger',
        description:
          'Cartea mare: pentru o lună, fiecare cont sintetic cu soldul inițial, rulajele pe conturi corespondente și soldul final.',
        permission: 'read',
        agent: true,
        effect: 'read',
        approval: 'none',
        input: generalLedgerInput,
        output: z.array(z.unknown()),
        run: (actor, _, input) => this.reports.generalLedger(actor, input),
      }),
      define({
        id: 'ledger.inventoryRegister',
        description:
          'Registrul-inventar: la o dată, conturile de active, datorii și capitaluri proprii cu soldurile și elementele lor.',
        permission: 'read',
        agent: true,
        effect: 'read',
        approval: 'none',
        input: inventoryInput,
        output: z.array(z.unknown()),
        run: (actor, _, input) => this.reports.inventoryRegister(actor, input),
      }),
      define({
        id: 'policies.create',
        description:
          'O politică aprobată de o persoană care contabilizează automat tratamente exacte.',
        permission: 'review',
        agent: false,
        effect: 'authorize',
        approval: 'human',
        input: policyInput,
        output: policyView,
        run: (actor, key, input) => this.policies.create(actor, key, input),
      }),
      define({
        id: 'policies.revoke',
        description: 'Revocă o politică de contabilizare automată.',
        permission: 'review',
        agent: false,
        effect: 'authorize',
        approval: 'human',
        input: ok({ id, reason }).strict(),
        output: ok({ id: z.string(), revoked: z.literal(true) }),
        run: (actor, key, input) => this.policies.revoke(actor, key, input),
      }),
      define({
        id: 'policies.list',
        description: 'Politicile de contabilizare automată.',
        permission: 'read',
        agent: true,
        effect: 'read',
        approval: 'none',
        input: z.object({}).strict(),
        output: z.array(policyView),
        run: (actor) => this.policies.list(actor),
      }),
      define({
        id: 'periods.close.request',
        description:
          'Pregătește închiderea unei luni: verificări complete și soldurile de închidere.',
        permission: 'write',
        agent: true,
        effect: 'prepare',
        approval: 'none',
        input: monthInput,
        output: actionView,
        run: (actor, key, input) => this.actions.request(actor, key, 'periods.close', input),
      }),
      define({
        id: 'periods.reopen.request',
        description: 'Pregătește redeschiderea motivată a unei luni închise.',
        permission: 'review',
        agent: false,
        effect: 'prepare',
        approval: 'none',
        input: reopenInput,
        output: actionView,
        run: (actor, key, input) => this.actions.request(actor, key, 'periods.reopen', input),
      }),
      define({
        id: 'periods.list',
        description: 'Starea lunilor cu evenimente de închidere.',
        permission: 'read',
        agent: true,
        effect: 'read',
        approval: 'none',
        input: z.object({}).strict(),
        output: z.array(ok({ month: z.string(), state: z.enum(['closed', 'open']) })),
        run: (actor) =>
          this.commands.read(actor, 'periods.list', (tx) => periodStates(tx, actor.companyId)),
      }),
      define({
        id: 'actions.get',
        description: 'O acțiune revizuită, cu previzualizarea și starea ei.',
        permission: 'read',
        agent: true,
        effect: 'read',
        approval: 'none',
        input: ok({ id }).strict(),
        output: actionView,
        run: (actor, _, input) => this.actions.get(actor, input.id),
      }),
      define({
        id: 'actions.approve',
        description: 'Aprobarea umană a previzualizării exacte a unei acțiuni.',
        permission: 'review',
        agent: false,
        effect: 'authorize',
        approval: 'human',
        input: ok({ id, previewHash: hash }).strict(),
        output: actionView,
        run: (actor, key, input) =>
          this.actions.decide(actor, key, { ...input, decision: 'approve' }),
      }),
      define({
        id: 'actions.reject',
        description: 'Respingerea motivată a unei acțiuni.',
        permission: 'review',
        agent: false,
        effect: 'authorize',
        approval: 'human',
        input: ok({ id, previewHash: hash, reason }).strict(),
        output: actionView,
        run: (actor, key, input) =>
          this.actions.decide(actor, key, { ...input, decision: 'reject' }),
      }),
      define({
        id: 'actions.execute',
        description: 'Execută o acțiune aprobată dacă previzualizarea ei este neschimbată.',
        permission: 'review',
        agent: true,
        effect: 'execute',
        approval: 'exact-version',
        input: ok({ id }).strict(),
        output: actionView,
        run: (actor, key, input) => this.actions.execute(actor, key, input),
      }),
      define({
        id: 'invoices.import',
        description:
          'Importă o factură sau notă de credit e-Factura (XML UBL) dintr-un document păstrat.',
        permission: 'write',
        agent: true,
        effect: 'prepare',
        approval: 'none',
        input: importInput,
        output: documentView,
        run: (actor, key, input) => this.invoices.import(actor, key, input),
      }),
      define({
        id: 'invoices.importInvoicer',
        description:
          'Importă facturile emise din exportul JSON al facturierului xfactura.ro; fiecare înregistrare primește o stare (importată, duplicat, conflict, invalidă).',
        permission: 'write',
        agent: true,
        effect: 'prepare',
        approval: 'none',
        input: invoicerImportInput,
        output: invoicerImportView,
        run: (actor, key, input) => this.invoicerImport.run(actor, key, input),
      }),
      define({
        id: 'declarations.prepare',
        description:
          'Pregătește o declarație din registre, în formatul ANAF al perioadei, și o validează cu validatorul ANAF.',
        permission: 'write',
        agent: true,
        effect: 'prepare',
        approval: 'none',
        input: prepareInput,
        output: artifactView,
        run: (actor, key, input) => this.declarations.prepare(actor, key, input),
      }),
      define({
        id: 'declarations.validate',
        description: 'Rulează validatorul ANAF pe XML-ul exact al unei declarații pregătite.',
        permission: 'write',
        agent: true,
        effect: 'prepare',
        approval: 'none',
        input: artifactInput,
        output: artifactView,
        run: (actor, _key, input) => this.declarations.validate(actor, input),
      }),
      define({
        id: 'declarations.authorize.request',
        description:
          'Cere autorizarea unei declarații validate: o persoană aprobă XML-ul exact, iar execuția blochează perioada fiscală.',
        permission: 'review',
        agent: false,
        effect: 'prepare',
        approval: 'none',
        input: artifactInput,
        output: actionView,
        run: (actor, key, input) =>
          this.actions.request(actor, key, 'declarations.authorize', input),
      }),
      define({
        id: 'declarations.pdf',
        description:
          'Produce PDF-ul ANAF al unei declarații autorizate, pentru semnare și depunere.',
        permission: 'write',
        agent: true,
        effect: 'prepare',
        approval: 'none',
        input: artifactInput,
        output: artifactView,
        run: (actor, _key, input) => this.declarations.exportPdf(actor, input),
      }),
      define({
        id: 'declarations.importSigned',
        description:
          'Importă PDF-ul semnat al unei declarații; trebuie să conțină exact XML-ul autorizat și o semnătură.',
        permission: 'write',
        agent: true,
        effect: 'prepare',
        approval: 'none',
        input: signedInput,
        output: z.object({ artifactId: z.string() }),
        run: (actor, key, input) => this.declarations.importSigned(actor, key, input),
      }),
      define({
        id: 'declarations.recordSubmission',
        description:
          'Înregistrează depunerea unei declarații semnate, cu numărul de înregistrare din recipisă.',
        permission: 'write',
        agent: false,
        effect: 'execute',
        approval: 'human',
        input: filingInput,
        output: z.object({ artifactId: z.string() }),
        run: (actor, key, input) => this.declarations.recordSubmission(actor, key, input),
      }),
      define({
        id: 'declarations.recordOutcome',
        description:
          'Înregistrează răspunsul ANAF la o declarație depusă (acceptare sau respingere), cu documentul primit.',
        permission: 'write',
        agent: true,
        effect: 'prepare',
        approval: 'none',
        input: outcomeInput,
        output: z.object({ artifactId: z.string() }),
        run: (actor, key, input) => this.declarations.recordOutcome(actor, key, input),
      }),
      define({
        id: 'declarations.reopen.request',
        description:
          'Cere redeschiderea unei perioade fiscale declarate, pentru corectare și declarație rectificativă.',
        permission: 'review',
        agent: false,
        effect: 'prepare',
        approval: 'none',
        input: declarationReopenInput,
        output: actionView,
        run: (actor, key, input) => this.actions.request(actor, key, 'declarations.reopen', input),
      }),
      define({
        id: 'vat.etva.check',
        description:
          'Compară decontul D300 al perioadei cu decontul precompletat RO e-TVA, rând cu rând, la pragul diferențelor semnificative, și arată facturile e-Factura neînregistrate și cele înregistrate în afara e-Factura.',
        permission: 'read',
        agent: true,
        effect: 'read',
        approval: 'none',
        input: etvaInput,
        output: z.unknown(),
        run: (actor, _key, input) => this.etva.check(actor, input),
      }),
      define({
        id: 'assets.register',
        description:
          'Înregistrează un mijloc fix în registru: cont, cod din catalog, valoare, durate contabilă și fiscală, punere în funcțiune.',
        permission: 'write',
        agent: true,
        effect: 'prepare',
        approval: 'none',
        input: assetInput,
        output: z.object({ id: z.string(), number: z.string() }),
        run: (actor, key, input) => this.assets.register(actor, key, input),
      }),
      define({
        id: 'assets.dispose',
        description:
          'Înregistrează scoaterea din funcțiune a unui mijloc fix (casare, vânzare), cu documentul ei.',
        permission: 'write',
        agent: false,
        effect: 'prepare',
        approval: 'none',
        input: disposalInput,
        output: z.object({ assetId: z.string(), disposedOn: z.string() }),
        run: (actor, key, input) => this.assets.dispose(actor, key, input),
      }),
      define({
        id: 'assets.list',
        description: 'Registrul mijloacelor fixe, cu amortizarea înregistrată și valoarea rămasă.',
        permission: 'read',
        agent: true,
        effect: 'read',
        approval: 'none',
        input: z.object({}).strict(),
        output: z.array(z.unknown()),
        run: (actor) => this.assets.list(actor),
      }),
      define({
        id: 'payroll.employees.record',
        description:
          'Înregistrează un salariat: numele și CNP-ul, păstrat criptat; salariatul devine partener.',
        permission: 'write',
        agent: false,
        effect: 'prepare',
        approval: 'none',
        input: employeeInput,
        output: z.object({ id: z.string(), partyId: z.string(), name: z.string() }),
        run: (actor, key, input) => this.payroll.recordEmployee(actor, key, input),
      }),
      define({
        id: 'parties.recordCnp',
        description:
          'Păstrează criptat CNP-ul unui partener persoană fizică (un asociat), pentru declarațiile care îl cer (D205).',
        permission: 'write',
        agent: false,
        effect: 'prepare',
        approval: 'none',
        input: partyCnpInput,
        output: z.object({ partyId: z.string() }),
        run: (actor, key, input) => this.payroll.recordPartyCnp(actor, key, input),
      }),
      define({
        id: 'payroll.employees.list',
        description: 'Salariații înregistrați, fără CNP.',
        permission: 'read',
        agent: false,
        effect: 'read',
        approval: 'none',
        input: z.object({}).strict(),
        output: z.array(z.object({ id: z.string(), partyId: z.string(), name: z.string() })),
        run: (actor) => this.payroll.listEmployees(actor),
      }),
      define({
        id: 'payroll.contracts.record',
        description:
          'Înregistrează un contract de muncă sau o versiune nouă a termenilor lui (salariu, normă, funcție de bază, persoane în întreținere).',
        permission: 'write',
        agent: false,
        effect: 'prepare',
        approval: 'none',
        input: termsInput,
        output: z.object({ contractId: z.string(), seq: z.number() }),
        run: (actor, key, input) => this.payroll.recordTerms(actor, key, input),
      }),
      define({
        id: 'payroll.contracts.list',
        description: 'Contractele de muncă, cu toate versiunile termenilor.',
        permission: 'read',
        agent: false,
        effect: 'read',
        approval: 'none',
        input: z.object({}).strict(),
        output: z.array(z.unknown()),
        run: (actor) => this.payroll.listContracts(actor),
      }),
      define({
        id: 'payroll.runs.prepare',
        description:
          'Calculează statul de plată al lunii din contracte și din ce diferă în lună; un calcul nou îl înlocuiește pe cel anterior.',
        permission: 'write',
        agent: false,
        effect: 'prepare',
        approval: 'none',
        input: runInput,
        output: z.unknown(),
        run: (actor, key, input) => this.payroll.prepareRun(actor, key, input),
      }),
      define({
        id: 'payroll.runs.get',
        description: 'Un stat de plată, cu liniile și problemele lui.',
        permission: 'read',
        agent: false,
        effect: 'read',
        approval: 'none',
        input: runIdInput,
        output: z.unknown(),
        run: (actor, _key, input) => this.payroll.getRun(actor, input.runId),
      }),
      define({
        id: 'payroll.runs.list',
        description: 'Statele de plată calculate.',
        permission: 'read',
        agent: false,
        effect: 'read',
        approval: 'none',
        input: z.object({}).strict(),
        output: z.array(z.unknown()),
        run: (actor) => this.payroll.listRuns(actor),
      }),
      define({
        id: 'obligations.calendar',
        description:
          'Calendarul declarațiilor: pentru perioadele încheiate într-un interval de luni, declarațiile care se aplică companiei, termenul fiecăreia (mutat de pe zilele nelucrătoare) și stadiul ei.',
        permission: 'read',
        agent: true,
        effect: 'read',
        approval: 'none',
        input: calendarInput,
        output: z.array(obligationView),
        run: (actor, _, input) =>
          this.commands.read(actor, 'obligations.calendar', async (tx) =>
            obligationsCalendar(
              tx,
              actor.companyId,
              input,
              await this.proposals.ruleContext(tx, actor.companyId),
              input.today ?? new Date(this.clock()).toISOString().slice(0, 10),
            ),
          ),
      }),
      define({
        id: 'declarations.list',
        description: 'Declarațiile pregătite, cu pașii și starea fiecăreia.',
        permission: 'read',
        agent: true,
        effect: 'read',
        approval: 'none',
        input: z.object({}).strict(),
        output: z.array(artifactView),
        run: (actor) => this.declarations.list(actor),
      }),
      define({
        id: 'spv.connect.start',
        description:
          'Adresa la care reprezentantul companiei autorizează aplicația la ANAF (logincert.anaf.ro), cu certificatul său.',
        permission: 'manage',
        agent: false,
        effect: 'prepare',
        approval: 'human',
        input: z.object({}).strict(),
        output: z.object({ url: z.string(), environment: z.string() }),
        run: (actor, key) => this.anafConnections().start(actor, key),
      }),
      define({
        id: 'spv.connect.finish',
        description: 'Primește codul de autorizare de la ANAF și păstrează tokenurile, sigilate.',
        permission: 'manage',
        agent: false,
        effect: 'execute',
        approval: 'human',
        input: connectFinishInput,
        output: z.object({ environment: z.string(), accessExpiresAt: z.string() }),
        run: (actor, key, input) => this.anafConnections().finish(actor, key, input),
      }),
      define({
        id: 'spv.connection',
        description: 'Starea conectării companiei la ANAF: mediul și expirarea autorizării.',
        permission: 'read',
        agent: true,
        effect: 'read',
        approval: 'none',
        input: z.object({}).strict(),
        output: z.unknown(),
        run: (actor) => this.anafConnections().status(actor),
      }),
      define({
        id: 'spv.submit',
        description:
          'Autorizează și transmite în SPV XML-ul unei facturi emise; o transmitere incertă nu se repetă, se clarifică la sincronizare.',
        permission: 'write',
        agent: false,
        effect: 'execute',
        approval: 'human',
        input: submitInput,
        output: submissionView,
        run: (actor, key, input) => this.spv.submit(actor, key, input),
      }),
      define({
        id: 'spv.refresh',
        description: 'Întreabă SPV cum a fost prelucrată o factură transmisă.',
        permission: 'write',
        agent: true,
        effect: 'prepare',
        approval: 'none',
        input: submissionInput,
        output: submissionView,
        run: (actor, _key, input) => this.spv.refresh(actor, input),
      }),
      define({
        id: 'spv.sync',
        description:
          'Citește mesajele SPV dintr-un interval: importă facturile primite, confirmă sau contrazice facturile emise și închide transmiterile.',
        permission: 'write',
        agent: true,
        effect: 'prepare',
        approval: 'none',
        input: syncInput,
        output: syncView,
        run: (actor, key, input) => this.spv.sync(actor, key, input),
      }),
      define({
        id: 'spv.importArchive',
        description:
          'Citește o arhivă e-Factura descărcată din SPV (păstrată ca document): factură primită, confirmarea unei facturi emise sau o eroare.',
        permission: 'write',
        agent: true,
        effect: 'prepare',
        approval: 'none',
        input: archiveInput,
        output: archiveView,
        run: (actor, key, input) => this.spv.importArchive(actor, key, input),
      }),
      define({
        id: 'spv.submissions',
        description: 'Transmiterile în SPV, cu pașii și starea fiecăreia.',
        permission: 'read',
        agent: true,
        effect: 'read',
        approval: 'none',
        input: z.object({}).strict(),
        output: z.array(submissionView),
        run: (actor) => this.spv.list(actor),
      }),
      define({
        id: 'spv.messages',
        description: 'Mesajele SPV citite și ce a devenit fiecare în registre.',
        permission: 'read',
        agent: true,
        effect: 'read',
        approval: 'none',
        input: z.object({}).strict(),
        output: z.array(z.unknown()),
        run: (actor) => this.spv.messages(actor),
      }),
      define({
        id: 'sales.seller.record',
        description:
          'Înregistrează datele de facturare ale companiei (adresă, cod de TVA, cont), cu CUI-ul ei.',
        permission: 'manage',
        agent: false,
        effect: 'manage',
        approval: 'human',
        input: sellerInput,
        output: z.object({ partyId: z.string(), version: z.number() }),
        run: (actor, key, input) => this.sales.recordSeller(actor, key, input),
      }),
      define({
        id: 'parties.recordDetails',
        description: 'Înregistrează o versiune nouă a datelor de facturare ale unui partener.',
        permission: 'write',
        agent: true,
        effect: 'prepare',
        approval: 'none',
        input: partyDetailsInput,
        output: z.object({ partyId: z.string(), version: z.number() }),
        run: (actor, key, input) => this.sales.recordPartyDetails(actor, key, input),
      }),
      define({
        id: 'parties.get',
        description: 'Un partener cu datele lui de facturare actuale.',
        permission: 'read',
        agent: true,
        effect: 'read',
        approval: 'none',
        input: z.object({ partyId: id }).strict(),
        output: z.unknown(),
        run: (actor, _key, input) => this.sales.partyDetails(actor, input),
      }),
      define({
        id: 'sales.series.create',
        description: 'Creează o serie de facturi, cu primul număr și contul de venit implicit.',
        permission: 'manage',
        agent: false,
        effect: 'manage',
        approval: 'human',
        input: seriesInput,
        output: seriesView,
        run: (actor, key, input) => this.sales.createSeries(actor, key, input),
      }),
      define({
        id: 'sales.series.list',
        description: 'Seriile de facturi, cu următorul număr al fiecăreia.',
        permission: 'read',
        agent: true,
        effect: 'read',
        approval: 'none',
        input: z.object({}).strict(),
        output: z.array(seriesView),
        run: (actor) => this.sales.listSeries(actor),
      }),
      define({
        id: 'sales.preview',
        description:
          'Previzualizează o factură de emis: următorul număr, sumele, XML-ul și orice problemă, fără a emite.',
        permission: 'read',
        agent: true,
        effect: 'read',
        approval: 'none',
        input: issueInput,
        output: previewView,
        run: (actor, _key, input) => this.sales.preview(actor, input),
      }),
      define({
        id: 'sales.issue',
        description:
          'Emite o factură sau notă de credit: primește următorul număr din serie, XML-ul e-Factura este păstrat și se propune înregistrarea ei.',
        permission: 'write',
        agent: false,
        effect: 'execute',
        approval: 'human',
        input: issueInput,
        output: issueView,
        run: (actor, key, input) => this.sales.issue(actor, key, input),
      }),
      define({
        id: 'treasury.createAccount',
        description: 'Configurează un cont bancar sau o casă și contul contabil pe care se ține.',
        permission: 'manage',
        agent: false,
        effect: 'manage',
        approval: 'human',
        input: treasuryAccountInput,
        output: z.unknown(),
        run: (actor, key, input) => this.treasury.createAccount(actor, key, input),
      }),
      define({
        id: 'treasury.accounts',
        description: 'Conturile bancare și casele companiei.',
        permission: 'read',
        agent: true,
        effect: 'read',
        approval: 'none',
        input: z.object({}).strict(),
        output: z.array(z.unknown()),
        run: (actor) => this.treasury.accounts(actor),
      }),
      define({
        id: 'bank.import',
        description: 'Importă extrase MT940 sau camt.053 dintr-un document păstrat.',
        permission: 'write',
        agent: true,
        effect: 'prepare',
        approval: 'none',
        input: bankImportInput,
        output: z.object({ statements: z.array(z.unknown()) }),
        run: (actor, key, input) => this.treasury.import(actor, key, input),
      }),
      define({
        id: 'bank.movements',
        description: 'Mișcările bancare raportate și dacă sunt explicate.',
        permission: 'read',
        agent: true,
        effect: 'read',
        approval: 'none',
        input: movementQuery,
        output: z.array(z.unknown()),
        run: (actor, _, input) => this.treasury.movements(actor, input),
      }),
      define({
        id: 'fx.importBnr',
        description: 'Importă cursurile de referință BNR dintr-un fișier XML publicat de BNR.',
        permission: 'write',
        agent: true,
        effect: 'prepare',
        approval: 'none',
        input: bnrImportInput,
        output: z.object({ rates: z.number(), added: z.number(), revised: z.number() }),
        run: (actor, key, input) => this.fx.importBnr(actor, key, input),
      }),
      define({
        id: 'fx.rates',
        description: 'Cursurile BNR cunoscute pentru o monedă și un interval.',
        permission: 'read',
        agent: true,
        effect: 'read',
        approval: 'none',
        input: rateQuery,
        output: z.array(z.unknown()),
        run: (actor, _, input) => this.fx.rates(actor, input),
      }),
      define({
        id: 'vat.journal',
        description: 'Jurnalul de vânzări sau de cumpărări (registru de lucru, nu declarație).',
        permission: 'read',
        agent: true,
        effect: 'read',
        approval: 'none',
        input: vatJournalInput,
        output: vatJournalView,
        run: (actor, _, input) => this.vat.journal(actor, input),
      }),
      define({
        id: 'documents.list',
        description: 'Documentele importate (facturi, note de credit), după dată.',
        permission: 'read',
        agent: true,
        effect: 'read',
        approval: 'none',
        input: z.object({ kinds: z.array(z.string()).max(20).optional() }).strict(),
        output: z.array(documentView),
        run: (actor, _, input) => this.invoices.list(actor, input),
      }),
      define({
        id: 'exports.request',
        description:
          'Cere un export complet al companiei: toate înregistrările și documentele originale.',
        permission: 'review',
        agent: true,
        effect: 'prepare',
        approval: 'none',
        input: z.object({}).strict(),
        output: z.object({
          id: z.string(),
          status: z.string(),
          size: z.number().nullable(),
          hash: z.string().nullable(),
          error: z.string().nullable(),
        }),
        run: (actor, key) => this.exports.request(actor, key),
      }),
      define({
        id: 'exports.get',
        description: 'Starea unui export; fișierul se descarcă de la /exports/{id}.',
        permission: 'review',
        agent: true,
        effect: 'read',
        approval: 'none',
        input: ok({ id }).strict(),
        output: z.object({
          id: z.string(),
          status: z.string(),
          size: z.number().nullable(),
          hash: z.string().nullable(),
          error: z.string().nullable(),
        }),
        run: (actor, _, input) => this.exports.get(actor, input.id),
      }),
      define({
        id: 'evidence.record',
        description: 'Păstrează un document original (conținut în base64).',
        permission: 'write',
        agent: true,
        effect: 'prepare',
        approval: 'none',
        input: evidenceInput,
        output: evidenceView,
        run: (actor, key, input) => this.evidence.record(actor, key, input),
      }),
      define({
        id: 'evidence.list',
        description: 'Documentele originale păstrate.',
        permission: 'read',
        agent: true,
        effect: 'read',
        approval: 'none',
        input: z.object({}).strict(),
        output: z.array(evidenceView),
        run: (actor) => this.evidence.list(actor),
      }),
      define({
        id: 'evidence.get',
        description: 'Conținutul unui document original, în base64.',
        permission: 'read',
        agent: true,
        effect: 'read',
        approval: 'none',
        input: ok({ id }).strict(),
        output: evidenceView.extend({ base64: z.string() }),
        run: async (actor, _, input) => {
          const { record, bytes } = await this.evidence.read(actor, input.id);
          return {
            id: record.id,
            hash: record.hash,
            filename: record.filename,
            mediaType: record.mediaType,
            size: record.size,
            base64: bytes.toString('base64'),
          };
        },
      }),
      define({
        id: 'years.list',
        description: 'Exercițiile financiare și fiscale.',
        permission: 'read',
        agent: true,
        effect: 'read',
        approval: 'none',
        input: z.object({}).strict(),
        output: z.array(z.unknown()),
        run: (actor) => this.configuration.years(actor),
      }),
      define({
        id: 'years.create',
        description: 'Adaugă un exercițiu financiar sau fiscal.',
        permission: 'manage',
        agent: false,
        effect: 'manage',
        approval: 'human',
        input: yearInput,
        output: z.unknown(),
        run: (actor, key, input) => this.configuration.createYear(actor, key, input),
      }),
      define({
        id: 'accounts.list',
        description: 'Planul de conturi al companiei, cu controlul fiecărui cont.',
        permission: 'read',
        agent: true,
        effect: 'read',
        approval: 'none',
        input: accountQuery,
        output: ok({ items: z.array(z.unknown()), next: z.string().nullable() }),
        run: (actor, _, input) => this.configuration.accounts(actor, input),
      }),
      define({
        id: 'accounts.create',
        description: 'Adaugă un cont analitic sub un cont sintetic.',
        permission: 'manage',
        agent: false,
        effect: 'manage',
        approval: 'human',
        input: accountInput,
        output: z.unknown(),
        run: (actor, key, input) => this.configuration.createAccount(actor, key, input),
      }),
      define({
        id: 'profile.read',
        description:
          'Faptele datate ale companiei (regim TVA, impozit, angajator, mod de asigurare).',
        permission: 'read',
        agent: true,
        effect: 'read',
        approval: 'none',
        input: z.object({}).strict(),
        output: z.array(z.unknown()),
        run: (actor) => this.configuration.profile(actor),
      }),
      define({
        id: 'profile.record',
        description: 'Înregistrează un fapt datat al companiei, cu documentul justificativ.',
        permission: 'review',
        agent: false,
        effect: 'authorize',
        approval: 'human',
        input: profileInput,
        output: z.unknown(),
        run: (actor, key, input) => this.configuration.recordProfile(actor, key, input),
      }),
      define({
        id: 'parties.list',
        description: 'Partenerii companiei.',
        permission: 'read',
        agent: true,
        effect: 'read',
        approval: 'none',
        input: z.object({}).strict(),
        output: z.array(z.unknown()),
        run: (actor) => this.configuration.parties(actor),
      }),
      define({
        id: 'parties.create',
        description: 'Adaugă un partener (client, furnizor, angajat, autoritate).',
        permission: 'write',
        agent: true,
        effect: 'prepare',
        approval: 'none',
        input: partyInput,
        output: z.unknown(),
        run: (actor, key, input) => this.configuration.createParty(actor, key, input),
      }),
      define({
        id: 'company.members',
        description: 'Membrii companiei și rolurile lor.',
        permission: 'read',
        agent: false,
        effect: 'read',
        approval: 'none',
        input: z.object({}).strict(),
        output: z.array(z.unknown()),
        run: (actor) => this.companies.members(actor),
      }),
      define({
        id: 'company.invite',
        description: 'Invită o persoană ca revizor sau vizitator.',
        permission: 'manage',
        agent: false,
        effect: 'manage',
        approval: 'human',
        input: inviteInput,
        output: ok({ id: z.string(), expiresInHours: z.number(), token: z.string() }),
        run: (actor, key, input) => this.companies.invite(actor, key, input),
      }),
      define({
        id: 'company.revoke',
        description: 'Revocă accesul unui membru; credențialele emise de acesta încetează.',
        permission: 'manage',
        agent: false,
        effect: 'manage',
        approval: 'human',
        input: ok({ userId: z.string().min(1).max(128) }).strict(),
        output: ok({ userId: z.string(), revoked: z.literal(true) }),
        run: (actor, key, input) => this.companies.revokeMember(actor, key, input),
      }),
      define({
        id: 'agents.issue',
        description: 'Emite o credențială de agent limitată la operațiuni numite și cu expirare.',
        permission: 'review',
        agent: false,
        effect: 'manage',
        approval: 'human',
        input: issueAgentInput,
        output: grantView.extend({ token: z.string() }),
        run: (actor, key, input) => this.agents.issue(actor, key, input),
      }),
      define({
        id: 'agents.list',
        description: 'Credențialele de agent, fără secrete.',
        permission: 'review',
        agent: false,
        effect: 'read',
        approval: 'none',
        input: z.object({}).strict(),
        output: z.array(grantView),
        run: (actor) => this.agents.list(actor),
      }),
      define({
        id: 'agents.revoke',
        description: 'Revocă o credențială de agent, inclusiv răspunsurile memorate.',
        permission: 'review',
        agent: false,
        effect: 'manage',
        approval: 'human',
        input: ok({ id }).strict(),
        output: ok({ id: z.string(), revoked: z.literal(true) }),
        run: (actor, key, input) => this.agents.revoke(actor, key, input),
      }),
    ];
  }
}

export function describe(operation: Operation) {
  return {
    id: operation.id,
    description: operation.description,
    permission: operation.permission,
    agent: operation.agent,
    effect: operation.effect,
    approval: operation.approval,
    inputSchema: z.toJSONSchema(operation.input, { io: 'input', unrepresentable: 'any' }),
    outputSchema: z.toJSONSchema(operation.output, { io: 'output', unrepresentable: 'any' }),
  };
}
