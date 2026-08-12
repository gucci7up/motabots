import { Module } from '@nestjs/common';
import { CustomersModule } from '../customers/customers.module';
import { InventoryModule } from '../inventory/inventory.module';
import { InvoicesModule } from '../invoices/invoices.module';
import { SalesService } from './sales.service';

@Module({
  imports: [InventoryModule, CustomersModule, InvoicesModule],
  providers: [SalesService],
  exports: [SalesService],
})
export class SalesModule {}
