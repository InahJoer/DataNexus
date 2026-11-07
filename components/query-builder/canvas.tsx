'use client';

import { useRef, useState, type DragEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { ENGINES, type Engine } from '@/components/connections/engines';
import { Icon } from '@/components/icons';
import {
  CARD_HEADER,
  CARD_WIDTH,
  FIELD_HEIGHT,
  MAX_FIELDS_SHOWN,
  joinCompatibility,
  type JoinType,
  type QbLink,
  type QbModel,
  type QbSource,
} from '@/components/query-builder/model';

export const DRAG_MIME = 'application/x-datanexus-object';
const JOIN_CYCLE: JoinType[] = ['INNER', 'LEFT', 'RIGHT', 'FULL'];
const TYPE_ICON: Record<string, string> = { número: '#', texto: 'Aa', fecha: '◷', booleano: '◐', objeto: '{}', lista: '[]', desconocido: '·' };

type Point = { x: number; y: number };
type CanvasProps = Readonly<{
  model: QbModel;
  suggestions: QbLink[];
  selectedSource: string | null;
  onSelectSource: (id: string | null) => void;
  onMoveSource: (id: string, x: number, y: number, commit: boolean) => void;
  onRemoveSource: (id: string) => void;
  onLink: (link: Omit<QbLink, 'id' | 'type'>) => void;
  onLinkChange: (id: string, type: JoinType | null) => void;
  onAcceptSuggestion: (link: QbLink) => void;
  onDropObject: (data: string, at: Point) => void;
  onAutoLayout: () => void;
}>;

function fieldIndex(source: QbSource, field: string, expanded: boolean) {
  const index = source.fields.findIndex((item) => item.name === field);
  const limit = expanded ? source.fields.length : MAX_FIELDS_SHOWN;
  return index < 0 || index >= limit ? Math.min(source.fields.length, limit) : index;
}

/** Lienzo del Query Builder (#45): tarjetas de entidad con sus campos y líneas de unión entre campos. */
export function QueryCanvas(props: CanvasProps) {
  const { model, suggestions, selectedSource } = props;
  const viewportRef = useRef<HTMLDivElement>(null);
  const [pan, setPan] = useState<Point>({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [linking, setLinking] = useState<{ source: string; field: string; from: Point; to: Point } | null>(null);
  const drag = useRef<{ kind: 'pan' | 'card'; id?: string; start: Point; origin: Point; moved: boolean } | null>(null);

  const toCanvas = (clientX: number, clientY: number): Point => {
    const rect = viewportRef.current?.getBoundingClientRect();
    return { x: (clientX - (rect?.left ?? 0) - pan.x) / zoom, y: (clientY - (rect?.top ?? 0) - pan.y) / zoom };
  };

  const port = (source: QbSource, field: string, side: 'left' | 'right'): Point => ({
    x: source.x + (side === 'right' ? CARD_WIDTH : 0),
    y: source.y + CARD_HEADER + fieldIndex(source, field, Boolean(expanded[source.id])) * FIELD_HEIGHT + FIELD_HEIGHT / 2,
  });

  const linkPath = (link: Pick<QbLink, 'from' | 'to'>) => {
    const from = model.sources.find((source) => source.id === link.from.source);
    const to = model.sources.find((source) => source.id === link.to.source);
    if (!from || !to) return null;
    const leftToRight = from.x + CARD_WIDTH / 2 <= to.x + CARD_WIDTH / 2;
    const a = port(from, link.from.field, leftToRight ? 'right' : 'left');
    const b = port(to, link.to.field, leftToRight ? 'left' : 'right');
    const bend = Math.max(60, Math.abs(b.x - a.x) / 2) * (leftToRight ? 1 : -1);
    return { d: `M${a.x},${a.y} C${a.x + bend},${a.y} ${b.x - bend},${b.y} ${b.x},${b.y}`, mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, from, to };
  };

  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    const target = event.target as HTMLElement;
    if (target.closest('[data-port]') || target.closest('button, input, select')) return;
    const card = target.closest<HTMLElement>('[data-card]');
    if (card) {
      const source = model.sources.find((item) => item.id === card.dataset.card);
      if (!source) return;
      props.onSelectSource(source.id);
      drag.current = { kind: 'card', id: source.id, start: { x: event.clientX, y: event.clientY }, origin: { x: source.x, y: source.y }, moved: false };
    } else {
      props.onSelectSource(null);
      drag.current = { kind: 'pan', start: { x: event.clientX, y: event.clientY }, origin: pan, moved: false };
    }
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  }

  function onPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    if (linking) {
      setLinking({ ...linking, to: toCanvas(event.clientX, event.clientY) });
      return;
    }
    const current = drag.current;
    if (!current) return;
    const dx = event.clientX - current.start.x;
    const dy = event.clientY - current.start.y;
    current.moved = current.moved || Math.abs(dx) + Math.abs(dy) > 3;
    if (current.kind === 'pan') setPan({ x: current.origin.x + dx, y: current.origin.y + dy });
    else if (current.id) props.onMoveSource(current.id, Math.max(0, current.origin.x + dx / zoom), Math.max(0, current.origin.y + dy / zoom), false);
  }

  function onPointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    if (linking) {
      const element = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('[data-field]');
      const target = element ? { source: element.dataset.source ?? '', field: element.dataset.field ?? '' } : null;
      if (target && target.source && target.source !== linking.source) props.onLink({ from: { source: linking.source, field: linking.field }, to: target });
      setLinking(null);
    }
    const current = drag.current;
    if (current?.kind === 'card' && current.id && current.moved) {
      const source = model.sources.find((item) => item.id === current.id);
      if (source) props.onMoveSource(source.id, source.x, source.y, true);
    }
    drag.current = null;
  }

  function startLink(event: ReactPointerEvent, source: QbSource, field: string, side: 'left' | 'right') {
    event.stopPropagation();
    const from = port(source, field, side);
    setLinking({ source: source.id, field, from, to: from });
    viewportRef.current?.setPointerCapture(event.pointerId);
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    const data = event.dataTransfer.getData(DRAG_MIME);
    if (!data) return;
    event.preventDefault();
    const at = toCanvas(event.clientX, event.clientY);
    props.onDropObject(data, { x: Math.max(0, at.x - CARD_WIDTH / 2), y: Math.max(0, at.y - 20) });
  }

  const setZoomAround = (next: number) => setZoom(Math.min(1.6, Math.max(0.4, Math.round(next * 10) / 10)));
  const width = Math.max(1200, ...model.sources.map((source) => source.x + CARD_WIDTH + 200));
  const height = Math.max(700, ...model.sources.map((source) => source.y + CARD_HEADER + Math.min(source.fields.length, MAX_FIELDS_SHOWN) * FIELD_HEIGHT + 200));

  return (
    <div className="qb-canvas-shell">
      <div className="qb-canvas-tools" role="toolbar" aria-label="Herramientas del lienzo">
        <button type="button" className="shell-icon-button" aria-label="Alejar" onClick={() => setZoomAround(zoom - 0.1)}>−</button>
        <span className="qb-zoom">{Math.round(zoom * 100)}%</span>
        <button type="button" className="shell-icon-button" aria-label="Acercar" onClick={() => setZoomAround(zoom + 0.1)}>+</button>
        <button type="button" className="row-action" onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }); }}>Centrar</button>
        <button type="button" className="row-action" onClick={props.onAutoLayout} disabled={model.sources.length < 2}>Ordenar tarjetas</button>
      </div>

      <div
        className="qb-viewport"
        ref={viewportRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onWheel={(event) => { if (event.ctrlKey || event.metaKey) { event.preventDefault(); setZoomAround(zoom - Math.sign(event.deltaY) * 0.1); } }}
        onDragOver={(event) => { if (event.dataTransfer.types.includes(DRAG_MIME)) event.preventDefault(); }}
        onDrop={onDrop}
        data-linking={linking ? 'true' : undefined}
      >
        {model.sources.length === 0 && (
          <div className="qb-empty">
            <Icon name="join" size={26} />
            <strong>Arrastra aquí tablas, colecciones o subcolecciones</strong>
            <span>Luego une un campo con otro arrastrando desde el punto de un campo hasta el campo de otra tarjeta.</span>
          </div>
        )}
        <div className="qb-stage" style={{ width, height, transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}>
          <svg className="qb-links" width={width} height={height} aria-hidden="true">
            {suggestions.map((link) => {
              const path = linkPath(link);
              return path && <path key={link.id} d={path.d} className="qb-link qb-link--suggested" />;
            })}
            {model.links.map((link) => {
              const path = linkPath(link);
              if (!path) return null;
              const a = path.from.fields.find((field) => field.name === link.from.field)?.type ?? 'desconocido';
              const b = path.to.fields.find((field) => field.name === link.to.field)?.type ?? 'desconocido';
              return <path key={link.id} d={path.d} className="qb-link" data-compat={joinCompatibility(a, b)} />;
            })}
            {linking && <path d={`M${linking.from.x},${linking.from.y} L${linking.to.x},${linking.to.y}`} className="qb-link qb-link--draft" />}
          </svg>

          {model.links.map((link) => {
            const path = linkPath(link);
            if (!path) return null;
            const a = path.from.fields.find((field) => field.name === link.from.field)?.type ?? 'desconocido';
            const b = path.to.fields.find((field) => field.name === link.to.field)?.type ?? 'desconocido';
            const compat = joinCompatibility(a, b);
            return (
              <div key={link.id} className="qb-link-label" data-compat={compat} style={{ left: path.mid.x, top: path.mid.y }}
                title={compat === 'ok' ? `${link.from.field} = ${link.to.field}` : compat === 'warning' ? `Tipos distintos (${a} y ${b}): puede no coincidir` : `Tipos incompatibles (${a} y ${b})`}>
                <button type="button" onClick={() => props.onLinkChange(link.id, JOIN_CYCLE[(JOIN_CYCLE.indexOf(link.type) + 1) % JOIN_CYCLE.length])}>{link.type}</button>
                <button type="button" aria-label="Quitar unión" onClick={() => props.onLinkChange(link.id, null)}>×</button>
              </div>
            );
          })}
          {suggestions.map((link) => {
            const path = linkPath(link);
            return path && (
              <button key={link.id} type="button" className="qb-suggestion" style={{ left: path.mid.x, top: path.mid.y }} onClick={() => props.onAcceptSuggestion(link)} title={`Unir ${link.from.field} = ${link.to.field}`}>
                + Unir {link.from.field} = {link.to.field}
              </button>
            );
          })}

          {model.sources.map((source) => {
            const isExpanded = Boolean(expanded[source.id]);
            const shown = isExpanded ? source.fields : source.fields.slice(0, MAX_FIELDS_SHOWN);
            const linkedFields = new Set(model.links.flatMap((link) => [link.from.source === source.id ? link.from.field : '', link.to.source === source.id ? link.to.field : '']));
            const engine = ENGINES[source.engine as Engine];
            return (
              <article key={source.id} className="qb-card" data-card={source.id} data-selected={selectedSource === source.id || undefined} style={{ left: source.x, top: source.y, width: CARD_WIDTH }}>
                <header>
                  <span className="engine-badge" data-engine={source.engine}>{engine?.short ?? '?'}</span>
                  <div><strong>{source.alias}</strong><small title={`${source.connectionName} · ${source.entity}`}>{source.entity} · {source.connectionName}</small></div>
                  {source.filters.length > 0 && <span className="qb-filter-count" title="Filtros de esta fuente">{source.filters.length}</span>}
                  <button type="button" aria-label={`Quitar ${source.alias}`} onClick={() => props.onRemoveSource(source.id)}>×</button>
                </header>
                <ul>
                  {shown.map((field) => (
                    <li key={field.name} data-field={field.name} data-source={source.id} data-linked={linkedFields.has(field.name) || undefined}>
                      <span className="qb-port qb-port--left" data-port onPointerDown={(event) => startLink(event, source, field.name, 'left')} />
                      <span className="qb-type" title={field.type}>{TYPE_ICON[field.type]}</span>
                      <span className="qb-field-name" title={field.name}>{field.name}</span>
                      <span className="qb-port qb-port--right" data-port onPointerDown={(event) => startLink(event, source, field.name, 'right')} />
                    </li>
                  ))}
                </ul>
                {source.fields.length > MAX_FIELDS_SHOWN && (
                  <button type="button" className="qb-more" onClick={() => setExpanded((current) => ({ ...current, [source.id]: !isExpanded }))}>
                    {isExpanded ? 'Mostrar menos' : `+${source.fields.length - MAX_FIELDS_SHOWN} campos más`}
                  </button>
                )}
                {source.fields.length === 0 && <p className="qb-loading">Cargando campos…</p>}
              </article>
            );
          })}
        </div>

        {model.sources.length > 1 && (
          <svg className="qb-minimap" viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
            {model.sources.map((source) => <rect key={source.id} x={source.x} y={source.y} width={CARD_WIDTH} height={CARD_HEADER + Math.min(source.fields.length, MAX_FIELDS_SHOWN) * FIELD_HEIGHT} rx={12} />)}
          </svg>
        )}
      </div>
    </div>
  );
}
