import { Suspense } from 'react';
import { AuthLayout } from '@/components/auth/auth-layout';
import { AcceptInviteForm } from './accept-invite-form';

export default function AcceptInvitePage() {
  return (
    <AuthLayout>
      <Suspense fallback={<p className="auth-loading">Cargando invitación…</p>}>
        <AcceptInviteForm />
      </Suspense>
    </AuthLayout>
  );
}
