import { type SelectQueryBuilder } from 'typeorm';

import { decodeCursor } from './cursor-pagination.dto';

/** Applies keyset ordering and the cursor predicate to a query. */
export function applyKeyset<T extends object>(
  query: SelectQueryBuilder<T>,
  options: { alias: string; timestampColumn: string; limit: number; cursor?: string },
): SelectQueryBuilder<T> {
  const ordering = `${options.alias}.${options.timestampColumn}`;

  if (options.cursor) {
    const position = decodeCursor(options.cursor);

    query.andWhere(`(${ordering}, ${options.alias}.id) < (:cursorTimestamp, :cursorId)`, {
      cursorTimestamp: position.timestamp,
      cursorId: position.id,
    });
  }

  return query
    .orderBy(ordering, 'DESC')
    .addOrderBy(`${options.alias}.id`, 'DESC')
    .limit(options.limit + 1);
}
