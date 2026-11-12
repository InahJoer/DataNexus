import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import bcrypt from 'bcrypt';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { AppModule } from '../../src/app.module.js';
import { configureApp } from '../../src/app.setup.js';
import type { UserRole } from '../../src/auth/interfaces/user-role.js';
import { PrismaService } from '../../src/prisma/prisma.service.js';

export const E2E_PASSWORD = 'E2e#Segura2026dn';

export interface E2eApp {
  app: INestApplication<App>;
  prisma: PrismaService;
  http: () => ReturnType<typeof request>;
  close: () => Promise<void>;
}

/** Levanta la API completa con la misma configuración HTTP que main.ts (helmet, límites, filtros). */
export async function createE2eApp(env: NodeJS.ProcessEnv = process.env): Promise<E2eApp> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({ logger: ['error', 'fatal'] });
  configureApp(app, env);
  await app.init();
  const prisma = app.get(PrismaService);
  return {
    app: app as unknown as INestApplication<App>,
    prisma,
    http: () => request(app.getHttpServer() as App),
    close: () => app.close(),
  };
}

export interface E2eUser {
  id: string;
  email: string;
  role: UserRole;
  token: string;
  refreshToken: string;
}

export type RoleUsers = Record<UserRole, E2eUser>;

export interface E2eWorkspace {
  id: string;
  users: RoleUsers;
}

const ROLES: UserRole[] = ['ADMIN', 'OPERADOR', 'LECTOR', 'AUDITOR'];

/** Inicia sesión por la API y devuelve los tokens. */
export async function login(ctx: E2eApp, email: string, password = E2E_PASSWORD) {
  const response = await ctx.http().post('/auth/login').send({ email, password });
  if (response.status !== 200 && response.status !== 201) {
    throw new Error(`Login de ${email} falló con ${response.status}: ${JSON.stringify(response.body)}`);
  }
  return { token: response.body.access_token as string, refreshToken: response.body.refresh_token as string, body: response.body };
}

/**
 * Crea una organización con un usuario de cada rol (ADMIN, OPERADOR, LECTOR, AUDITOR) e inicia sesión con todos.
 * Los usuarios se insertan directamente: las altas por API se prueban en auth.e2e-spec.ts.
 */
export async function seedWorkspace(ctx: E2eApp, label: string): Promise<E2eWorkspace> {
  const domain = `${label.toLowerCase()}-${Date.now().toString(36)}.e2e.io`;
  const workspace = await ctx.prisma.workspace.create({
    data: { nombreEmpresa: `Empresa ${label}`, tipoCuenta: 'ORGANIZACION', dominiosPermitidos: [domain] },
  });
  const password = await bcrypt.hash(E2E_PASSWORD, 10);
  const users = {} as RoleUsers;
  for (const role of ROLES) {
    const email = `${role.toLowerCase()}@${domain}`;
    const user = await ctx.prisma.user.create({
      data: { email, name: `${role} ${label}`, password, role, workspaceId: workspace.id },
    });
    const tokens = await login(ctx, email);
    users[role] = { id: user.id, email, role, token: tokens.token, refreshToken: tokens.refreshToken };
  }
  return { id: workspace.id, users };
}

export const bearer = (user: { token: string }) => ({ Authorization: `Bearer ${user.token}` });
