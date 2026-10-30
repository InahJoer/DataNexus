'use client';

import { type FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Icon } from '@/components/icons';
import { apiBaseUrl, createApiClient } from '@/lib/api/client';
import { useAuth } from '@/lib/auth-context';
import type { components } from '@/lib/api/schema';

type Connection = components['schemas']['ConnectionResponseDto'];
type ConnectionSchema = components['schemas']['ConnectionSchemaResponseDto'];
type CatalogObject = components['schemas']['CatalogObjectResponseDto'];
type CrossJoinPayload = components['schemas']['CrossJoinDto'];
type CrossJoinResult = components['schemas']['PaginatedCrossJoinResultDto'];
type ExportFormat = components['schemas']['ExportCrossJoinDto']['format'];

const SQL_ENGINES = new Set(['SQLSERVER', 'MSSQL']);
const NOSQL_ENGINES = new Set(['FIRESTORE', 'FIREBASE', 'CLOUDFIRESTORE']);
const PAGE_SIZES = [25, 50, 100, 250];

function engineKey(value: string) {
  return value.toUpperCase().replace(/[^A-Z]/g, '');
}

function objectKey(object: CatalogObject) {
  return `${object.schema ?? ''}::${object.name}`;
}

function responseMessage(value: unknown) {
  if (!value || typeof value !== 'object' || !('message' in value)) return null;
  const message = value.message;
  if (typeof message === 'string') return message;
  if (Array.isArray(message)) return message.filter((part) => typeof part === 'string').join(' ');
  return null;
}

function displayValue(value: unknown) {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'object') return JSON.stringify(value) ?? '—';
  return String(value);
}

function connectionLabel(connection: Connection) {
  return `${connection.dbName} · ${connection.tipoMotor}`;
}

function preferredField(fields: string[], preferred: string[]) {
  const byName = new Map(fields.map((field) => [field.toLowerCase(), field]));
  return preferred.map((field) => byName.get(field)).find(Boolean) ?? fields[0] ?? '';
}

