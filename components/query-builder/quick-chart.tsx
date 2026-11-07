'use client';

import { useMemo, useState } from 'react';

type Row = Record<string, unknown>;

/**
 * Gráfico rápido del resultado agrupado: barras horizontales de una métrica por cada grupo (los 15 mayores).
 * Solo lectura; sirve para ver de un vistazo lo que dice la tabla.
 */
export function QuickChart({ rows, labelColumns, metrics }: Readonly<{ rows: Row[]; labelColumns: string[]; metrics: string[] }>) {
  const numeric = metrics.filter((metric) => rows.some((row) => typeof row[metric] === 'number'));
  const [metric, setMetric] = useState(numeric[0] ?? '');
  const bars = useMemo(() => {
    const items = rows
      .map((row) => ({ label: labelColumns.map((column) => String(row[column] ?? '—')).join(' · ') || 'Total', value: typeof row[metric] === 'number' ? (row[metric] as number) : 0 }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 15);
    const max = Math.max(1, ...items.map((item) => Math.abs(item.value)));
    return items.map((item) => ({ ...item, pct: Math.round((Math.abs(item.value) / max) * 100) }));
  }, [rows, labelColumns, metric]);

  if (!numeric.length) return null;
  return (
    <section className="qb-chart" aria-label="Gráfico del resultado">
      <header>
        <strong>Gráfico rápido</strong>
        <select className="form-input compact-select" value={metric} onChange={(event) => setMetric(event.target.value)} aria-label="Métrica del gráfico">
          {numeric.map((name) => <option key={name} value={name}>{name}</option>)}
        </select>
      </header>
      <svg viewBox={`0 0 600 ${bars.length * 28 + 8}`} role="img" aria-label={`Barras de ${metric} por ${labelColumns.join(', ') || 'total'}`}>
        {bars.map((bar, index) => (
          <g key={`${bar.label}-${index}`} transform={`translate(0 ${index * 28 + 4})`}>
            <text x="0" y="15" className="qb-chart-label">{bar.label.length > 24 ? `${bar.label.slice(0, 23)}…` : bar.label}</text>
            <rect x="170" y="2" height="18" rx="4" width={Math.max(2, bar.pct * 3.4)} className="qb-chart-bar" />
            <text x={176 + Math.max(2, bar.pct * 3.4)} y="15" className="qb-chart-value">{bar.value.toLocaleString('es', { maximumFractionDigits: 2 })}</text>
          </g>
        ))}
      </svg>
    </section>
  );
}
