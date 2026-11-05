# DataNexus Backend

API de DataNexus con NestJS, Prisma y PostgreSQL. La aplicación Next.js se ejecuta desde la raíz del repositorio.

## Configuración

Requisitos: Node.js 22.18+ (el seed usa TypeScript nativo de Node) y PostgreSQL 14+ (local con Docker o un servidor propio).

Desde la raíz instala dependencias y crea la configuración local:

```bash
npm --prefix backend ci
cp -n backend/.env.example backend/.env
```

Levanta PostgreSQL, aplica migraciones y carga datos demo:

```bash
cd backend
npm run db:up        # docker compose up -d postgres
npm run db:migrate   # prisma migrate dev
npm run db:seed      # workspace demo con un usuario de cada rol
npm run dev
```

Si no usas Docker, crea una base `datanexus` y ajusta `DATABASE_URL` en `.env`.

La API corre en `http://localhost:3001` y Swagger en `http://localhost:3001/api/docs`.
La guía de arquitectura está en [`docs/ARQUITECTURA.md`](docs/ARQUITECTURA.md).

### Variables de entorno

La app valida el `.env` al arrancar (`src/config/env.validation.ts`) y no inicia si falta algo crítico:

| Variable | Requerida | Regla |
| --- | :-: | --- |
| `DATABASE_URL` | ✅ | URL `postgresql://...` |
| `JWT_SECRET` | ✅ | Mínimo 32 caracteres |
| `ENCRYPTION_KEY` | ✅ | 64 caracteres hex (`openssl rand -hex 32`) |
| `PORT`, `SMTP_PORT` | | Entero 1–65535 |
| `FRONTEND_URL` | | URL válida |

Con `NODE_ENV=production` se rechazan los secretos de ejemplo de `.env.example`.

### Usuarios demo (`npm run db:seed`)

| Rol | Email |
| --- | --- |
| ADMIN | `admin@datanexus.demo` (o `SEED_ADMIN_EMAIL`) |
| OPERADOR | `operador@datanexus.demo` |
| LECTOR | `lector@datanexus.demo` |
| AUDITOR | `auditor@datanexus.demo` |

La contraseña es la de `SEED_PASSWORD` en tu `.env`.

## Módulos

- Autenticación JWT y matriz RBAC de 4 roles por workspace.
- Gestión de conexiones con credenciales cifradas.
- Exploración de esquemas y cruces SQL/NoSQL, con exportación.
- Auditoría paginada y filtrada por fecha y evento.
- Gestión de miembros y reportes programados.

## Comandos

```bash
npm run build
npm run test         # la prueba de PrismaService necesita DATABASE_URL
npm run db:reset     # borra y recrea la base local
```
