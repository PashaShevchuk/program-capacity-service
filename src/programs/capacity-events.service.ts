import { Injectable } from '@nestjs/common';
import { Observable, Subject, filter } from 'rxjs';

import { type CapacityChangedPayload } from './capacity-changed.event';

/**
 * In-process fan-out of capacity changes to SSE subscribers.
 *
 * Single-instance only: a client connected to one replica will not see changes
 * applied by another. Making this cluster-wide means subscribing to the
 * `program.capacity.changed` topic the service already publishes, or a Redis
 * pub/sub channel. See ADR-0005.
 */
@Injectable()
export class CapacityEventsService {
  private readonly changes = new Subject<CapacityChangedPayload>();

  publish(payload: CapacityChangedPayload): void {
    this.changes.next(payload);
  }

  forProgram(programId: string): Observable<CapacityChangedPayload> {
    return this.changes.asObservable().pipe(filter((change) => change.programId === programId));
  }
}
