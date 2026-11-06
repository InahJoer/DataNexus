import { describe, expect, it } from 'vitest';
import { renderInvitationEmail } from './invitation.template.js';

describe('renderInvitationEmail', () => {
  const data = {
    name: 'María <script>',
    inviterName: 'Ana "Admin"',
    workspaceName: 'Acme & Co',
    roleLabel: 'Lector',
    acceptUrl: 'https://app.acme.com/accept-invite?token=abc_DEF-123',
    expiresInHours: 72,
  };

  it('incluye el enlace, el workspace, el rol y el vencimiento en texto plano', () => {
    const email = renderInvitationEmail(data);
    expect(email.subject).toBe('Invitación a Acme & Co en DataNexus');
    expect(email.text).toContain(data.acceptUrl);
    expect(email.text).toContain('Acme & Co');
    expect(email.text).toContain('rol Lector');
    expect(email.text).toContain('72 horas');
  });

  it('escapa el HTML de los datos variables', () => {
    const { html } = renderInvitationEmail(data);
    expect(html).not.toContain('<script>');
    expect(html).toContain('María &lt;script&gt;');
    expect(html).toContain('Ana &quot;Admin&quot;');
    expect(html).toContain('Acme &amp; Co');
    expect(html).toContain('href="https://app.acme.com/accept-invite?token=abc_DEF-123"');
  });
});
