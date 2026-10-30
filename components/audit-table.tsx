'use client';

import { type FormEvent, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Icon } from '@/components/icons';
import { createApiClient } from '@/lib/api/client';
import { useAuth } from '@/lib/auth-context';
import type { components } from '@/lib/api/schema';

type AuditPage = components['schemas']['PaginatedAuditLogsResponseDto'];
type AuditEntry = components['schemas']['AuditLogEntryResponseDto'];

type AuditFilters = {
  startDate: string;
  endDate: string;
  eventType: string;
};

const EMPTY_FILTERS: AuditFilters = { startDate: '', endDate: '', eventType: '' };
const PAGE_SIZES = [25, 50, 100];
const EVENT_TYPES = [
  { value: 'LOGIN_SUCCESS', label: 'Inicio de sesión correcto' },
  { value: 'LOGIN_FAILURE', label: 'Intento de acceso fallido' },
  { value: 'USER_ROLE_CHANGED', label: 'Cambio de rol' },
  { value: 'CONNECTION_CREATED', label: 'Conexión creada' },
  { value: 'CONNECTION_UPDATED', label: 'Conexión actualizada' },
  { value: 'CONNECTION_DELETED', label: 'Conexión eliminada' },
  { value: 'REPORT_GENERATED_AND_SENT', label: 'Reporte enviado' },
] as const;

