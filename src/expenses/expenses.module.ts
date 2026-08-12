import { Module } from '@nestjs/common';
import { CashModule } from '../cash/cash.module';
import { ExpensesService } from './expenses.service';

@Module({
  imports: [CashModule],
  providers: [ExpensesService],
  exports: [ExpensesService],
})
export class ExpensesModule {}
