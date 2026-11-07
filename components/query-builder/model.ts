import type { components } from '@/lib/api/schema';

export type JoinPayload = components['schemas']['CrossJoinDto'];
export type JoinType = 'INNER' | 'LEFT' | 'RIGHT' | 'FULL';
export type FieldType = 'número' | 'texto' | 'fecha' | 'booleano' | 'objeto' | 'lista' | 'desconocido';
export type Operator = 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains' | 'startsWith' | 'isNull' | 'in' | 'between';
export type Aggregation = 'COUNT' | 'COUNT_DISTINCT' | 'SUM' | 'AVG' | 'MIN' | 'MAX';

export type QbField = { name: string; type: FieldType };
export type QbFilter = { id: string; campo: string; operador: Operator; valor: string; valor2?: string };
export type QbSource = {
  id: string;
  alias: string;
  connectionId: string;
  connectionName: string;
  engine: string;
  entity: string;
  schema?: string;
  fields: QbField[];
  x: number;
  y: number;
  filters: QbFilter[];
  /** Cómo se combinan los filtros de esta fuente. */
  logic: 'AND' | 'OR';
};
export type QbLink = { id: string; from: { source: string; field: string }; to: { source: string; field: string }; type: JoinType };
export type QbColumn = { name: string; visible: boolean; alias: string };
export type QbMetric = { id: string; operation: Aggregation; field: string; as: string };
export type QbSort = { campo: string; direccion: 'ASC' | 'DESC' };
export type QbModel = {
  sources: QbSource[];
  links: QbLink[];
  columns: QbColumn[];
  groupBy: string[];
  metrics: QbMetric[];
  sort: QbSort[];
  limit: 50 | 100 | 500 | 1000 | null;
};

export const EMPTY_MODEL: QbModel = { sources: [], links: [], columns: [], groupBy: [], metrics: [], sort: [], limit: null };
export const CARD_WIDTH = 230;
export const CARD_HEADER = 46;
export const FIELD_HEIGHT = 26;
export const MAX_FIELDS_SHOWN = 14;

export const AGGREGATIONS: Record<Aggregation, string> = {
  COUNT: 'Contar filas',
  COUNT_DISTINCT: 'Contar distintos',
  SUM: 'Sumar',
  AVG: 'Promedio',
  MIN: 'Mínimo',
  MAX: 'Máximo',
};

export const OPERATORS: Record<Operator, string> = {
  eq: '=',
  neq: '≠',
  gt: '>',
  gte: '≥',
  lt: '<',
  lte: '≤',
  contains: 'contiene',
  startsWith: 'empieza con',
  in: 'está en (lista)',
  between: 'entre',
  isNull: 'está vacío',
};

let counter = 0;
export const uid = (prefix: string) => `${prefix}${Date.now().toString(36)}${(counter++).toString(36)}`;

/** Tipo de un valor de muestra. */
export function typeOf(value: unknown): FieldType {
  if (value === null || value === undefined) return 'desconocido';
  if (Array.isArray(value)) return 'lista';
  if (typeof value === 'object') return 'objeto';
  if (typeof value === 'number') return 'número';
  if (typeof value === 'boolean') return 'booleano';
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2})?/.test(value)) return 'fecha';
  return 'texto';
}

/** Tipos de los campos a partir de una muestra de filas (el primer tipo no vacío de cada campo). */
export function inferFields(names: string[], sample: Record<string, unknown>[]): QbField[] {
  const all = [...new Set([...names, ...sample.flatMap((row) => Object.keys(row))])];
  return all.map((name) => {
    const value = sample.map((row) => row[name]).find((item) => item !== null && item !== undefined);
    return { name, type: typeOf(value) };
  });
}

/** Alias válido para el motor (letra inicial, letras, números o _), único en el lienzo. */
export function aliasFor(entity: string, taken: string[]) {
  const last = entity.split('/').filter((part) => part !== '*').pop() ?? 'fuente';
  const base = last.normalize('NFD').replace(/[^A-Za-z0-9_]/g, '_').replace(/^[^A-Za-z]+/, '').slice(0, 24) || 'fuente';
  let alias = base;
  for (let n = 2; taken.includes(alias); n += 1) alias = `${base}${n}`;
  return alias;
}

/** Tipos compatibles para unir: iguales, o número con texto (avisando), o desconocido. */
export function joinCompatibility(a: FieldType, b: FieldType): 'ok' | 'warning' | 'error' {
  if (a === b || a === 'desconocido' || b === 'desconocido') return 'ok';
  if ((a === 'número' && b === 'texto') || (a === 'texto' && b === 'número') || (a === 'fecha' && b === 'texto') || (a === 'texto' && b === 'fecha')) return 'warning';
  return 'error';
}