function toIsoBoundary(value: string, endOfDay = false) {
  if (!value) return undefined;
  const date = new Date(`${value}T${endOfDay ? '23:59:59.999' : '00:00:00'}`);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat('es', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}

function eventLabel(value: string) {
  return EVENT_TYPES.find((event) => event.value === value)?.label ?? value.replaceAll('_', ' ');
}

function formatDetails(value: string | null) {
  if (!value) return '—';
  try {
    const details = JSON.parse(value) as Record<string, unknown>;
    return Object.entries(details)
      .map(([key, detail]) => `${key}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`)
      .join(' · ') || '—';
  } catch {
    return value;
  }
}

function describeError(value: unknown) {
  if (!value || typeof value !== 'object' || !('message' in value)) return null;
  return typeof value.message === 'string' ? value.message : null;
}

function AuditRow({ entry }: { entry: AuditEntry }) {
  const details = formatDetails(entry.detailsJson);
  return (
    <tr>
      <td className="audit-date">{formatDateTime(entry.createdAt)}</td>
      <td><span className="audit-event-badge">{eventLabel(entry.eventType)}</span></td>
      <td className="audit-actor">{entry.actorEmail ?? entry.actorUserId ?? 'Sistema'}</td>
      <td className="audit-target">
        {entry.targetType || entry.targetId
          ? <><strong>{entry.targetType ?? 'Recurso'}</strong><span>{entry.targetId ?? '—'}</span></>
          : '—'}
      </td>
      <td><span className={`audit-outcome${entry.outcome === 'FAILURE' ? ' audit-outcome--failure' : ''}`}>{entry.outcome === 'FAILURE' ? 'Fallido' : 'Correcto'}</span></td>
      <td className="audit-details" title={details}>{details}</td>
    </tr>
  );
}

export function AuditTable() {
  const { session, logout } = useAuth();
  const router = useRouter();
  const accessToken = session?.accessToken;
  const isAdmin = session?.user.role === 'ADMIN';
  const [draftFilters, setDraftFilters] = useState<AuditFilters>(EMPTY_FILTERS);
  const [filters, setFilters] = useState<AuditFilters>(EMPTY_FILTERS);
  const [filterError, setFilterError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [auditPage, setAuditPage] = useState<AuditPage | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!isAdmin || !accessToken) return;
    let cancelled = false;
    setIsLoading(true);
    setErrorMessage(null);

    const query = {
      page,
      limit: pageSize,
      ...(filters.startDate ? { fechaInicio: toIsoBoundary(filters.startDate) } : {}),
      ...(filters.endDate ? { fechaFin: toIsoBoundary(filters.endDate, true) } : {}),
      ...(filters.eventType ? { tipoAccion: filters.eventType } : {}),
    };

    async function loadAuditLogs() {
      try {
        const response = await createApiClient(accessToken).GET('/audit/logs', { params: { query } });
        if (cancelled) return;
        if (response.response.status === 401) {
          logout();
          router.replace('/login');
          return;
        }
        if (response.response.status === 403) {
          setErrorMessage('Solo ADMIN puede consultar la bitácora de auditoría.');
          return;
        }
        if (!response.response.ok || !response.data) {
          setErrorMessage(describeError('error' in response ? response.error : null) ?? 'No se pudieron cargar los registros de auditoría.');
          return;
        }
        setAuditPage(response.data);
      } catch {
        if (!cancelled) setErrorMessage('No se pudo conectar con la API de DataNexus.');
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }

    void loadAuditLogs();
    return () => { cancelled = true; };
  }, [accessToken, filters, isAdmin, logout, page, pageSize, reloadKey, router]);

  if (!isAdmin || !session) return null;

  function applyFilters(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (draftFilters.startDate && draftFilters.endDate && draftFilters.startDate > draftFilters.endDate) {
      setFilterError('La fecha inicial debe ser anterior o igual a la fecha final.');
      return;
    }
    setFilterError(null);
    setFilters(draftFilters);
    setPage(1);
  }

  function clearFilters() {
    setDraftFilters(EMPTY_FILTERS);
    setFilters(EMPTY_FILTERS);
    setFilterError(null);
    setPage(1);
  }

  const totalPages = auditPage?.totalPages ?? 0;

  return (
    <section className="surface-card audit-card" id="activity" aria-labelledby="audit-title" aria-busy={isLoading}>
      <header className="audit-header">
        <div>
          <p className="audit-eyebrow">SEGURIDAD DEL WORKSPACE</p>
          <h2 id="audit-title">Bitácora de auditoría</h2>
          <p>Consulta accesos y cambios registrados en este workspace.</p>
        </div>
        <span className="audit-admin-badge"><Icon name="shield" size={14} />Solo ADMIN</span>
      </header>

      <form className="audit-filters" onSubmit={applyFilters}>
        <label className="audit-filter-field">
          <span>Desde</span>
          <input type="date" value={draftFilters.startDate} onChange={(event) => setDraftFilters((current) => ({ ...current, startDate: event.target.value }))} />
        </label>
        <label className="audit-filter-field">
          <span>Hasta</span>
          <input type="date" value={draftFilters.endDate} onChange={(event) => setDraftFilters((current) => ({ ...current, endDate: event.target.value }))} />
        </label>
        <label className="audit-filter-field audit-filter-field--event">
          <span>Tipo de evento</span>
          <select value={draftFilters.eventType} onChange={(event) => setDraftFilters((current) => ({ ...current, eventType: event.target.value }))}>
            <option value="">Todos los eventos</option>
            {EVENT_TYPES.map((eventType) => <option key={eventType.value} value={eventType.value}>{eventType.label}</option>)}
          </select>
        </label>
        <div className="audit-filter-actions">
          <button className="button button--primary audit-apply-button" type="submit"><Icon name="search" size={14} />Aplicar filtros</button>
          <button className="audit-clear-button" type="button" onClick={clearFilters}>Limpiar</button>
        </div>
      </form>

      {filterError && <p className="audit-error" role="alert">{filterError}</p>}
      {errorMessage && (
        <div className="audit-error audit-error--request" role="alert">
          <span>{errorMessage}</span>
          <button type="button" onClick={() => setReloadKey((current) => current + 1)}>Reintentar</button>
        </div>
      )}

      <div className="audit-summary" aria-live="polite">
        <span>{isLoading ? 'Cargando registros…' : `${(auditPage?.total ?? 0).toLocaleString('es')} eventos`}</span>
        <label>Filas
          <select value={pageSize} onChange={(event) => { setPageSize(Number(event.target.value)); setPage(1); }}>
            {PAGE_SIZES.map((size) => <option key={size} value={size}>{size}</option>)}
          </select>
        </label>
      </div>

      <div className="audit-table-wrap">
        <table className="audit-table">
          <thead><tr><th>Fecha y hora</th><th>Evento</th><th>Usuario</th><th>Recurso</th><th>Resultado</th><th>Detalles</th></tr></thead>
          <tbody>
            {isLoading && !auditPage ? (
              <tr><td className="audit-table-message" colSpan={6}>Cargando bitácora…</td></tr>
            ) : auditPage?.data.length ? (
              auditPage.data.map((entry) => <AuditRow key={entry.id} entry={entry} />)
            ) : !errorMessage ? (
              <tr><td className="audit-table-message" colSpan={6}>No hay eventos que coincidan con estos filtros.</td></tr>
            ) : null}
          </tbody>
        </table>
      </div>

      <footer className="audit-pagination">
        <span>{auditPage?.total ? `Página ${auditPage.page} de ${Math.max(1, totalPages)}` : 'Sin resultados'}</span>
        <div>
          <button type="button" onClick={() => setPage((current) => Math.max(1, current - 1))} disabled={page <= 1 || isLoading}>Anterior</button>
          <button type="button" onClick={() => setPage((current) => current + 1)} disabled={!auditPage || page >= totalPages || isLoading}>Siguiente</button>
        </div>
      </footer>
    </section>
  );
}
