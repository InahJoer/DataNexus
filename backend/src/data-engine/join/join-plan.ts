import { BadRequestException, PayloadTooLargeException } from '@nestjs/common';
import type { DataFilter } from '../dto/cross-join.dto.js';

export const JOIN_TYPES = ['INNER', 'LEFT', 'RIGHT', 'FULL'] as const;
export type JoinType = (typeof JOIN_TYPES)[number];

export const MIN_JOIN_SOURCES = 2;
export const MAX_JOIN_SOURCES = 5;
export const MAX_JOIN_KEYS = 3;
export const JOIN_ALIAS_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;

export interface JoinSourceSpec {
  alias: string;
  conexionId: string;
  entidad: string;
  esquema?: string;
  filtros?: DataFilter[];
}

export interface JoinKeyPair {
  izquierda: string;
  derecha: string;
}

export interface JoinRelationSpec {
  izquierda: string;
  derecha: string;
  tipo: JoinType;
  llaves: JoinKeyPair[];
}

/** Plan validado: `sources` en el orden en que se unen (left-deep) y una relación por cada fuente añadida. */
export interface JoinPlan {
  sources: JoinSourceSpec[];
  relations: JoinRelationSpec[];
}

/** Una fila intermedia: el registro de cada fuente (en el orden del plan) o null si no tuvo pareja (outer join). */
export type JoinTuple = Array<Record<string, any> | null>;

/**
 * Valida y ordena un plan de N fuentes:
 * - de 2 a 5 fuentes con alias únicos y N-1 relaciones;
 * - la primera relación une dos fuentes y cada relación siguiente añade una fuente nueva (`derecha`) a una ya
 *   unida (`izquierda`), así que el resultado es un árbol sin ciclos que cubre todas las fuentes;
 * - de 1 a 3 pares de llaves por relación (llaves compuestas).
 */
export function validateJoinPlan(sources: JoinSourceSpec[], relations: JoinRelationSpec[]): JoinPlan {
  if (!Array.isArray(sources) || sources.length < MIN_JOIN_SOURCES || sources.length > MAX_JOIN_SOURCES) {
    throw new BadRequestException(`El cross-join necesita entre ${MIN_JOIN_SOURCES} y ${MAX_JOIN_SOURCES} fuentes`);
  }
  const byAlias = new Map<string, JoinSourceSpec>();
  for (const source of sources) {
    if (!source || typeof source.alias !== 'string' || !JOIN_ALIAS_PATTERN.test(source.alias)) {
      throw new BadRequestException('Cada fuente necesita un alias de 1 a 32 letras, números o _ que empiece por letra');
    }
    if (byAlias.has(source.alias)) throw new BadRequestException(`El alias '${source.alias}' está repetido`);
    byAlias.set(source.alias, source);
  }
  if (!Array.isArray(relations) || relations.length !== sources.length - 1) {
    throw new BadRequestException(`Con ${sources.length} fuentes se necesitan ${sources.length - 1} relaciones`);
  }

  const ordered: JoinSourceSpec[] = [];
  const joined = new Set<string>();
  relations.forEach((relation, index) => {
    if (!relation || !JOIN_TYPES.includes(relation.tipo)) {
      throw new BadRequestException(`El tipo de join debe ser uno de: ${JOIN_TYPES.join(', ')}`);
    }
    const left = byAlias.get(relation.izquierda);
    const right = byAlias.get(relation.derecha);
    if (!left || !right) throw new BadRequestException('Las relaciones solo pueden usar alias de las fuentes declaradas');
    if (index === 0) {
      if (left === right) throw new BadRequestException('Una relación no puede unir una fuente consigo misma');
      ordered.push(left);
      joined.add(left.alias);
    } else if (!joined.has(left.alias)) {
      throw new BadRequestException(`La relación ${index + 1} debe partir de una fuente ya unida ('${relation.izquierda}' aún no lo está)`);
    }
    if (joined.has(right.alias)) {
      throw new BadRequestException(`La fuente '${relation.derecha}' ya está unida: las relaciones no pueden formar ciclos`);
    }
    if (
      !Array.isArray(relation.llaves) ||
      relation.llaves.length === 0 ||
      relation.llaves.length > MAX_JOIN_KEYS ||
      relation.llaves.some(
        (pair) =>
          !pair ||
          typeof pair.izquierda !== 'string' ||
          typeof pair.derecha !== 'string' ||
          !pair.izquierda.trim() ||
          !pair.derecha.trim(),
      )
    ) {
      throw new BadRequestException(`Cada relación necesita de 1 a ${MAX_JOIN_KEYS} pares de llaves`);
    }
    ordered.push(right);
    joined.add(right.alias);
  });

  return { sources: ordered, relations };
}

/**
 * Normaliza un valor de llave para compararlo entre motores: texto recortado, números y booleanos como texto
 * (así 1 y "1" coinciden, igual que antes), fechas en ISO 8601. null, objetos y listas no cruzan (como NULL en SQL).
 */
export function normalizeJoinKey(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : null;
  if (typeof value === 'bigint' || typeof value === 'boolean') return String(value);
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  return null;
}

/** Llave compuesta de un registro; null si falta alguna parte. */
function compositeKey(record: Record<string, any> | null, fields: string[]): string | null {
  if (!record) return null;
  if (fields.length === 1) return normalizeJoinKey(ownValue(record, fields[0]));
  const parts: string[] = [];
  for (const field of fields) {
    const part = normalizeJoinKey(ownValue(record, field));
    if (part === null) return null;
    parts.push(part);
  }
  return JSON.stringify(parts);
}

