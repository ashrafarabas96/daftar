import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CredentialDelivery } from '../../apps/api/src/modules/auth/tokens';
import { CredentialDeliveryWorker } from '../../apps/api/src/modules/delivery/delivery-worker.service';
import { createTestApp, ownerPool, raiseLimit, resetData, uniqueEmail, type TestApp } from '../helpers/test-app';

/**
 * DR-71 section 4 — MAIL ISOLATION AT THE SERVICE LAYER.
 *
 * `smtp-delivery` tests prove the TRANSPORT: that a message handed to the SMTP
 * adapter arrives at the address it was handed. They say nothing about WHICH
 * address a service hands over, and that choice is where a tenant can be
 * confused: the invitation service picks the recipient from the invitation row,
 * the auth service picks it for a password reset, the enqueuer encrypts the
 * secret, and the worker — a different process in production — decrypts it and
 * decides who receives it. This suite drives exactly that chain, with the real
 * database, real services, the real worker and a RECORDING delivery double in
 * the place of SMTP, and asks one question: can a credential minted for
 * tenant A reach an address that belongs to tenant B?
 *
 * THE BINDINGS UNDER TEST (and where each one lives)
 *   1. recipient per row   — the invitation / reset service writes the
 *                            recipient of THIS credential on THIS row;
 *   2. recipient per job   — the worker sends each claimed job to that job's
 *                            own recipient (a batch spans tenants);
 *   3. recipient bound to the secret — the payload's AAD covers kind +
 *                            recipient + parent id + delivery id
 *                            (credential-protector `credentialAad`), so a row
 *                            whose `email` is rewritten after the fact does not
 *                            decrypt, and nothing is sent;
 *   4. credential bound to its owner — the token a message carries only works
 *                            for the address it was sent to (redeeming A's
 *                            invitation as B's user is refused; A's reset
 *                            token does not touch B's password);
 *   5. command scoped to the caller's tenant — A cannot resend or cancel B's
 *                            invitation (no message, no token rotation).
 *
 * THE DATABASE IS A SECOND WALL, NOT THIS SUITE'S SUBJECT. A composite FK
 * (`credential_deliveries_invitation_business_fk`) already refuses a delivery
 * whose business does not own its invitation; the tamper case below shows it
 * and then goes where the FK cannot — the recipient column, which no
 * constraint ties to the invitation's own address. That is the case the AAD
 * exists for.
 *
 * NEGATIVE CONTROLS (planted with sha256 before/after, restored byte-for-byte;
 * the results are in the commit message): removing the recipient from the AAD
 * reddens the tamper case; making the worker send a batch to one job's
 * recipient reddens the batch case.
 *
 * WHAT WOULD MAKE A GREEN HERE VACUOUS
 *  - a worker that delivers nothing -> every "never sent to B" assertion is
 *    preceded by a positive control in the SAME drain: the untampered
 *    deliveries ARE sent, to the right addresses;
 *  - a tamper the database or the encryptor refuses before the worker ever
 *    sees it -> the case asserts the row really holds the tampered recipient
 *    when drained;
 *  - a tenant B with no addresses -> B's owner, invitees and reset accounts
 *    are all real rows, and the address set asserted against is read back from
 *    the database, not assumed.
 */

interface Sent {
  kind: 'invitation' | 'password_reset';
  to: string;
  secret: string;
}

function recorder(): { sent: Sent[]; delivery: CredentialDelivery } {
  const sent: Sent[] = [];
  return {
    sent,
    delivery: {
      kind: 'recording-test-double',
      sendInvitation: (to, secret) => {
        sent.push({ kind: 'invitation', to, secret });
        return Promise.resolve();
      },
      sendPasswordReset: (to, secret) => {
        sent.push({ kind: 'password_reset', to, secret });
        return Promise.resolve();
      },
    },
  };
}

interface Tenant {
  token: string;
  businessId: string;
  email: string;
  password: string;
}

const PASSWORD = 'Str0ng!Passw0rd';

