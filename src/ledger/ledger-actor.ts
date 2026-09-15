export enum LedgerActorType {
  /** An authenticated caller of this service's API. */
  User = 'USER',
  /** The external treasury system, over Kafka. */
  Treasury = 'TREASURY',
  /** The service itself, with no caller behind the change. */
  System = 'SYSTEM',
}

/**
 * Who caused a capacity movement.
 *
 * `label` is a snapshot of how the actor was identified at the time. An email
 * or a service name can change later; an audit record should still read the way
 * it did when it was written.
 */
export interface LedgerActor {
  type: LedgerActorType;
  /** Stable identifier: the user id, or null for non-user actors. */
  id: string | null;
  label: string | null;
}

export function userActor(id: string, label: string): LedgerActor {
  return { type: LedgerActorType.User, id, label };
}

export const TREASURY_ACTOR: LedgerActor = {
  type: LedgerActorType.Treasury,
  id: null,
  label: 'treasury',
};

export const SYSTEM_ACTOR: LedgerActor = {
  type: LedgerActorType.System,
  id: null,
  label: null,
};
