# DataNexus Backend

API NestJS, Prisma y SQLite de DataNexus. La aplicación Next.js se ejecuta desde la raíz del repositorio.

## Configuración

Desde la raíz instala dependencias y crea la configuración local:

```bash
npm --prefix backend ci
cp -n backend/.env.example backend/.env
```

Para migraciones, entra al backend:

```bash
cd backend
npm exec -- prisma migrate dev
npm run dev
```

La API corre en `http://localhost:3001` y Swagger en `http://localhost:3001/api/docs`.
La guía de arquitectura está en [`docs/ARQUITECTURA.md`](docs/ARQUITECTURA.md).

## Módulos

- Autenticación JWT y perfiles por workspace.
- Gestión de conexiones con credenciales cifradas.
- Exploración de esquemas y cruces SQL/NoSQL, con exportación.
- Auditoría paginada y filtrada por fecha y evento.
- Gestión de miembros y reportes programados.

## Comandos

```bash
npm run build
npm run test
```
