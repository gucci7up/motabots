import { Module } from '@nestjs/common';
import { InvoiceNumberService } from './invoice-number.service';

@Module({
  providers: [InvoiceNumberService],
  exports: [InvoiceNumberService],
})
export class InvoicesModule {}
