import { Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { randomUUID } from 'node:crypto';
import { AppConfigModule } from '../../config/config.module';
import { AppConfigService } from '../../config/app-config.service';

/**
 * Logging estructurado en JSON. Nunca se imprimen tokens ni secretos: las rutas sensibles
 * se redactan automáticamente antes de escribir la línea de log.
 */
@Module({
  imports: [
    LoggerModule.forRootAsync({
      imports: [AppConfigModule],
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) => ({
        pinoHttp: {
          level: config.logLevel,
          genReqId: (req, res) => {
            const existing = req.headers['x-correlation-id'];
            const id = typeof existing === 'string' && existing.length > 0 ? existing : randomUUID();
            res.setHeader('x-correlation-id', id);
            return id;
          },
          redact: {
            paths: [
              'req.headers.authorization',
              'req.headers.cookie',
              'req.headers["x-telegram-bot-api-secret-token"]',
              'req.body.token',
              'req.body.password',
              'req.body.secret',
              'req.body.apiKey',
              'res.headers["set-cookie"]',
            ],
            censor: '[redacted]',
          },
          autoLogging: {
            ignore: (req) => req.url === '/health' || req.url === '/health/ready',
          },
          customProps: () => ({ service: 'motaparfum-admin' }),
          transport: config.logPretty
            ? {
                target: 'pino-pretty',
                options: { singleLine: true, translateTime: 'SYS:standard' },
              }
            : undefined,
        },
      }),
    }),
  ],
  exports: [LoggerModule],
})
export class AppLoggerModule {}
