import { type UserRole } from './user.entity';

export interface AuthenticatedUser {
  id: string;
  email: string;
  name: string;
  roles: UserRole[];
}

export interface AccessTokenClaims {
  sub: string;
  email: string;
  name: string;
  roles: UserRole[];
}