export function CrossJoinBuilder() {
  const { session, logout } = useAuth();
  const router = useRouter();
  const role = session?.user.role;
  const canBuild = role === 'ADMIN' || role === 'OPERADOR';
  const accessToken = session?.accessToken;

  const [connections, setConnections] = useState<Connection[]>([]);
  const [isLoadingConnections, setIsLoadingConnections] = useState(false);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [sqlConnectionId, setSqlConnectionId] = useState('');
  const [noSqlConnectionId, setNoSqlConnectionId] = useState('');
  const [sqlSchema, setSqlSchema] = useState<ConnectionSchema | null>(null);
  const [noSqlSchema, setNoSqlSchema] = useState<ConnectionSchema | null>(null);
  const [isLoadingSchemas, setIsLoadingSchemas] = useState(false);
  const [schemaError, setSchemaError] = useState<string | null>(null);
  const [sqlFields, setSqlFields] = useState<string[]>([]);
  const [noSqlFields, setNoSqlFields] = useState<string[]>([]);
  const [isLoadingSqlFields, setIsLoadingSqlFields] = useState(false);
  const [isLoadingNoSqlFields, setIsLoadingNoSqlFields] = useState(false);
  const [sqlFieldsError, setSqlFieldsError] = useState<string | null>(null);
  const [noSqlFieldsError, setNoSqlFieldsError] = useState<string | null>(null);
  const [sqlObjectKey, setSqlObjectKey] = useState('');
  const [noSqlObjectKey, setNoSqlObjectKey] = useState('');
  const [sqlKey, setSqlKey] = useState('id');
  const [noSqlKey, setNoSqlKey] = useState('cliente_id');
  const [pageSize, setPageSize] = useState(50);
  const [result, setResult] = useState<CrossJoinResult | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [isExporting, setIsExporting] = useState<ExportFormat | null>(null);
  const [joinError, setJoinError] = useState<string | null>(null);
  const lastPayload = useRef<CrossJoinPayload | null>(null);

  const sqlConnections = useMemo(
    () => connections.filter((connection) => SQL_ENGINES.has(engineKey(connection.tipoMotor))),
    [connections],
  );
  const noSqlConnections = useMemo(
    () => connections.filter((connection) => NOSQL_ENGINES.has(engineKey(connection.tipoMotor))),
    [connections],
  );
  const sqlObjects = useMemo(
    () => sqlSchema?.objects.filter((object) => object.type === 'TABLE' || object.type === 'VIEW') ?? [],
    [sqlSchema],
  );
  const noSqlObjects = useMemo(
    () => noSqlSchema?.objects.filter((object) => object.type === 'COLLECTION') ?? [],
    [noSqlSchema],
  );
  const selectedSqlObject = sqlObjects.find((object) => objectKey(object) === sqlObjectKey);
  const selectedNoSqlObject = noSqlObjects.find((object) => objectKey(object) === noSqlObjectKey);

  useEffect(() => {
    if (!canBuild || !accessToken) return;
    let cancelled = false;

    async function loadConnections() {
      setIsLoadingConnections(true);
      setConnectionError(null);
      try {
        const response = await createApiClient(accessToken).GET('/connections');
        if (cancelled) return;
        if (response.response.status === 401) {
          logout();
          router.replace('/login');
          return;
        }
        if (!response.response.ok || !response.data) {
          setConnectionError(
            responseMessage('error' in response ? response.error : null) ??
              'No se pudieron cargar las conexiones del workspace.',
          );
          return;
        }

        setConnections(response.data);
        const sqlOptions = response.data.filter((connection) => SQL_ENGINES.has(engineKey(connection.tipoMotor)));
        const noSqlOptions = response.data.filter((connection) => NOSQL_ENGINES.has(engineKey(connection.tipoMotor)));
        setSqlConnectionId((current) => current && sqlOptions.some((connection) => connection.id === current)
          ? current
          : sqlOptions[0]?.id ?? '');
        setNoSqlConnectionId((current) => current && noSqlOptions.some((connection) => connection.id === current)
          ? current
          : noSqlOptions[0]?.id ?? '');
      } catch {
        if (!cancelled) setConnectionError('No se pudo conectar con la API de DataNexus.');
      } finally {
        if (!cancelled) setIsLoadingConnections(false);
      }
    }

    void loadConnections();
    return () => { cancelled = true; };
  }, [accessToken, canBuild, logout, router]);

  useEffect(() => {
    if (!canBuild || !accessToken) return;
    let cancelled = false;
    setSchemaError(null);
    setSqlSchema(null);
    setNoSqlSchema(null);
    setIsLoadingSchemas(Boolean(sqlConnectionId || noSqlConnectionId));

    async function loadSchema(connectionId: string) {
      const response = await createApiClient(accessToken).GET('/engine/connections/{connectionId}/schema', {
        params: { path: { connectionId } },
      });
      if (response.response.status === 401) {
        logout();
        router.replace('/login');
        return null;
      }
      if (!response.response.ok || !response.data) {
        throw new Error(
          responseMessage('error' in response ? response.error : null) ??
            'No se pudo explorar el esquema de una de las fuentes.',
        );
      }
      return response.data;
    }

    async function loadSelectedSchemas() {
      try {
        const [sql, noSql] = await Promise.all([
          sqlConnectionId ? loadSchema(sqlConnectionId) : Promise.resolve(null),
          noSqlConnectionId ? loadSchema(noSqlConnectionId) : Promise.resolve(null),
        ]);
        if (cancelled) return;
        setSqlSchema(sql);
        setNoSqlSchema(noSql);
        const firstSqlObject = sql?.objects.find((object) => object.type === 'TABLE' || object.type === 'VIEW');
        const firstNoSqlObject = noSql?.objects.find((object) => object.type === 'COLLECTION');
        setSqlObjectKey(firstSqlObject ? objectKey(firstSqlObject) : '');
        setNoSqlObjectKey(firstNoSqlObject ? objectKey(firstNoSqlObject) : '');
      } catch (error) {
        if (!cancelled) {
          setSchemaError(error instanceof Error ? error.message : 'No se pudo explorar el esquema de las fuentes.');
        }
      } finally {
        if (!cancelled) setIsLoadingSchemas(false);
      }
    }

    void loadSelectedSchemas();
    return () => { cancelled = true; };
  }, [accessToken, canBuild, logout, noSqlConnectionId, router, sqlConnectionId]);

  useEffect(() => {
    if (!canBuild || !accessToken || !sqlConnectionId || !selectedSqlObject) {
      setSqlFields([]);
      setSqlKey('');
      setIsLoadingSqlFields(false);
      setSqlFieldsError(null);
      return;
    }
    let cancelled = false;
    setIsLoadingSqlFields(true);
    setSqlFieldsError(null);

    async function loadSqlFields() {
      try {
        const response = await createApiClient(accessToken).GET('/engine/connections/{connectionId}/schema/fields', {
          params: {
            path: { connectionId: sqlConnectionId },
            query: {
              objectName: selectedSqlObject.name,
              ...(selectedSqlObject.schema ? { schema: selectedSqlObject.schema } : {}),
            },
          },
        });
        if (cancelled) return;
        if (response.response.status === 401) {
          logout();
          router.replace('/login');
          return;
        }
        if (!response.response.ok || !response.data) {
          setSqlFieldsError(responseMessage('error' in response ? response.error : null) ?? 'No se pudieron cargar las columnas SQL.');
          return;
        }
        const fields = response.data.fields;
        setSqlFields(fields);
        setSqlKey((current) => fields.includes(current) ? current : preferredField(fields, ['id']));
      } catch {
        if (!cancelled) setSqlFieldsError('No se pudieron cargar las columnas SQL.');
      } finally {
        if (!cancelled) setIsLoadingSqlFields(false);
      }
    }

    void loadSqlFields();
    return () => { cancelled = true; };
  }, [accessToken, canBuild, logout, router, selectedSqlObject, sqlConnectionId]);

  useEffect(() => {
    if (!canBuild || !accessToken || !noSqlConnectionId || !selectedNoSqlObject) {
      setNoSqlFields([]);
      setNoSqlKey('');
      setIsLoadingNoSqlFields(false);
      setNoSqlFieldsError(null);
      return;
    }
    let cancelled = false;
    setIsLoadingNoSqlFields(true);
    setNoSqlFieldsError(null);

    async function loadNoSqlFields() {
      try {
        const response = await createApiClient(accessToken).GET('/engine/connections/{connectionId}/schema/fields', {
          params: {
            path: { connectionId: noSqlConnectionId },
            query: { objectName: selectedNoSqlObject.name },
          },
        });
        if (cancelled) return;
        if (response.response.status === 401) {
          logout();
          router.replace('/login');
          return;
        }
        if (!response.response.ok || !response.data) {
          setNoSqlFieldsError(responseMessage('error' in response ? response.error : null) ?? 'No se pudieron cargar los campos de la colección.');
          return;
        }
        const fields = response.data.fields;
        setNoSqlFields(fields);
        setNoSqlKey((current) => fields.includes(current)
          ? current
          : preferredField(fields, ['cliente_id', 'customer_id', 'client_id', 'clienteid']));
      } catch {
        if (!cancelled) setNoSqlFieldsError('No se pudieron cargar los campos de la colección.');
      } finally {
        if (!cancelled) setIsLoadingNoSqlFields(false);
      }
    }

    void loadNoSqlFields();
    return () => { cancelled = true; };
  }, [accessToken, canBuild, logout, noSqlConnectionId, router, selectedNoSqlObject]);

  if (!canBuild || !session) return null;

  function clearExecution() {
    lastPayload.current = null;
    setResult(null);
    setJoinError(null);
  }

  async function runPage(payload: CrossJoinPayload, offset: number) {
    if (!accessToken) return;
    setIsRunning(true);
    setJoinError(null);
    try {
      const response = await createApiClient(accessToken).POST('/engine/join', {
        body: { ...payload, offset },
      });
      if (response.response.status === 401) {
        logout();
        router.replace('/login');
        return;
      }
      if (!response.response.ok || !response.data) {
        setJoinError(
          responseMessage('error' in response ? response.error : null) ??
            'No se pudo ejecutar el cruce. Revisa las fuentes y las llaves seleccionadas.',
        );
        return;
      }
      setResult(response.data);
    } catch {
      setJoinError('No se pudo conectar con la API de DataNexus.');
    } finally {
      setIsRunning(false);
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!sqlConnectionId || !noSqlConnectionId || !selectedSqlObject || !selectedNoSqlObject) return;

    const payload: CrossJoinPayload = {
      conexionSqlId: sqlConnectionId,
      conexionNoSqlId: noSqlConnectionId,
      tablaSql: selectedSqlObject.name,
      ...(selectedSqlObject.schema ? { esquemaSql: selectedSqlObject.schema } : {}),
      coleccionNoSql: selectedNoSqlObject.name,
      llaveSql: sqlKey.trim(),
      llaveNoSql: noSqlKey.trim(),
      limit: pageSize,
      offset: 0,
    };
    lastPayload.current = payload;
    await runPage(payload, 0);
  }

  async function exportResults(format: ExportFormat) {
    if (!accessToken || !lastPayload.current) return;
    setIsExporting(format);
    setJoinError(null);
    try {
      const response = await fetch(`${apiBaseUrl}/engine/export`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ...lastPayload.current, format }),
      });

      if (response.status === 401) {
        logout();
        router.replace('/login');
        return;
      }
      if (!response.ok) {
        const errorBody: unknown = await response.json().catch(() => null);
        setJoinError(responseMessage(errorBody) ?? 'No se pudo exportar el resultado.');
        return;
      }

      const extension = format === 'excel' ? 'xlsx' : format;
      const filename = response.headers.get('content-disposition')?.match(/filename="?([^";]+)"?/i)?.[1]
        ?? `datanexus-cross-join.${extension}`;
      const objectUrl = URL.createObjectURL(await response.blob());
      const anchor = document.createElement('a');
      anchor.href = objectUrl;
      anchor.download = filename;
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
    } catch {
      setJoinError('No se pudo conectar con la API para exportar el resultado.');
    } finally {
      setIsExporting(null);
    }
  }

  function handleSqlConnectionChange(value: string) {
    setSqlConnectionId(value);
    setSqlObjectKey('');
    setSqlKey('');
    clearExecution();
  }

  function handleNoSqlConnectionChange(value: string) {
    setNoSqlConnectionId(value);
    setNoSqlObjectKey('');
    setNoSqlKey('');
    clearExecution();
  }

  const columns = result?.data[0] ? Object.keys(result.data[0]) : [];
  const page = result ? Math.floor(result.offset / result.limit) + 1 : 0;
  const totalPages = result ? Math.max(1, Math.ceil(result.total / result.limit)) : 0;
  const hasPrevious = Boolean(result && result.offset > 0);
  const hasNext = Boolean(result && result.offset + result.limit < result.total);
  const hasSqlSources = sqlConnections.length > 0;
  const hasNoSqlSources = noSqlConnections.length > 0;
  const canRun = Boolean(
    selectedSqlObject && selectedNoSqlObject && sqlFields.includes(sqlKey) && noSqlFields.includes(noSqlKey) &&
      !isLoadingSchemas && !isLoadingSqlFields && !isLoadingNoSqlFields && !isRunning,
  );

  return (
    <section className="surface-card join-builder-card" id="joins" aria-labelledby="join-builder-title">
      <header className="join-builder-header">
        <div>
          <p className="join-builder-eyebrow">DATA BUILDER</p>
          <h2 id="join-builder-title">Constructor de cruces</h2>
          <p>Relaciona una fuente SQL con una colección NoSQL y explora el resultado en memoria.</p>
        </div>
        <span className="join-builder-role"><Icon name="join" size={15} />ADMIN · OPERADOR</span>
      </header>

      {isLoadingConnections ? (
        <p className="join-builder-message" role="status">Cargando conexiones disponibles…</p>
      ) : connectionError ? (
        <p className="join-builder-message join-builder-message--error" role="alert">{connectionError}</p>
      ) : !hasSqlSources || !hasNoSqlSources ? (
        <div className="join-builder-message join-builder-message--empty">
          <Icon name="database" size={20} />
          <div>
            <strong>Faltan fuentes compatibles</strong>
            <p>Para ejecutar un cruce se necesita SQL Server y una fuente Firestore o Firebase en este workspace.</p>
          </div>
        </div>
      ) : (
        <>
          <form className="join-builder-form" onSubmit={(event) => void handleSubmit(event)}>
            <div className="join-source-grid">
              <article className="join-source-card">
                <div className="join-source-heading">
                  <span className="join-source-step">01</span>
                  <span><strong>Fuente relacional</strong><small>SQL Server</small></span>
                </div>
                <label className="join-field">
                  <span>Conexión</span>
                  <select className="join-control" value={sqlConnectionId} onChange={(event) => handleSqlConnectionChange(event.target.value)}>
                    <option value="">Selecciona una conexión</option>
                    {sqlConnections.map((connection) => <option key={connection.id} value={connection.id}>{connectionLabel(connection)}</option>)}
                  </select>
                </label>
                <label className="join-field">
                  <span>Tabla o vista</span>
                  <select
                    className="join-control"
                    value={sqlObjectKey}
                    onChange={(event) => { setSqlObjectKey(event.target.value); clearExecution(); }}
                    disabled={isLoadingSchemas || !sqlObjects.length}
                  >
                    <option value="">{isLoadingSchemas ? 'Explorando catálogo…' : 'Selecciona una tabla'}</option>
                    {sqlObjects.map((object) => <option key={objectKey(object)} value={objectKey(object)}>{object.schema ? `${object.schema}.${object.name}` : object.name}</option>)}
                  </select>
                </label>
                <label className="join-field">
                  <span>Llave SQL</span>
                  <select className="join-control" value={sqlKey} onChange={(event) => { setSqlKey(event.target.value); clearExecution(); }} disabled={isLoadingSqlFields || !sqlFields.length} required>
                    <option value="">{isLoadingSqlFields ? 'Cargando columnas…' : 'Selecciona una columna'}</option>
                    {sqlFields.map((field) => <option key={field} value={field}>{field}</option>)}
                  </select>
                  <small className="join-field-hint">{sqlFieldsError ?? (sqlSchema && !sqlFields.length && !isLoadingSqlFields ? 'No se detectaron columnas en esta tabla.' : 'Campo que relaciona esta tabla con la colección.')}</small>
                </label>
              </article>

              <div className="join-source-connector" aria-hidden="true"><Icon name="join" size={21} /></div>

              <article className="join-source-card join-source-card--nosql">
                <div className="join-source-heading">
                  <span className="join-source-step">02</span>
                  <span><strong>Fuente documental</strong><small>Firestore / Firebase</small></span>
                </div>
                <label className="join-field">
                  <span>Conexión</span>
                  <select className="join-control" value={noSqlConnectionId} onChange={(event) => handleNoSqlConnectionChange(event.target.value)}>
                    <option value="">Selecciona una conexión</option>
                    {noSqlConnections.map((connection) => <option key={connection.id} value={connection.id}>{connectionLabel(connection)}</option>)}
                  </select>
                </label>
                <label className="join-field">
                  <span>Colección</span>
                  <select
                    className="join-control"
                    value={noSqlObjectKey}
                    onChange={(event) => { setNoSqlObjectKey(event.target.value); clearExecution(); }}
                    disabled={isLoadingSchemas || !noSqlObjects.length}
                  >
                    <option value="">{isLoadingSchemas ? 'Explorando catálogo…' : 'Selecciona una colección'}</option>
                    {noSqlObjects.map((object) => <option key={objectKey(object)} value={objectKey(object)}>{object.name}</option>)}
                  </select>
                </label>
                <label className="join-field">
                  <span>Llave NoSQL</span>
                  <select className="join-control" value={noSqlKey} onChange={(event) => { setNoSqlKey(event.target.value); clearExecution(); }} disabled={isLoadingNoSqlFields || !noSqlFields.length} required>
                    <option value="">{isLoadingNoSqlFields ? 'Cargando campos…' : 'Selecciona un campo'}</option>
                    {noSqlFields.map((field) => <option key={field} value={field}>{field}</option>)}
                  </select>
                  <small className="join-field-hint">{noSqlFieldsError ?? (noSqlSchema && !noSqlFields.length && !isLoadingNoSqlFields ? 'La colección está vacía o no tiene documentos visibles.' : 'Campos detectados en el primer documento; verifica el identificador relacionado.')}</small>
                </label>
              </article>
            </div>

            {schemaError && <p className="join-builder-message join-builder-message--error" role="alert">{schemaError}</p>}

            <div className="join-builder-actions">
              <label className="join-page-size">
                <span>Filas por página</span>
                <select className="join-control" value={pageSize} onChange={(event) => { setPageSize(Number(event.target.value)); clearExecution(); }}>
                  {PAGE_SIZES.map((size) => <option key={size} value={size}>{size}</option>)}
                </select>
              </label>
              <button className="button button--primary join-run-button" type="submit" disabled={!canRun} aria-busy={isRunning}>
                <Icon name="join" size={15} />{isRunning ? 'Ejecutando cruce…' : 'Ejecutar cruce'}
              </button>
            </div>
          </form>

          {joinError && <p className="join-builder-message join-builder-message--error" role="alert">{joinError}</p>}

          <section className="join-results" id="reports" aria-labelledby="join-results-title" aria-live="polite">
            <div className="join-results-header">
              <div>
                <p className="join-builder-eyebrow">VISTA PREVIA</p>
                <h3 id="join-results-title">Resultados del cruce</h3>
                {result && <p>{result.total.toLocaleString('es')} filas encontradas · página {page} de {totalPages}</p>}
              </div>
              {result && result.total > 0 && (
                <div className="join-export-actions" aria-label="Exportar resultados">
                  <span>Exportar</span>
                  {(['excel', 'pdf', 'json'] as const).map((format) => (
                    <button
                      className="join-export-button"
                      type="button"
                      key={format}
                      onClick={() => void exportResults(format)}
                      disabled={isExporting !== null}
                      aria-label={`Exportar a ${format.toUpperCase()}`}
                    >
                      {isExporting === format ? '…' : format === 'excel' ? 'Excel' : format.toUpperCase()}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {!result ? (
              <div className="join-results-empty"><Icon name="join" size={20} /><p>Configura las fuentes y ejecuta el cruce para ver una vista previa.</p></div>
            ) : result.data.length === 0 ? (
              <div className="join-results-empty"><p>El cruce no encontró registros para esta página.</p></div>
            ) : (
              <>
                <div className="join-results-table-wrap">
                  <table className="join-results-table">
                    <thead><tr>{columns.map((column) => <th key={column}>{column}</th>)}</tr></thead>
                    <tbody>
                      {result.data.map((row, rowIndex) => (
                        <tr key={result.offset + rowIndex}>
                          {columns.map((column) => <td key={column} title={displayValue(row[column])}>{displayValue(row[column])}</td>)}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <footer className="join-results-footer">
                  <span>Mostrando {result.data.length.toLocaleString('es')} de {result.total.toLocaleString('es')} registros</span>
                  <div>
                    <button type="button" className="join-page-button" onClick={() => lastPayload.current && void runPage(lastPayload.current, Math.max(0, result.offset - result.limit))} disabled={!hasPrevious || isRunning}>Anterior</button>
                    <button type="button" className="join-page-button" onClick={() => lastPayload.current && void runPage(lastPayload.current, result.offset + result.limit)} disabled={!hasNext || isRunning}>Siguiente</button>
                  </div>
                </footer>
              </>
            )}
          </section>
        </>
      )}
    </section>
  );
}
