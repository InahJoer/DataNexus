'use client';

import { useState, type FormEvent } from 'react';
import { Modal } from '@/components/app-shell/modal';
import { ENGINES, ENGINE_ORDER, type Connection, type Engine } from '@/components/connections/engines';
import { Icon } from '@/components/icons';
import { apiErrorMessage, NETWORK_ERROR_MESSAGE } from '@/lib/api/errors';
import { useApiCall } from '@/lib/api/use-api-call';
import type { components } from '@/lib/api/schema';

type Credentials = components['schemas']['CreateConnectionDto']['credenciales'];

type Fields = {
  nombre: string;
  host: string;
  port: string;
  database: string;
  username: string;
  password: string;
  ssl: boolean;
  uri: string;
  serviceAccount: string;
  databaseId: string;
};

type TestState = { state: 'idle' } | { state: 'running' } | { state: 'ok'; detail: string } | { state: 'error'; detail: string };

const EMPTY: Fields = { nombre: '', host: '', port: '', database: '', username: '', password: '', ssl: false, uri: '', serviceAccount: '', databaseId: '' };

/** Credenciales en el formato que espera la API para cada motor, o el mensaje de lo que falta. */
function buildCredentials(engine: Engine, fields: Fields): Credentials | string {
  const kind = ENGINES[engine].kind;
  if (kind === 'mongo') {
    if (!fields.uri.trim() || !fields.database.trim()) return 'Completa la URI y la base de datos.';
    return { uri: fields.uri.trim(), database: fields.database.trim() };
  }
  if (kind === 'firestore') {
    try {
      const serviceAccount: unknown = JSON.parse(fields.serviceAccount);
      if (!serviceAccount || typeof serviceAccount !== 'object' || Array.isArray(serviceAccount)) throw new Error('json');
      return { serviceAccount: serviceAccount as Record<string, unknown>, ...(fields.databaseId.trim() ? { databaseId: fields.databaseId.trim() } : {}) };
    } catch {
      return 'Pega el JSON completo de la cuenta de servicio de Firebase.';
    }
  }
  if (!fields.host.trim() || !fields.database.trim() || !fields.username.trim() || !fields.password) {
    return 'Completa host, base de datos, usuario y contraseña.';
  }
  return {
    host: fields.host.trim(),
    ...(fields.port ? { port: Number(fields.port) } : {}),
    database: fields.database.trim(),
    username: fields.username.trim(),
    password: fields.password,
    ...(engine === 'SQLSERVER' ? { encrypt: fields.ssl } : { ssl: fields.ssl }),
  };
}

type ConnectionFormProps = Readonly<{ connection?: Connection; onClose: () => void; onSaved: () => void }>;

