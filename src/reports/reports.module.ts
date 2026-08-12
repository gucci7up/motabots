import { Module } from '@nestjs/common';
import { AccountingModule } from '../accounting/accounting.module';
import { CreditsModule } from '../credits/credits.module';
import { ExpensesModule } from '../expenses/expenses.module';
import { InventoryModule } from '../inventory/inventory.module';
import { ReportsService } from './reports.service';

@Module({
  imports: [AccountingModule, InventoryModule, CreditsModule, ExpensesModule],
  providers: [ReportsService],
  exports: [ReportsService],
})
export class ReportsModule {}
