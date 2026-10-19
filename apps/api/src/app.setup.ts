import type { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import { allowedOrigins, isProduction, trustedProxyHops } from './config.js';

export function configure(app: NestExpressApplication): void {
  // Behind the HTTPS proxy, use the visitor's real address (for attempt limits and history).
  app.set('trust proxy', trustedProxyHops());
  // Standard browser protections (no framing by other sites, no content sniffing, HTTPS only...).
  app.use(helmet({ hsts: isProduction() ? { maxAge: 31_536_000, includeSubDomains: true } : false }));
  // Only our own websites may call the API from a browser, cookies included.
  app.enableCors({
    origin: allowedOrigins(),
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: ['content-type', 'authorization', 'x-device-token'],
    maxAge: 600,
  });
  // Requests larger than this are refused (protects against memory abuse).
  app.useBodyParser('json', { limit: '100kb' });
}
