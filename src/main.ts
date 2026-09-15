import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';

import { AppModule } from './app.module';
import { appConfig } from './config/configuration';
import type { ConfigType } from '@nestjs/config';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });

  app.useLogger(app.get(Logger));
  app.use(helmet());
  app.enableShutdownHooks();

  // Health and metrics stay unversioned so probes and scrapers are unaffected
  // by API versioning.
  app.setGlobalPrefix('v1', { exclude: ['healthz', 'readyz', 'metrics'] });

  const swagger = new DocumentBuilder()
    .setTitle('Program Capacity & Invoice Reservation')
    .setDescription(
      'Tracks financing program capacity in real time: reservations, releases and treasury reconciliation.',
    )
    .setVersion('1.0')
    .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' })
    .build();

  SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, swagger), {
    swaggerOptions: { persistAuthorization: true },
  });

  const config = app.get<ConfigType<typeof appConfig>>(appConfig.KEY);
  await app.listen(config.port, '0.0.0.0');

  app.get(Logger).log(`Listening on http://localhost:${config.port} (docs at /docs)`);
}

void bootstrap();