/** Alta y edición de conexiones (Figma · Nueva conexión SQL / Firebase). Las credenciales nunca vuelven de la API. */
export function ConnectionForm({ connection, onClose, onSaved }: ConnectionFormProps) {
  const call = useApiCall();
  const isEdit = Boolean(connection);
  const [engine, setEngine] = useState<Engine>(connection?.tipoMotor ?? 'POSTGRESQL');
  const [fields, setFields] = useState<Fields>({
    ...EMPTY,
    nombre: connection?.nombre ?? '',
    host: connection && ENGINES[connection.tipoMotor].kind === 'sql' ? connection.host : '',
    database: connection?.dbName ?? '',
  });
  const [test, setTest] = useState<TestState>({ state: 'idle' });
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const kind = ENGINES[engine].kind;
  // Al editar, las credenciales son opcionales: si no se escriben, se conservan las guardadas.
  const touchedCredentials = kind === 'sql' ? Boolean(fields.password || fields.username) : kind === 'mongo' ? Boolean(fields.uri) : Boolean(fields.serviceAccount);
  const sendCredentials = !isEdit || touchedCredentials || engine !== connection?.tipoMotor;

  const set = <K extends keyof Fields>(key: K, value: Fields[K]) => {
    setFields((current) => ({ ...current, [key]: value }));
    setTest({ state: 'idle' });
  };

  async function runTest() {
    const credenciales = buildCredentials(engine, fields);
    if (typeof credenciales === 'string') {
      setTest({ state: 'error', detail: credenciales });
      return;
    }
    setTest({ state: 'running' });
    try {
      const result = await call((api) => api.POST('/connections/test', { body: { tipoMotor: engine, credenciales } }));
      if (!result.response.ok || !result.data) {
        setTest({ state: 'error', detail: apiErrorMessage(result.error, result.response.status) });
      } else if (result.data.ok) {
        const version = result.data.serverVersion ? ` · ${result.data.serverVersion}` : '';
        setTest({ state: 'ok', detail: `Conexión correcta en ${result.data.latencyMs ?? '—'} ms${version}` });
      } else {
        setTest({ state: 'error', detail: result.data.error?.message ?? 'No se pudo conectar.' });
      }
    } catch {
      setTest({ state: 'error', detail: NETWORK_ERROR_MESSAGE });
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const credenciales = sendCredentials ? buildCredentials(engine, fields) : null;
    if (typeof credenciales === 'string') {
      setError(credenciales);
      return;
    }
    const nombre = fields.nombre.trim() || undefined;
    setIsSaving(true);
    try {
      const result = connection
        ? await call((api) =>
            api.PATCH('/connections/{id}', {
              params: { path: { id: connection.id } },
              body: { ...(nombre ? { nombre } : {}), ...(credenciales ? { tipoMotor: engine, credenciales } : {}) },
            }),
          )
        : await call((api) => api.POST('/connections', { body: { ...(nombre ? { nombre } : {}), tipoMotor: engine, credenciales: credenciales as Credentials } }));
      if (!result.response.ok) {
        setError(apiErrorMessage(result.error, result.response.status));
        return;
      }
      onSaved();
    } catch {
      setError(NETWORK_ERROR_MESSAGE);
    } finally {
      setIsSaving(false);
    }
  }

  const input = (key: 'host' | 'port' | 'database' | 'username' | 'password' | 'uri' | 'databaseId', label: string, extra: Record<string, unknown> = {}) => (
    <label className="form-field">
      <span>{label}</span>
      <input className="form-input" value={fields[key]} onChange={(event) => set(key, event.target.value)} {...extra} />
    </label>
  );

  return (
    <Modal
      size="lg"
      title={isEdit ? 'Editar conexión' : 'Nueva conexión'}
      description={isEdit ? 'Deja las credenciales vacías para conservar las actuales.' : 'Las credenciales se cifran con AES-256 antes de guardarse.'}
      onClose={onClose}
      footer={
        <>
          <span className={`connection-test connection-test--${test.state}`} role="status">
            {test.state === 'running' && 'Probando conexión…'}
            {(test.state === 'ok' || test.state === 'error') && <><Icon name={test.state === 'ok' ? 'check' : 'alert'} size={14} />{test.detail}</>}
          </span>
          <button className="button form-secondary" type="button" onClick={() => void runTest()} disabled={test.state === 'running' || !sendCredentials}>Probar conexión</button>
          <button className="button button--primary form-primary" type="submit" form="connection-form" disabled={isSaving}>{isSaving ? 'Guardando…' : isEdit ? 'Guardar cambios' : 'Crear conexión'}</button>
        </>
      }
    >
      <form id="connection-form" className="form-grid" onSubmit={handleSubmit}>
        <fieldset className="engine-picker">
          <legend>Motor</legend>
          {ENGINE_ORDER.map((option) => (
            <label key={option} className="engine-option" data-selected={option === engine}>
              <input type="radio" name="engine" value={option} checked={option === engine} onChange={() => { setEngine(option); setTest({ state: 'idle' }); }} />
              <span className="engine-badge" data-engine={option}>{ENGINES[option].short}</span>
              <span>{ENGINES[option].label}<small>{ENGINES[option].family}</small></span>
            </label>
          ))}
        </fieldset>

        <label className="form-field form-field--wide">
          <span>Nombre de la conexión</span>
          <input className="form-input" value={fields.nombre} onChange={(event) => set('nombre', event.target.value)} placeholder="Ventas producción" maxLength={120} />
        </label>

        {kind === 'sql' && (
          <>
            {input('host', 'Host', { placeholder: 'db.empresa.com', required: !isEdit, autoComplete: 'off' })}
            {input('port', 'Puerto', { type: 'number', min: 1, max: 65535, placeholder: String(ENGINES[engine].port) })}
            {input('database', 'Base de datos', { required: !isEdit })}
            {input('username', 'Usuario', { autoComplete: 'off', required: !isEdit })}
            {input('password', 'Contraseña', { type: 'password', autoComplete: 'new-password', required: !isEdit })}
            <label className="form-check">
              <input type="checkbox" checked={fields.ssl} onChange={(event) => set('ssl', event.target.checked)} />
              <span>{engine === 'SQLSERVER' ? 'Cifrar la conexión (encrypt)' : 'Usar SSL/TLS'}</span>
            </label>
          </>
        )}
        {kind === 'mongo' && (
          <>
            <label className="form-field form-field--wide">
              <span>URI de conexión</span>
              <input className="form-input" value={fields.uri} onChange={(event) => set('uri', event.target.value)} placeholder="mongodb+srv://usuario:clave@cluster.mongodb.net" autoComplete="off" required={!isEdit} />
            </label>
            {input('database', 'Base de datos', { required: !isEdit })}
          </>
        )}
        {kind === 'firestore' && (
          <>
            <label className="form-field form-field--wide">
              <span>Cuenta de servicio (JSON)</span>
              <textarea className="form-input form-textarea" value={fields.serviceAccount} onChange={(event) => set('serviceAccount', event.target.value)} placeholder='{"type": "service_account", "project_id": "…", …}' required={!isEdit} spellCheck={false} />
            </label>
            {input('databaseId', 'ID de base de datos (opcional)', { placeholder: '(default)' })}
          </>
        )}
        {error && <p className="form-error form-field--wide" role="alert">{error}</p>}
      </form>
    </Modal>
  );
}
