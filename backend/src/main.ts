import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';
import { configureApp, setupSwagger } from './app.setup.js';
import { createAppLogger } from './observability/app-logger.js';

async function bootstrap() {
  // bufferLogs: los mensajes del arranque salen ya con el logger estructurado (issue #51).
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: createAppLogger(),
    bufferLogs: true,
  });

  configureApp(app);
  setupSwagger(app);

  const port = process.env.PORT ?? 3001;
  await app.listen(port);
  const logger = new Logger('Bootstrap');
  logger.log(`Application is running on: http://localhost:${port}`);
  logger.log(`Swagger documentation available at: http://localhost:${port}/api/docs`);
}
await bootstrap();
