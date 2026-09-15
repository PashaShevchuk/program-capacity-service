import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { type ConfigType } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy, type StrategyOptionsWithoutRequest } from 'passport-jwt';

import { jwtConfig } from '../config/configuration';
import { type AccessTokenClaims, type AuthenticatedUser } from './authenticated-user';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(@Inject(jwtConfig.KEY) config: ConfigType<typeof jwtConfig>) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.secret,
      issuer: config.issuer,
      audience: config.audience,
      algorithms: ['HS256'],
    } satisfies StrategyOptionsWithoutRequest);
  }

  validate(claims: AccessTokenClaims): AuthenticatedUser {
    if (!claims.sub || !Array.isArray(claims.roles)) {
      throw new UnauthorizedException('Malformed access token');
    }

    return { id: claims.sub, email: claims.email, name: claims.name, roles: claims.roles };
  }
}
