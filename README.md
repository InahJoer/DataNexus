# DataNexus

Plataforma unificada de gestión de datos mixtos y Business Intelligence. Conecta bases relacionales (PostgreSQL, MySQL, SQL Server) y NoSQL (MongoDB, Firestore), las cruza en memoria (*cross-joins*), enmascara datos sensibles según el rol, exporta resultados y programa reportes por correo. Todo queda en una bitácora de auditoría inmutable.

| Carpeta | Contenido |
| --- | --- |
| `/` (raíz) | Frontend Next.js |
| [`backend/`](backend/) | API NestJS + Prisma + PostgreSQL |
| [`backend/docs/`](backend/docs/) | Arquitectura, seguridad, operación y gobierno de TI |

## Levantar el proyecto desde cero

### Opción A · Docker (recomendada)

Requisitos: Docker con Compose v2.20 o posterior.

```bash
git clone https://github.com/InahJoer/DataNexus.git
cd DataNexus
docker compose up --build
```

El `.env` es opcional: sin él se usan los valores de desarrollo de `.env.docker.example` (cópialo como `.env` solo si quieres cambiarlos).

Compose levanta PostgreSQL, Redis, la API y el frontend. También levanta una fuente de cada motor con datos de ejemplo (SQL Server, MySQL, PostgreSQL, MongoDB y el emulador de Firestore) y Mailpit para el correo. Al arrancar, la API aplica las migraciones y carga los usuarios demo. Además registra las cinco conexiones y publica dos consultas cross-join listas para ejecutar. Detalles en [Docker, CI/CD y Railway](docs/DOCKER-CICD-RAILWAY.md#entorno-de-demo-issue-49).

### Opción B · Node.js local

Requisitos: Node.js 22.18 o posterior, y PostgreSQL 14 o posterior (propio o `npm --prefix backend run db:up` con Docker). Redis es opcional.

```bash
git clone https://github.com/InahJoer/DataNexus.git
cd DataNexus
npm ci
npm --prefix backend ci
cp backend/.env.example backend/.env    # ajusta DATABASE_URL si no usas el PostgreSQL de Docker
npm --prefix backend run db:deploy      # aplica las migraciones
npm --prefix backend run db:seed        # workspace demo con un usuario de cada rol
```

Inicia cada aplicación en una terminal:

```bash
npm --prefix backend run dev
```

```bash
npm run dev
```

### Comprobar que funciona

| Qué | Dónde |
| --- | --- |
| Frontend | http://localhost:3000 |
| API (Swagger) | http://localhost:3001/api/docs |
| Health check | http://localhost:3001/health/ready |
| Correo enviado (solo Docker) | http://localhost:8025 |

Entra con `admin@datanexus.demo` y la contraseña de `SEED_PASSWORD` (por defecto `DataNexus2026!`). También existen `operador@`, `lector@` y `auditor@datanexus.demo`, uno por rol.

## Pruebas

```bash
npm --prefix backend run lint
npm --prefix backend test            # unitarias (+ integración si hay DATABASE_URL)
npm --prefix backend run test:e2e    # e2e contra PostgreSQL; ver backend/docs/PRUEBAS.md
```

## Documentación

| Documento | Contenido |
| --- | --- |
| [Arquitectura](backend/docs/ARQUITECTURA.md) | Módulos, diagramas, matriz RBAC de 4 roles y tokens de acceso personal |
| [OpenAPI](backend/docs/openapi/v1.yaml) | Contrato de la API, generado del código con `npm --prefix backend run openapi:generate` |
| [Seguridad](backend/docs/SEGURIDAD.md) | Hardening, TLS y revisión OWASP API Top 10 |
| [Observabilidad](backend/docs/OBSERVABILIDAD.md) | Health checks, logs JSON y `requestId` |
| [Pruebas](backend/docs/PRUEBAS.md) | Suites unitarias, de integración y e2e |
| [Respaldo y recuperación (DRP)](backend/docs/DRP.md) | Copias de seguridad, RPO/RTO y procedimientos de restauración (COBIT DSS04) |
| [SLA y OLA](backend/docs/SLA-OLA.md) | Niveles de servicio y acuerdos internos (ITIL 4) |
| [Docker, CI/CD y Railway](docs/DOCKER-CICD-RAILWAY.md) | Imágenes, pipeline y despliegue |
| [Guía de contribución](CONTRIBUTING.md) | Flujo de ramas, commits, PRs y CI |
