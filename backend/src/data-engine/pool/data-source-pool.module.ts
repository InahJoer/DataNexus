import { Module } from '@nestjs/common';
import { DataSourceClientPool } from './data-source-client-pool.js';

/**
 * Módulo propio para el pool: lo usan ConnectionsModule (invalida al editar o eliminar) y DataEngineModule
 * (adaptadores) sin crear dependencias circulares entre ambos. Se registra con factory porque los parámetros
 * del constructor (TTL, máximo, reloj) son configuración, no dependencias de Nest.
 */
@Module({
  providers: [{ provide: DataSourceClientPool, useFactory: () => new DataSourceClientPool() }],
  exports: [DataSourceClientPool],
})
export class DataSourcePoolModule {}