/** Formas singulares posibles de un nombre de tabla: clientes → cliente, pedidos → pedido, ciudades → ciudad. */
const singulars = (word: string) => [...new Set([word.replace(/s$/i, ''), word.replace(/es$/i, ''), word])].filter(Boolean);

/**
 * Uniones probables entre fuentes que aún no están unidas: `cliente_id` ↔ `clientes.id`, campos con el mismo nombre
 * terminado en id, y documento ↔ subcolección (`__documentId` ↔ `__parentId`).
 */
export function suggestLinks(model: QbModel): QbLink[] {
  const suggestions: QbLink[] = [];
  const linked = (a: string, b: string) => model.links.some((link) => (link.from.source === a && link.to.source === b) || (link.from.source === b && link.to.source === a));
  for (const left of model.sources) {
    for (const right of model.sources) {
      if (left.id >= right.id || linked(left.id, right.id)) continue;
      const add = (from: QbSource, fromField: string, to: QbSource, toField: string) => {
        if (!suggestions.some((item) => (item.from.source === from.id && item.to.source === to.id) || (item.from.source === to.id && item.to.source === from.id))) {
          suggestions.push({ id: uid('s'), from: { source: from.id, field: fromField }, to: { source: to.id, field: toField }, type: 'INNER' });
        }
      };
      for (const [a, b] of [[left, right], [right, left]] as const) {
        const names = new Set(b.fields.map((field) => field.name));
        const entities = singulars(a.entity.split('/').filter((part) => part !== '*').pop() ?? '');
        // pedidos.cliente_id ↔ clientes.id (o clientes._id / __documentId)
        for (const candidate of entities.flatMap((entity) => [`${entity}_id`, `${entity}id`, `id_${entity}`])) {
          const match = b.fields.find((field) => field.name.toLowerCase() === candidate.toLowerCase());
          const key = a.fields.find((field) => ['id', '_id', '__documentId'].includes(field.name));
          if (match && key) add(a, key.name, b, match.name);
        }
        // Subcolección con su documento padre (Firestore)
        if (b.entity.startsWith(`${a.entity}/*/`) && names.has('__parentId')) add(a, '__documentId', b, '__parentId');
      }
      // Mismo nombre de campo terminado en id (codigo, producto_id…)
      for (const field of left.fields) {
        if (/(_id|Id|codigo|code)$/.test(field.name) && right.fields.some((other) => other.name === field.name)) add(left, field.name, right, field.name);
      }
    }
  }
  return suggestions;
}

/** Orden de las fuentes para el motor: la primera y luego cada una unida a alguna anterior (recorrido por uniones). */
export function plan(model: QbModel): { order: QbSource[]; relations: { left: QbSource; right: QbSource; links: QbLink[] }[]; disconnected: QbSource[] } {
  const [first] = model.sources;
  if (!first) return { order: [], relations: [], disconnected: [] };
  const order: QbSource[] = [first];
  const relations: { left: QbSource; right: QbSource; links: QbLink[] }[] = [];
  let progress = true;
  while (progress) {
    progress = false;
    for (const source of model.sources) {
      if (order.includes(source)) continue;
      const edges = model.links.filter((link) =>
        (link.to.source === source.id && order.some((item) => item.id === link.from.source)) ||
        (link.from.source === source.id && order.some((item) => item.id === link.to.source)),
      );
      if (!edges.length) continue;
      const leftId = edges[0].from.source === source.id ? edges[0].to.source : edges[0].from.source;
      const left = order.find((item) => item.id === leftId)!;
      const sameLeft = edges.filter((edge) => edge.from.source === left.id || edge.to.source === left.id);
      relations.push({ left, right: source, links: sameLeft });
      order.push(source);
      progress = true;
    }
  }
  return { order, relations, disconnected: model.sources.filter((source) => !order.includes(source)) };
}

function filterValue(filter: QbFilter, type: FieldType | undefined): unknown {
  const parse = (raw: string) => (type === 'número' && raw.trim() !== '' && !Number.isNaN(Number(raw)) ? Number(raw) : type === 'booleano' ? raw === 'true' : raw);
  if (filter.operador === 'isNull') return true;
  if (filter.operador === 'in') return filter.valor.split(',').map((item) => parse(item.trim())).filter((item) => item !== '');
  if (filter.operador === 'between') return [parse(filter.valor), parse(filter.valor2 ?? '')];
  return ['contains', 'startsWith'].includes(filter.operador) ? filter.valor : parse(filter.valor);
}

/** Tipo de join visto desde la fuente que se agrega (la relación del motor va de la anterior a la nueva). */
function relationType(link: QbLink, newSourceId: string): JoinType {
  if (link.to.source === newSourceId || link.type === 'INNER' || link.type === 'FULL') return link.type;
  return link.type === 'LEFT' ? 'RIGHT' : 'LEFT';
}

