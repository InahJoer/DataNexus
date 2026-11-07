import { Suspense } from 'react';
import { AuthLayout } from '@/components/auth/auth-layout';
import { ResetPasswordForm } from './reset-password-form';

export default function ResetPasswordPage() {
  return (
    <AuthLayout>
      <Suspense fallback={<p className="auth-loading">Cargando…</p>}>
        <ResetPasswordForm />
      </Suspense>
    </AuthLayout>
  );
}
