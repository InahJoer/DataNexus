# DataNexus

La aplicación web Next.js vive en la raíz del repositorio. La API NestJS y Prisma están dentro de [`backend/`](backend/).

## Instalación

Desde la raíz:

```bash
npm ci
npm --prefix backend ci
cp -n backend/.env.example backend/.env
```

## Desarrollo

Inicia cada aplicación en una terminal separada:

```bash
npm run dev
PORT=3001 npm --prefix backend run dev
```

El frontend usa `http://localhost:3000`. El backend usa `http://localhost:3001` y Swagger está en `http://localhost:3001/api/docs`.
Consulta [`backend/README.md`](backend/README.md) para migraciones y comandos adicionales.