/** Consulta para el motor (fuentes, relaciones, filtros, salida) a partir del lienzo. */
export function toPayload(model: QbModel, options: { includeOutput?: boolean } = {}): JoinPayload | null {
  const { order, relations, disconnected } = plan(model);
  if (order.length < 2 || disconnected.length) return null;
  const visible = model.columns.filter((column) => column.visible);
  const aggregated = model.groupBy.length > 0 || model.metrics.length > 0;
  const allVisible = visible.length === model.columns.length && model.columns.every((column) => !column.alias);
  const payload = {
    fuentes: order.map((source) => {
      const valid = source.filters.filter((filter) => filter.campo && (filter.operador === 'isNull' || filter.valor !== ''));
      const filtros = valid.map((filter) => ({ campo: filter.campo, operador: filter.operador, valor: filterValue(filter, source.fields.find((field) => field.name === filter.campo)?.type) }));
      return {
        alias: source.alias,
        conexionId: source.connectionId,
        entidad: source.entity,
        ...(source.schema ? { esquema: source.schema } : {}),
        ...(filtros.length ? { filtros: source.logic === 'OR' && filtros.length > 1 ? [{ logica: 'OR' as const, filtros }] : filtros } : {}),
      };
    }),
    relaciones: relations.map(({ left, right, links }) => ({
      izquierda: left.alias,
      derecha: right.alias,
      tipo: relationType(links[0], right.id),
      llaves: links.map((link) => (link.from.source === left.id
        ? { izquierda: link.from.field, derecha: link.to.field }
        : { izquierda: link.to.field, derecha: link.from.field })),
    })),
    ...(aggregated ? {
      groupBy: model.groupBy,
      aggregations: model.metrics.filter((metric) => metric.as.trim()).map((metric) => ({ operation: metric.operation, ...(metric.field ? { field: metric.field } : {}), as: metric.as.trim() })),
    } : {}),
    ...(options.includeOutput !== false && !aggregated && model.columns.length && !allVisible && visible.length ? { columnas: visible.map((column) => column.name) } : {}),
    ...(options.includeOutput !== false && model.columns.some((column) => column.alias.trim()) ? { aliasColumnas: Object.fromEntries(model.columns.filter((column) => column.alias.trim()).map((column) => [column.name, column.alias.trim()])) } : {}),
    ...(model.sort.length ? { ordenarPor: model.sort } : {}),
    ...(model.limit ? { limiteFilas: model.limit } : {}),
    lienzo: { version: 1, fuentes: Object.fromEntries(model.sources.map((source) => [source.alias, { x: Math.round(source.x), y: Math.round(source.y) }])) },
  };
  return payload as unknown as JoinPayload;
}

const quote = (name: string) => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : `"${name.replace(/"/g, '""')}"`);
const literal = (value: unknown): string => (typeof value === 'number' || typeof value === 'boolean' ? String(value) : Array.isArray(value) ? `(${value.map(literal).join(', ')})` : `'${String(value).replace(/'/g, "''")}'`);

/** SQL equivalente (solo lectura) para entender qué hace el cruce; el motor lo ejecuta en memoria entre motores. */
export function toSql(model: QbModel): string {
  const { order, relations, disconnected } = plan(model);
  if (!order.length) return '-- Arrastra tablas o colecciones al lienzo para empezar.';
  const visible = model.columns.filter((column) => column.visible);
  const select = model.groupBy.length || model.metrics.length
    ? [...model.groupBy.map(quote), ...model.metrics.map((metric) => `${metric.operation === 'COUNT_DISTINCT' ? `COUNT(DISTINCT ${quote(metric.field)})` : `${metric.operation}(${metric.field ? quote(metric.field) : '*'})`} AS ${quote(metric.as)}`)]
    : visible.length && visible.length < model.columns.length ? visible.map((column) => `${quote(column.name)}${column.alias ? ` AS ${quote(column.alias)}` : ''}`) : ['*'];
  const from = (source: QbSource) => `${source.schema && source.schema !== 'public' ? `${quote(source.schema)}.` : ''}${quote(source.entity)} AS ${source.alias}  -- ${source.connectionName}`;
  const lines = [`SELECT ${select.join(',\n       ')}`, `FROM ${from(order[0])}`];
  for (const { left, right, links } of relations) {
    const on = links.map((link) => (link.from.source === left.id ? `${left.alias}.${quote(link.from.field)} = ${right.alias}.${quote(link.to.field)}` : `${left.alias}.${quote(link.to.field)} = ${right.alias}.${quote(link.from.field)}`));
    lines.push(`${relationType(links[0], right.id)} JOIN ${from(right)}\n  ON ${on.join(' AND ')}`);
  }
  const where = order.flatMap((source) => {
    const parts = source.filters.filter((filter) => filter.campo).map((filter) => {
      const column = `${source.alias}.${quote(filter.campo)}`;
      const value = filterValue(filter, source.fields.find((field) => field.name === filter.campo)?.type);
      if (filter.operador === 'isNull') return `${column} IS NULL`;
      if (filter.operador === 'contains') return `${column} LIKE ${literal(`%${filter.valor}%`)}`;
      if (filter.operador === 'startsWith') return `${column} LIKE ${literal(`${filter.valor}%`)}`;
      if (filter.operador === 'in') return `${column} IN ${literal(value)}`;
      if (filter.operador === 'between') return `${column} BETWEEN ${literal((value as unknown[])[0])} AND ${literal((value as unknown[])[1])}`;
      return `${column} ${OPERATORS[filter.operador].replace('≠', '<>').replace('≥', '>=').replace('≤', '<=')} ${literal(value)}`;
    });
    return parts.length > 1 && source.logic === 'OR' ? [`(${parts.join(' OR ')})`] : parts;
  });
  if (where.length) lines.push(`WHERE ${where.join('\n  AND ')}`);
  if (model.groupBy.length) lines.push(`GROUP BY ${model.groupBy.map(quote).join(', ')}`);
  if (model.sort.length) lines.push(`ORDER BY ${model.sort.map((item) => `${quote(item.campo)} ${item.direccion}`).join(', ')}`);
  if (model.limit) lines.push(`LIMIT ${model.limit}`);
  if (disconnected.length) lines.push(`-- Sin unir: ${disconnected.map((source) => source.alias).join(', ')}`);
  return `${lines.join('\n')};`;
}

