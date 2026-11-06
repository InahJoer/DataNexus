import { BadRequestException } from '@nestjs/common';
import type { CrossJoinDto } from '../dto/cross-join.dto.js';
import { validateJoinPlan, type JoinPlan } from './join-plan.js';

/** Alias del formato original: las columnas repetidas siguen saliendo como `sql.campo` y `nosql.campo`. */
export const LEGACY_SQL_ALIAS = 'sql';
export const LEGACY_NOSQL_ALIAS = 'nosql';

const LEGACY_FIELDS = [
  'conexionSqlId',
  'conexionNoSqlId',
  'tablaSql',
  'esquemaSql',
  'coleccionNoSql',
  'llaveSql',
  'llaveNoSql',
  'filtrosSql',
  'filtrosNoSql',
  'tipoJoin',
] as const;

/**
 * Convierte cualquiera de los dos formatos del payload en un plan validado:
 * - N fuentes (`fuentes` + `relaciones`), o
 * - el formato original (tabla SQL × colección NoSQL), que equivale a dos fuentes y una relación.
 * Mezclar ambos formatos se rechaza para que nunca se ignore un campo sin avisar.
 */
export function resolveJoinPlan(payload: CrossJoinDto): JoinPlan {
  if (payload.fuentes !== undefined) {
    const mixed = LEGACY_FIELDS.filter((field) => payload[field] !== undefined);
    if (mixed.length) {
      throw new BadRequestException(
        `Use el formato de fuentes y relaciones o el original, no ambos (sobra: ${mixed.join(', ')})`,
      );
    }
    return validateJoinPlan(
      payload.fuentes.map((source) => ({
        alias: source.alias,
        conexionId: source.conexionId,
        entidad: source.entidad,
        ...(source.esquema ? { esquema: source.esquema } : {}),
        ...(source.filtros?.length ? { filtros: source.filtros } : {}),
      })),
      (payload.relaciones ?? []).map((relation) => ({
        izquierda: relation.izquierda,
        derecha: relation.derecha,
        tipo: relation.tipo ?? 'INNER',
        llaves: (relation.llaves ?? []).map((pair) => ({ izquierda: pair.izquierda, derecha: pair.derecha })),
      })),
    );
  }

  const required = ['conexionSqlId', 'conexionNoSqlId', 'tablaSql', 'coleccionNoSql', 'llaveSql', 'llaveNoSql'] as const;
  const missing = required.filter((field) => typeof payload[field] !== 'string' || !payload[field]);
  if (missing.length) {
    throw new BadRequestException(`Faltan campos del cross-join: ${missing.join(', ')}`);
  }

  return validateJoinPlan(
    [
      {
        alias: LEGACY_SQL_ALIAS,
        conexionId: payload.conexionSqlId!,
        entidad: payload.tablaSql!,
        ...(payload.esquemaSql ? { esquema: payload.esquemaSql } : {}),
        ...(payload.filtrosSql?.length ? { filtros: payload.filtrosSql } : {}),
      },
      {
        alias: LEGACY_NOSQL_ALIAS,
        conexionId: payload.conexionNoSqlId!,
        entidad: payload.coleccionNoSql!,
        ...(payload.filtrosNoSql?.length ? { filtros: payload.filtrosNoSql } : {}),
      },
    ],
    [
      {
        izquierda: LEGACY_SQL_ALIAS,
        derecha: LEGACY_NOSQL_ALIAS,
        tipo: payload.tipoJoin ?? 'INNER',
        llaves: [{ izquierda: payload.llaveSql!, derecha: payload.llaveNoSql! }],
      },
    ],
  );
}
