// Convierte backend/coverage/coverage-summary.json (Vitest + v8) en una tabla Markdown para el
// resumen del job de GitHub Actions. Uso: node .github/scripts/coverage-summary.mjs <ruta-al-json>
import { readFileSync } from 'node:fs';

const path = process.argv[2] ?? 'backend/coverage/coverage-summary.json';
const { total } = JSON.parse(readFileSync(path, 'utf8'));

const metrics = [
  ['Líneas', total.lines],
  ['Sentencias', total.statements],
  ['Funciones', total.functions],
  ['Ramas', total.branches],
];
const icon = (pct) => (pct >= 80 ? '🟢' : pct >= 50 ? '🟡' : '🔴');

const rows = metrics.map(([label, metric]) => `| ${label} | ${icon(metric.pct)} ${metric.pct.toFixed(2)} % | ${metric.covered} / ${metric.total} |`);

console.log(['## Cobertura del backend', '', '| Métrica | Cobertura | Cubiertas / total |', '| --- | --- | --- |', ...rows, '', '_Reporte completo (lcov) en el artefacto `backend-coverage`._'].join('\n'));
