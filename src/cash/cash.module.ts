import { Module } from '@nestjs/common';
import { CashService } from './cash.service';

@Module({
  providers: [CashService],
  exports: [CashService],
})
export class CashModule {}
