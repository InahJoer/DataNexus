'use client';

import Link from 'next/link';
import { useEffect, useRef, useState, type DragEvent, type FormEvent } from 'react';
import { Modal } from '@/components/app-shell/modal';
import type { DataSource } from '@/components/connections/engines';
import type { CatalogObject } from '@/components/explorer/explorer-tree';
import { Icon } from '@/components/icons';
import { apiBaseUrl } from '@/lib/api/client';
import { apiErrorMessage, NETWORK_ERROR_MESSAGE } from '@/lib/api/errors';
import type { components } from '@/lib/api/schema';
import { useApiCall } from '@/lib/api/use-api-call';
import { useAuth } from '@/lib/auth-context';
import { hasPermission } from '@/lib/permissions';

export type ExcelFile = components['schemas']['ExcelFileResponseDto'];
type ExcelTarget = Readonly<{ connection: DataSource; object: CatalogObject }>;

export const EXCEL_ACCEPT = '.xlsx,.xlsm,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv';

/** El archivo como fuente del explorador y del editor: su id funciona como conexionId. */
export const excelSource = (file: ExcelFile): DataSource => ({ id: file.id, nombre: file.nombre, dbName: file.nombreArchivo, tipoMotor: 'EXCEL' });
export const sheetObject = (name: string): CatalogObject => ({ name, type: 'TABLE' });

