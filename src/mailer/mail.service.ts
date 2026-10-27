import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import nodemailer, { type Transporter } from 'nodemailer';

export interface EmailAttachment {
  filename: string;
  content: Buffer;
  contentType?: string;
}

export interface SendMailOptions {
  to: string | string[];
  subject: string;
  text?: string;
  html?: string;
  attachments?: EmailAttachment[];
}

export interface SendMailResult {
  messageId: string;
  accepted: string[];
  rejected: string[];
}

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private transporter: Transporter;

  constructor(private readonly configService: ConfigService) {
    const host = this.configService.get<string>('SMTP_HOST');
    const port = this.configService.get<number>('SMTP_PORT', 587);
    const user = this.configService.get<string>('SMTP_USER');
    const pass = this.configService.get<string>('SMTP_PASS');

    if (host && user && pass) {
      this.transporter = nodemailer.createTransport({
        host,
        port,
        secure: port === 465,
        auth: { user, pass },
      });
      this.logger.log(`Transporter SMTP configurado hacia ${host}:${port}`);
    } else {
      // Mock / Stream transporter para entornos locales y tests
      this.transporter = nodemailer.createTransport({
        streamTransport: true,
        newline: 'windows',
        buffer: true,
      });
      this.logger.log('Transporter SMTP simulado en memoria inicializado');
    }
  }

  async sendReportEmail(options: SendMailOptions): Promise<SendMailResult> {
    const from =
      this.configService.get<string>('MAIL_FROM') ?? 'DataNexus <no-reply@datanexus.io>';
    const recipients = Array.isArray(options.to) ? options.to.join(', ') : options.to;

    this.logger.log(`Enviando reporte por correo a: ${recipients} | Asunto: ${options.subject}`);

    const mailOptions = {
      from,
      to: options.to,
      subject: options.subject,
      text: options.text ?? 'Adjunto se encuentra el reporte automático de DataNexus.',
      html:
        options.html ??
        `<div style="font-family: sans-serif; color: #1F4E78;">
          <h2>Reporte Automático DataNexus</h2>
          <p>Se ha generado un nuevo reporte consolidado de datos.</p>
          <p>Revisa el archivo adjunto para más detalles.</p>
        </div>`,
      attachments: options.attachments?.map((att) => ({
        filename: att.filename,
        content: att.content,
        contentType: att.contentType,
      })),
    };

    const info = await this.transporter.sendMail(mailOptions);
    this.logger.log(`Correo enviado exitosamente. ID: ${info.messageId}`);

    return {
      messageId: info.messageId,
      accepted: (info.accepted as string[]) ?? [recipients],
      rejected: (info.rejected as string[]) ?? [],
    };
  }

  // Método auxiliar para testing e inyección de transportes
  setTransporter(customTransporter: Transporter) {
    this.transporter = customTransporter;
  }
}
