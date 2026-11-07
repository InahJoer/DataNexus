export const NETWORK_ERROR_MESSAGE = 'No se pudo conectar con la API de DataNexus. Verifica tu conexión e inténtalo de nuevo.';

const STATUS_MESSAGES: Record<number, string> = {
  401: 'Tu sesión expiró. Vuelve a iniciar sesión.',
  403: 'Tu rol no tiene permiso para realizar esta acción.',
  404: 'El recurso solicitado no existe o fue eliminado.',
  409: 'La operación entra en conflicto con datos existentes.',
  429: 'Demasiadas solicitudes. Espera un momento e inténtalo de nuevo.',
};

/** Texto que envía la API en `message` (NestJS lo manda como texto o como lista de errores de validación). */
function messageFrom(error: unknown): string | null {
  if (!error || typeof error !== 'object' || !('message' in error)) return null;
  const { message } = error;
  if (typeof message === 'string') return message;
  if (Array.isArray(message)) {
    const parts = message.filter((part): part is string => typeof part === 'string');
    return parts.length > 0 ? parts.join(' ') : null;
  }
  return null;
}

/** Mensaje legible para el usuario a partir de una respuesta de error de la API. */
export function apiErrorMessage(error: unknown, status: number): string {
  if (status >= 500) return 'La API de DataNexus tuvo un problema. Inténtalo de nuevo en unos minutos.';
  return messageFrom(error) ?? STATUS_MESSAGES[status] ?? 'No se pudo completar la solicitud.';
}
