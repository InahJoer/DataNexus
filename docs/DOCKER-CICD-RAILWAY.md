# Docker, CI/CD y Railway en DataNexus

La guía del curso usa Nginx para servir un sitio estático. DataNexus necesita dos imágenes Node independientes: Next.js en la raíz y NestJS en `backend/`. PostgreSQL es la persistencia interna. En desarrollo, Compose reutiliza el servicio PostgreSQL existente en `backend/docker-compose.yml`; para producción, los contenedores reciben la URL de una instancia PostgreSQL externa.

## Desarrollo local

Requiere Docker Compose v2.20 o posterior por el uso de `include`.

1. Ejecuta `docker compose up --build` en la raíz. El `.env` es opcional: sin él se usan los valores de desarrollo de `.env.docker.example` (cópialo como `.env` solo para cambiarlos).
2. Abre `http://localhost:3000` y `http://localhost:3001/api/docs`. El correo enviado por la API se ve en `http://localhost:8025` (Mailpit).
3. Inicia sesión con `admin@datanexus.demo` / `DataNexus2026!` (también `operador@`, `lector@` y `auditor@datanexus.demo`).

Compose monta el código fuente, usa los scripts de desarrollo existentes y aplica las migraciones pendientes con `prisma migrate deploy` antes de iniciar el backend. El proyecto Compose conserva el nombre `backend` para reutilizar el contenedor y el volumen PostgreSQL (`backend_datanexus-pgdata`) creados por la configuración anterior. `docker compose down` detiene los servicios sin borrar ese volumen.

### Entorno de demo (issue #49)

`docker compose up` levanta además una fuente de cada motor soportado con datos de ejemplo deterministas, pensados para probar cross-joins:

| Servicio | Motor | Datos | Puerto local |
| --- | --- | --- | --- |
| `sqlserver` | SQL Server 2022 | `erp.dbo.clientes`: 24 clientes | 1433 |
| `mysql` | MySQL 8.4 | `tienda.pedidos`: 75 pedidos (clientes 1–20) | 3306 |
| `postgres-demo` | PostgreSQL 16 | `logistica.public.envios`: 40 envíos | 5433 |
| `mongo` | MongoDB 7 | `app_eventos.eventos`: 120 eventos | 27017 |
| `firestore` | Emulador de Firestore | colección `tickets`: 30 tickets | 8080 |
| `mailpit` | SMTP de pruebas | bandeja web | 8025 (SMTP 1025) |

Los datos están en `docker/demo/` y `backend/prisma/demo/`. Incluyen casos para los distintos tipos de join: clientes sin pedidos (21–24) y pedidos sin envío. Al arrancar, el backend ejecuta en orden:

1. `db:deploy`
2. `db:seed` (workspace "DataNexus Demo S.A." y sus usuarios)
3. `db:seed:demo`, que:
   - registra las cinco conexiones (credenciales cifradas con `ENCRYPTION_KEY`);
   - carga los tickets en el emulador;
   - publica dos consultas guardadas listas para ejecutar: **Clientes, pedidos y envíos** (SQL Server × MySQL × PostgreSQL) y **Actividad y soporte por cliente** (SQL Server × MongoDB × Firestore).

`db:seed:demo` es idempotente. Al repetirlo, actualiza las conexiones demo, pero no pisa las consultas si alguien las editó. Solo escribe en Firestore si existe `FIRESTORE_EMULATOR_HOST`, así que nunca toca un proyecto real.

Las fuentes de la demo no usan volúmenes con nombre: `docker compose down` y `up` las dejan como nuevas. La base interna de la API sí conserva su volumen. La imagen de SQL Server solo existe para `amd64`; en Mac con Apple Silicon corre emulada y tarda más en arrancar. Si un puerto está ocupado, cámbialo con las variables `DEMO_*_PORT` de `.env.docker.example`.

Para correr la API fuera de Docker contra estas fuentes, sigue estos pasos:

1. Levántalas con `docker compose up -d sqlserver sqlserver-init mysql postgres-demo mongo firestore mailpit`.
2. Desde `backend/`, ejecuta:

   ```sh
   FIRESTORE_EMULATOR_HOST=localhost:8080 DEMO_SOURCES_HOST=localhost npm run db:seed:demo
   ```

3. Arranca la API con `FIRESTORE_EMULATOR_HOST=localhost:8080`.

El Compose de producción construye las imágenes optimizadas y requiere una conexión PostgreSQL externa. Prepara un archivo separado para producción:

```sh
cp .env.production.example .env.production
# Edita .env.production con los dominios, DATABASE_URL y claves persistentes.
docker compose --env-file .env.production -f docker-compose.prod.yml up --build
```

