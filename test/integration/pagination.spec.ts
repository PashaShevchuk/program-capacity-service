import request from 'supertest';
import { type Server } from 'node:http';

import { UserRole } from '../../src/auth/user.entity';
import { Money } from '../../src/common/money';
import { LedgerEntrySource } from '../../src/ledger/capacity-ledger-entry.entity';
import { ReservationSource } from '../../src/reservations/invoice-reservation.entity';
import { ReservationsService } from '../../src/reservations/reservations.service';
import { createTestContext, TEST_ACTOR, type TestContext } from '../helpers/test-app';

interface CursorPage {
  items: { id: string }[];
  nextCursor: string | null;
  hasMore: boolean;
}

/**
 * The ledger is append-only and read newest first, which is exactly the shape
 * offset pagination gets wrong: rows shift under the reader, and a timestamp
 * shared by concurrent writes leaves the order undefined. These tests pin down
 * that the cursor does not have either problem.
 */
describe('cursor pagination', () => {
  let context: TestContext;
  let reservations: ReservationsService;
  let token: string;

  const api = () => request(context.app.getHttpServer() as Server);

  const reserve = (invoiceId: string) =>
    reservations.reserve({
      programRef: 'PRG-PAGE',
      invoiceId,
      amount: Money.fromDecimal('100.00', 'USD'),
      source: ReservationSource.Api,
      ledgerSource: LedgerEntrySource.Api,
      actor: TEST_ACTOR,
    });

  /** Walks every page and returns the ids in the order they were served. */
  const readAll = async (path: string, limit: number): Promise<string[]> => {
    const ids: string[] = [];
    let cursor: string | null = null;

    for (let guard = 0; guard < 50; guard += 1) {
      const query: string = cursor
        ? `?limit=${limit}&cursor=${encodeURIComponent(cursor)}`
        : `?limit=${limit}`;

      const response = await api()
        .get(path + query)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      const page = response.body as CursorPage;
      ids.push(...page.items.map((item) => item.id));

      if (!page.hasMore) return ids;
      cursor = page.nextCursor;
    }

    throw new Error('Pagination did not terminate');
  };

  beforeAll(async () => {
    context = await createTestContext();
    reservations = context.app.get(ReservationsService);
    token = await context.tokenFor(UserRole.Admin);
  });

  afterAll(async () => {
    await context.close();
  });

  beforeEach(async () => {
    await context.reset();
    await context.createProgram('PRG-PAGE', '1000000.00', 'USD');
  });

  it('serves every ledger entry exactly once across pages', async () => {
    for (let index = 0; index < 25; index += 1) {
      await reserve(`INV-${index}`);
    }

    const ids = await readAll('/v1/programs/PRG-PAGE/ledger', 10);

    expect(ids).toHaveLength(25);
    expect(new Set(ids).size).toBe(25);
  });

  it('does not lose entries that share a timestamp', async () => {
    // Concurrent writes land in the same millisecond, so ordering by the
    // timestamp alone would leave tied rows in an undefined order and a page
    // boundary could fall between two of them differently on each query.
    await Promise.all(Array.from({ length: 20 }, (_, index) => reserve(`INV-RACE-${index}`)));

    const ids = await readAll('/v1/programs/PRG-PAGE/ledger', 3);

    expect(ids).toHaveLength(20);
    expect(new Set(ids).size).toBe(20);
  });

  it('keeps a page stable while new entries are being written', async () => {
    for (let index = 0; index < 10; index += 1) {
      await reserve(`INV-${index}`);
    }

    const first = await api()
      .get('/v1/programs/PRG-PAGE/ledger?limit=5')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const firstPage = first.body as CursorPage;
    expect(firstPage.hasMore).toBe(true);

    // Five more arrive at the head of the list before the client reads on.
    for (let index = 0; index < 5; index += 1) {
      await reserve(`INV-NEW-${index}`);
    }

    const second = await api()
      .get(
        `/v1/programs/PRG-PAGE/ledger?limit=5&cursor=${encodeURIComponent(firstPage.nextCursor!)}`,
      )
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const secondPage = second.body as CursorPage;
    const firstIds = firstPage.items.map((item) => item.id);
    const secondIds = secondPage.items.map((item) => item.id);

    // With offsets, the five inserts would have pushed the first page's rows
    // down into the second, repeating them.
    expect(secondIds.filter((id) => firstIds.includes(id))).toEqual([]);
    expect(secondIds).toHaveLength(5);
  });

  it('reports the last page without a cursor', async () => {
    for (let index = 0; index < 3; index += 1) {
      await reserve(`INV-${index}`);
    }

    const response = await api()
      .get('/v1/programs/PRG-PAGE/ledger?limit=10')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const page = response.body as CursorPage;

    expect(page.items).toHaveLength(3);
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeNull();
  });

  it('pages reservations the same way', async () => {
    for (let index = 0; index < 12; index += 1) {
      await reserve(`INV-${index}`);
    }

    const ids = await readAll('/v1/programs/PRG-PAGE/reservations', 5);

    expect(ids).toHaveLength(12);
    expect(new Set(ids).size).toBe(12);
  });

  it('rejects a cursor it did not issue', async () => {
    const response = await api()
      .get('/v1/programs/PRG-PAGE/ledger?cursor=not-a-real-cursor')
      .set('Authorization', `Bearer ${token}`)
      .expect(422);

    expect(response.body.code).toBe('INVALID_CURSOR');
  });

  it('refuses a limit beyond the maximum', async () => {
    await api()
      .get('/v1/programs/PRG-PAGE/ledger?limit=5000')
      .set('Authorization', `Bearer ${token}`)
      .expect(400);
  });
});
