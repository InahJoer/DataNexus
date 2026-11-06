import { type CallHandler, type ExecutionContext, Injectable, type NestInterceptor } from '@nestjs/common';
import type { Observable } from 'rxjs';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface.js';
import { UsageMeterService } from './usage-meter.service.js';

/**
 * Cuenta cada solicitud HTTP autenticada en el consumo de API de su workspace (issue #40).
 * Los interceptores corren después de los guards, así que `request.user` ya está validado.
 */
@Injectable()
export class ApiUsageInterceptor implements NestInterceptor {
  constructor(private readonly meter: UsageMeterService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() === 'http') {
      const user = context.switchToHttp().getRequest<{ user?: Partial<AuthenticatedUser> }>().user;
      if (typeof user?.workspaceId === 'string') this.meter.recordApiRequest(user.workspaceId);
    }
    return next.handle();
  }
}