const formatBytes = (bytes: number) =>
  bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : bytes < 1024 ** 3 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${(bytes / 1024 ** 3).toFixed(2)} GB`;
const formatDate = (value: string) => new Date(value).toLocaleString('es', { dateStyle: 'medium', timeStyle: 'short' });

type UploadResult = { status: number; body: unknown };

/**
 * Sube un archivo nuevo (o reemplaza uno existente) como multipart/form-data con XMLHttpRequest, que, a diferencia de
 * fetch, informa el avance del envío: con archivos de cientos de MB el usuario ve cuánto falta.
 */
function sendFile(token: string, file: File, replaceId: string | undefined, onProgress: (fraction: number) => void): Promise<UploadResult> {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    form.append('archivo', file, file.name);
    const request = new XMLHttpRequest();
    request.open(replaceId ? 'PUT' : 'POST', replaceId ? `${apiBaseUrl}/excel/${encodeURIComponent(replaceId)}/archivo` : `${apiBaseUrl}/excel`);
    request.setRequestHeader('Authorization', `Bearer ${token}`);
    request.responseType = 'json';
    request.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded / event.total);
    };
    request.onload = () => resolve({ status: request.status, body: request.response });
    request.onerror = () => reject(new Error('network'));
    request.send(form);
  });
}

function localError(file: File): string | null {
  if (!/\.(xlsx|xlsm|csv)$/i.test(file.name)) return /\.xls$/i.test(file.name) ? 'El formato .xls (Excel 97-2003) no se admite: guárdalo como .xlsx.' : 'Elige un archivo .xlsx o .csv.';
  if (!file.size) return 'El archivo está vacío.';
  return null;
}

/** Mientras algún archivo se está cargando en el servidor, vuelve a pedir la lista cada segundo y medio. */
export function useExcelProcessingRefresh(files: ExcelFile[] | null | undefined, reload: () => Promise<void> | void) {
  const processing = (files ?? []).some((file) => file.estado === 'PROCESANDO');
  useEffect(() => {
    if (!processing) return;
    const timer = window.setInterval(() => void reload(), 1500);
    return () => window.clearInterval(timer);
  }, [processing, reload]);
}

/** Avance de la carga en el servidor (lectura e inserción de filas). */
export function ExcelProgress({ file }: Readonly<{ file: ExcelFile }>) {
  return (
    <div className="excel-progress" role="status">
      <progress max={100} value={file.progreso} aria-label={`Procesando ${file.nombre}`} />
      <span>Procesando… {file.progreso}% · {file.filasProcesadas.toLocaleString('es')} registros leídos</span>
    </div>
  );
}

type ExcelTreeProps = Readonly<{
  files: ExcelFile[];
  selected: ExcelTarget | null;
  onSelect: (target: ExcelTarget) => void;
  onLibrary: () => void;
}>;

/** Árbol de la pestaña Excels: archivo → hojas. */
export function ExcelTree({ files, selected, onSelect, onLibrary }: ExcelTreeProps) {
  const [filter, setFilter] = useState('');
  const term = filter.trim().toLowerCase();
  const visible = files
    .map((file) => ({ file, sheets: file.hojas.filter((sheet) => !term || sheet.nombre.toLowerCase().includes(term) || file.nombre.toLowerCase().includes(term)) }))
    .filter((item) => item.sheets.length || (item.file.estado !== 'LISTO' && (!term || item.file.nombre.toLowerCase().includes(term))));
  return (
    <nav className="explorer-tree" aria-label="Archivos de Excel">
      <button type="button" className="button form-secondary compact-button excel-tree-library" aria-pressed={!selected} onClick={onLibrary}>
        <Icon name="layers" size={13} />Archivos de Excel
      </button>
      <label className="search-field tree-search">
        <Icon name="search" size={14} />
        <input type="search" placeholder="Buscar archivo u hoja" value={filter} onChange={(event) => setFilter(event.target.value)} aria-label="Buscar en los archivos de Excel" />
      </label>
      {!visible.length && <p className="tree-note">{term ? 'Sin coincidencias' : 'Aún no hay archivos.'}</p>}
      <ul className="tree-root">
        {visible.map(({ file, sheets }) => (
          <li key={file.id}>
            <span className="tree-connection excel-tree-file" title={file.nombreArchivo}>
              <span className="engine-badge" data-engine="EXCEL">XL</span>
              <span className="tree-connection-name">
                {file.nombre}
                <small>{file.estado === 'PROCESANDO' ? `Procesando… ${file.progreso}%` : file.estado === 'ERROR' ? 'Error al cargar' : file.hojas.length === 1 ? '1 hoja' : `${file.hojas.length} hojas`}</small>
              </span>
            </span>
            <ul className="tree-children">
              {sheets.map((sheet) => (
                <li key={sheet.nombre}>
                  <button
                    type="button"
                    className="tree-item"
                    aria-current={selected?.connection.id === file.id && selected.object.name === sheet.nombre ? 'true' : undefined}
                    onClick={() => onSelect({ connection: excelSource(file), object: sheetObject(sheet.nombre) })}
                    title={`${sheet.nombre} · ${sheet.totalFilas} registros · ID: ${sheet.columnaId}`}
                  >
                    <Icon name="table" size={14} />
                    <span>{sheet.nombre}</span>
                    <small>{sheet.totalFilas.toLocaleString('es')}</small>
                  </button>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </nav>
  );
}

type ExcelLibraryProps = Readonly<{
  files: ExcelFile[];
  onChanged: () => Promise<void> | void;
  onOpen: (target: ExcelTarget) => void;
}>;

type Notice = { tone: 'ok' | 'error'; text: string; avisos?: string[] } | null;

/** Biblioteca de archivos: subir (arrastrando o eligiendo), abrir hojas, reemplazar, renombrar y eliminar. */
export function ExcelLibrary({ files, onChanged, onOpen }: ExcelLibraryProps) {
  const call = useApiCall();
  const { session, refreshSession } = useAuth();
  const canManage = hasPermission(session?.user.role, 'MANAGE_EXCEL');
  const picker = useRef<HTMLInputElement>(null);
  const replacePicker = useRef<HTMLInputElement>(null);
  const [replacing, setReplacing] = useState<ExcelFile | null>(null);
  const [busy, setBusy] = useState<{ label: string; fraction: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [renaming, setRenaming] = useState<{ file: ExcelFile; nombre: string } | null>(null);
  const [deleting, setDeleting] = useState<{ file: ExcelFile; usadoEn: { id: string; nombre: string }[] | null } | null>(null);

  async function upload(file: File, target?: ExcelFile) {
    const problem = localError(file);
    if (problem) {
      setNotice({ tone: 'error', text: problem });
      return;
    }
    const label = `${target ? 'Reemplazando' : 'Subiendo'} ${file.name} (${formatBytes(file.size)})`;
    setBusy({ label, fraction: 0 });
    setNotice(null);
    try {
      const onProgress = (fraction: number) => setBusy({ label, fraction });
      let token = session?.accessToken;
      if (!token) throw new Error('Sin sesión');
      let result = await sendFile(token, file, target?.id, onProgress);
      if (result.status === 401) {
        // El token pudo vencer durante una subida larga: se renueva y se reintenta una vez.
        token = (await refreshSession()) ?? undefined;
        if (token) result = await sendFile(token, file, target?.id, onProgress);
      }
      if (result.status < 200 || result.status >= 300) {
        setNotice({ tone: 'error', text: apiErrorMessage(result.body as never, result.status) });
        return;
      }
      const saved = result.body as ExcelFile;
      setNotice({
        tone: 'ok',
        text: `"${saved.nombre}" se recibió y se está procesando en segundo plano. Puedes seguir trabajando: aparecerá listo en esta lista.`,
      });
      await onChanged();
    } catch {
      setNotice({ tone: 'error', text: NETWORK_ERROR_MESSAGE });
    } finally {
      setBusy(null);
    }
  }

  function onDrop(event: DragEvent<HTMLElement>) {
    event.preventDefault();
    setDragging(false);
    const file = event.dataTransfer.files[0];
    if (file && canManage) void upload(file);
  }

  async function askDelete(file: ExcelFile) {
    setDeleting({ file, usadoEn: null });
    const result = await call((api) => api.GET('/excel/{id}', { params: { path: { id: file.id } } })).catch(() => null);
    setDeleting({ file, usadoEn: result?.data?.usadoEn ?? [] });
  }

  async function confirmDelete() {
    if (!deleting) return;
    const { file } = deleting;
    const result = await call((api) => api.DELETE('/excel/{id}', { params: { path: { id: file.id } } })).catch(() => null);
    setDeleting(null);
    if (!result?.response.ok) {
      setNotice({ tone: 'error', text: result ? apiErrorMessage(result.error, result.response.status) : NETWORK_ERROR_MESSAGE });
      return;
    }
    setNotice({ tone: 'ok', text: `"${file.nombre}" se eliminó.` });
    await onChanged();
  }

  async function saveName(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!renaming?.nombre.trim()) return;
    const { file, nombre } = renaming;
    const result = await call((api) => api.PATCH('/excel/{id}', { params: { path: { id: file.id } }, body: { nombre: nombre.trim() } })).catch(() => null);
    if (!result?.response.ok) {
      setNotice({ tone: 'error', text: result ? apiErrorMessage(result.error, result.response.status) : NETWORK_ERROR_MESSAGE });
      return;
    }
    setRenaming(null);
    await onChanged();
  }

  return (
    <section className="excel-library" aria-label="Archivos de Excel">
      <header className="excel-library-head">
        <div>
          <h2>Archivos de Excel</h2>
          <p>Cada hoja se usa como una tabla: la <strong>fila 1</strong> son los nombres de columna y la <strong>columna 1</strong> el identificador de cada registro. Después puedes cruzarlas con tus conexiones en el <Link className="auth-link" href="/queries">editor de consultas</Link>.</p>
        </div>
      </header>

      {canManage && (
        <div
          className="excel-drop"
          data-dragging={dragging || undefined}
          data-busy={busy ? true : undefined}
          onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
        >
          <span className="excel-drop-icon" aria-hidden="true"><Icon name="file" size={22} /></span>
          <div>
            <strong>{busy ? `${busy.label}… ${Math.round(busy.fraction * 100)}%` : 'Arrastra aquí un archivo .xlsx o .csv'}</strong>
            {busy ? (
              <progress className="excel-upload-progress" max={1} value={busy.fraction} aria-label="Avance de la subida" />
            ) : (
              <span>Sin límite de tamaño ni de registros: los archivos grandes (cientos de MB, millones de filas) se procesan en segundo plano. Se leen todas las hojas visibles.</span>
            )}
          </div>
          <button type="button" className="button button--primary compact-button" disabled={Boolean(busy)} onClick={() => picker.current?.click()}>Elegir archivo</button>
          <input ref={picker} type="file" accept={EXCEL_ACCEPT} hidden onChange={(event) => { const file = event.target.files?.[0]; if (file) void upload(file); event.target.value = ''; }} />
          <input ref={replacePicker} type="file" accept={EXCEL_ACCEPT} hidden onChange={(event) => { const file = event.target.files?.[0]; if (file && replacing) void upload(file, replacing); setReplacing(null); event.target.value = ''; }} />
        </div>
      )}

      {notice && (
        <div className={notice.tone === 'ok' ? 'page-notice excel-notice' : 'form-error excel-notice'} role={notice.tone === 'ok' ? 'status' : 'alert'}>
          <p>{notice.text} <button type="button" className="inline-link auth-link" onClick={() => setNotice(null)}>Cerrar</button></p>
          {notice.avisos && notice.avisos.length > 0 && (
            <ul className="excel-warnings">{notice.avisos.map((aviso) => <li key={aviso}>{aviso}</li>)}</ul>
          )}
        </div>
      )}

      {files.length === 0 ? (
        <p className="panel-empty">Aún no hay archivos de Excel en el workspace.{canManage ? ' Sube el primero para explorarlo y cruzarlo con tus bases de datos.' : ''}</p>
      ) : (
        <ul className="excel-files">
          {files.map((file) => (
            <li key={file.id} className="excel-file">
              <div className="excel-file-head">
                <span className="engine-badge" data-engine="EXCEL">XL</span>
                {renaming?.file.id === file.id ? (
                  <form className="excel-rename" onSubmit={(event) => void saveName(event)}>
                    <input className="form-input" aria-label="Nombre del archivo" maxLength={120} value={renaming.nombre} onChange={(event) => setRenaming({ file, nombre: event.target.value })} autoFocus />
                    <button type="submit" className="button button--primary compact-button">Guardar</button>
                    <button type="button" className="button form-secondary compact-button" onClick={() => setRenaming(null)}>Cancelar</button>
                  </form>
                ) : (
                  <div className="excel-file-title">
                    <strong>{file.nombre}</strong>
                    <small>{file.nombreArchivo} · {formatBytes(file.tamanoBytes)}{file.estado === 'LISTO' ? ` · ${file.filasProcesadas.toLocaleString('es')} registros` : ''} · {file.creadoPor} · {formatDate(String(file.updatedAt))}</small>
                  </div>
                )}
                {canManage && renaming?.file.id !== file.id && (
                  <div className="excel-file-actions">
                    <button type="button" className="row-action" onClick={() => setRenaming({ file, nombre: file.nombre })}>Renombrar</button>
                    <button type="button" className="row-action" disabled={Boolean(busy) || file.estado === 'PROCESANDO'} onClick={() => { setReplacing(file); replacePicker.current?.click(); }}>Reemplazar</button>
                    <button type="button" className="row-action row-action--danger" onClick={() => void askDelete(file)}>Eliminar</button>
                  </div>
                )}
              </div>
              {file.estado === 'PROCESANDO' && <ExcelProgress file={file} />}
              {file.error && <p className={file.estado === 'ERROR' ? 'form-error excel-file-error' : 'excel-file-warning'} role="alert">{file.error}</p>}
              {file.avisos.length > 0 && file.estado === 'LISTO' && (
                <details className="excel-file-notes">
                  <summary>{file.avisos.length === 1 ? '1 observación de la carga' : `${file.avisos.length} observaciones de la carga`}</summary>
                  <ul className="excel-warnings">{file.avisos.map((aviso) => <li key={aviso}>{aviso}</li>)}</ul>
                </details>
              )}
              <ul className="excel-sheets">
                {file.hojas.map((sheet) => (
                  <li key={sheet.nombre}>
                    <button type="button" className="excel-sheet" onClick={() => onOpen({ connection: excelSource(file), object: sheetObject(sheet.nombre) })}>
                      <Icon name="table" size={14} />
                      <span><strong>{sheet.nombre}</strong><small>{sheet.totalFilas.toLocaleString('es')} registros · {sheet.columnas.length} columnas</small></span>
                      <span className="excel-id" title="Columna identificadora (primera columna)">ID: {sheet.columnaId}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}

      {deleting && (
        <Modal
          title="Eliminar archivo de Excel"
          onClose={() => setDeleting(null)}
          footer={<>
            <button type="button" className="button form-secondary" onClick={() => setDeleting(null)}>Cancelar</button>
            <button type="button" className="button form-danger" disabled={deleting.usadoEn === null} onClick={() => void confirmDelete()}>Eliminar</button>
          </>}
        >
          <p className="modal-text">Se eliminará <strong>{deleting.file.nombre}</strong> con sus {deleting.file.hojas.length} hoja(s). Esta acción no se puede deshacer.</p>
          {deleting.usadoEn === null && <p className="modal-text">Revisando si algún reporte lo usa…</p>}
          {deleting.usadoEn && deleting.usadoEn.length > 0 && (
            <div className="form-error" role="alert">
              <p>Estos reportes guardados lo usan y dejarán de ejecutarse (puedes <strong>reemplazar</strong> el archivo en lugar de eliminarlo):</p>
              <ul className="excel-warnings">{deleting.usadoEn.map((query) => <li key={query.id}>{query.nombre}</li>)}</ul>
            </div>
          )}
        </Modal>
      )}
    </section>
  );
}
