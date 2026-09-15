import request from 'supertest';
import { type Server } from 'node:http';

import { UserRole } from '../../src/auth/user.entity';
import { createTestContext, type TestContext } from '../helpers/test-app';

describe('reservations over HTTP', () => {
  let context: TestContext;
  let clientToken: string;
  let adminToken: string;
  let viewerToken: string;

  const api = () => request(context.app.getHttpServer() as Server);

  beforeAll(async () => {
    context = await createTestContext();
    clientToken = await context.tokenFor(UserRole.Client);
    adminToken = await context.tokenFor(UserRole.Admin);
    viewerToken = await context.tokenFor(UserRole.Viewer);
  });

  afterAll(async () => {
    await context.close();
  });

  beforeEach(async () => {
    await context.reset();
    await context.createProgram('PRG-1', '1000000.00', 'USD');
  });

  describe('authentication', () => {
    it('rejects a request with no token', async () => {
      await api().get('/v1/programs/PRG-1/capacity').expect(401);
    });

    it('rejects a token signed with the wrong secret', async () => {
      await api()
        .get('/v1/programs/PRG-1/capacity')
        .set('Authorization', 'Bearer not.a.real.token')
        .expect(401);
    });

    it('answers a wrong password the same way whatever its length', async () => {
      // A minimum length on sign-in would reject a short password as malformed
      // and a long one as wrong, telling a caller about the password policy.
      for (const password of ['short', 'a-long-wrong-password']) {
        await request(context.app.getHttpServer() as Server)
          .post('/v1/auth/token')
          .send({ email: 'client@test.local', password })
          .expect(401);
      }
    });

    it('lets an authenticated viewer read capacity', async () => {
      const response = await api()
        .get('/v1/programs/PRG-1/capacity')
        .set('Authorization', `Bearer ${viewerToken}`)
        .expect(200);

      expect(response.body.available).toEqual({ amount: '1000000.00', currency: 'USD' });
    });

    it('does not let a viewer reserve', async () => {
      await api()
        .post('/v1/programs/PRG-1/reservations')
        .set('Authorization', `Bearer ${viewerToken}`)
        .send({ invoiceId: 'INV-1', amount: { amount: '100.00', currency: 'USD' } })
        .expect(403);
    });
  });

  describe('reserving', () => {
    it('reserves capacity and reports it as unavailable', async () => {
      const created = await api()
        .post('/v1/programs/PRG-1/reservations')
        .set('Authorization', `Bearer ${clientToken}`)
        .send({ invoiceId: 'INV-1', amount: { amount: '250000.00', currency: 'USD' } })
        .expect(201);

      expect(created.body.status).toBe('RESERVED');
      expect(created.body.reservedAmount).toEqual({ amount: '250000.00', currency: 'USD' });

      const capacity = await api()
        .get('/v1/programs/PRG-1/capacity')
        .set('Authorization', `Bearer ${clientToken}`)
        .expect(200);

      expect(capacity.body.reserved.amount).toBe('250000.00');
      expect(capacity.body.available.amount).toBe('750000.00');
    });

    it('converts an invoice in another currency and freezes the rate', async () => {
      const created = await api()
        .post('/v1/programs/PRG-1/reservations')
        .set('Authorization', `Bearer ${clientToken}`)
        .send({ invoiceId: 'INV-EUR', amount: { amount: '100000.00', currency: 'EUR' } })
        .expect(201);

      expect(created.body.invoiceAmount).toEqual({ amount: '100000.00', currency: 'EUR' });
      expect(created.body.reservedAmount).toEqual({ amount: '108500.00', currency: 'USD' });
      expect(created.body.fxRate).toBe('1.085000000000');
    });

    it('refuses a reservation larger than the remaining capacity', async () => {
      const response = await api()
        .post('/v1/programs/PRG-1/reservations')
        .set('Authorization', `Bearer ${clientToken}`)
        .send({ invoiceId: 'INV-BIG', amount: { amount: '2000000.00', currency: 'USD' } })
        .expect(409);

      expect(response.body.code).toBe('INSUFFICIENT_CAPACITY');
      expect(response.body.details).toMatchObject({ availableAmount: '1000000.00' });
    });

    it('refuses an amount with more precision than the currency has', async () => {
      const response = await api()
        .post('/v1/programs/PRG-1/reservations')
        .set('Authorization', `Bearer ${clientToken}`)
        .send({ invoiceId: 'INV-ODD', amount: { amount: '100.005', currency: 'USD' } })
        .expect(422);

      expect(response.body.code).toBe('INVALID_AMOUNT');
    });

    it('refuses an unknown currency', async () => {
      await api()
        .post('/v1/programs/PRG-1/reservations')
        .set('Authorization', `Bearer ${clientToken}`)
        .send({ invoiceId: 'INV-XXX', amount: { amount: '100.00', currency: 'XXX' } })
        .expect(400);
    });

    it('refuses unknown fields rather than ignoring them', async () => {
      await api()
        .post('/v1/programs/PRG-1/reservations')
        .set('Authorization', `Bearer ${clientToken}`)
        .send({
          invoiceId: 'INV-1',
          amount: { amount: '100.00', currency: 'USD' },
          reservedAmount: { amount: '1.00', currency: 'USD' },
        })
        .expect(400);
    });

    it('refuses a negative or zero amount instead of failing in the database', async () => {
      for (const amount of ['-100.00', '0.00']) {
        const response = await api()
          .post('/v1/programs/PRG-1/reservations')
          .set('Authorization', `Bearer ${clientToken}`)
          .send({ invoiceId: `INV-${amount}`, amount: { amount, currency: 'USD' } })
          .expect(400);

        expect(response.status).not.toBe(500);
      }
    });

    it('refuses an amount too large for the money columns', async () => {
      await api()
        .post('/v1/programs/PRG-1/reservations')
        .set('Authorization', `Bearer ${clientToken}`)
        .send({ invoiceId: 'INV-HUGE', amount: { amount: '999999999999999999', currency: 'USD' } })
        .expect(400);
    });

    it('returns 404 for a program that does not exist', async () => {
      await api()
        .post('/v1/programs/NOPE/reservations')
        .set('Authorization', `Bearer ${clientToken}`)
        .send({ invoiceId: 'INV-1', amount: { amount: '100.00', currency: 'USD' } })
        .expect(404);
    });
  });

  describe('idempotency', () => {
    const body = { invoiceId: 'INV-IDEM', amount: { amount: '100000.00', currency: 'USD' } };

    it('returns the original reservation when a request is retried', async () => {
      const first = await api()
        .post('/v1/programs/PRG-1/reservations')
        .set('Authorization', `Bearer ${clientToken}`)
        .set('Idempotency-Key', 'key-1')
        .send(body)
        .expect(201);

      const retry = await api()
        .post('/v1/programs/PRG-1/reservations')
        .set('Authorization', `Bearer ${clientToken}`)
        .set('Idempotency-Key', 'key-1')
        .send(body)
        .expect(200);

      expect(retry.body.id).toBe(first.body.id);

      const capacity = await api()
        .get('/v1/programs/PRG-1/capacity')
        .set('Authorization', `Bearer ${clientToken}`);

      expect(capacity.body.reserved.amount).toBe('100000.00');
    });

    it('rejects the same key used for a different amount', async () => {
      await api()
        .post('/v1/programs/PRG-1/reservations')
        .set('Authorization', `Bearer ${clientToken}`)
        .set('Idempotency-Key', 'key-amount')
        .send(body)
        .expect(201);

      // Returning the original here would tell the caller that 200,000 was
      // reserved when only 100,000 was.
      const response = await api()
        .post('/v1/programs/PRG-1/reservations')
        .set('Authorization', `Bearer ${clientToken}`)
        .set('Idempotency-Key', 'key-amount')
        .send({ ...body, amount: { amount: '200000.00', currency: 'USD' } })
        .expect(409);

      expect(response.body.code).toBe('IDEMPOTENCY_KEY_CONFLICT');
    });

    it('rejects the same key used with a different approval time', async () => {
      // approvedAt picks the FX rate, so it changes how much capacity is taken.
      await api()
        .post('/v1/programs/PRG-1/reservations')
        .set('Authorization', `Bearer ${clientToken}`)
        .set('Idempotency-Key', 'key-approved-at')
        .send({ ...body, approvedAt: '2026-02-01T00:00:00.000Z' })
        .expect(201);

      const response = await api()
        .post('/v1/programs/PRG-1/reservations')
        .set('Authorization', `Bearer ${clientToken}`)
        .set('Idempotency-Key', 'key-approved-at')
        .send({ ...body, approvedAt: '2026-03-01T00:00:00.000Z' })
        .expect(409);

      expect(response.body.code).toBe('IDEMPOTENCY_KEY_CONFLICT');
    });

    it('rejects an idempotency key longer than the column allows', async () => {
      const response = await api()
        .post('/v1/programs/PRG-1/reservations')
        .set('Authorization', `Bearer ${clientToken}`)
        .set('Idempotency-Key', 'k'.repeat(500))
        .send(body)
        .expect(422);

      expect(response.body.code).toBe('INVALID_IDEMPOTENCY_KEY');
    });

    it('rejects an idempotency key reused for a different invoice', async () => {
      await api()
        .post('/v1/programs/PRG-1/reservations')
        .set('Authorization', `Bearer ${clientToken}`)
        .set('Idempotency-Key', 'key-2')
        .send(body)
        .expect(201);

      const response = await api()
        .post('/v1/programs/PRG-1/reservations')
        .set('Authorization', `Bearer ${clientToken}`)
        .set('Idempotency-Key', 'key-2')
        .send({ ...body, invoiceId: 'INV-OTHER' })
        .expect(409);

      expect(response.body.code).toBe('IDEMPOTENCY_KEY_CONFLICT');
    });

    it('rejects a second reservation for the same invoice', async () => {
      await api()
        .post('/v1/programs/PRG-1/reservations')
        .set('Authorization', `Bearer ${clientToken}`)
        .send(body)
        .expect(201);

      const response = await api()
        .post('/v1/programs/PRG-1/reservations')
        .set('Authorization', `Bearer ${clientToken}`)
        .send({ ...body, amount: { amount: '200000.00', currency: 'USD' } })
        .expect(409);

      expect(response.body.code).toBe('DUPLICATE_RESERVATION');
    });
  });

  describe('releasing', () => {
    beforeEach(async () => {
      await api()
        .post('/v1/programs/PRG-1/reservations')
        .set('Authorization', `Bearer ${clientToken}`)
        .send({ invoiceId: 'INV-REL', amount: { amount: '100000.00', currency: 'EUR' } })
        .expect(201);
    });

    it('returns exactly the amount that was taken, not a fresh conversion', async () => {
      const released = await api()
        .post('/v1/programs/PRG-1/reservations/INV-REL/release')
        .set('Authorization', `Bearer ${clientToken}`)
        .send({ reason: 'Repaid' })
        .expect(200);

      expect(released.body.status).toBe('RELEASED');

      const capacity = await api()
        .get('/v1/programs/PRG-1/capacity')
        .set('Authorization', `Bearer ${clientToken}`);

      expect(capacity.body.reserved.amount).toBe('0.00');
      expect(capacity.body.available.amount).toBe('1000000.00');
    });

    it('treats a repeated release as already done', async () => {
      await api()
        .post('/v1/programs/PRG-1/reservations/INV-REL/release')
        .set('Authorization', `Bearer ${clientToken}`)
        .send({})
        .expect(200);

      await api()
        .post('/v1/programs/PRG-1/reservations/INV-REL/release')
        .set('Authorization', `Bearer ${clientToken}`)
        .send({})
        .expect(200);

      const capacity = await api()
        .get('/v1/programs/PRG-1/capacity')
        .set('Authorization', `Bearer ${clientToken}`);

      expect(capacity.body.reserved.amount).toBe('0.00');
    });

    it('refuses a release dated before the reservation was made', async () => {
      const response = await api()
        .post('/v1/programs/PRG-1/reservations/INV-REL/release')
        .set('Authorization', `Bearer ${clientToken}`)
        .send({ occurredAt: '2020-01-01T00:00:00.000Z' })
        .expect(422);

      expect(response.body.code).toBe('INVALID_TIMESTAMP');
    });

    it('returns the capacity when a reservation is cancelled', async () => {
      const cancelled = await api()
        .post('/v1/programs/PRG-1/reservations/INV-REL/cancel')
        .set('Authorization', `Bearer ${clientToken}`)
        .send({ reason: 'Approval withdrawn' })
        .expect(200);

      expect(cancelled.body.status).toBe('CANCELLED');
      expect(cancelled.body.cancelledAt).not.toBeNull();

      const capacity = await api()
        .get('/v1/programs/PRG-1/capacity')
        .set('Authorization', `Bearer ${clientToken}`);

      expect(capacity.body.reserved.amount).toBe('0.00');

      const ledger = await api()
        .get('/v1/programs/PRG-1/ledger')
        .set('Authorization', `Bearer ${clientToken}`);

      expect(ledger.body.items[0].entryType).toBe('CANCEL');
      expect(ledger.body.items[0].reservedDelta.amount).toBe('-108500.00');
    });

    it('refuses to cancel a reservation that was already released', async () => {
      await api()
        .post('/v1/programs/PRG-1/reservations/INV-REL/release')
        .set('Authorization', `Bearer ${clientToken}`)
        .send({})
        .expect(200);

      const response = await api()
        .post('/v1/programs/PRG-1/reservations/INV-REL/cancel')
        .set('Authorization', `Bearer ${clientToken}`)
        .send({})
        .expect(409);

      expect(response.body.code).toBe('INVALID_RESERVATION_TRANSITION');
    });
  });

  describe('limits', () => {
    it('lets an admin raise the limit', async () => {
      const response = await api()
        .patch('/v1/programs/PRG-1/limit')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ totalLimit: { amount: '2000000.00', currency: 'USD' } })
        .expect(200);

      expect(response.body.totalLimit.amount).toBe('2000000.00');
    });

    it('does not let a client change the limit', async () => {
      await api()
        .patch('/v1/programs/PRG-1/limit')
        .set('Authorization', `Bearer ${clientToken}`)
        .send({ totalLimit: { amount: '2000000.00', currency: 'USD' } })
        .expect(403);
    });

    it('refuses a limit below what is already reserved', async () => {
      await api()
        .post('/v1/programs/PRG-1/reservations')
        .set('Authorization', `Bearer ${clientToken}`)
        .send({ invoiceId: 'INV-L', amount: { amount: '500000.00', currency: 'USD' } })
        .expect(201);

      const response = await api()
        .patch('/v1/programs/PRG-1/limit')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ totalLimit: { amount: '100000.00', currency: 'USD' } })
        .expect(409);

      expect(response.body.code).toBe('LIMIT_BELOW_RESERVED');
    });
  });

  describe('creating programs', () => {
    it('opens the ledger with the initial limit', async () => {
      await api()
        .post('/v1/programs')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          code: 'PRG-NEW',
          name: 'Newly created',
          totalLimit: { amount: '750000.00', currency: 'GBP' },
        })
        .expect(201);

      const ledger = await api()
        .get('/v1/programs/PRG-NEW/ledger')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      expect(ledger.body.items).toHaveLength(1);
      expect(ledger.body.hasMore).toBe(false);
      expect(ledger.body.items[0].entryType).toBe('LIMIT_CHANGE');
      expect(ledger.body.items[0].limitAfter).toEqual({ amount: '750000.00', currency: 'GBP' });
    });

    it('rejects a code that is already taken', async () => {
      const response = await api()
        .post('/v1/programs')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          code: 'PRG-1',
          name: 'Duplicate',
          totalLimit: { amount: '1.00', currency: 'USD' },
        })
        .expect(409);

      expect(response.body.code).toBe('PROGRAM_CODE_TAKEN');
    });

    it('does not let a client create a program', async () => {
      await api()
        .post('/v1/programs')
        .set('Authorization', `Bearer ${clientToken}`)
        .send({
          code: 'PRG-NOPE',
          name: 'Not allowed',
          totalLimit: { amount: '1.00', currency: 'USD' },
        })
        .expect(403);
    });
  });

  describe('audit trail', () => {
    it('records every movement with the balance it produced', async () => {
      await api()
        .post('/v1/programs/PRG-1/reservations')
        .set('Authorization', `Bearer ${clientToken}`)
        .send({ invoiceId: 'INV-A', amount: { amount: '100000.00', currency: 'USD' } })
        .expect(201);

      await api()
        .post('/v1/programs/PRG-1/reservations/INV-A/release')
        .set('Authorization', `Bearer ${clientToken}`)
        .send({})
        .expect(200);

      const ledger = await api()
        .get('/v1/programs/PRG-1/ledger')
        .set('Authorization', `Bearer ${clientToken}`)
        .expect(200);

      expect(ledger.body.items).toHaveLength(2);
      expect(
        ledger.body.items.map((entry: { entryType: string }) => entry.entryType).sort(),
      ).toEqual(['RELEASE', 'RESERVE']);
    });

    it('names the user behind every movement', async () => {
      await api()
        .post('/v1/programs/PRG-1/reservations')
        .set('Authorization', `Bearer ${clientToken}`)
        .send({ invoiceId: 'INV-WHO', amount: { amount: '1000.00', currency: 'USD' } })
        .expect(201);

      const ledger = await api()
        .get('/v1/programs/PRG-1/ledger')
        .set('Authorization', `Bearer ${clientToken}`)
        .expect(200);

      expect(ledger.body.items[0].actor).toMatchObject({
        type: 'USER',
        label: 'client@test.local',
      });
      expect(ledger.body.items[0].actor.id).toEqual(expect.any(String));
    });

    it('ties an entry back to the request that caused it', async () => {
      const created = await api()
        .post('/v1/programs/PRG-1/reservations')
        .set('Authorization', `Bearer ${clientToken}`)
        .set('X-Request-Id', 'trace-me-123')
        .send({ invoiceId: 'INV-TRACE', amount: { amount: '1000.00', currency: 'USD' } })
        .expect(201);

      expect(created.headers['x-request-id']).toBe('trace-me-123');

      const ledger = await api()
        .get('/v1/programs/PRG-1/ledger')
        .set('Authorization', `Bearer ${clientToken}`)
        .expect(200);

      expect(ledger.body.items[0].correlationId).toBe('trace-me-123');
    });
  });
});
