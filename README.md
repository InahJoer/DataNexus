# DataNexus Backend

API NestJS del backend de DataNexus: Plataforma Unificada de Gestión de Datos Mixtas, Business Intelligence & Federación.

Para la especificación arquitectónica detallada, consulta [`docs/ARQUITECTURA.md`](docs/ARQUITECTURA.md).

## Requisitos y Configuración Inicial

```bash
npm ci
cp .env.example .env
```

Configura las variables esenciales en `.env`:
- `DATABASE_URL`: Cadena de conexión (SQLite local `file:./dev.db` o PostgreSQL).
- `JWT_SECRET`: Clave secreta para firma y verificación de tokens JWT.
- `ENCRYPTION_KEY`: Clave hex de 32 bytes (64 caracteres) para el cifrado AES-256-GCM.
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`: Configuración opcional para envío de correos (en local se utiliza transporter en memoria simulado).

Aplica las migraciones de base de datos antes de iniciar:

```bash
npx prisma migrate dev
npm run start:dev
# o bien
npm run dev
```

La documentación Swagger interactiva se encuentra disponible en:
- `http://localhost:3000/api/docs`

---

## Módulos y Capacidades Implementadas

1. **Autenticación & RBAC (`/auth`):**
   - Registro de empresas/workspaces y login con JWT.
   - Roles soportados: `ADMIN` y `LECTOR`.
2. **Conexiones Cifradas (`/connections`):**
   - Cifrado en reposo AES-256-GCM para cadenas de conexión.
   - Acceso seguro sin exposición de credenciales hacia clientes.
3. **Auditoría del Sistema (`/audit`):**
   - Registro inmutable de inicios de sesión, cambios de rol y modificación de conexiones.
   - `GET /audit/logs`: Consulta paginada (`page`, `limit`) y filtros por `fechaInicio`, `fechaFin` y `tipoAccion` (exclusivo `ADMIN`).
4. **Motor de Datos & Cross-Joins (`/engine`):**
   - Exploración de catálogos y esquemas externos en SQL Server, PostgreSQL, MySQL y Firestore.
   - `POST /engine/join`: Cruce de datos en memoria (Inner Join indexado) con enmascaramiento automático de campos sensibles para rol `LECTOR`.
   - `POST /engine/export`: Exportación descargable en Excel (`.xlsx`), PDF y JSON protegida con rate limiting de 20 req/min.
5. **Automatización de Reportes & Cron (`/reports`):**
   - Tarea programada diaria a la medianoche (UTC) mediante `@nestjs/schedule`.
   - Despacho de reportes consolidados por correo electrónico con adjuntos binarios mediante `nodemailer`.
6. **Seguridad Perimetral & Rate Limiting:**
   - Políticas CORS restrictivas para orígenes autorizados de frontend (Next.js en local y producción).
   - Throttling global mediante `@nestjs/throttler`.
7. **Ecosistema Empresarial de Miembros (`/users`):**
   - `GET /users`: Listado de miembros del Workspace.
   - `POST /users/invite`: Invitación y alta de nuevos miembros con rol asignado (`ADMIN`/`LECTOR`).
   - `PATCH /users/:id/role`: Modificación de roles por parte de administradores.

---

## Pruebas de Calidad

Ejecución completa de la suite de pruebas unitarias:

```bash
npm run test
```

Compilación de producción:

```bash
npm run build
```
