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
  /** Filtros sobre la tabla combinada (columnas de salida); con agrupación funcionan como HAVING. */
  resultFilters: QbFilter[];
  resultLogic: 'AND' | 'OR';
};

export const EMPTY_MODEL: QbModel = { sources: [], links: [], columns: [], groupBy: [], metrics: [], sort: [], limit: null, resultFilters: [], resultLogic: 'AND' };

/** Completa un modelo guardado con una versión anterior (borradores sin los campos nuevos). */
export function normalizeModel(raw: Partial<QbModel> | null | undefined): QbModel {
  return { ...EMPTY_MODEL, ...raw, resultFilters: raw?.resultFilters ?? [], resultLogic: raw?.resultLogic ?? 'AND' };
}
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

/** Filas de muestra de cada fuente (por id de fuente), para comparar valores reales al sugerir uniones. */
export type Samples = Record<string, Record<string, unknown>[]>;
export type LinkSuggestion = { link: QbLink; score: number; reasons: string[] };

const normName = (name: string) => name.normalize('NFD').toLowerCase().replace(/[^a-z0-9]/g, '');
const entityName = (source: QbSource) => source.entity.split('/').filter((part) => part !== '*').pop() ?? source.entity;
const KEY_FIELDS = new Set(['id', '_id', '__documentId', 'uuid', 'codigo', 'code', 'clave', 'sku']);
const KEYISH = /(id|codigo|code|ref|clave|key|sku|uuid)$/;
const JOINABLE: FieldType[] = ['número', 'texto', 'desconocido', 'fecha'];

/** Evidencia por nombre de que `a.fa` y `b.fb` son la misma llave (0 = ninguna, 1 = segura). */
function nameEvidence(a: QbSource, fa: string, b: QbSource, fb: string): { score: number; reason: string } | null {
  const na = normName(fa);
  const nb = normName(fb);
  if (fa === '__documentId' && fb === '__parentId' && b.entity.startsWith(`${a.entity}/`)) return { score: 1, reason: `${b.alias} es subcolección de ${a.alias}` };
  for (const [x, fx, y, ny] of [[a, fa, b, nb], [b, fb, a, na]] as const) {
    if (!KEY_FIELDS.has(fx)) continue;
    const stems = singulars(entityName(x)).map(normName);
    if (stems.some((stem) => [`${stem}id`, `id${stem}`, `${stem}ref`, `${stem}codigo`, `${stem}code`].includes(ny))) {
      return { score: 0.95, reason: `${y.alias}.${fx === fa ? fb : fa} apunta a la llave ${x.alias}.${fx}` };
    }
  }
  if (na === nb && na.length > 2 && KEYISH.test(na)) return { score: 0.8, reason: `Ambas fuentes tienen la llave "${fa}"` };
  for (const [x, y, nx, ny] of [[a, b, na, nb], [b, a, nb, na]] as const) {
    const stems = singulars(entityName(y)).map(normName);
    if (stems.some((stem) => stem.length > 2 && nx.startsWith(stem)) && KEYISH.test(nx) && KEYISH.test(ny)) {
      return { score: 0.6, reason: `El campo de ${x.alias} menciona a ${y.alias}` };
    }
  }
  if (na === nb && na.length > 2) return { score: 0.3, reason: `Mismo nombre de campo ("${fa}")` };
  return null;
}

const scalarKey = (value: unknown) => (value === null || value === undefined || value === '' || typeof value === 'object' ? null : String(value).trim().toLowerCase());

/** Comparación de valores de muestra: cuántos valores de un lado aparecen en el otro y si alguno parece llave única. */
function valueEvidence(rowsA: Record<string, unknown>[], fa: string, rowsB: Record<string, unknown>[], fb: string) {
  const listA = rowsA.map((row) => scalarKey(row[fa])).filter((value): value is string => value !== null);
  const listB = rowsB.map((row) => scalarKey(row[fb])).filter((value): value is string => value !== null);
  const setA = new Set(listA);
  const setB = new Set(listB);
  if (setA.size < 2 || setB.size < 2) return { overlap: 0, matches: 0, smaller: 0, unique: false, trivial: true };
  let matches = 0;
  for (const value of setA) if (setB.has(value)) matches += 1;
  const smaller = Math.min(setA.size, setB.size);
  const unique = setA.size === listA.length || setB.size === listB.length;
  // Valores numéricos pequeños (1, 2, 3…) coinciden por casualidad: cantidades, estados, posiciones.
  const trivial = [...setA, ...setB].every((value) => /^-?\d{1,2}$/.test(value));
  return { overlap: matches / smaller, matches, smaller, unique, trivial };
}

