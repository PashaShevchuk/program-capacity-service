import { ApiProperty } from '@nestjs/swagger';

import { type UserRole } from '../user.entity';

export class TokenResponseDto {
  @ApiProperty()
  accessToken: string;

  @ApiProperty({ example: 'Bearer' })
  tokenType: string;

  @ApiProperty({ example: 3600, description: 'Lifetime in seconds' })
  expiresIn: number;

  @ApiProperty({ example: ['admin'] })
  roles: UserRole[];
}
