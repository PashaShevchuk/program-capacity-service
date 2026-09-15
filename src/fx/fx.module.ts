import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { DatabaseExchangeRateProvider } from './database-exchange-rate.provider';
import { EXCHANGE_RATE_PROVIDER } from './exchange-rate.types';
import { FxRateEntity } from './fx-rate.entity';
import { FxService } from './fx.service';

@Module({
  imports: [TypeOrmModule.forFeature([FxRateEntity])],
  providers: [
    FxService,
    DatabaseExchangeRateProvider,
    { provide: EXCHANGE_RATE_PROVIDER, useExisting: DatabaseExchangeRateProvider },
  ],
  exports: [FxService, EXCHANGE_RATE_PROVIDER],
})
export class FxModule {}
