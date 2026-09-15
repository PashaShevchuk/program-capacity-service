import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { OutboxMessageEntity } from './outbox-message.entity';
import { OutboxPublisherService } from './outbox-publisher.service';
import { OutboxService } from './outbox.service';

@Module({
  imports: [TypeOrmModule.forFeature([OutboxMessageEntity])],
  providers: [OutboxService, OutboxPublisherService],
  exports: [OutboxService, OutboxPublisherService],
})
export class OutboxModule {}
