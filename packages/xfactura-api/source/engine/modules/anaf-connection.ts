import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { requireCondition } from 'xfactura-core/errors';
import {
  anafAuthorizeUrl,
  anafExchangeCode,
  anafRefresh,
  EFacturaRefused,
  type AnafClient,
  type AnafEnvironment,
  type AnafTokens,
} from '../adapters/anaf-efactura';
import type { Transaction } from '../db/database';
import { anafConnections, companies } from '../db/schema';
import { appendAudit, type Actor, type Commands } from '../kernel/commands';
import { Sealer } from './payroll';

export const connectFinishInput = z
  .object({ code: z.string().trim().min(1).max(4000), state: z.string().trim().min(1).max(400) })
  .strict();

/** The access token is renewed this long before it expires (ANAF issues it for 90 days). */
const RENEW_BEFORE_MS = 7 * 86_400_000;
/** ANAF issues the refresh token for 365 days. */
const REFRESH_LIFETIME_MS = 365 * 86_400_000;

/**
 * A company's connection to ANAF: its representative signs in on logincert.anaf.ro with their
 * certificate, ANAF returns an authorization code to the application, and the engine keeps the
 * tokens it is exchanged for, sealed, renewing the access token before it expires.
 */
export class AnafConnections {
  private readonly sealer: Sealer;

  constructor(
    private readonly commands: Commands,
    private readonly secret: string,
    private readonly client: AnafClient,
    private readonly environment: AnafEnvironment,
    private readonly http: typeof fetch = fetch,
    private readonly clock: () => number = Date.now,
  ) {
    this.sealer = new Sealer(secret, 'anaf tokens v1');
  }

  private signature(companyId: string, actorId: string, nonce: string) {
    return createHmac('sha256', this.secret)
      .update(`anaf-connect|${companyId}|${actorId}|${nonce}`)
      .digest('base64url');
  }

  /** The address where the representative authorizes the application; the state ties the
   * answer to this company and person. */
  start(actor: Actor, key: string) {
    return this.commands.run(actor, key, 'spv.connect.start', {}, 'manage', async () => {
      const nonce = randomBytes(16).toString('base64url');
      const state = `${nonce}.${this.signature(actor.companyId, actor.actorId, nonce)}`;
      return { url: anafAuthorizeUrl(this.client, state), environment: this.environment };
    });
  }

  /** The authorization code ANAF returned, exchanged for tokens kept sealed. */
  finish(actor: Actor, key: string, input: z.infer<typeof connectFinishInput>) {
    return this.commands.run(
      actor,
      key,
      'spv.connect.finish',
      { state: input.state },
      'manage',
      async (tx) => {
        const [nonce, signature] = input.state.split('.');
        const expected = nonce ? this.signature(actor.companyId, actor.actorId, nonce) : '';
        requireCondition(
          signature !== undefined &&
            signature.length === expected.length &&
            timingSafeEqual(Buffer.from(signature), Buffer.from(expected)),
          'ANAF_STATE',
          'Răspunsul ANAF nu corespunde unei cereri de conectare a acestei companii.',
        );
        const tokens = await anafExchangeCode(this.client, input.code, this.http);
        const stored = await this.store(tx, actor.companyId, actor.actorId, tokens);
        await appendAudit(tx, {
          companyId: actor.companyId,
          actorId: actor.actorId,
          action: 'spv.connected',
          body: { environment: this.environment, accessExpiresAt: stored.accessExpiresAt },
        });
        return {
          environment: this.environment,
          accessExpiresAt: new Date(stored.accessExpiresAt).toISOString(),
        };
      },
    );
  }

  status(actor: Actor) {
    return this.commands.db.read(async (tx) => {
      const latest = await this.latest(tx, actor.companyId);
      return latest
        ? {
            connected: true,
            environment: latest.environment,
            accessExpiresAt: new Date(latest.accessExpiresAt).toISOString(),
            refreshExpiresAt: new Date(latest.refreshExpiresAt).toISOString(),
          }
        : { connected: false, environment: this.environment };
    });
  }

  /** The access token for a company's CIF, renewed with the refresh token when it nears expiry. */
  async tokenFor(cif: string): Promise<string> {
    const found = await this.commands.db.read(async (tx) => {
      const [company] = await tx.select().from(companies).where(eq(companies.cui, cif));
      return company ? { company, latest: await this.latest(tx, company.id) } : undefined;
    });
    if (!found?.latest || found.latest.environment !== this.environment)
      throw new EFacturaRefused('Compania nu este conectată la ANAF (SPV) în acest mediu.');
    const { company, latest } = found;
    const now = this.clock();
    if (latest.accessExpiresAt - now > RENEW_BEFORE_MS)
      return this.sealer.open(company.id, latest.accessSealed);
    if (latest.refreshExpiresAt <= now)
      throw new EFacturaRefused('Autorizarea ANAF a expirat: reconectați compania la SPV.');
    const tokens = await anafRefresh(
      this.client,
      this.sealer.open(company.id, latest.refreshSealed),
      this.http,
    );
    await this.commands.db.write((tx) => this.store(tx, company.id, latest.createdBy, tokens));
    return tokens.accessToken;
  }

  private async latest(tx: Transaction, companyId: string) {
    const [row] = await tx
      .select()
      .from(anafConnections)
      .where(eq(anafConnections.companyId, companyId))
      .orderBy(desc(anafConnections.seq))
      .limit(1);
    return row;
  }

  private async store(tx: Transaction, companyId: string, actorId: string, tokens: AnafTokens) {
    const now = this.clock();
    const latest = await this.latest(tx, companyId);
    const row = {
      companyId,
      seq: (latest?.seq ?? 0) + 1,
      environment: this.environment,
      accessSealed: this.sealer.seal(companyId, tokens.accessToken),
      refreshSealed: this.sealer.seal(companyId, tokens.refreshToken),
      accessExpiresAt: now + tokens.expiresIn * 1000,
      refreshExpiresAt: now + REFRESH_LIFETIME_MS,
      createdBy: actorId,
    };
    await tx.insert(anafConnections).values(row);
    return row;
  }
}
