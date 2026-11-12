import { readFileSync } from 'node:fs';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import type { ConfigService } from '@nestjs/config';
import type { TipoMotor } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { EncryptionService } from '../src/common/encryption/encryption.service.js';
import {
  describeCredentials,
  parseStoredCredentials,
  validateCredentials,
} from '../src/connections/credentials/connection-credentials.js';
import { CrossJoinDto } from '../src/data-engine/dto/cross-join.dto.js';
import { validateJoinPlan } from '../src/data-engine/join/join-plan.js';
import {
  DEMO_CONNECTION_IDS,
  demoConnections,
  demoSavedQueries,
  encryptLikeEncryptionService,
} from './seed-demo.js';

const encryptionWith = (key: string) => new EncryptionService({ get: () => key } as unknown as ConfigService);

describe('seed de la demo (issue #49)', () => {
  it.each([
    ['hex de 64', '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'],
    ['32 bytes', 'clave-de-32-bytes-exactos-demo!!'],
    ['frase', 'cualquier frase se deriva con sha-256'],
  ])('EncryptionService descifra lo que cifra el seed (clave %s)', (_label, key) => {
    const text = JSON.stringify({ v: 2, tipoMotor: 'MYSQL', credentials: { password: 'ñandú' } });
    expect(encryptionWith(key).decrypt(encryptLikeEncryptionService(text, key))).toBe(text);
  });

  it('registra una conexión por motor con credenciales válidas y metadatos coherentes', async () => {
    const connections = demoConnections({});
    expect(connections.map((c) => c.tipoMotor).sort()).toEqual(['FIRESTORE', 'MONGODB', 'MYSQL', 'POSTGRESQL', 'SQLSERVER']);

    for (const connection of connections) {
      const credentials = await validateCredentials(connection.tipoMotor, connection.credentials);
      const metadata = describeCredentials(connection.tipoMotor, credentials);
      expect(metadata).toEqual({ host: connection.host, dbName: connection.dbName, detalles: connection.detalles });
      expect(JSON.stringify(connection.detalles)).not.toMatch(/password|private_key/i);

      const stored = JSON.stringify({ v: 2, tipoMotor: connection.tipoMotor, credentials });
      expect(parseStoredCredentials(stored)?.tipoMotor).toBe(connection.tipoMotor);
    }
  });

  it('usa los servicios de docker-compose por defecto y los puertos publicados con DEMO_SOURCES_HOST', () => {
    const byEngine = (env: Record<string, string>) =>
      Object.fromEntries(demoConnections(env).map((c) => [c.tipoMotor, c])) as Record<TipoMotor, ReturnType<typeof demoConnections>[number]>;

    const inDocker = byEngine({});
    expect(inDocker.SQLSERVER.host).toBe('sqlserver');
    expect(inDocker.POSTGRESQL.credentials).toMatchObject({ host: 'postgres-demo', port: 5432 });

    const fromHost = byEngine({ DEMO_SOURCES_HOST: 'localhost' });
    expect(fromHost.POSTGRESQL.credentials).toMatchObject({ host: 'localhost', port: 5433 });
    expect(fromHost.MONGODB.credentials).toMatchObject({ uri: 'mongodb://localhost:27017/?directConnection=true' });
  });

  it('las consultas guardadas son cuerpos válidos de POST /engine/join', async () => {
    const ids = new Set<string>(Object.values(DEMO_CONNECTION_IDS));
    for (const query of demoSavedQueries()) {
      const dto = plainToInstance(CrossJoinDto, query.definicion);
      expect(await validate(dto), query.nombre).toEqual([]);
      expect(() => validateJoinPlan(dto.fuentes!, dto.relaciones!)).not.toThrow();
      for (const fuente of dto.fuentes!) expect(ids.has(fuente.conexionId)).toBe(true);
    }
  });

  it('los tickets de Firestore apuntan a clientes que existen en SQL Server', () => {
    const tickets = JSON.parse(readFileSync(new URL('./demo/firestore-tickets.json', import.meta.url), 'utf8')) as {
      id: string;
      cliente_id: number;
    }[];
    const clientes = readFileSync(new URL('../../docker/demo/sqlserver-init.sql', import.meta.url), 'utf8').match(/^\s+\((\d+), N'/gm) ?? [];
    expect(clientes).toHaveLength(24);
    expect(tickets.length).toBeGreaterThan(0);
    expect(new Set(tickets.map((t) => t.id)).size).toBe(tickets.length);
    for (const ticket of tickets) {
      expect(ticket.cliente_id).toBeGreaterThanOrEqual(1);
      expect(ticket.cliente_id).toBeLessThanOrEqual(24);
    }
  });
});
