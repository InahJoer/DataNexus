const DEFAULT_MAX_SOURCE_ROWS = 10_000;
const DEFAULT_MAX_JOIN_ROWS = 100_000;
const DEFAULT_MAX_SOURCE_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_JOIN_BYTES = 64 * 1024 * 1024;

function positiveIntegerFromEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

export function getMaxSourceRows(): number {
  return positiveIntegerFromEnv(
    'DATA_ENGINE_MAX_SOURCE_ROWS',
    DEFAULT_MAX_SOURCE_ROWS,
  );
}

export function getMaxJoinRows(): number {
  return positiveIntegerFromEnv(
    'DATA_ENGINE_MAX_JOIN_ROWS',
    DEFAULT_MAX_JOIN_ROWS,
  );
}

export function getMaxSourceBytes(): number {
  return positiveIntegerFromEnv(
    'DATA_ENGINE_MAX_SOURCE_BYTES',
    DEFAULT_MAX_SOURCE_BYTES,
  );
}

export function getMaxJoinBytes(): number {
  return positiveIntegerFromEnv(
    'DATA_ENGINE_MAX_JOIN_BYTES',
    DEFAULT_MAX_JOIN_BYTES,
  );
}

export function getJsonByteLength(value: unknown): number {
  const json = JSON.stringify(value, (_key, entry) =>
    typeof entry === 'bigint' ? entry.toString() : entry,
  );
  return Buffer.byteLength(json ?? '', 'utf8');
}

export const EXTERNAL_QUERY_TIMEOUT_MS = 8_000;
