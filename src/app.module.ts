import { Module } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { AppLoggerModule } from './common/logging/logger.module';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { SerializationInterceptor } from './common/interceptors/serialization.interceptor';
import { AppConfigModule } from './config/config.module';
import { PrismaModule } from './database/prisma.module';
import { HealthModule } from './health/health.module';

/**
 * Fase 1: infraestructura. Los módulos de dominio (users, products, sales, …) se añaden
 * aquí en las fases siguientes; ninguno de ellos dependerá del módulo de Telegram.
 */
@Module({
  imports: [AppConfigModule, AppLoggerModule, PrismaModule, HealthModule],
  providers: [
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_INTERCEPTOR, useClass: SerializationInterceptor },
  ],
})
export class AppModule {}
