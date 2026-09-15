import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { KafkaClientService } from './kafka-client.service';
import { KafkaConsumerService } from './kafka-consumer.service';
import { KafkaHandlerRegistry } from './kafka-handler.registry';
import { ProcessedMessageEntity } from './processed-message.entity';

@Global()
@Module({
  imports: [TypeOrmModule.forFeature([ProcessedMessageEntity])],
  providers: [KafkaClientService, KafkaHandlerRegistry, KafkaConsumerService],
  exports: [KafkaClientService, KafkaHandlerRegistry, KafkaConsumerService],
})
export class KafkaModule {}
