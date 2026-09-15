import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { type ConfigType } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import * as bcrypt from 'bcryptjs';
import { Repository } from 'typeorm';

import { jwtConfig } from '../config/configuration';
import { type AccessTokenClaims } from './authenticated-user';
import { type LoginDto } from './dto/login.dto';
import { type TokenResponseDto } from './dto/token-response.dto';
import { UserEntity } from './user.entity';

/** Never matches; only there to keep the failure paths the same cost. */
const UNKNOWN_USER_HASH = '$2a$10$G3lj59DdSiVPf.aFS57iH./6JO6v4RNqn3TejhdKe5TmzvqMW/c5C';

@Injectable()
export class AuthService {
  constructor(
    @InjectRepository(UserEntity) private readonly users: Repository<UserEntity>,
    private readonly jwt: JwtService,
    @Inject(jwtConfig.KEY) private readonly config: ConfigType<typeof jwtConfig>,
  ) {}

  async issueToken(credentials: LoginDto): Promise<TokenResponseDto> {
    const user = await this.users
      .createQueryBuilder('user')
      .where('lower(user.email) = lower(:email)', { email: credentials.email })
      .getOne();

    // A real cost-10 hash of a value nobody knows. Comparing against a
    // malformed string returns instantly, which would make a missing user
    // measurably faster to reject than a wrong password.
    const passwordMatches = await bcrypt.compare(
      credentials.password,
      user?.passwordHash ?? UNKNOWN_USER_HASH,
    );

    if (!user || !user.isActive || !passwordMatches) {
      throw new UnauthorizedException('Invalid email or password');
    }

    const claims: AccessTokenClaims = {
      sub: user.id,
      email: user.email,
      name: user.name,
      roles: user.roles,
    };

    const accessToken = await this.jwt.signAsync(claims, {
      issuer: this.config.issuer,
      audience: this.config.audience,
      expiresIn: this.config.expiresInSeconds,
    });

    return {
      accessToken,
      tokenType: 'Bearer',
      expiresIn: this.config.expiresInSeconds,
      roles: user.roles,
    };
  }
}
