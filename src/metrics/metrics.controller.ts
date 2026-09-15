import { Controller, Get, Header } from '@nestjs/common';
import { ApiExcludeEndpoint } from '@nestjs/swagger';

import { Public } from '../auth/decorators/public.decorator';
import { MetricsService } from './metrics.service';

@Controller()
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  /**
   * Public so a scraper does not need a token. In a real deployment this port is not exposed outside the cluster.
   */
  @Public()
  @Get('metrics')
  @Header('Content-Type', 'text/plain; version=0.0.4')
  @ApiExcludeEndpoint()
  scrape(): Promise<string> {
    return this.metrics.registry.metrics();
  }
}
