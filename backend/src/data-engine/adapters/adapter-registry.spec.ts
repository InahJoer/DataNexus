import { describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { AdapterRegistry } from './adapter-registry.js';
import type { IDataSourceAdapter } from './data-source-adapter.interface.js';
import { ADAPTER_PROVIDERS } from './adapter-providers.js';
import { DataEngineModule } from '../data-engine.module.js';
import { DataEngineService } from '../data-engine.service.js';
import { DataSourcePoolModule } from '../pool/data-source-pool.module.js';
import { DataSourceClientPool } from '../pool/data-source-client-pool.js';
import { MaskingService } from '../masking/masking.service.js';
import { ExportService } from '../export/export.service.js';
import { ConnectionsService } from '../../connections/connections.service.js';

const adapter = (tipoMotor: IDataSourceAdapter['tipoMotor']): IDataSourceAdapter => ({
  tipoMotor,
  capabilities: { explore: true, fields: true, extract: false },
  listObjects: async () => [],
  listFields: async () => [],
  extract: async () => [],
});

describe('AdapterRegistry', () => {
  it('resuelve el adaptador por motor aceptando alias', () => {
    const postgres = adapter('POSTGRESQL');
    const sqlServer = adapter('SQLSERVER');
    const registry = new AdapterRegistry([postgres, sqlServer]);
    expect(registry.get('postgres')).toBe(postgres);
    expect(registry.get('PostgreSQL')).toBe(postgres);
    expect(registry.get('SQL Server')).toBe(sqlServer);
    expect(registry.get('mssql')).toBe(sqlServer);
  });

  it('devuelve undefined para motores sin adaptador o desconocidos', () => {
    const registry = new AdapterRegistry([adapter('POSTGRESQL')]);
    expect(registry.get('MONGODB')).toBeUndefined();
    expect(registry.get('Oracle')).toBeUndefined();
    expect(registry.get('')).toBeUndefined();
  });

  it('rechaza dos adaptadores para el mismo motor', () => {
    expect(() => new AdapterRegistry([adapter('MYSQL'), adapter('MYSQL')])).toThrow(/duplicado/);
  });

  it('Nest resuelve el pool, los cinco adaptadores, el registro y DataEngineService', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [DataSourcePoolModule],
      providers: [
        ...ADAPTER_PROVIDERS,
        DataEngineService,
        MaskingService,
        ExportService,
        { provide: ConnectionsService, useValue: {} },
      ],
    }).compile();

    expect(moduleRef.get(AdapterRegistry).supported()).toEqual([
      { tipoMotor: 'POSTGRESQL', explore: true, fields: true, extract: true },
      { tipoMotor: 'MYSQL', explore: true, fields: true, extract: true },
      { tipoMotor: 'SQLSERVER', explore: true, fields: true, extract: true },
      { tipoMotor: 'FIRESTORE', explore: true, fields: true, extract: true },
      { tipoMotor: 'MONGODB', explore: true, fields: true, extract: true },
    ]);
    expect(moduleRef.get(DataEngineService)).toBeInstanceOf(DataEngineService);
    expect(moduleRef.get(DataSourceClientPool)).toBeInstanceOf(DataSourceClientPool);
    await moduleRef.close();
  });

  it('DataEngineModule usa los proveedores de adapter-providers', () => {
    const providers = Reflect.getMetadata('providers', DataEngineModule) as unknown[];
    for (const provider of ADAPTER_PROVIDERS) expect(providers).toContain(provider);
  });
});
