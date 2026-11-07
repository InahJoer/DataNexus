'use client';

import { useState } from 'react';
import { Modal } from '@/components/app-shell/modal';
import { Icon, type IconName } from '@/components/icons';
import { apiBaseUrl } from '@/lib/api/client';
import { apiErrorMessage, NETWORK_ERROR_MESSAGE } from '@/lib/api/errors';
import { useAuth } from '@/lib/auth-context';
import type { components } from '@/lib/api/schema';

type ExportBody = components['schemas']['ExportCrossJoinDto'];
type Format = ExportBody['format'];
type RowLimit = NonNullable<ExportBody['limiteFilas']>;

const FORMATS: { value: Format; label: string; ext: string; detail: string; icon: IconName }[] = [
  { value: 'excel', label: 'Excel', ext: 'xlsx', detail: 'Hoja de cálculo con encabezados', icon: 'grid' },
  { value: 'pdf', label: 'PDF', ext: 'pdf', detail: 'Documento listo para compartir', icon: 'layers' },
  { value: 'json', label: 'JSON', ext: 'json', detail: 'Datos para integraciones', icon: 'join' },
  { value: 'word', label: 'Word', ext: 'docx', detail: 'Tabla en documento editable', icon: 'mail' },
];
const LIMITS: RowLimit[] = [50, 100, 500, 1000];

type ExportModalProps = Readonly<{
  /** Configuración del cruce ya ejecutado (fuentes, llaves, filtros). */
  payload: Omit<ExportBody, 'format' | 'limiteFilas'>;
  total: number;
  onClose: () => void;
}>;

/** Modal de exportación (#67): formato, cuántas filas y nombre del archivo. Los campos sensibles salen enmascarados. */
export function ExportModal({ payload, total, onClose }: ExportModalProps) {
  const { session, refreshSession } = useAuth();
  const [format, setFormat] = useState<Format>('excel');
  const [limit, setLimit] = useState<RowLimit | 'all'>('all');
  const [filename, setFilename] = useState('datanexus-cross-join');
  const [isExporting, setIsExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const ext = FORMATS.find((item) => item.value === format)?.ext ?? format;

  async function handleExport() {
    if (!session) return;
    const { limit: _pageLimit, offset: _offset, ...rest } = payload;
    const body: ExportBody = { ...rest, format, ...(limit === 'all' ? {} : { limiteFilas: limit }) };
    const send = (token: string) =>
      fetch(`${apiBaseUrl}/engine/export`, {
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
      const name = `${filename.trim().replace(/[\\/:*?"<>|]+/g, '-') || 'datanexus-cross-join'}.${ext}`;
      const url = URL.createObjectURL(await response.blob());
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = name;
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setDone(name);
    } catch {
      setError(NETWORK_ERROR_MESSAGE);
    } finally {
      setIsExporting(false);
    }
  }

  const rowsToExport = limit === 'all' ? total : Math.min(limit, total);

  return (
    <Modal
      title="Exportar resultados"
      description={`${rowsToExport.toLocaleString('es')} filas del cruce. Los campos sensibles se exportan enmascarados según tu rol.`}
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
          <select className="form-input" value={limit} onChange={(event) => setLimit(event.target.value === 'all' ? 'all' : (Number(event.target.value) as RowLimit))}>
            <option value="all">Todas ({total.toLocaleString('es')})</option>
            {LIMITS.map((value) => <option key={value} value={value}>Primeras {value}</option>)}
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
