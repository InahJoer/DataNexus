import { UpcomingSection } from '@/components/app-shell/upcoming-section';

export default function ProfilePage() {
  return (
    <UpcomingSection
      trail={['Cuenta', 'Mi perfil']}
      title="Mi perfil"
      subtitle="Tus datos personales y preferencias de seguridad."
      icon="user"
      preview="Aquí podrás editar tu nombre, cambiar tu contraseña y gestionar tus tokens de acceso."
    />
  );
}