describe('DR-71 s4. mail isolation: a credential minted for tenant A never reaches a tenant-B address', () => {
  let t: TestApp;
  let rec: ReturnType<typeof recorder>;
  let A: Tenant;
  let B: Tenant;

  async function newTenant(label: string): Promise<Tenant> {
    const email = uniqueEmail();
    const reg = await t.request.post('/v1/auth/register').send({ email, password: PASSWORD, displayName: label, preferredLocale: 'ar' });
    const token = reg.body.accessToken as string;
    const on = await t.request
      .post('/v1/onboarding/complete')
      .set('Idempotency-Key', `idem-${Date.now()}-${Math.floor(Math.random() * 1e9)}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ businessName: label, countryCode: 'PS', baseCurrency: 'ILS', storeSlug: `dr71m-${Date.now()}-${Math.floor(Math.random() * 1e6)}` });
    const businessId = on.body.businessId as string;
    const me = await t.request.get('/v1/auth/me').set('Authorization', `Bearer ${token}`);
    // The invitation quota is not what this suite is about; lift it so a refused invite can only mean a scoping refusal.
    await raiseLimit(businessId, me.body.userId as string, 'MAX_USERS', 50);
    return { token, businessId, email, password: PASSWORD };
  }

  const invite = (tn: Tenant, email: string) =>
    t.request
      .post('/v1/businesses/current/invitations')
      .set({ Authorization: `Bearer ${tn.token}`, 'X-Business-Id': tn.businessId })
      .send({ email, roleKey: 'cashier' });

  /** Drain until the outbox is quiet, so a case never depends on how many rounds the worker needs. */
  async function drainAll(): Promise<void> {
    const worker = t.app.get(CredentialDeliveryWorker);
    for (let i = 0; i < 10; i += 1) {
      const r = await worker.drain(25);
      if (r.sent + r.failed + r.dead === 0) return;
    }
  }

  async function deliveries(): Promise<{ id: string; kind: string; business_id: string | null; email: string; status: string; last_error: string | null }[]> {
    return (await ownerPool().query(`SELECT id, kind, business_id, email::text AS email, status, last_error FROM credential_deliveries ORDER BY created_at`))
      .rows as never;
  }

  beforeAll(async () => {
    rec = recorder();
    t = await createTestApp({ delivery: rec.delivery });
    await resetData();
    A = await newTenant('Mail Tenant A');
    B = await newTenant('Mail Tenant B');
  });
  afterAll(async () => {
    await t.close();
  });

  it('one batch spanning both tenants: every invitation and every reset goes to its OWN address and its token only works for that address', async () => {
    const invA = uniqueEmail();
    const invB = uniqueEmail();
    expect((await invite(A, invA)).status).toBe(201);
    expect((await invite(B, invB)).status).toBe(201);
    expect((await t.request.post('/v1/auth/password-reset/request').send({ email: A.email })).status).toBeLessThan(300);
    expect((await t.request.post('/v1/auth/password-reset/request').send({ email: B.email })).status).toBeLessThan(300);

    // Before any send: each row already names its own tenant's recipient (binding 1).
    const rows = await deliveries();
    const pending = rows.filter((r) => r.status === 'pending');
    expect(pending.length, 'the outbox holds all four, so ONE drain claims a mixed batch').toBe(4);
    const byEmail = new Map(pending.map((r) => [r.email, r]));
    expect(byEmail.get(invA)?.business_id).toBe(A.businessId);
    expect(byEmail.get(invB)?.business_id).toBe(B.businessId);
    expect(byEmail.get(A.email)?.kind).toBe('password_reset');
    expect(byEmail.get(B.email)?.kind).toBe('password_reset');

    await drainAll();

    // Binding 2 — the worker sent each job to its own recipient, once.
    const mine = rec.sent.filter((s) => [invA, invB, A.email, B.email].includes(s.to));
    expect(mine.map((s) => `${s.kind}:${s.to}`).sort(), 'exactly the four expected messages: no duplicate, no swap, no extra recipient').toEqual(
      [`invitation:${invA}`, `invitation:${invB}`, `password_reset:${A.email}`, `password_reset:${B.email}`].sort(),
    );
    const secretOf = (kind: Sent['kind'], to: string): string => {
      const s = rec.sent.find((x) => x.kind === kind && x.to === to);
      if (!s) throw new Error(`no ${kind} message to ${to}`);
      return s.secret;
    };
    const secrets = [secretOf('invitation', invA), secretOf('invitation', invB), secretOf('password_reset', A.email), secretOf('password_reset', B.email)];
    expect(new Set(secrets).size, "four different secrets: no message carries another tenant's token").toBe(4);

    // Binding 4 — an invitation token works only for the address it was sent to. A and B's OWNERS are existing,
    // authenticated users with the wrong address: both are refused, and nothing is joined.
    const crossA = await t.request
      .post('/v1/invitations/accept')
      .set('Authorization', `Bearer ${B.token}`)
      .send({ token: secretOf('invitation', invA) });
    expect(crossA.status, "tenant B's owner cannot redeem the invitation that was sent to tenant A's invitee").toBe(403);
    const crossB = await t.request
      .post('/v1/invitations/accept')
      .set('Authorization', `Bearer ${A.token}`)
      .send({ token: secretOf('invitation', invB) });
    expect(crossB.status, 'and the other way round').toBe(403);
    // Positive control: the address it WAS sent to redeems it, into the tenant that issued it.
    const okA = await t.request
      .post('/v1/invitations/accept-register')
      .send({ token: secretOf('invitation', invA), email: invA, password: PASSWORD, displayName: 'Invitee A' });
    expect(okA.status, JSON.stringify(okA.body)).toBe(200);
    expect(okA.body.businessId).toBe(A.businessId);
    const okB = await t.request
      .post('/v1/invitations/accept-register')
      .send({ token: secretOf('invitation', invB), email: invB, password: PASSWORD, displayName: 'Invitee B' });
    expect(okB.body.businessId).toBe(B.businessId);

    // Binding 4 for recovery — each reset token changes ONLY the account it was sent to.
    const PA = 'N3w!PasswordForA-1';
    const PB = 'N3w!PasswordForB-2';
    expect((await t.request.post('/v1/auth/password-reset/complete').send({ token: secretOf('password_reset', A.email), password: PA })).status).toBeLessThan(
      300,
    );
    expect((await t.request.post('/v1/auth/password-reset/complete').send({ token: secretOf('password_reset', B.email), password: PB })).status).toBeLessThan(
      300,
    );
    const login = async (email: string, password: string): Promise<number> => (await t.request.post('/v1/auth/login').send({ email, password })).status;
    expect(await login(A.email, PA), "A's token set A's password").toBeLessThan(300);
    expect(await login(B.email, PB), "B's token set B's password").toBeLessThan(300);
    expect(await login(A.email, PB), "B's password does not open A's account").toBeGreaterThanOrEqual(400);
    expect(await login(B.email, PA), "A's password does not open B's account").toBeGreaterThanOrEqual(400);

    // A reset revokes the account's sessions (by design); take fresh ones so the cases below act as the same owners.
    A.token = (await t.request.post('/v1/auth/login').send({ email: A.email, password: PA })).body.accessToken as string;
    B.token = (await t.request.post('/v1/auth/login').send({ email: B.email, password: PB })).body.accessToken as string;
  });

  it('the recipient is cryptographically bound to the secret: a delivery whose address is rewritten to a tenant-B address is NOT sent', async () => {
    const victim = uniqueEmail();
    const control = uniqueEmail();
    expect((await invite(A, victim)).status).toBe(201);
    expect((await invite(A, control)).status).toBe(201);
    const target = B.email; // an address that belongs to tenant B

    // Rewrite the recipient of the victim's pending delivery (what a bug, a bad migration or an attacker with row access would do).
    const rows = (await deliveries()).filter((r) => r.status === 'pending');
    const vrow = rows.find((r) => r.email === victim);
    expect(vrow, "the victim's delivery is pending").toBeTruthy();
    await ownerPool().query('UPDATE credential_deliveries SET email = $2 WHERE id = $1', [vrow?.id, target]);
    expect((await deliveries()).find((r) => r.id === vrow?.id)?.email, 'the tamper is really in the row when the worker claims it').toBe(target);

    const before = rec.sent.length;
    await drainAll();
    const after = rec.sent.slice(before);

    expect(
      after.map((s) => s.to),
      'nothing at all reached the tenant-B address',
    ).not.toContain(target);
    expect(
      after.map((s) => s.to),
      'positive control: the untampered delivery in the SAME drain WAS sent, to its own address',
    ).toContain(control);
    expect(
      after.map((s) => s.to),
      'and the victim did not get it either: a message that cannot be authenticated is not sent anywhere',
    ).not.toContain(victim);
    const row = (await deliveries()).find((r) => r.id === vrow?.id);
    expect(row?.status, 'the row is parked for retry, not sent').not.toBe('sent');
    expect(row?.last_error, 'classified, never the raw error and never the address or the secret').toBe('PAYLOAD_DECRYPT_FAILED');
  });

  it('a delivery re-homed to the other tenant is refused twice over: the database (composite FK) and, past it, the payload binding', async () => {
    const mine = uniqueEmail();
    const theirs = uniqueEmail();
    expect((await invite(A, mine)).status).toBe(201);
    const bRes = await invite(B, theirs);
    expect(bRes.status).toBe(201);
    const bInvitationId = bRes.body.id as string;
    // Park everything else so the next drain claims only these two rows.
    await drainAll();

    const aRow = (await deliveries()).find((r) => r.email === mine);
    expect(aRow?.status, 'sent by the drain above').toBe('sent');

    // New A invitation, still pending; try to point it at B's invitation while keeping A's business id.
    const mine2 = uniqueEmail();
    expect((await invite(A, mine2)).status).toBe(201);
    const row2 = (await deliveries()).find((r) => r.email === mine2 && r.status === 'pending');
    expect(row2).toBeTruthy();
    const fk = await ownerPool()
      .query('UPDATE credential_deliveries SET invitation_id = $2 WHERE id = $1', [row2?.id, bInvitationId])
      .then(() => null)
      .catch((e: { code?: string }) => e.code ?? 'error');
    expect(fk, 'the database refuses a delivery whose business does not own the invitation (23503)').toBe('23503');

    // Re-home BOTH columns to tenant B (what the FK permits): the row now looks like B's. The address stays A's invitee.
    await ownerPool().query('UPDATE credential_deliveries SET invitation_id = $2, business_id = $3 WHERE id = $1', [row2?.id, bInvitationId, B.businessId]);
    const before = rec.sent.length;
    await drainAll();
    const after = rec.sent.slice(before);
    expect(
      after.map((s) => s.to),
      "the secret minted for tenant A is not delivered under tenant B's parent",
    ).not.toContain(mine2);
    expect((await deliveries()).find((r) => r.id === row2?.id)?.last_error).toBe('PAYLOAD_DECRYPT_FAILED');
  });

  it("commands are scoped to the caller's tenant: A cannot resend or cancel B's invitation, and no message follows", async () => {
    const victim = uniqueEmail();
    const created = await invite(B, victim);
    expect(created.status).toBe(201);
    const id = created.body.id as string;
    await drainAll();
    const pre = (await ownerPool().query('SELECT token_hash, expires_at FROM business_invitations WHERE id = $1', [id])).rows[0] as {
      token_hash: string;
      expires_at: Date;
    };
    const preCount = (await deliveries()).filter((r) => r.email === victim).length;
    const before = rec.sent.length;

    const resend = await t.request
      .post(`/v1/businesses/current/invitations/${id}/resend`)
      .set({ Authorization: `Bearer ${A.token}`, 'X-Business-Id': A.businessId });
    expect(resend.status, "A's own business scope does not contain B's invitation").toBe(404);
    const cancel = await t.request
      .delete(`/v1/businesses/current/invitations/${id}`)
      .set({ Authorization: `Bearer ${A.token}`, 'X-Business-Id': A.businessId });
    expect(cancel.status).toBe(404);
    const stranger = await t.request
      .post(`/v1/businesses/current/invitations/${id}/resend`)
      .set({ Authorization: `Bearer ${A.token}`, 'X-Business-Id': B.businessId });
    expect(stranger.status, "naming B's business while not being its member is refused outright").toBe(403);

    await drainAll();
    const post = (await ownerPool().query('SELECT token_hash, expires_at, status FROM business_invitations WHERE id = $1', [id])).rows[0] as {
      token_hash: string;
      expires_at: Date;
      status: string;
    };
    expect(post.token_hash, "the invitation's token was not rotated by a foreign resend").toBe(pre.token_hash);
    expect(post.status, 'and not cancelled by a foreign delete').toBe('pending');
    expect((await deliveries()).filter((r) => r.email === victim).length, "no new delivery was enqueued for B's invitee").toBe(preCount);
    expect(
      rec.sent.slice(before).map((s) => s.to),
      'no message left the system',
    ).toEqual([]);

    // Positive control: B itself CAN resend it, so the 404s above were scoping, not a broken route.
    const own = await t.request
      .post(`/v1/businesses/current/invitations/${id}/resend`)
      .set({ Authorization: `Bearer ${B.token}`, 'X-Business-Id': B.businessId });
    expect(own.status).toBeLessThan(300);
    await drainAll();
    expect(rec.sent.slice(before).map((s) => s.to)).toEqual([victim]);
  });

  it('recovery: one request produces one message to that account, in any spelling of the address; an unknown address produces none', async () => {
    const before = rec.sent.length;
    const unknown = uniqueEmail();
    const r1 = await t.request.post('/v1/auth/password-reset/request').send({ email: unknown });
    const r2 = await t.request.post('/v1/auth/password-reset/request').send({ email: A.email.toUpperCase() });
    expect(r1.status, 'the same answer for a known and an unknown address (no enumeration)').toBe(r2.status);
    await drainAll();
    const got = rec.sent.slice(before);
    expect(
      got.map((s) => s.to.toLowerCase()),
      "one message, to tenant A's account, none to B and none to the unknown address",
    ).toEqual([A.email.toLowerCase()]);
    expect(got.some((s) => s.to.toLowerCase() === B.email.toLowerCase())).toBe(false);
  });
});
