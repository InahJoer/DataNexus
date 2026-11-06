import { describe, expect, it } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { UpdateWorkspaceDto } from './update-workspace.dto.js';

async function errorsFor(payload: Record<string, unknown>): Promise<string[]> {
  const dto = plainToInstance(UpdateWorkspaceDto, payload);
  const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });
  return errors.map((error) => error.property);
}

describe('UpdateWorkspaceDto', () => {
  it('acepta un cambio parcial válido', async () => {
    expect(
      await errorsFor({
        nombreEmpresa: '  Acme Analytics  ',
        logoUrl: 'https://cdn.acme.com/logo.png',
        zonaHoraria: 'America/Managua',
        dominiosPermitidos: ['acme.com'],
        camposSensibles: ['cedula'],
      }),
    ).toEqual([]);
  });

  it('recorta el nombre', () => {
    expect(plainToInstance(UpdateWorkspaceDto, { nombreEmpresa: '  Acme  ' }).nombreEmpresa).toBe('Acme');
  });

  it('permite logoUrl null para eliminar el logo', async () => {
    expect(await errorsFor({ logoUrl: null })).toEqual([]);
  });

  it('rechaza null en campos obligatorios', async () => {
    expect(await errorsFor({ nombreEmpresa: null, zonaHoraria: null, dominiosPermitidos: null })).toEqual([
      'nombreEmpresa',
      'zonaHoraria',
      'dominiosPermitidos',
    ]);
  });

  it('rechaza logos que no son https', async () => {
    expect(await errorsFor({ logoUrl: 'http://cdn.acme.com/logo.png' })).toEqual(['logoUrl']);
    expect(await errorsFor({ logoUrl: 'javascript:alert(1)' })).toEqual(['logoUrl']);
  });

  it('rechaza zonas horarias desconocidas y nombres demasiado cortos', async () => {
    expect(await errorsFor({ zonaHoraria: 'Marte/Olympus', nombreEmpresa: 'A' })).toEqual([
      'nombreEmpresa',
      'zonaHoraria',
    ]);
  });

  it('rechaza listas con elementos no textuales o demasiado largas', async () => {
    expect(await errorsFor({ camposSensibles: [1, 2] })).toEqual(['camposSensibles']);
    expect(await errorsFor({ dominiosPermitidos: Array.from({ length: 51 }, (_, i) => `d${i}.com`) })).toEqual([
      'dominiosPermitidos',
    ]);
  });

  it('no permite cambiar el id del workspace ni otros campos', async () => {
    expect(await errorsFor({ id: 'otro-workspace', workspaceId: 'otro' })).toEqual(['id', 'workspaceId']);
  });
});
