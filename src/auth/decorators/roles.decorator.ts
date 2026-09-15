import { SetMetadata } from '@nestjs/common';

import { type UserRole } from '../user.entity';

export const ROLES_KEY = 'auth:roles';

/** Restricts a route to callers holding at least one of these roles. */
export const Roles = (...roles: UserRole[]) => SetMetadata(ROLES_KEY, roles);