/**
 * Detección inteligente de uniones entre fuentes que aún no están unidas. Combina el nombre de los campos
 * (`cliente_id` ↔ `clientes.id`, misma llave en ambas, documento ↔ subcolección) con los valores reales de la
 * muestra (qué parte coincide y si un lado es llave única). Devuelve la mejor unión de cada par, de más a menos segura.
 */
/** En un Excel subido, la primera columna es el identificador de cada registro: una llave natural para unir. */
export const isExcelKey = (source: QbSource, field: string) => source.engine === 'EXCEL' && source.fields[0]?.name === field;

export function detectLinks(model: QbModel, samples: Samples = {}): LinkSuggestion[] {
  const linked = (a: string, b: string) => model.links.some((link) => (link.from.source === a && link.to.source === b) || (link.from.source === b && link.to.source === a));
  const result: LinkSuggestion[] = [];
  for (const [i, left] of model.sources.entries()) {
    for (const right of model.sources.slice(i + 1)) {
      if (linked(left.id, right.id)) continue;
      let best: LinkSuggestion | null = null;
      for (const fa of left.fields) {
        if (!JOINABLE.includes(fa.type)) continue;
        for (const fb of right.fields) {
          if (!JOINABLE.includes(fb.type) || joinCompatibility(fa.type, fb.type) === 'error') continue;
          const named = nameEvidence(left, fa.name, right, fb.name);
          const values = valueEvidence(samples[left.id] ?? [], fa.name, samples[right.id] ?? [], fb.name);
          const reasons: string[] = [];
          const excelKey = isExcelKey(left, fa.name) || isExcelKey(right, fb.name);
          let score: number;
          if (named) {
            reasons.push(named.reason);
            score = values.smaller ? 0.55 * named.score + 0.45 * values.overlap : named.score * 0.85;
          } else {
            // Solo por valores: exige mucha coincidencia, un lado con valores únicos y valores no triviales.
            if (values.trivial || !(values.unique || excelKey) || values.overlap < 0.6) continue;
            score = 0.7 * values.overlap;
          }
          if (values.smaller) reasons.push(`${Math.round(values.overlap * 100)}% de los valores de muestra coinciden (${values.matches} de ${values.smaller})`);
          if (values.unique && values.overlap > 0) reasons.push('Uno de los lados tiene valores únicos (parece llave)');
          if (excelKey && (named || values.overlap > 0)) {
            score += 0.08;
            reasons.push('Es la columna identificadora del Excel (primera columna)');
          }
          if (joinCompatibility(fa.type, fb.type) === 'warning') {
            score -= 0.1;
            reasons.push(`Tipos distintos (${fa.type} y ${fb.type})`);
          }
          if (score < 0.35 || (best && best.score >= score)) continue;
          best = { link: { id: `s-${left.id}-${right.id}`, from: { source: left.id, field: fa.name }, to: { source: right.id, field: fb.name }, type: 'INNER' }, score: Math.min(1, score), reasons };
        }
      }
      if (best) result.push(best);
    }
  }
  return result.sort((a, b) => b.score - a.score);
}

/** Uniones sugeridas (solo la unión, sin puntaje). */
export function suggestLinks(model: QbModel, samples: Samples = {}): QbLink[] {
  return detectLinks(model, samples).map((item) => item.link);
}

/** Columnas que producirá el cruce: un nombre repetido entre fuentes se califica con el alias (como el motor). */
export function outputFields(model: QbModel): { name: string; type: FieldType }[] {
  const { order } = plan(model);
  const sources = order.length ? order : model.sources;
  const count = new Map<string, number>();
  for (const source of sources) for (const field of source.fields) count.set(field.name, (count.get(field.name) ?? 0) + 1);
  return sources.flatMap((source) => source.fields.map((field) => ({ name: (count.get(field.name) ?? 0) > 1 ? `${source.alias}.${field.name}` : field.name, type: field.type })));
}

/** Nombre de salida de un campo de una fuente (igual que outputFields): con el alias si el nombre se repite. */
export function outputName(model: QbModel, source: QbSource, field: string): string {
  const repeated = model.sources.filter((item) => item.fields.some((candidate) => candidate.name === field)).length > 1;
  return repeated ? `${source.alias}.${field}` : field;
}

/**
 * Incluye o quita columnas del resultado antes de ejecutar (desde las tarjetas del lienzo). Sin lista configurada, se
 * parte de todas visibles. Nunca deja el resultado sin columnas: en ese caso no cambia nada.
 */
export function setOutputVisibility(model: QbModel, names: readonly string[], visible: boolean): QbModel {
  const base = model.columns.length ? model.columns : outputFields(model).map((field) => ({ name: field.name, visible: true, alias: '' }));
  const targets = new Set(names);
  const columns = base.map((column) => (targets.has(column.name) ? { ...column, visible } : column));
  if (!columns.some((column) => column.visible)) return model;
  return { ...model, columns };
}

