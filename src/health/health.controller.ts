import { Controller, Get } from '@nestjs/common';
import { ApiExcludeEndpoint, ApiTags } from '@nestjs/swagger';
import {
  HealthCheck,
  HealthCheckService,
  HealthIndicatorService,
  TypeOrmHealthIndicator,
} from '@nestjs/terminus';

import { Public } from '../auth/decorators/public.decorator';
import { KafkaConsumerService } from '../kafka/kafka-consumer.service';

@ApiTags('health')
@Controller()
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly database: TypeOrmHealthIndicator,
    private readonly consumer: KafkaConsumerService,
    private readonly indicator: HealthIndicatorService,
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
    return this.health.check([
      () => this.database.pingCheck('database', { timeout: 2000 }),
      () => {
        // A consumer that has stopped for good means treasury updates are no
        // longer arriving, even though HTTP still works.
        const check = this.indicator.check('kafka-consumer');

        return this.consumer.isConsuming ? check.up() : check.down('consumer stopped');
      },
    ]);
  }
}
