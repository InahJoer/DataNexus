import { Inject, Injectable } from '@nestjs/common';
import { normalizeTipoMotor, TIPOS_MOTOR, type TipoMotor } from '../../common/tipo-motor.js';
import { DATA_SOURCE_ADAPTERS, type IDataSourceAdapter } from './data-source-adapter.interface.js';

/**
 * Registro de adaptadores por TipoMotor (factory con inyección de Nest). Acepta los alias del motor
 * ("SQL Server", "Firebase", "postgres"...) y rechaza al arrancar registros duplicados.
 */
@Injectable()
export class AdapterRegistry {
  private readonly adapters = new Map<TipoMotor, IDataSourceAdapter>();

  constructor(@Inject(DATA_SOURCE_ADAPTERS) adapters: IDataSourceAdapter[]) {
    for (const adapter of adapters) {
      if (this.adapters.has(adapter.tipoMotor)) {
        throw new Error(`Adaptador duplicado para el motor ${adapter.tipoMotor}`);
      }
      this.adapters.set(adapter.tipoMotor, adapter);
    }
  }

  /** Adaptador del motor, o undefined si no hay ninguno registrado. */
  get(tipoMotor: string): IDataSourceAdapter | undefined {
    const normalized = normalizeTipoMotor(tipoMotor);
    return typeof normalized === 'string' && (TIPOS_MOTOR as readonly string[]).includes(normalized)
      ? this.adapters.get(normalized as TipoMotor)
      : undefined;
  }

  /** Motores con adaptador y lo que soporta cada uno. */
  supported(): { tipoMotor: TipoMotor; explore: boolean; fields: boolean; extract: boolean }[] {
    return [...this.adapters.values()].map((adapter) => ({ tipoMotor: adapter.tipoMotor, ...adapter.capabilities }));
  }
}
