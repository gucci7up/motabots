import { Module } from '@nestjs/common';
import { CreditsModule } from '../credits/credits.module';
import { CustomersModule } from '../customers/customers.module';
import { InventoryModule } from '../inventory/inventory.module';
import { ReportsModule } from '../reports/reports.module';
import { TelegramModule } from '../telegram/telegram.module';
import { AlertsService } from './alerts.service';
import { NotifierService } from './notifier.service';

/**
 * Depende de TelegramModule para poder enviar; es la única dirección permitida.
 * Ningún módulo de dominio conoce este módulo.
 */
@Module({
  imports: [TelegramModule, InventoryModule, CreditsModule, CustomersModule, ReportsModule],
  providers: [AlertsService, NotifierService],
  exports: [NotifierService],
})
export class AlertsModule {}
