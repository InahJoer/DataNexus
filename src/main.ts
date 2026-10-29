import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Validación global de DTOs
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  // Configuración de CORS estricto (Issue #6)
  const allowedOrigins = [
    'http://localhost:3000',
    'http://localhost:3001',
    process.env.FRONTEND_URL,
  ].filter((origin): origin is string => Boolean(origin));

  app.enableCors({
    origin: (
      origin: string | undefined,
      callback: (err: Error | null, allow?: boolean) => void,
    ) => {
      // Permitir herramientas locales/servidor sin encabezado origin o dominios autorizados
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error(`CORS bloqueado para el origen: ${origin}`));
      }
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Accept'],
  });

  const config = new DocumentBuilder()
    .setTitle('DataNexus API')
    .setDescription('Plataforma Unificada de Gestión de Datos Mixtas y Business Intelligence')
    .setVersion('1.2.0')
    .addTag('Auth', 'Autenticación y generación de tokens JWT')
    .addTag('Connections', 'Gestión y administración de conexiones DB encriptadas con AES-256')
    .addTag('Users', 'Gestión de usuarios y roles dentro del workspace')
    .addTag('Engine - Cross-Join & Analytics', 'Motor de Cross-Joins en memoria, enmascaramiento y exportación')
    .addTag('Audit', 'Bitácora y consulta de logs de auditoría con paginación y filtros')
    .addTag('Reports - Automation', 'Automatización de reportes periódicos y despacho por correo electrónico')
    .addBearerAuth()
    .build();

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api/docs', app, document);

  const port = process.env.PORT ?? 3000;
  await app.listen(port);
  console.log(`Application is running on: http://localhost:${port}`);
  console.log(`Swagger documentation available at: http://localhost:${port}/api/docs`);
}
await bootstrap();
