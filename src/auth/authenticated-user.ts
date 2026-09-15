import { type UserRole } from './user.entity';

/** Who the request is acting as, resolved from the bearer token. */
export interface AuthenticatedUser {
  id: string;
  email: string;
  name: string;
  roles: UserRole[];
}

/** Claims the service puts in the access token. */
export interface AccessTokenClaims {
  sub: string;
  email: string;
  name: string;
  roles: UserRole[];
}
