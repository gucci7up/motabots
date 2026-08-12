import { Module } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { AppLoggerModule } from './common/logging/logger.module';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { SerializationInterceptor } from './common/interceptors/serialization.interceptor';
import { AppConfigModule } from './config/config.module';
import { AuditModule } from './audit/audit.module';
import { AuthModule } from './auth/auth.module';
import { CashModule } from './cash/cash.module';
import { CategoriesModule } from './categories/categories.module';
import { CreditsModule } from './credits/credits.module';
import { StorageModule } from './storage/storage.module';
import { CustomersModule } from './customers/customers.module';
import { InventoryModule } from './inventory/inventory.module';
import { InvoicesModule } from './invoices/invoices.module';
import { SalesModule } from './sales/sales.module';
import { ProductsModule } from './products/products.module';
import { SettingsModule } from './settings/settings.module';
import { PrismaModule } from './database/prisma.module';
import { HealthModule } from './health/health.module';
import { RolesModule } from './roles/roles.module';
import { TelegramModule } from './telegram/telegram.module';
import { UsersModule } from './users/users.module';

/**
 * Los módulos de dominio (products, sales, …) se añaden aquí en las fases siguientes;
 * ninguno de ellos depende del módulo de Telegram. La dependencia va en un solo sentido.
 */
@Module({
  imports: [
    AppConfigModule,
    AppLoggerModule,
    PrismaModule,
    AuditModule,
    HealthModule,
    RolesModule,
    UsersModule,
    AuthModule,
    SettingsModule,
    CategoriesModule,
    ProductsModule,
    InventoryModule,
    CustomersModule,
    InvoicesModule,
    SalesModule,
    CreditsModule,
    StorageModule,
    CashModule,
    TelegramModule,
  ],
  providers: [
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_INTERCEPTOR, useClass: SerializationInterceptor },
  ],
})
export class AppModule {}
