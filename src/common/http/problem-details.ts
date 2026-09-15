import { ApiProperty } from '@nestjs/swagger';

/** RFC 7807 error body. Every error the API returns has this shape. */
export class ProblemDetails {
  @ApiProperty({ example: 'https://docs.capacity.example/errors/INSUFFICIENT_CAPACITY' })
  type: string;

  @ApiProperty({ example: 'Insufficient capacity' })
  title: string;

  @ApiProperty({ example: 409 })
  status: number;

  @ApiProperty({ example: 'Program PRG-001 has 1000.00 USD available, ...' })
  detail: string;

  @ApiProperty({ example: '/v1/programs/PRG-001/reservations' })
  instance: string;

  @ApiProperty({ example: 'INSUFFICIENT_CAPACITY' })
  code: string;

  @ApiProperty({ example: '2026-09-15T10:00:00.000Z' })
  timestamp: string;

  @ApiProperty({ description: 'Correlates the error with server logs' })
  requestId: string;

  @ApiProperty({ required: false, type: Object })
  details?: Record<string, unknown>;
}
