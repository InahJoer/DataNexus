import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { REPORT_FORMATS } from '../../data-engine/dto/cross-join.dto.js';
import {
  CreateScheduledReportDto,
  SCHEDULED_REPORT_FORMATS,
  UpdateScheduledReportDto,
} from './scheduled-report.dto.js';

/** Misma configuración que main.ts. */
const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
const body = (metatype: new () => object, value: unknown) => pipe.transform(value, { type: 'body', metatype });

const schedule = {
  savedQueryId: 'c3d4e5f6-a7b8-4c9d-8e1f-3a4b5c6d7e8f',
  reportTitle: 'Ventas diarias',
  frequency: 'daily',
  time: '08:00',
};

describe('Formatos de los reportes programados', () => {
  it('acepta Word (.docx, RF-21) al crear y al editar una programación', async () => {
    await expect(body(CreateScheduledReportDto, { ...schedule, format: 'word' })).resolves.toMatchObject({
      format: 'word',
    });
    await expect(body(UpdateScheduledReportDto, { format: 'word' })).resolves.toMatchObject({ format: 'word' });
  });

  it.each(['docx', 'WORD', 'csv'])('rechaza el formato %s', async (format) => {
    await expect(body(CreateScheduledReportDto, { ...schedule, format })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('ofrece todos los formatos que el motor genera en streaming', () => {
    for (const format of REPORT_FORMATS) expect(SCHEDULED_REPORT_FORMATS).toContain(format);
  });
});
