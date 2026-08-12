import { Module } from '@nestjs/common';
import { InvoiceNumberService } from './invoice-number.service';
import { InvoicePdfService } from './invoice-pdf.service';
import { InvoicesService } from './invoices.service';

@Module({
  providers: [InvoiceNumberService, InvoicePdfService, InvoicesService],
  exports: [InvoiceNumberService, InvoicePdfService, InvoicesService],
})
export class InvoicesModule {}
