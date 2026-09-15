import { Controller, Get } from '@nestjs/common';
import { ApiExcludeEndpoint, ApiTags } from '@nestjs/swagger';
import { HealthCheck, HealthCheckService, TypeOrmHealthIndicator } from '@nestjs/terminus';

import { Public } from '../auth/decorators/public.decorator';

@ApiTags('health')
@Controller()
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly database: TypeOrmHealthIndicator,
  ) {}

  /** Liveness: the process is up. Never touches dependencies. */
  @Public()
  @Get('healthz')
  @ApiExcludeEndpoint()
  live(): { status: string } {
    return { status: 'ok' };
  }

  /** Readiness: the service can actually serve traffic. */
  @Public()
  @Get('readyz')
  @HealthCheck()
  @ApiExcludeEndpoint()
  ready() {
    return this.health.check([() => this.database.pingCheck('database', { timeout: 2000 })]);
  }
}
