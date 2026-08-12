import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CashModule } from '../cash/cash.module';
import { CreditsModule } from '../credits/credits.module';
import { CustomersModule } from '../customers/customers.module';
import { ExpensesModule } from '../expenses/expenses.module';
import { InventoryModule } from '../inventory/inventory.module';
import { InvoicesModule } from '../invoices/invoices.module';
import { ProductsModule } from '../products/products.module';
import { ReportsModule } from '../reports/reports.module';
import { SalesModule } from '../sales/sales.module';
import { UsersModule } from '../users/users.module';
import { CashHandler } from './handlers/cash.handler';
import { CreditsHandler } from './handlers/credits.handler';
import { CustomersHandler } from './handlers/customers.handler';
import { DashboardHandler } from './handlers/dashboard.handler';
import { ExpensesHandler } from './handlers/expenses.handler';
import { InventoryHandler } from './handlers/inventory.handler';
import { InvoicesHandler } from './handlers/invoices.handler';
import { ReportsHandler } from './handlers/reports.handler';
import { SaleHandler } from './handlers/sale.handler';
import { SettingsHandler } from './handlers/settings.handler';
import { SessionStore } from './session/session.store';
import { TelegramController } from './telegram.controller';
import { TelegramService } from './telegram.service';
import { TelegramUpdateService } from './telegram-update.service';

/**
 * Capa de transporte del bot. Depende de los módulos de dominio, nunca al revés:
 * la lógica de negocio no debe saber que Telegram existe.
 */
@Module({
  imports: [
    AuthModule,
    UsersModule,
    SalesModule,
    ProductsModule,
    CustomersModule,
    InventoryModule,
    CreditsModule,
    InvoicesModule,
    CashModule,
    ExpensesModule,
    ReportsModule,
  ],
  controllers: [TelegramController],
  providers: [
    TelegramService,
    TelegramUpdateService,
    SessionStore,
    DashboardHandler,
    SaleHandler,
    CustomersHandler,
    InventoryHandler,
    CreditsHandler,
    InvoicesHandler,
    CashHandler,
    ExpensesHandler,
    ReportsHandler,
    SettingsHandler,
  ],
  exports: [TelegramService],
})
export class TelegramModule {}
