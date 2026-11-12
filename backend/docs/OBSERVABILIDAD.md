# Observabilidad

Issue #51 (S5-04) · RNF-09 (99.9 % de disponibilidad).

## Health checks

| Endpoint | Uso | Qué comprueba | Respuesta |
| --- | --- | --- | --- |
| `GET /health` | Liveness: health check del contenedor (Docker Compose, Railway) | Nada externo: solo que el proceso responde | `200 {"status":"ok","uptimeSeconds":123}` |
| `GET /health/ready` | Readiness y monitoreo externo (UptimeRobot, Better Stack…) | PostgreSQL (`SELECT 1`), Redis si hay `REDIS_URL`, SMTP si está configurado | `200` si todo está bien; `503` si PostgreSQL o Redis fallan |

- Son públicos, no cuentan para el rate limiting y no devuelven datos de negocio.
- **SMTP no tumba la API.** Si el servidor de correo falla, `smtp` queda como `degraded` con HTTP 200: la API sigue sirviendo y solo fallan los correos. El resultado se cachea 60 s para no abrir una conexión SMTP en cada sondeo.
- El health check del contenedor usa `/health` y no `/health/ready`, para que una caída breve de la base de datos no provoque reinicios en cadena.

```json
GET /health/ready
{
  "status": "ok",
  "details": {
    "database": { "status": "up", "responseTime": 3 },
    "redis":    { "status": "up", "mode": "memory", "message": "Sin REDIS_URL: cola en memoria" },
    "smtp":     { "status": "up", "mode": "smtp" }
  }
}
```

## Request id

- Cada respuesta lleva la cabecera `X-Request-Id`. Si el cliente o el proxy envían una válida (`[A-Za-z0-9._:-]`, hasta 128 caracteres), se reutiliza; si no, se genera un UUID.
- El id se propaga con `AsyncLocalStorage` (`src/observability/request-context.ts`): cualquier `Logger` de Nest lo incluye sin pasarlo a mano.
- Los errores lo devuelven en el cuerpo (`requestId`), así que un usuario puede reportarlo y se encuentra en los logs.

## Logs estructurados

- `LOG_FORMAT=json`, el valor por defecto en producción, escribe una línea JSON por evento:

```json
{"level":"log","pid":1,"timestamp":1794451181644,"message":"POST /engine/join 201 84ms","context":"HTTP","method":"POST","path":"/engine/join","status":201,"durationMs":84,"requestId":"d7fa5595-4270-4698-a5bf-762db4c33a37"}
```

- Con `LOG_FORMAT=text`, el valor por defecto en desarrollo, se mantiene el formato legible de Nest con los primeros 8 caracteres del `requestId` en el contexto.
- `LOG_LEVEL` fija el nivel mínimo: `fatal`, `error`, `warn`, `log` (por defecto), `debug` o `verbose`.
- **Línea de acceso:** una por petición, con método, ruta, estado y duración. Los 4xx salen como `warn` y los 5xx como `error`. Nunca se registra la query string, que puede llevar tokens de descarga o de recuperación.
- **Redacción:** los campos `password`, `token`, `refresh_token`, `authorization`, `secret`, `privateKey`, `credentials`, etc. aparecen como `[REDACTED]` en cualquier objeto que se registre.
- Se usa el `ConsoleLogger` de Nest en modo JSON en lugar de pino: el formato es equivalente y no añade dependencias.

## Formato uniforme de error

Todas las respuestas de error tienen la misma forma: las de Nest, las de validación y también las de antes de Nest (CORS, cuerpo demasiado grande, JSON mal formado).

```json
{
  "statusCode": 404,
  "error": "Not Found",
  "message": "Conexión no encontrada",
  "path": "/connections/5e15…",
  "timestamp": "2026-11-12T02:39:41.596Z",
  "requestId": "abc-123"
}
```

- Se conservan `statusCode`, `message` (texto o lista de errores de validación) y `error`, igual que antes, así que el frontend no necesita cambios. También se mantienen los campos extra que lance una excepción, por ejemplo `code`.
- Los 5xx responden siempre `"Error interno del servidor"` y el detalle real, con su stack, va a los logs junto con el `requestId`.
