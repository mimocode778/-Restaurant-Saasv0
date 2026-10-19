import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';
import { configure } from './app.setup.js';
import { assertSafeConfig } from './config.js';

async function bootstrap() {
  // Stops right away, with a clear message, if a production setting is missing or unsafe.
  assertSafeConfig();
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bodyParser: false });
  configure(app);
  app.enableShutdownHooks();
  await app.listen(process.env.PORT ?? 3000);
}
await bootstrap();
