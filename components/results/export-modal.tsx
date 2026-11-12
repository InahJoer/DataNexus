'use client';

import { useState } from 'react';
import { Modal } from '@/components/app-shell/modal';
import { Icon, type IconName } from '@/components/icons';
import { apiBaseUrl } from '@/lib/api/client';
import { apiErrorMessage, NETWORK_ERROR_MESSAGE } from '@/lib/api/errors';
import { useAuth } from '@/lib/auth-context';
import type { components } from '@/lib/api/schema';

type ExportBody = components['schemas']['ExportCrossJoinDto'];
type ExportDataBody = components['schemas']['ExportDataDto'];
type Format = ExportBody['format'];
type JoinRowLimit = NonNullable<ExportBody['limiteFilas']>;

const FORMATS: { value: Format; label: string; ext: string; detail: string; icon: IconName }[] = [
  { value: 'excel', label: 'Excel', ext: 'xlsx', detail: 'Hoja de cálculo con encabezados', icon: 'grid' },
  { value: 'csv', label: 'CSV', ext: 'csv', detail: 'Texto separado por comas (Excel, Sheets…)', icon: 'table' },
  { value: 'pdf', label: 'PDF', ext: 'pdf', detail: 'Documento listo para compartir', icon: 'layers' },
  { value: 'word', label: 'Word', ext: 'docx', detail: 'Tabla en documento editable', icon: 'mail' },
  { value: 'json', label: 'JSON', ext: 'json', detail: 'Datos para integraciones', icon: 'join' },
];
const JOIN_LIMITS: JoinRowLimit[] = [50, 100, 500, 1000];
const DATA_LIMITS = [100, 500, 1000, 5000];
/** Máximo de filas que el explorador exporta por archivo (MAX_DATA_EXPORT_ROWS del backend). */
export const MAX_DATA_EXPORT_ROWS = 10_000;

/** Qué se exporta: el resultado de un cruce o una tabla/colección del explorador con su vista (filtros, orden, columnas). */
export type ExportTarget =
  | { kind: 'join'; payload: Omit<ExportBody, 'format' | 'limiteFilas'>; total: number }
  | { kind: 'data'; body: Omit<ExportDataBody, 'format' | 'limiteFilas'> };

type ExportModalProps = Readonly<{
  target: ExportTarget;
  /** Nombre sugerido del archivo, sin extensión. */
  defaultName?: string;
  /** Texto bajo el título (qué se va a exportar). */
  summary?: string;
  onClose: () => void;
}>;

/** Modal de exportación (#67): formato, cuántas filas y nombre del archivo. Los campos sensibles salen enmascarados. */
export function ExportModal({ target, defaultName = 'datanexus-cross-join', summary, onClose }: ExportModalProps) {
  const { session, refreshSession } = useAuth();
  const [format, setFormat] = useState<Format>('excel');
  const [limit, setLimit] = useState<number | 'all'>('all');
  const [filename, setFilename] = useState(defaultName);
  const [isExporting, setIsExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const ext = FORMATS.find((item) => item.value === format)?.ext ?? format;
  const limits = target.kind === 'join' ? JOIN_LIMITS : DATA_LIMITS;

  function request(): { path: string; body: unknown } {
    if (target.kind === 'join') {
      const { limit: _pageLimit, offset: _offset, ...rest } = target.payload;
      return { path: '/engine/export', body: { ...rest, format, ...(limit === 'all' ? {} : { limiteFilas: limit }) } };
    }
    return { path: '/engine/export/data', body: { ...target.body, format, limiteFilas: limit === 'all' ? MAX_DATA_EXPORT_ROWS : limit } };
  }

  async function handleExport() {
    if (!session) return;
    const { path, body } = request();
    const send = (token: string) =>
      fetch(`${apiBaseUrl}${path}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    setIsExporting(true);
    setError(null);
    setDone(null);
    try {
      let response = await send(session.accessToken);
      if (response.status === 401) {
        const renewed = await refreshSession();
        if (!renewed) return;
        response = await send(renewed);
      }
      if (!response.ok) {
        setError(apiErrorMessage(await response.json().catch(() => null), response.status));
        return;
      }
      const name = `${filename.trim().replace(/[\\/:*?"<>|]+/g, '-') || 'datanexus'}.${ext}`;
      const truncated = response.headers.get('X-DataNexus-Truncated') === 'true';
      const url = URL.createObjectURL(await response.blob());
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = name;
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setDone(truncated ? `${name} (recortado a ${limit === 'all' ? MAX_DATA_EXPORT_ROWS.toLocaleString('es') : limit.toLocaleString('es')} filas)` : name);
    } catch {
      setError(NETWORK_ERROR_MESSAGE);
    } finally {
      setIsExporting(false);
    }
  }

  const description =
    summary ??
    (target.kind === 'join'
      ? `${(limit === 'all' ? target.total : Math.min(limit, target.total)).toLocaleString('es')} filas del cruce.`
      : 'Se exporta con los filtros, el orden y las columnas visibles de la vista.');

  return (
    <Modal
      title="Exportar"
      description={`${description} Los campos sensibles se exportan enmascarados según tu rol.`}
      onClose={onClose}
      footer={
        <>
          {done && <span className="connection-test connection-test--ok" role="status"><Icon name="check" size={14} />Descargado {done}</span>}
          <button className="button form-secondary" type="button" onClick={onClose}>Cerrar</button>
          <button className="button button--primary form-primary" type="button" onClick={() => void handleExport()} disabled={isExporting}>
            {isExporting ? 'Generando archivo…' : `Descargar .${ext}`}
          </button>
        </>
      }
    >
      <fieldset className="export-formats">
        <legend>Formato</legend>
        {FORMATS.map((item) => (
          <label key={item.value} className="export-option" data-selected={item.value === format}>
            <input type="radio" name="format" value={item.value} checked={item.value === format} onChange={() => setFormat(item.value)} />
            <Icon name={item.icon} size={18} />
            <span><strong>{item.label} <small>.{item.ext}</small></strong><small>{item.detail}</small></span>
          </label>
        ))}
      </fieldset>
      <div className="form-grid export-options">
        <label className="form-field">
          <span>Filas</span>
          <select className="form-input" value={limit} onChange={(event) => setLimit(event.target.value === 'all' ? 'all' : Number(event.target.value))}>
            <option value="all">
              {target.kind === 'join' ? `Todas (${target.total.toLocaleString('es')})` : `Todas (hasta ${MAX_DATA_EXPORT_ROWS.toLocaleString('es')})`}
            </option>
            {limits.map((value) => <option key={value} value={value}>Primeras {value.toLocaleString('es')}</option>)}
          </select>
        </label>
        <label className="form-field">
          <span>Nombre del archivo</span>
          <input className="form-input" value={filename} onChange={(event) => setFilename(event.target.value)} maxLength={80} />
        </label>
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
    </Modal>
  );
}
