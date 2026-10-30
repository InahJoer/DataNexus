import { describe, expect, it, vi, beforeEach } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { MailService } from './mail.service.js';

describe('MailService', () => {
  let service: MailService;
  let configService: ConfigService;

  beforeEach(() => {
    configService = {
      get: vi.fn().mockImplementation((key: string, defaultValue?: any) => {
        if (key === 'MAIL_FROM') return 'DataNexus <no-reply@datanexus.io>';
        return defaultValue;
      }),
    } as unknown as ConfigService;

    service = new MailService(configService);
  });

  it('sends report email using mock transporter and returns messageId and accepted list', async () => {
    const mockTransporter = {
      sendMail: vi.fn().mockResolvedValue({
        messageId: 'msg-12345',
        accepted: ['analyst@corp.com'],
        rejected: [],
      }),
    };
    service.setTransporter(mockTransporter as any);

    const result = await service.sendReportEmail({
      to: 'analyst@corp.com',
      subject: 'Reporte Semanal',
      text: 'Texto plano',
      attachments: [
        {
          filename: 'reporte.xlsx',
          content: Buffer.from('test-content'),
          contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        },
      ],
    });

    expect(mockTransporter.sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        from: 'DataNexus <no-reply@datanexus.io>',
        to: 'analyst@corp.com',
        subject: 'Reporte Semanal',
        attachments: [
          {
            filename: 'reporte.xlsx',
            content: Buffer.from('test-content'),
            contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          },
        ],
      }),
    );
    expect(result.messageId).toBe('msg-12345');
    expect(result.accepted).toContain('analyst@corp.com');
  });
});
