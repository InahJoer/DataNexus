# Docker, CI/CD y Railway en DataNexus

La guía del curso usa Nginx para servir un sitio estático. DataNexus necesita dos imágenes Node independientes: Next.js en la raíz y NestJS en `backend/`. PostgreSQL es la persistencia interna. En desarrollo, Compose reutiliza el servicio PostgreSQL existente en `backend/docker-compose.yml`; para producción, los contenedores reciben la URL de una instancia PostgreSQL externa.

## Desarrollo local

Requiere Docker Compose v2.20 o posterior por el uso de `include`.

1. Copia `.env.docker.example` a `.env` en la raíz.
2. Ejecuta `docker compose up --build`.
3. Abre `http://localhost:3000` y `http://localhost:3001/api/docs`.

Compose monta el código fuente, usa los scripts de desarrollo existentes y aplica las migraciones pendientes con `prisma migrate deploy` antes de iniciar el backend. El proyecto Compose conserva el nombre `backend` para reutilizar el contenedor y el volumen PostgreSQL (`backend_datanexus-pgdata`) creados por la configuración anterior. `docker compose down` detiene los servicios sin borrar ese volumen.

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
