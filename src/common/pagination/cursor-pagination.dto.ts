import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

import { InvalidCursorError } from '../errors/domain.errors';

/** Keyset pagination for lists that grow at the head. */
export class CursorQueryDto {
  @ApiPropertyOptional({ default: 50, minimum: 1, maximum: 200 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit = 50;

  @ApiPropertyOptional({ description: 'The `nextCursor` from the previous page' })
  @IsOptional()
  @IsString()
  cursor?: string;
}

export class CursorPageDto<T> {
  @ApiProperty({ isArray: true })
  items: T[];

  @ApiProperty({
    nullable: true,
    description: 'Pass as `cursor` to fetch the next page. Null on the last page.',
  })
  nextCursor: string | null;

  @ApiProperty()
  hasMore: boolean;
}

/** Position in a list ordered by a timestamp, with the id breaking ties. */
export interface KeysetPosition {
  timestamp: Date;
  id: string;
}

export function encodeCursor(position: KeysetPosition): string {
  const payload = JSON.stringify({ t: position.timestamp.toISOString(), i: position.id });

  return Buffer.from(payload, 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): KeysetPosition {
  let parsed: { t?: unknown; i?: unknown };

  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as typeof parsed;
  } catch {
    throw new InvalidCursorError();
  }

  if (typeof parsed.t !== 'string' || typeof parsed.i !== 'string') {
    throw new InvalidCursorError();
  }

  const timestamp = new Date(parsed.t);
  if (Number.isNaN(timestamp.getTime())) {
    throw new InvalidCursorError();
  }

  return { timestamp, id: parsed.i };
}

/**
 * Turns `limit + 1` rows into a page. The extra row is what tells us whether
 * there is more to come without running a second query.
 */
export function buildCursorPage<T extends { id: string }>(
  rows: T[],
  limit: number,
  timestampOf: (row: T) => Date,
): CursorPageDto<T> {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items.at(-1);

  return {
    items,
    hasMore,
    nextCursor:
      hasMore && last ? encodeCursor({ timestamp: timestampOf(last), id: last.id }) : null,
  };
}
