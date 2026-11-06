import { describe, expect, it } from 'vitest';
import { performance } from 'node:perf_hooks';
import { createRowFlattener, executeJoinPlan, validateJoinPlan, type JoinType } from './join-plan.js';

/**
 * Benchmark del motor de joins en memoria con 100.000 filas por fuente (issue #30). Mide solo el join y el
 * aplanado (la extracción depende de cada motor). Resultados documentados en docs/BENCHMARK-CROSS-JOIN.md.
 * Ejecutar con: npm run bench:join. No corre en npm test: competiría por CPU con las pruebas que miden tiempos.
 */
const runBenchmark = typeof globalThis.gc === 'function';
const ROWS = 100_000;
const source = (alias: string) => ({ alias, conexionId: alias, entidad: alias });

const clientes = Array.from({ length: ROWS }, (_, i) => ({ id: i, nombre: `Cliente ${i}`, email: `c${i}@corp.com`, pais: i % 2 ? 'NI' : 'CR' }));
// 90 % de los pedidos tienen cliente; el 10 % apunta a clientes inexistentes (para LEFT/RIGHT/FULL).
const pedidos = Array.from({ length: ROWS }, (_, i) => ({
  numero: `P${i}`,
  cliente_id: i % 10 === 0 ? `X${i}` : String(i),
  total: (i % 500) + 0.5,
}));
const envios = Array.from({ length: ROWS }, (_, i) => ({ pedido: `P${i}`, cliente: i, estado: i % 3 ? 'entregado' : 'en ruta' }));

function measure(label: string, run: () => number) {
  globalThis.gc?.();
  const heapBefore = process.memoryUsage().heapUsed;
  const start = performance.now();
  const rows = run();
  const ms = performance.now() - start;
  const heapMb = (process.memoryUsage().heapUsed - heapBefore) / 1024 / 1024;
  console.log(`${label.padEnd(44)} ${String(rows).padStart(7)} filas  ${ms.toFixed(0).padStart(5)} ms  ${heapMb.toFixed(0).padStart(4)} MB`);
  return { rows, ms };
}

describe.runIf(runBenchmark)('Benchmark de joins en memoria (100.000 filas por fuente)', () => {
  it.each<[JoinType, number]>([
    ['INNER', 90_000],
    ['LEFT', 100_000],
    ['RIGHT', 100_000],
    ['FULL', 110_000],
  ])('%s de 2 fuentes', (tipo, expected) => {
    const plan = validateJoinPlan([source('clientes'), source('pedidos')], [
      { izquierda: 'clientes', derecha: 'pedidos', tipo, llaves: [{ izquierda: 'id', derecha: 'cliente_id' }] },
    ]);
    const records = new Map<string, Record<string, unknown>[]>([
      ['clientes', clientes],
      ['pedidos', pedidos],
    ]);
    const { rows, ms } = measure(`${tipo} clientes x pedidos`, () => {
      const flatten = createRowFlattener(plan, records);
      return executeJoinPlan(plan, records, 1_000_000).map(flatten).length;
    });
    expect(rows).toBe(expected);
    expect(ms).toBeLessThan(10_000);
  });

  it('3 fuentes: INNER + LEFT con llave compuesta', () => {
    const plan = validateJoinPlan([source('clientes'), source('pedidos'), source('envios')], [
      { izquierda: 'clientes', derecha: 'pedidos', tipo: 'INNER', llaves: [{ izquierda: 'id', derecha: 'cliente_id' }] },
      {
        izquierda: 'pedidos',
        derecha: 'envios',
        tipo: 'LEFT',
        llaves: [
          { izquierda: 'numero', derecha: 'pedido' },
          { izquierda: 'cliente_id', derecha: 'cliente' },
        ],
      },
    ]);
    const records = new Map<string, Record<string, unknown>[]>([
      ['clientes', clientes],
      ['pedidos', pedidos],
      ['envios', envios],
    ]);
    const { rows, ms } = measure('INNER + LEFT clientes x pedidos x envios', () => {
      const flatten = createRowFlattener(plan, records);
      return executeJoinPlan(plan, records, 1_000_000).map(flatten).length;
    });
    expect(rows).toBe(90_000);
    expect(ms).toBeLessThan(15_000);
  });
});
