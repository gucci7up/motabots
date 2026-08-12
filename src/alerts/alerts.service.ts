import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { CreditsService } from '../credits/credits.service';
import { today } from '../common/date-range';
import { formatMoney, formatQuantity } from '../common/money';
import { CustomersService } from '../customers/customers.service';
import { InventoryService } from '../inventory/inventory.service';
import { ReportsService } from '../reports/reports.service';
import { SettingKey, SettingsService } from '../settings/settings.service';
import { NotifierService } from './notifier.service';

/**
 * Alertas automáticas por Telegram.
 *
 * Las expresiones cron corren en la zona horaria del proceso (`TZ=America/Santo_Domingo`),
 * así que «las 9 PM» son las 9 PM locales, no UTC.
 */
@Injectable()
export class AlertsService {
  private readonly logger = new Logger(AlertsService.name);

  constructor(
    private readonly notifier: NotifierService,
    private readonly inventory: InventoryService,
    private readonly credits: CreditsService,
    private readonly customers: CustomersService,
    private readonly reports: ReportsService,
    private readonly settings: SettingsService,
  ) {}

  /** Cada mañana: productos que llegaron a su mínimo. */
  @Cron('0 9 * * *', { name: 'low-stock' })
  async lowStockAlert(): Promise<void> {
    const enabled = await this.settings.getBoolean(SettingKey.LOW_STOCK_ALERTS, true);
    if (!enabled) {
      return;
    }

    const lowStock = await this.inventory.findLowStock();
    if (lowStock.length === 0) {
      return;
    }

    const lines = lowStock
      .slice(0, 15)
      .map(
        (row) =>
          `• ${row.productName} ${row.name}\n` +
          `   Stock: ${formatQuantity(row.currentStock)} · Mínimo: ${formatQuantity(row.minimumStock)}`,
      );

    const extra = lowStock.length > 15 ? `\n\n…y ${lowStock.length - 15} más.` : '';

    await this.notifier.broadcast(
      `⚠️ STOCK BAJO\n\n${lines.join('\n')}${extra}`,
      'inventory.read',
    );

    this.logger.log(`Alerta de stock bajo enviada: ${lowStock.length} productos`);
  }

  /**
   * Cada mañana: marca los créditos vencidos y avisa.
   * El marcado va primero: el aviso debe reflejar el estado ya actualizado.
   */
  @Cron('0 9 * * *', { name: 'overdue-credits' })
  async overdueCreditsAlert(): Promise<void> {
    const marked = await this.credits.markOverdue();
    const summary = await this.credits.getSummary();

    if (summary.overdueCount === 0) {
      return;
    }

    const debtors = await this.customers.findWithDebt(1, 10, true);

    const lines = debtors.data.map(
      (row) => `• ${row.customer.name}: ${formatMoney(row.balance)}`,
    );

    await this.notifier.broadcast(
      [
        '🔴 CRÉDITOS VENCIDOS',
        '',
        `Total vencido: ${formatMoney(summary.totalOverdue)}`,
        `Créditos: ${summary.overdueCount}`,
        '',
        ...lines,
      ].join('\n'),
      'credits.read',
    );

    this.logger.log(
      `Alerta de créditos vencidos enviada (${summary.overdueCount} créditos, ${marked} recién marcados)`,
    );
  }

  /** Resumen del día a la hora configurada. */
  @Cron('0 * * * *', { name: 'daily-summary' })
  async dailySummary(): Promise<void> {
    const configuredHour = await this.settings.getNumber(SettingKey.DAILY_SUMMARY_HOUR, 21);
    if (new Date().getHours() !== configuredHour) {
      return;
    }

    const data = await this.reports.getDashboard(today());

    // Un día sin ventas ni gastos no merece una notificación.
    if (data.sales.salesCount === 0 && data.expenses.isZero()) {
      return;
    }

    const lines = [
      '📊 RESUMEN DEL DÍA',
      '',
      `Ventas: ${data.sales.salesCount}`,
      `Facturado: ${formatMoney(data.sales.netSales)}`,
      `Cobrado: ${formatMoney(data.sales.collected)}`,
    ];

    if (data.sales.onCredit.greaterThan(0)) {
      lines.push(`A crédito: ${formatMoney(data.sales.onCredit)}`);
    }

    lines.push(
      '',
      `Ganancia bruta: ${formatMoney(data.sales.profit)}`,
      `Gastos: ${formatMoney(data.expenses)}`,
      `Ganancia neta: ${formatMoney(data.netProfit)}`,
      '',
      `Por cobrar: ${formatMoney(data.position.accountsReceivable)}`,
      `Efectivo en caja: ${formatMoney(data.position.cashOnHand)}`,
    );

    if (data.lowStockCount > 0) {
      lines.push('', `⚠️ ${data.lowStockCount} producto(s) con stock bajo`);
    }

    await this.notifier.broadcast(lines.join('\n'), 'reports.read');
    this.logger.log('Resumen diario enviado');
  }
}
