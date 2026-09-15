import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

/**
 * Offset pagination, for short lists with a stable unique sort key.
 *
 * Lists that grow while a client reads them use {@link CursorQueryDto} instead
 */
export class PaginationQueryDto {
  @ApiPropertyOptional({ default: 1, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page = 1;

  @ApiPropertyOptional({ default: 50, minimum: 1, maximum: 200 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  pageSize = 50;

  get skip(): number {
    return (this.page - 1) * this.pageSize;
  }
}

export class PageDto<T> {
  @ApiProperty({ isArray: true })
  items: T[];

  @ApiProperty()
  page: number;

  @ApiProperty()
  pageSize: number;

  @ApiProperty()
  total: number;

  static of<T>(items: T[], total: number, query: PaginationQueryDto): PageDto<T> {
    return { items, total, page: query.page, pageSize: query.pageSize };
  }
}