Genera `JWT_SECRET` con `openssl rand -base64 48` y `ENCRYPTION_KEY` con `openssl rand -hex 32` una sola vez; guarda sus valores en un gestor de secretos y reutilízalos en futuros arranques. Cambiar `ENCRYPTION_KEY` impide descifrar las credenciales cifradas que ya están guardadas. `DATABASE_URL` debe apuntar a PostgreSQL accesible desde los contenedores. `.env.production` no se versiona ni se copia a las imágenes; Compose pasa también desde ese archivo las opciones SMTP y demás variables opcionales del backend.

## Imágenes

- `Dockerfile` construye el frontend con salida Next.js `standalone`. `NEXT_PUBLIC_API_URL` es un argumento de build porque Next.js incorpora las variables `NEXT_PUBLIC_*` al bundle del navegador.
- `backend/Dockerfile` genera Prisma Client, compila NestJS y ejecuta `prisma migrate deploy` en la base indicada por `DATABASE_URL` antes de iniciar la API.
- `.dockerignore` y `backend/.dockerignore` evitan incluir secretos, dependencias locales y artefactos de build.

Que falten funcionalidades no impide construir la imagen: el código actual debe compilar y el servicio debe poder iniciar con PostgreSQL y las variables requeridas. La imagen no equivale a un despliegue de producción.

## GitHub Actions y GHCR

`.github/workflows/ci-cd.yml` corre en pushes a `DOCKERCICD` y `main`, Pull Requests hacia `main` y ejecuciones manuales. El job **Validate backend** inicia PostgreSQL y Redis y ejecuta, en orden: `npm ci`, `prisma generate`, `prisma validate`, migraciones, `npm run lint` (oxlint `--type-aware`), `npm run build`, las pruebas con cobertura, las pruebas e2e (`npm run test:e2e`) y `npm audit --omit=dev --audit-level=high`. Después, **Build and validate Docker images** construye las dos imágenes. Solo cuando ambas compilaciones Docker terminan correctamente, otro job publica las imágenes desde pushes.

### Cobertura (issue #48)

Las pruebas corren con `vitest --coverage` (v8). El resumen (líneas, sentencias, funciones y ramas) aparece en la pestaña **Summary** de cada ejecución, y el reporte completo (`lcov` y HTML) se guarda 14 días como artefacto `backend-coverage`. En local: `npm --prefix backend run test:cov`.

### PR con el CI en rojo (issue #48)

`.github/workflows/pr-ci-guard.yml` se ejecuta cuando termina el CI de un Pull Request. Si falló, comenta en el PR qué jobs y pasos fallaron, cómo reproducirlo en local, y cierra el PR. Tras subir la corrección a la misma rama, se reabre con **Reopen pull request** y el CI vuelve a correr. Por usar `workflow_run`, GitHub lo ejecuta desde la versión de `main`: empieza a funcionar cuando este archivo está en `main`.

### Protección de `main` (issue #48)

La protección de rama no se guarda en el repositorio: la aplica un administrador con la configuración de `.github/branch-protection.json` (CI verde en **Validate backend** y **Build and validate Docker images**, rama actualizada, 1 aprobación, conversaciones resueltas y sin force push):

```bash
gh api -X PUT repos/InahJoer/DataNexus/branches/main/protection --input .github/branch-protection.json
```

Con ella, un PR con pruebas rotas no puede fusionarse aunque alguien lo reabra sin corregirlo.

Las plantillas de PR y de issues están en `.github/pull_request_template.md` y `.github/ISSUE_TEMPLATE/`.

Después de CI, los pushes (no los Pull Requests) publican imágenes a GHCR:

- `ghcr.io/inahjoer/datanexus-frontend`
- `ghcr.io/inahjoer/datanexus-backend`

Cada imagen lleva un tag `sha-<commit>`; `main` también actualiza `latest`, mientras `DOCKERCICD` publica su propio tag. El workflow usa `GITHUB_TOKEN`; no hace falta crear un PAT para publicar desde este repositorio.

## Preparar Railway, sin desplegar ahora

Cuando estén listos para conectarlo:

1. Crea un proyecto Railway con un servicio PostgreSQL administrado.
2. Crea dos servicios de imagen Docker: `ghcr.io/inahjoer/datanexus-frontend:latest` y `ghcr.io/inahjoer/datanexus-backend:latest`.
3. Configura `DATABASE_URL` del backend con la URL PostgreSQL de Railway, más `JWT_SECRET`, `ENCRYPTION_KEY` y `FRONTEND_URL`. El servicio backend ejecuta las migraciones existentes al iniciar.
4. Configura la variable de repositorio `NEXT_PUBLIC_API_URL` con la URL pública del backend antes de construir la imagen del frontend.
5. Si GHCR permanece privado, configura credenciales de registry en Railway; de lo contrario, publica ambos paquetes como públicos.
6. Agrega los secretos `RAILWAY_TOKEN`, `RAILWAY_FRONTEND_SERVICE_ID` y `RAILWAY_BACKEND_SERVICE_ID` a GitHub Actions.
7. Solo cuando autoricen CD, crea la variable de repositorio `ENABLE_RAILWAY_CD=true`.

