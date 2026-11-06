import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import { SensitiveFieldsService } from './sensitive-fields.service.js';
import type { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface.js';

/** CRUD y alcance de los campos sensibles contra PostgreSQL real (issue #34). */
describe.skipIf(!process.env.DATABASE_URL)('SensitiveFieldsService con PostgreSQL real', () => {
  const prisma = new PrismaService();
  const service = new SensitiveFieldsService(prisma);
  const marker = `sensibles-${Date.now()}`;
  let admin: AuthenticatedUser;
  let other: AuthenticatedUser;
  let crm = '';
  let erp = '';

  beforeAll(async () => {
    await prisma.$connect();
    const ws = await prisma.workspace.create({ data: { nombreEmpresa: marker, camposSensibles: ['salario'] } });
    const ws2 = await prisma.workspace.create({ data: { nombreEmpresa: `${marker}-2` } });
    const connection = (nombre: string, workspaceId: string) =>
      prisma.conexionDB.create({
        data: { nombre, tipoMotor: 'POSTGRESQL', host: 'h', dbName: 'd', connectionStringEncriptada: 'x', workspaceId },
      });
    crm = (await connection('CRM', ws.id)).id;
    erp = (await connection('ERP', ws.id)).id;
    admin = { id: 'a', email: 'admin@corp.com', name: 'A', role: 'ADMIN', workspaceId: ws.id } as AuthenticatedUser;
    other = { id: 'b', email: 'otro@corp.com', name: 'B', role: 'ADMIN', workspaceId: ws2.id } as AuthenticatedUser;
  });

  afterAll(async () => {
    await prisma.workspace.deleteMany({ where: { nombreEmpresa: { startsWith: marker } } });
    await prisma.$disconnect();
  });

  it('crea reglas con distintos alcances y rechaza duplicados', async () => {
    const global = await service.create(admin, { campo: '  Cedula ', estrategia: 'FULL' });
    expect(global).toMatchObject({ campo: 'cedula', conexionId: null, entidad: null, estrategia: 'FULL', creadoPor: 'admin@corp.com' });
    await service.create(admin, { campo: 'telefono', estrategia: 'PHONE', conexionId: crm });
    await service.create(admin, { campo: 'correo', estrategia: 'EMAIL', conexionId: erp, entidad: 'empleados' });
    await expect(service.create(admin, { campo: 'cedula' })).rejects.toBeInstanceOf(ConflictException);
    expect(await service.list(admin)).toHaveLength(3);
  });

  it('no admite conexiones de otro workspace ni ve sus reglas', async () => {
    await expect(service.create(other, { campo: 'x', conexionId: crm })).rejects.toBeInstanceOf(NotFoundException);
    expect(await service.list(other)).toEqual([]);
    const [rule] = await service.list(admin);
    await expect(service.remove(other, rule.id)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rulesFor aplica solo las reglas cuyo alcance coincide, más los campos por defecto del workspace', async () => {
    const fields = async (sources: { conexionId: string; entidad: string }[]) =>
      (await service.rulesFor(admin.workspaceId, sources)).map((rule) => `${rule.campo}:${rule.estrategia}`).sort();

    expect(await fields([{ conexionId: crm, entidad: 'clientes' }])).toEqual(['cedula:FULL', 'salario:FULL', 'telefono:PHONE']);
    expect(await fields([{ conexionId: erp, entidad: 'clientes' }])).toEqual(['cedula:FULL', 'salario:FULL']);
    expect(await fields([{ conexionId: erp, entidad: 'Empleados' }])).toEqual(['cedula:FULL', 'correo:EMAIL', 'salario:FULL']);
    // En un cruce, se suman las reglas de todas las fuentes.
    expect(await fields([{ conexionId: crm, entidad: 'clientes' }, { conexionId: erp, entidad: 'empleados' }])).toEqual([
      'cedula:FULL',
      'correo:EMAIL',
      'salario:FULL',
      'telefono:PHONE',
    ]);
  });

  it('elimina reglas del propio workspace', async () => {
    const [rule] = await service.list(admin);
    await service.remove(admin, rule.id);
    expect(await service.list(admin)).toHaveLength(2);
  });
});
