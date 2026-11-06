import { describe, expect, it } from 'vitest';
import { renderEmail, renderEmailLayout } from './email-layout.js';
import { renderInvitationEmail } from './invitation.template.js';
import { renderPasswordResetEmail } from './password-reset.template.js';
import { renderReportEmail } from '../../reports/templates/report-email.template.js';
import { renderReportFailureEmail } from '../../reports/templates/report-failure-email.template.js';

describe('Layout común de correos (issue #39)', () => {
  it('escapa todo el contenido variable', () => {
    const html = renderEmailLayout({
      title: 'Hola <b>',
      preheader: 'pre "x"',
      eyebrow: 'Eyebrow & co',
      paragraphs: ['<script>alert(1)</script>'],
      details: [{ label: 'Archivo', value: '<img src=x onerror=1>' }],
      action: { label: 'Ver <ahora>', url: 'https://app.acme.com/x?a=1&b=2' },
    });

    expect(html).not.toMatch(/<script>|<img |<b>|<ahora>/);
    expect(html).toContain('Hola &lt;b&gt;');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('href="https://app.acme.com/x?a=1&amp;b=2"');
    expect(html).toContain('Eyebrow &amp; co');
  });

  it.each(['javascript:alert(1)', 'ftp://acme.com/x', 'https://user:clave@acme.com/x'])(
    'rechaza el enlace inseguro %s',
    (url) => {
      expect(() => renderEmailLayout({ title: 't', paragraphs: [], action: { label: 'x', url } })).toThrow(
        'La URL del correo no es válida',
      );
    },
  );

  it('genera la versión de texto con los mismos datos', () => {
    const email = renderEmail('Asunto', {
      title: 'Título',
      paragraphs: ['Uno', 'Dos'],
      details: [{ label: 'Filas', value: '42' }],
      action: { label: 'Abrir', url: 'https://acme.com/a' },
      footnote: 'Nota',
    });

    expect(email.subject).toBe('Asunto');
    expect(email.text).toBe(
      ['Título', '', 'Uno', '', 'Dos', '', 'Filas: 42', '', 'Abrir: https://acme.com/a', '', 'Nota', '', '— Equipo DataNexus'].join('\n'),
    );
  });

  it('las cuatro plantillas comparten el mismo layout', () => {
    const emails = [
      renderInvitationEmail({
        name: 'Ana', inviterName: 'Luis', workspaceName: 'Acme', roleLabel: 'Lector',
        acceptUrl: 'https://acme.com/i', expiresInHours: 72,
      }),
      renderPasswordResetEmail({ name: 'Ana', resetUrl: 'https://acme.com/r', expiresInMinutes: 30 }),
      renderReportEmail({
        reportTitle: 'Ventas', customMessage: 'Hola', filename: 'datanexus_export_1.pdf', fileSizeBytes: 2048,
        fileSizeLabel: '2.00 KB', generatedAt: 'hoy', expiresAt: 'mañana', downloadUrl: 'https://acme.com/d',
      }),
      renderReportFailureEmail({
        authorName: 'Ana', reportTitle: 'Ventas', error: 'No se pudo generar', attempts: 3, failedAt: 'hoy',
      }),
    ];

    for (const email of emails) {
      expect(email.html).toContain('<!doctype html>');
      expect(email.html).toContain('DATANEXUS');
      expect(email.html).toContain('Correo automático de DataNexus Platform');
      expect(email.text).toContain('— Equipo DataNexus');
    }
  });

  it('el aviso de fallo usa el tono de alerta e incluye motivo e intentos', () => {
    const email = renderReportFailureEmail({
      authorName: 'Ana',
      reportTitle: 'Ventas <diarias>',
      error: 'El reporte se generó, pero falló la entrega por correo.',
      attempts: 3,
      failedAt: '6 de noviembre de 2026, 8:00',
    });

    expect(email.subject).toBe('[DataNexus] Falló el reporte "Ventas <diarias>"');
    expect(email.html).toContain('#b42318');
    expect(email.html).toContain('Ventas &lt;diarias&gt;');
    expect(email.text).toContain('falló después de 3 intentos');
    expect(email.text).toContain('Motivo: El reporte se generó, pero falló la entrega por correo.');
  });

  it('el correo del reporte conserva asunto, archivo, tamaño y enlace', () => {
    const email = renderReportEmail({
      reportTitle: 'Ventas', customMessage: 'Adjunto', filename: 'datanexus_export_1.xlsx', fileSizeBytes: 2048,
      fileSizeLabel: '2.00 KB', generatedAt: 'hoy', expiresAt: 'mañana', downloadUrl: 'https://acme.com/d?s=1',
    });

    expect(email.subject).toBe('[DataNexus] Ventas');
    expect(email.html).toContain('href="https://acme.com/d?s=1"');
    expect(email.text).toContain('Tamaño: 2.00 KB (2048 bytes)');
    expect(email.text).toContain('Este enlace seguro vence el mañana.');
  });
});
