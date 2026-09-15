import { Module, ValidationPipe } from '@nestjs/common';
import { ConfigModule, type ConfigType } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, APP_PIPE } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { LoggerModule } from 'nestjs-pino';

import { AuthModule } from './auth/auth.module';
import { JwtAuthGuard } from './auth/guards/jwt-auth.guard';
import { buildLoggerOptions } from './common/logging/logger.config';
import { ProblemDetailsFilter } from './common/http/problem-details.filter';
import { appConfig, configurations } from './config/configuration';
import { validateEnv } from './config/env.validation';
import { DatabaseModule } from './database/database.module';
import { FxModule } from './fx/fx.module';
import { HealthModule } from './health/health.module';
import { LedgerModule } from './ledger/ledger.module';
import { MetricsModule } from './metrics/metrics.module';
import { OutboxModule } from './outbox/outbox.module';
import { ProgramsModule } from './programs/programs.module';
import { ReservationsModule } from './reservations/reservations.module';
import { KafkaModule } from './kafka/kafka.module';
import { TreasuryModule } from './treasury/treasury.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: configurations, validate: validateEnv }),
    LoggerModule.forRootAsync({
      inject: [appConfig.KEY],
      useFactory: (app: ConfigType<typeof appConfig>) =>
        buildLoggerOptions(app.logLevel, app.logPretty),
    }),
    ScheduleModule.forRoot(),
    DatabaseModule,
    MetricsModule,
    KafkaModule,
    AuthModule,
    FxModule,
    LedgerModule,
    OutboxModule,
    ProgramsModule,
    ReservationsModule,
    TreasuryModule,
    HealthModule,
  ],
  providers: [
    // Authenticated by default: a route has to opt out with @Public().
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    {
      provide: APP_PIPE,
      useValue: new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        transformOptions: { enableImplicitConversion: false },
      }),
    },
    { provide: APP_FILTER, useClass: ProblemDetailsFilter },
  ],
})
export class AppModule {}
