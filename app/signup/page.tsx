import { Suspense } from 'react';
import { AuthLayout } from '@/components/auth/auth-layout';
import { SignupForm } from './signup-form';

export default function SignupPage() {
  return (
    <AuthLayout>
      <Suspense fallback={<p className="auth-loading">Cargando…</p>}>
        <SignupForm />
      </Suspense>
    </AuthLayout>
  );
}