/** Reconstruye el lienzo desde una consulta guardada (fuentes, relaciones, salida y posiciones). */
export function fromDefinition(definition: JoinPayload, base: Omit<QbSource, 'x' | 'y' | 'filters' | 'logic'>[]): QbModel {
  const raw = definition as unknown as {
    fuentes?: { alias: string; filtros?: unknown[] }[];
    relaciones?: { izquierda: string; derecha: string; tipo?: JoinType; llaves: { izquierda: string; derecha: string }[] }[];
    columnas?: string[];
    aliasColumnas?: Record<string, string>;
    groupBy?: string[];
    aggregations?: { operation: Aggregation; field?: string; as: string }[];
    ordenarPor?: QbSort[];
    limiteFilas?: QbModel['limit'];
    lienzo?: { fuentes?: Record<string, { x: number; y: number }> };
  };
  const sources: QbSource[] = base.map((source, index) => {
    const position = raw.lienzo?.fuentes?.[source.alias];
    const saved = raw.fuentes?.find((item) => item.alias === source.alias);
    const flat = (saved?.filtros ?? []).flatMap((item) => {
      const node = item as { logica?: string; filtros?: unknown[]; campo?: string; operador?: Operator; valor?: unknown };
      return node.logica ? (node.filtros ?? []) : [node];
    }) as { campo: string; operador: Operator; valor: unknown }[];
    const isOr = (saved?.filtros ?? []).some((item) => (item as { logica?: string }).logica === 'OR');
    return {
      ...source,
      x: position?.x ?? 40 + index * (CARD_WIDTH + 90),
      y: position?.y ?? 70 + (index % 2) * 60,
      logic: isOr ? 'OR' : 'AND',
      filters: flat.map((filter) => ({
        id: uid('f'),
        campo: filter.campo,
        operador: filter.operador,
        valor: Array.isArray(filter.valor) ? (filter.operador === 'between' ? String(filter.valor[0]) : filter.valor.join(', ')) : filter.operador === 'isNull' ? '' : String(filter.valor ?? ''),
        valor2: Array.isArray(filter.valor) && filter.operador === 'between' ? String(filter.valor[1]) : undefined,
      })),
    };
  });
  const byAlias = (alias: string) => sources.find((source) => source.alias === alias);
  const links: QbLink[] = (raw.relaciones ?? []).flatMap((relation) => relation.llaves.map((key) => ({
    id: uid('l'),
    from: { source: byAlias(relation.izquierda)?.id ?? '', field: key.izquierda },
    to: { source: byAlias(relation.derecha)?.id ?? '', field: key.derecha },
    type: relation.tipo ?? 'INNER',
  })));
  return {
    sources,
    links,
    columns: (raw.columnas ?? []).map((name) => ({ name, visible: true, alias: raw.aliasColumnas?.[name] ?? '' })),
    groupBy: raw.groupBy ?? [],
    metrics: (raw.aggregations ?? []).map((metric) => ({ id: uid('m'), operation: metric.operation, field: metric.field ?? '', as: metric.as })),
    sort: raw.ordenarPor ?? [],
    limit: raw.limiteFilas ?? null,
  };
}
