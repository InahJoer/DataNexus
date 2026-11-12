import type { ExecutionContext } from '@nestjs/common';

/** Prefijo de metadata que usa @Throttle de @nestjs/throttler (no se exporta en su API pública). */
const THROTTLER_LIMIT = 'THROTTLER:LIMIT';

/** true si el handler o su controlador declaran @Throttle({ [name]: ... }). */
export function hasNamedThrottle(context: ExecutionContext, name: string): boolean {
  const key = `${THROTTLER_LIMIT}${name}`;
  return Reflect.hasMetadata(key, context.getHandler()) || Reflect.hasMetadata(key, context.getClass());
}
