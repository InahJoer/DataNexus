import { describe, expect, it, vi } from 'vitest';
import { Writable } from 'node:stream';
import { MaskingService, findRule, type SensitiveRule } from './masking.service.js';
import { DataEngineService } from '../data-engine.service.js';
import type { SensitiveFieldsService } from './sensitive-fields.service.js';
import type { AdapterRegistry } from '../adapters/adapter-registry.js';
import type { ConnectionsService } from '../../connections/connections.service.js';
import type { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface.js';
import type { CrossJoinDto } from '../dto/cross-join.dto.js';

const masking = new MaskingService();
const rules: SensitiveRule[] = [
  { campo: 'cedula', estrategia: 'FULL' },
  { campo: 'correo_personal', estrategia: 'EMAIL' },
  { campo: 'movil', estrategia: 'PHONE' },
  { campo: 'cliente_ref', estrategia: 'HASH' },
];

describe('MaskingService con campos sensibles configurados (RF-20)', () => {
  const record = {
    nombre: 'Ana',
    cedula: '001-010190-0001A',
    correo_personal: 'ana.lopez@gmail.com',
    movil: '+505 8888-1234',
    cliente_ref: 'C-1',
    total: 120,
  };

  it('aplica cada estrategia a un LECTOR y deja intactos los demás campos', () => {
    const [masked] = masking.maskDataset([record], 'LECTOR', rules);
    expect(masked).toMatchObject({
      nombre: 'Ana',
      cedula: '********',
      correo_personal: '***@gmail.com',
      movil: '******34',
      total: 120,
    });
    expect(masked.cliente_ref).toMatch(/^hash:[0-9a-f]{16}$/);
  });

  it('HASH es estable: el mismo valor da la misma huella (se puede agrupar) y otro valor, otra', () => {
    const hash = (value: string) => masking.maskDataset([{ cliente_ref: value }], 'LECTOR', rules)[0].cliente_ref;
    expect(hash('C-1')).toBe(hash('C-1'));
    expect(hash('C-1')).not.toBe(hash('C-2'));
    expect(hash('C-1')).not.toContain('C-1');
  });

  it('ADMIN y OPERADOR reciben los valores reales', () => {
    expect(masking.maskDataset([record], 'ADMIN', rules)[0]).toEqual(record);
    expect(masking.maskDataset([record], 'OPERADOR', rules)[0]).toEqual(record);
  });

  it('reconoce columnas calificadas por el cross-join, sin distinguir mayúsculas, y campos anidados', () => {
    const [masked] = masking.maskDataset(
      [{ 'clientes.Cedula': '001', 'sql.cedula': '002', perfil: { cedula: '003', ciudad: 'León' }, cedulas: 'x' }],
      'LECTOR',
      rules,
    );
    expect(masked).toEqual({ 'clientes.Cedula': '********', 'sql.cedula': '********', perfil: { cedula: '********', ciudad: 'León' }, cedulas: 'x' });
  });

  it('un objeto o lista marcado como sensible se oculta entero', () => {
    const [masked] = masking.maskDataset([{ cedula: { numero: '001', pais: 'NI' } }], 'LECTOR', rules);
    expect(masked.cedula).toBe('********');
  });

  it('la regla manda sobre las heurísticas y se informa en isValueMasked', () => {
    expect(findRule('Clientes.CEDULA', rules)?.estrategia).toBe('FULL');
    expect(masking.isValueMasked('cedula', '001', 'LECTOR', rules)).toBe(true);
    expect(masking.isValueMasked('cedula', '001', 'LECTOR')).toBe(false);
    expect(masking.isValueMasked('cedula', '001', 'ADMIN', rules)).toBe(false);
  });
});

describe('Criterio de aceptación: un LECTOR nunca recibe un campo sensible, en ningún endpoint', () => {
  const SQL = 'a1b2c3d4-e5f6-4a8b-9c0d-1e2f3a4b5c6d';
  const NOSQL = 'b2c3d4e5-f6a7-4b9c-8d1e-2f3a4b5c6d7e';
  const SECRET = '001-010190-0001A';
  const clientes = [
    { id: 1, nombre: 'Ana', cedula: SECRET, segmento: 'A', saldo: 10 },
    { id: 2, nombre: 'Luis', cedula: '002-020290-0002B', segmento: 'B', saldo: 20 },
  ];
  const pedidos = [
    { cliente_id: 1, total: 120 },
    { cliente_id: 2, total: 50 },
  ];
  const base = {
    conexionSqlId: SQL,
    conexionNoSqlId: NOSQL,
    tablaSql: 'clientes',
    coleccionNoSql: 'pedidos',
    llaveSql: 'id',
    llaveNoSql: 'cliente_id',
  };
  const payload = base as CrossJoinDto;

  const setup = () => {
    const adapter = {
      tipoMotor: 'POSTGRESQL',
      capabilities: { explore: true, fields: true, extract: true },
      extract: vi.fn(async (_c: unknown, entity: string) => (entity === 'clientes' ? clientes : pedidos)),
      readPage: vi.fn(async () => ({ rows: clientes, orderBy: ['id'], lastKey: null })),
    };
    const rulesFor = vi.fn(async () => [{ campo: 'cedula', estrategia: 'FULL' as const }]);
    const engine = new DataEngineService(
      {
        getConnectionForExploration: async (id: string) => ({ id, tipoMotor: 'POSTGRESQL', dbName: 'd', connectionString: 's' }),
      } as unknown as ConnectionsService,
      { get: () => adapter } as unknown as AdapterRegistry,
      undefined,
      undefined,
      undefined,
      { rulesFor } as unknown as SensitiveFieldsService,
    );
    return { engine, rulesFor };
  };
  const user = (role: string) => ({ id: 'u', email: 'u@corp.com', name: 'U', role, workspaceId: 'ws-1' }) as AuthenticatedUser;
  const leaks = (value: unknown) => JSON.stringify(value).includes(SECRET);

  it('POST /engine/join', async () => {
    const { engine, rulesFor } = setup();
    expect(leaks(await engine.executeCrossJoin(payload, user('LECTOR')))).toBe(false);
    expect(rulesFor).toHaveBeenCalledWith('ws-1', [
      { conexionId: SQL, entidad: 'clientes' },
      { conexionId: NOSQL, entidad: 'pedidos' },
    ]);
    // ADMIN recibe el valor real y ni siquiera se consultan las reglas.
    const admin = setup();
    expect(leaks(await admin.engine.executeCrossJoin(payload, user('ADMIN')))).toBe(true);
    expect(admin.rulesFor).not.toHaveBeenCalled();
  });

  it('POST /engine/join con groupBy y métricas sobre el campo sensible', async () => {
    const { engine } = setup();
    const grouped = await engine.executeCrossJoin(
      { ...base, groupBy: ['cedula'], aggregations: [{ operation: 'COUNT', field: 'cedula', as: 'n' }] } as CrossJoinDto,
      user('LECTOR'),
    );
    expect(leaks(grouped)).toBe(false);
  });

  it('POST /engine/export (JSON)', async () => {
    const { engine } = setup();
    const file = await engine.executeCrossJoinForExport({ ...base, format: 'json' } as never, user('AUDITOR'));
    expect(file.buffer.toString('utf8')).not.toContain(SECRET);
  });

  it('reportes programados (exportación por stream a Excel)', async () => {
    const { engine } = setup();
    const chunks: Buffer[] = [];
    const sink = new Writable({
      write(chunk, _encoding, done) {
        chunks.push(Buffer.from(chunk));
        done();
      },
    });
    await engine.executeCrossJoinToStream({ ...base, format: 'excel' } as never, user('LECTOR'), sink);
    const { default: ExcelJS } = await import('exceljs');
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(Buffer.concat(chunks) as never);
    const values: unknown[] = [];
    workbook.eachSheet((sheet) => sheet.eachRow((row) => values.push(row.values)));
    expect(leaks(values)).toBe(false);
  });

  it('POST /engine/jobs (join asíncrono)', async () => {
    const { engine } = setup();
    expect(leaks(await engine.runCrossJoinJob(payload, user('LECTOR')))).toBe(false);
  });

  it('GET /engine/connections/:id/data (exploración paginada)', async () => {
    const { engine, rulesFor } = setup();
    expect(leaks(await engine.browseData(user('LECTOR'), SQL, { entidad: 'clientes', limite: 50 }))).toBe(false);
    expect(rulesFor).toHaveBeenCalledWith('ws-1', [{ conexionId: SQL, entidad: 'clientes' }]);
  });

  it('si no se pueden leer las reglas, la petición falla en lugar de devolver datos sin enmascarar', async () => {
    const { engine, rulesFor } = setup();
    rulesFor.mockRejectedValueOnce(new Error('db caída'));
    await expect(engine.executeCrossJoin(payload, user('LECTOR'))).rejects.toThrow();
  });
});
