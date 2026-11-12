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
  // Subidas grandes (Excel de cientos de MB): el cuerpo puede tardar más que los 5 minutos que Node permite por defecto.
  const server = app.getHttpServer() as { requestTimeout: number };
  server.requestTimeout = Number(process.env.HTTP_REQUEST_TIMEOUT_MS) || 60 * 60 * 1000;
  const logger = new Logger('Bootstrap');
  logger.log(`Application is running on: http://localhost:${port}`);
  logger.log(`Swagger documentation available at: http://localhost:${port}/api/docs`);
}
await bootstrap();