El job de Railway solo se ejecuta en un push a `main`, tras el éxito de CI y la publicación de imágenes, y cuando `ENABLE_RAILWAY_CD` vale exactamente `true`. El job usa Railway CLI 5.71.0 y `railway redeploy --from-source` para desplegar la imagen nueva desde el tag `latest` configurado en cada servicio. Esa variable y los secretos no están configurados por este cambio, por lo que el workflow queda apagado y no despliega.

El servicio backend aplica migraciones existentes con `prisma migrate deploy`; no ejecuta resets ni modifica datos mediante una migración destructiva.

## Despliegue a staging (issue #49)

En cada push a `main` con el CI en verde y las imágenes ya publicadas, el job **Deploy staging** hace dos cosas:

1. Redespliega los servicios del entorno `staging` de Railway.
2. Comprueba `GET /health` de la API de staging.

Las imágenes de staging son:

- **Backend:** el workflow publica `ghcr.io/inahjoer/datanexus-backend:staging`, la misma imagen que `latest`.
- **Frontend:** tiene su propia imagen, `ghcr.io/inahjoer/datanexus-frontend:staging`, construida con `NEXT_PUBLIC_API_URL=STAGING_API_URL`. La URL de la API queda incrustada en el bundle, así que no puede reutilizar la de producción.

El job de producción (`deploy-railway`) sigue siendo independiente.

Para activarlo:

1. En Railway, crea un entorno `staging` en el proyecto, con su propio PostgreSQL. Crea también dos servicios de imagen: `ghcr.io/inahjoer/datanexus-backend:staging` y `ghcr.io/inahjoer/datanexus-frontend:staging`.
2. Configura las variables del backend de staging, igual que en producción, con claves propias. Para cargar las cuentas demo, ejecuta una vez `npm run db:seed` contra la base de staging.
3. En GitHub, ve a **Settings → Environments** y crea el entorno `staging`. Ahí agrega los secretos `RAILWAY_STAGING_TOKEN` (token de proyecto limitado al entorno staging), `RAILWAY_STAGING_FRONTEND_SERVICE_ID` y `RAILWAY_STAGING_BACKEND_SERVICE_ID`.
4. Crea las variables de repositorio `STAGING_API_URL` (URL pública de la API de staging, sin `/` final) y `STAGING_FRONTEND_URL`.
5. Activa el pipeline con la variable de repositorio `ENABLE_STAGING_CD=true`.

Los nombres de los secretos son distintos a los de producción a propósito. Si faltara alguno, el job falla en vez de usar por error el token de producción.

## PostgreSQL en un volumen pequeño (plan gratuito de Railway)

En los planes Free y Trial de Railway el volumen de PostgreSQL mide 0.5 GB y no se puede ampliar. Si se llena, PostgreSQL no puede ni escribir su registro de recuperación y entra en un ciclo de caídas. Sin plan de pago, la única salida es borrar el volumen; las migraciones vuelven a crear las tablas al arrancar la API.

Para que no se llene:

1. **Limita las cargas de Excel**, que guardan cada hoja como una tabla. Configura `EXCEL_DB_MAX_MB=300` en el backend: al superar ese tamaño, la carga se detiene con un aviso en lugar de llenar el disco.
2. **Limita el WAL** (registro de transacciones). Por defecto puede crecer hasta 1 GB, más que todo el volumen. Una sola vez, con `psql` contra la base:

   ```sql
   ALTER SYSTEM SET max_wal_size = '96MB';
   ALTER SYSTEM SET min_wal_size = '32MB';
   SELECT pg_reload_conf();
   ```

   La configuración se guarda en el volumen: repítela si lo recreas.
3. **Limpieza automática.** La API borra cada día, a las 03:30 UTC y un minuto después de arrancar, lo siguiente:
   - las sesiones vencidas o revocadas hace más de 7 días, con sus refresh tokens;
   - los tokens de recuperación de contraseña vencidos o usados hace más de 7 días.

   No necesita configuración.
4. **La bitácora de auditoría no se borra.** Es inmutable (RF-26) y se conserva 5 años (`backend/docs/SLA-OLA.md`). Si ocupa demasiado, exporta y archiva la bitácora según `backend/docs/DRP.md`, o usa un plan con más disco.

Para ver qué ocupa espacio:

```sql
SELECT relname AS tabla, pg_size_pretty(pg_total_relation_size(relid)) AS tamano
FROM pg_catalog.pg_statio_user_tables ORDER BY pg_total_relation_size(relid) DESC LIMIT 10;
```
