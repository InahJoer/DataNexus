# Seguridad de la API: hardening y revisión OWASP

Issue #52 (S5-05) · RNF-02 (TLS 1.2+). Revisión del 11 de noviembre de 2026 sobre la rama `main` + este cambio.

**Resultado:** sin hallazgos críticos ni altos abiertos. Quedan dos riesgos medios/bajos aceptados y documentados (API7 y API9).

## 1. Controles HTTP

Todo se configura en `src/app.setup.ts` (`configureApp`), que usan tanto `main.ts` como las pruebas e2e. Así las pruebas recorren la misma cadena de middlewares que producción.

| Control | Detalle | Variable |
| --- | --- | --- |
| Cabeceras de seguridad (`helmet`) | CSP restrictiva (`default-src 'self'`, `frame-ancestors 'none'`), HSTS de 1 año, `nosniff`, `Referrer-Policy: no-referrer`, sin `X-Powered-By` | — |
| Límite del cuerpo | JSON y formularios hasta 1 MB (413 si se supera). Los archivos van por multipart con su propio límite, por ejemplo la Service Account de Firestore | `BODY_LIMIT` |
| Rate limiting | 100 peticiones/min por IP en toda la API, 20/min en exportaciones y límites propios en login, registro, recuperación e invitaciones | `RATE_LIMIT_PER_MINUTE` |
| IP real detrás de proxy | `trust proxy` para que el rate limiting y la auditoría usen la IP del cliente y no la del balanceador | `TRUST_PROXY` |
| CORS | Lista blanca (`FRONTEND_URL`, `API_PUBLIC_URL`). Un origen no permitido recibe 403 con el formato de error de la API | — |
| Validación de entrada | `ValidationPipe` global con `whitelist` y `forbidNonWhitelisted`: se rechaza cualquier campo no declarado | — |
| Errores | Filtro global: los 5xx nunca exponen mensajes internos, SQL ni stack. Se registran con su `requestId` | — |

> **Corrección incluida:** el limitador `export` (20/min) se aplicaba a **todas** las rutas, porque un throttler con nombre de `@nestjs/throttler` cuenta en cada endpoint. En la práctica, toda la API quedaba limitada a 20 peticiones por minuto e IP. Ahora solo cuenta en las rutas marcadas con `@Throttle({ export: ... })` (`src/common/named-throttle.ts`).

## 2. TLS

### Clientes → API

La API no termina TLS: se despliega detrás de un proxy HTTPS (Railway, Nginx, Caddy o un balanceador cloud).

1. Publica solo el puerto HTTPS del proxy. El contenedor `backend` no debe exponerse directamente a Internet.
2. Configura el proxy con TLS 1.2 como mínimo y redirección HTTP → HTTPS. En Railway viene así por defecto.
3. Define `TRUST_PROXY=1`, o el número de proxies que haya delante.
4. Usa URLs `https://` en `FRONTEND_URL`, `API_PUBLIC_URL` y `REPORTS_PUBLIC_BASE_URL`. Esta última ya se exige en producción.
5. HSTS (`Strict-Transport-Security`) lo envía la API. Los navegadores solo lo aplican cuando la respuesta llega por HTTPS.

Ejemplo mínimo con Nginx:

```nginx
server {
  listen 443 ssl http2;
  server_name api.example.com;
  ssl_certificate     /etc/letsencrypt/live/api.example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/api.example.com/privkey.pem;
  ssl_protocols TLSv1.2 TLSv1.3;

  location / {
    proxy_pass http://127.0.0.1:3001;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Request-Id $request_id;
  }
}
server { listen 80; server_name api.example.com; return 301 https://$host$request_uri; }
```

### API → bases externas

Con `EXTERNAL_DB_REQUIRE_TLS=true` (el valor por defecto con `NODE_ENV=production`), crear, editar o probar una conexión sin cifrado devuelve 400 e indica el campo a corregir. Lo implementa `src/connections/credentials/tls-policy.ts`:

| Motor | Requisito |
| --- | --- |
| PostgreSQL | `ssl: true` (`sslmode=require`) |
| MySQL | `ssl: true` |
| SQL Server | `encrypt: true` y `trustServerCertificate: false` |
| MongoDB | `mongodb+srv://`, o `tls=true` / `ssl=true` en la URI |
| Firestore | Siempre usa TLS (gRPC sobre HTTPS) |

