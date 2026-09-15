import { Module } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

import { databaseConfig } from '../config/configuration';
import { buildDataSourceOptions } from './data-source';

@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      inject: [databaseConfig.KEY],
      useFactory: (db: ConfigType<typeof databaseConfig>) =>
        buildDataSourceOptions({
          host: db.host,
          port: db.port,
          username: db.username,
          password: db.password,
          database: db.database,
          // Migrating on boot keeps `docker compose up` a single step. With more
          // than one replica this belongs in a deploy job instead.
          migrationsRun: db.runMigrationsOnBoot,
        }),
    }),
  ],
})
export class DatabaseModule {}
