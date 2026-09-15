import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { type Request } from 'express';

import { type AuthenticatedUser } from '../authenticated-user';
import { ROLES_KEY } from '../decorators/roles.decorator';
import { type UserRole } from '../user.entity';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<UserRole[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!required?.length) {
      return true;
    }

    const { user } = context.switchToHttp().getRequest<Request & { user?: AuthenticatedUser }>();

    if (!user || !required.some((role) => user.roles.includes(role))) {
      throw new ForbiddenException(`This operation requires one of: ${required.join(', ')}`);
    }

    return true;
  }
}
