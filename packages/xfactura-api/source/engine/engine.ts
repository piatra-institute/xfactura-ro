import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Treatment } from 'xfactura-core/kernel';
import { vatDefinitions, vatVersions } from 'xfactura-core/ro/vat';
import { generalJournal, reversal } from 'xfactura-core/ro/treatments/ledger';
import { ParameterRegister } from 'xfactura-core/rules';
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
import { journalInput, Reports, trialBalanceInput, trialBalanceView } from './kernel/reports';
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

export const defaultRegister = () => new ParameterRegister(vatDefinitions, vatVersions);

/** The accounting engine: one kernel, its modules and the operation catalogue they expose. */
export class Engine {
  readonly operations = new OperationRegistry();
  readonly commands: Commands;
  readonly proposals: Proposals;
  readonly policies: PostingPolicies;
  readonly actions: Actions;
  readonly reports: Reports;
  readonly companies: Companies;
  readonly configuration: Configuration;
  readonly agents: Agents;
  readonly evidence: Evidence;

  constructor(
    readonly db: Database,
    objects: ObjectStore,
    secret: string,
    options: {
      register?: ParameterRegister;
      treatments?: Treatment[];
      closeChecks?: CloseCheck[];
    } = {},
  ) {
    this.commands = new Commands(db, this.operations.agentAllowed);
    this.policies = new PostingPolicies(this.commands);
    this.proposals = new Proposals(
      this.commands,
      options.register ?? defaultRegister(),
      this.policies,
    );
    this.proposals.addTreatment(generalJournal, reversal, ...(options.treatments ?? []));
    this.actions = new Actions(this.commands);
    this.actions.add(closeHandler(options.closeChecks ?? []));
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
    this.operations.add(...this.catalogue());
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
