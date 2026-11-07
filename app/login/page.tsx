import { AuthHeading, AuthLayout } from '@/components/auth/auth-layout';
import { LoginForm } from './login-form';

export default function LoginPage() {
  return (
    <AuthLayout>
      <AuthHeading title="Vuelve a tu espacio." description="Inicia sesión para continuar con tus datos." />
      <LoginForm />
    </AuthLayout>
  );
}
