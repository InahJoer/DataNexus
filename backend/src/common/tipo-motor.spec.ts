import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { normalizeTipoMotor } from './tipo-motor.js';
import { CreateConnectionDto } from '../connections/dto/create-connection.dto.js';

describe('normalizeTipoMotor', () => {
  it.each([
    ['PostgreSQL', 'POSTGRESQL'],
    ['postgres', 'POSTGRESQL'],
    ['SQL Server', 'SQLSERVER'],
    ['SQLServer', 'SQLSERVER'],
    ['mssql', 'SQLSERVER'],
    ['Firebase', 'FIRESTORE'],
    ['Cloud Firestore', 'FIRESTORE'],
    ['MySQL', 'MYSQL'],
    ['mongo', 'MONGODB'],
  ])('normaliza "%s" a %s', (input, expected) => {
    expect(normalizeTipoMotor(input)).toBe(expected);
  });

  it('deja intactos los valores desconocidos para que la validación los rechace', () => {
    expect(normalizeTipoMotor('Oracle')).toBe('Oracle');
    expect(normalizeTipoMotor(42)).toBe(42);
  });
});

describe('CreateConnectionDto.tipoMotor', () => {
  const base = { credenciales: { host: 'db.internal', database: 'analytics', username: 'u', password: 'secret' } };

  it('acepta alias y guarda el valor canónico', () => {
    const dto = plainToInstance(CreateConnectionDto, { ...base, tipoMotor: 'SQL Server' });
    expect(validateSync(dto)).toHaveLength(0);
    expect(dto.tipoMotor).toBe('SQLSERVER');
  });

  it('rechaza motores no soportados', () => {
    const dto = plainToInstance(CreateConnectionDto, { ...base, tipoMotor: 'Oracle' });
    const errors = validateSync(dto);
    expect(errors.map((error) => error.property)).toContain('tipoMotor');
  });
});