/**
 * Completa la lista de columnas de un reporte guardado: las que no estaban en `columnas` se habían ocultado, así que
 * se agregan ocultas al final (sin lista guardada, se muestran todas).
 */
export function withHiddenColumns(model: QbModel): QbModel {
  if (!model.columns.length) return model;
  const known = new Set(model.columns.map((column) => column.name));
  const missing = outputFields(model).filter((field) => !known.has(field.name)).map((field) => ({ name: field.name, visible: false, alias: '' }));
  return missing.length ? { ...model, columns: [...model.columns, ...missing] } : model;
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

/** Valor de un filtro sobre la tabla combinada: el motor compara números y texto con flexibilidad. */
function resultFilterValue(filter: QbFilter): unknown {
  const parse = (raw: string) => (raw === 'true' ? true : raw === 'false' ? false : raw);
  if (filter.operador === 'isNull') return true;
  if (filter.operador === 'in') return filter.valor.split(',').map((item) => item.trim()).filter(Boolean).map(parse);
  if (filter.operador === 'between') return [filter.valor, filter.valor2 ?? ''];
  return ['contains', 'startsWith'].includes(filter.operador) ? filter.valor : parse(filter.valor);
}

/** Filtros válidos de la tabla combinada, con su lógica Y/O. */
export function resultFilterNodes(model: QbModel) {
  const valid = model.resultFilters.filter((filter) => filter.campo && (filter.operador === 'isNull' || filter.valor !== '') && (filter.operador !== 'between' || (filter.valor2 ?? '') !== ''));
  const nodes = valid.map((filter) => ({ campo: filter.campo, operador: filter.operador, valor: resultFilterValue(filter) }));
  return model.resultLogic === 'OR' && nodes.length > 1 ? [{ logica: 'OR' as const, filtros: nodes }] : nodes;
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
    ...(resultFilterNodes(model).length ? { filtrosResultado: resultFilterNodes(model) } : {}),
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
  const resultParts = model.resultFilters.filter((filter) => filter.campo).map((filter) => {
    const column = quote(filter.campo);
    if (filter.operador === 'isNull') return `${column} IS NULL`;
    if (filter.operador === 'contains') return `${column} LIKE ${literal(`%${filter.valor}%`)}`;
    if (filter.operador === 'startsWith') return `${column} LIKE ${literal(`${filter.valor}%`)}`;
    if (filter.operador === 'between') return `${column} BETWEEN ${literal(filter.valor)} AND ${literal(filter.valor2 ?? '')}`;
    if (filter.operador === 'in') return `${column} IN ${literal(filter.valor.split(',').map((item) => item.trim()))}`;
    return `${column} ${OPERATORS[filter.operador].replace('≠', '<>').replace('≥', '>=').replace('≤', '<=')} ${literal(filter.valor)}`;
  });
  if (resultParts.length) {
    const joined = resultParts.join(model.resultLogic === 'OR' ? ' OR ' : ' AND ');
    lines.push(model.groupBy.length || model.metrics.length ? `HAVING ${joined}` : `-- Filtro sobre la tabla combinada:\n--   ${joined}`);
  }
  if (model.sort.length) lines.push(`ORDER BY ${model.sort.map((item) => `${quote(item.campo)} ${item.direccion}`).join(', ')}`);
  if (model.limit) lines.push(`LIMIT ${model.limit}`);
  if (disconnected.length) lines.push(`-- Sin unir: ${disconnected.map((source) => source.alias).join(', ')}`);
  return `${lines.join('\n')};`;
}

/** Filtro del motor → filtro editable (los valores de lista y rango vuelven a texto). */
function toQbFilter(filter: { campo: string; operador: Operator; valor: unknown }): QbFilter {
  return {
    id: uid('f'),
    campo: filter.campo,
    operador: filter.operador,
    valor: Array.isArray(filter.valor) ? (filter.operador === 'between' ? String(filter.valor[0]) : filter.valor.join(', ')) : filter.operador === 'isNull' ? '' : String(filter.valor ?? ''),
    valor2: Array.isArray(filter.valor) && filter.operador === 'between' ? String(filter.valor[1]) : undefined,
  };
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
    filtrosResultado?: unknown[];
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
      filters: flat.map(toQbFilter),
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
    resultLogic: (raw.filtrosResultado ?? []).some((item) => (item as { logica?: string }).logica === 'OR') ? 'OR' : 'AND',
    resultFilters: ((raw.filtrosResultado ?? []).flatMap((item) => {
      const node = item as { logica?: string; filtros?: unknown[] };
      return node.logica ? (node.filtros ?? []) : [node];
    }) as { campo: string; operador: Operator; valor: unknown }[]).map(toQbFilter),
  };
}