**Proveedores con CA propia (Supabase, Aiven, RDS…).** El driver de PostgreSQL trata `sslmode=require` como `verify-full`: verifica el certificado del servidor contra las CA públicas de Node. Si el proveedor firma con su propia CA, la prueba falla con "Falló la negociación SSL/TLS". La solución no es desactivar la verificación: pega el PEM de la CA del proveedor en el campo **Certificado CA** de la conexión (credencial `caCertificate`, PostgreSQL y MySQL, solo con `ssl: true`).
- La conexión sigue cifrada y el servidor se verifica contra esa CA (`rejectUnauthorized: true`).
- El certificado se guarda cifrado junto con las demás credenciales. Los metadatos solo indican `certificadoCa: true`.
- En Supabase se descarga en **Database → Settings → SSL Configuration → Download certificate**.

Las conexiones ya guardadas siguen funcionando. La política se aplica al crearlas, editarlas o probarlas con credenciales nuevas. Si una base de demo no admite TLS, se puede desactivar explícitamente con `EXTERNAL_DB_REQUIRE_TLS=false`.

## 3. Revisión OWASP API Security Top 10 (2023)

| # | Riesgo | Estado | Controles y evidencia |
| --- | --- | :---: | --- |
| API1 | Autorización a nivel de objeto (BOLA) | ✅ | Todas las consultas filtran por el `workspaceId` del token. `test/workspace-isolation.e2e-spec.ts` comprueba que B recibe 404 al leer, modificar, borrar o usar en joins los recursos de A |
| API2 | Autenticación rota | ✅ | bcrypt; política de contraseñas; bloqueo tras `LOGIN_MAX_ATTEMPTS`; access token de 15 min; refresh token rotativo (el anterior queda invalidado); cierre por inactividad; `JWT_SECRET` de 32+ caracteres que no puede ser el de ejemplo en producción. Cubierto en `test/auth.e2e-spec.ts` |
| API3 | Autorización a nivel de propiedad | ✅ | DTOs con lista blanca. Las respuestas nunca incluyen contraseñas ni credenciales (e2e). El AUDITOR recibe `MODIFY_RECORD` sin valores y el LECTOR, datos enmascarados |
| API4 | Consumo de recursos sin límite | ✅ | Rate limiting (corregido, ver §1), `BODY_LIMIT`, límites de multipart, `DATA_ENGINE_MAX_*` (filas y bytes por fuente y por join), timeouts de consulta externa, cola con `JOBS_MAX_ACTIVE_PER_WORKSPACE` |
| API5 | Autorización a nivel de función | ✅ | Matriz única `ROLE_PERMISSIONS` + `RolesGuard`. `test/rbac.e2e-spec.ts` prueba cada permiso con los 4 roles (176 casos), sin token y frente a escalada de rol |
| API6 | Acceso sin restricción a flujos sensibles | ✅ | Throttling específico en registro (5/h), recuperación de contraseña (5/15 min), invitaciones y cambio de contraseña. Tokens de un solo uso con hash |
| API7 | SSRF | ⚠️ Medio, aceptado | Por diseño, un ADMIN puede apuntar una conexión a cualquier host, incluida la red interna del servidor. Mitigaciones: solo ADMIN gestiona conexiones, todo queda auditado y los errores de conexión se normalizan sin devolver respuestas del host. **Recomendación:** desplegar la API en una red sin acceso a servicios internos (metadatos cloud `169.254.169.254`, Redis, la propia PostgreSQL) mediante reglas de egress |
| API8 | Configuración insegura | ✅ | helmet, CORS estricto, sin `X-Powered-By`, errores 5xx genéricos, validación de entorno al arrancar, TLS obligatorio en producción, `npm audit` en CI |
| API9 | Inventario de API | ⚠️ Bajo | OpenAPI en `/api/docs`. Hay rutas alias heredadas (`/data-engine/*` = `/engine/*`) que conviene retirar cuando el frontend use solo `/engine`. Swagger UI es público en producción: si no se necesita, protégelo en el proxy |
| API10 | Consumo inseguro de APIs/fuentes | ✅ | Consultas parametrizadas y lista blanca de operadores de filtro en los adaptadores SQL; nombres de tabla y campo validados; TLS hacia las fuentes; tamaño de los resultados limitado |

## 4. Dependencias

- `npm audit --omit=dev --audit-level=high` corre en CI y falla con vulnerabilidades altas o críticas en dependencias de producción.
- Se actualizaron `@nestjs/*` a 12.4.x (corrige un DoS de `multer` y otro de `body-parser`) y `@azure/msal-node`, todos dentro de su rango semver.
- Quedan 6 avisos **moderados** transitivos de `@google-cloud/firestore` → `google-gax` → `rimraf` → `glob`/`minimatch`. Son DoS por patrones glob y la API nunca pasa entrada de usuario a esas funciones. Se aceptan hasta que Google publique la actualización.