function ownValue(record: Record<string, any>, field: string): unknown {
  return Object.prototype.hasOwnProperty.call(record, field) ? record[field] : undefined;
}

/**
 * Ejecuta el plan en memoria con índices hash (O(N + M) por relación). Cada relación une el resultado acumulado
 * con una fuente nueva según su tipo:
 * - INNER: solo filas con pareja; LEFT: además las del lado acumulado sin pareja;
 * - RIGHT: además los registros de la fuente nueva sin pareja; FULL: ambos.
 * `maxRows` limita cada resultado intermedio para que una explosión de combinaciones no agote la memoria.
 */
export function executeJoinPlan(
  plan: JoinPlan,
  recordsByAlias: ReadonlyMap<string, Record<string, any>[]>,
  maxRows: number,
): JoinTuple[] {
  const index = new Map(plan.sources.map((source, position) => [source.alias, position]));
  const width = plan.sources.length;
  const records = (alias: string) => recordsByAlias.get(alias) ?? [];
  const tooMany = () => new PayloadTooLargeException(`El join supera el máximo de ${maxRows} filas configurado`);

  const first = records(plan.sources[0].alias);
  if (first.length > maxRows) throw tooMany();
  let rows: JoinTuple[] = first.map((record) => {
    const tuple: JoinTuple = Array.from({ length: width }, () => null);
    tuple[0] = record;
    return tuple;
  });

  for (const relation of plan.relations) {
    const leftPosition = index.get(relation.izquierda)!;
    const rightPosition = index.get(relation.derecha)!;
    const rightRecords = records(relation.derecha);
    const leftFields = relation.llaves.map((pair) => pair.izquierda);
    const rightFields = relation.llaves.map((pair) => pair.derecha);
    const keepLeft = relation.tipo === 'LEFT' || relation.tipo === 'FULL';
    const keepRight = relation.tipo === 'RIGHT' || relation.tipo === 'FULL';

    const rightIndex = new Map<string, number[]>();
    rightRecords.forEach((record, position) => {
      const key = compositeKey(record, rightFields);
      if (key === null) return;
      const bucket = rightIndex.get(key);
      if (bucket) bucket.push(position);
      else rightIndex.set(key, [position]);
    });
    const matchedRight = keepRight ? new Uint8Array(rightRecords.length) : undefined;

    const next: JoinTuple[] = [];
    const push = (tuple: JoinTuple) => {
      if (next.length >= maxRows) throw tooMany();
      next.push(tuple);
    };
    for (const row of rows) {
      const key = compositeKey(row[leftPosition], leftFields);
      const matches = key === null ? undefined : rightIndex.get(key);
      if (matches?.length) {
        for (const position of matches) {
          const tuple = row.slice();
          tuple[rightPosition] = rightRecords[position];
          if (matchedRight) matchedRight[position] = 1;
          push(tuple);
        }
      } else if (keepLeft) {
        push(row.slice());
      }
    }
    if (matchedRight) {
      rightRecords.forEach((record, position) => {
        if (matchedRight[position]) return;
        const tuple: JoinTuple = Array.from({ length: width }, () => null);
        tuple[rightPosition] = record;
        push(tuple);
      });
    }
    rows = next;
  }
  return rows;
}

/**
 * Convierte cada fila intermedia en un registro plano con columnas estables:
 * - un campo que existe en una sola fuente conserva su nombre;
 * - un campo presente en varias fuentes se califica con el alias (`clientes.email`, `pedidos.email`);
 * - si una fuente no tuvo pareja (outer join), sus columnas conocidas salen en null.
 */
export function createRowFlattener(
  plan: JoinPlan,
  recordsByAlias: ReadonlyMap<string, Record<string, any>[]>,
): (tuple: JoinTuple) => Record<string, any> {
  const fieldsByPosition = plan.sources.map((source) => {
    const fields = new Set<string>();
    for (const record of recordsByAlias.get(source.alias) ?? []) for (const key of Object.keys(record)) fields.add(key);
    return [...fields];
  });
  const owners = new Map<string, number>();
  for (const fields of fieldsByPosition) for (const field of fields) owners.set(field, (owners.get(field) ?? 0) + 1);
  const outputName = (position: number, field: string) =>
    (owners.get(field) ?? 0) > 1 ? `${plan.sources[position].alias}.${field}` : field;

  return (tuple) => {
    const row: Record<string, any> = {};
    tuple.forEach((record, position) => {
      if (record) {
        for (const [field, value] of Object.entries(record)) assignUnique(row, outputName(position, field), value);
      } else {
        for (const field of fieldsByPosition[position]) assignUnique(row, outputName(position, field), null);
      }
    });
    return row;
  };
}

function assignUnique(target: Record<string, any>, preferred: string, value: unknown): void {
  let key = preferred;
  let suffix = 2;
  while (Object.prototype.hasOwnProperty.call(target, key)) {
    key = `${preferred}_${suffix}`;
    suffix += 1;
  }
  target[key] = value;
}

/** Descripción corta para títulos y bitácora: `public.clientes x pedidos x eventos`. */
export function describeJoinPlan(plan: JoinPlan): string {
  return plan.sources.map((source) => (source.esquema ? `${source.esquema}.${source.entidad}` : source.entidad)).join(' x ');
}
