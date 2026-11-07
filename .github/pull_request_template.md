## Qué cambia

<!-- Resumen breve del cambio y por qué. -->

Closes #

## Cómo se probó

- [ ] `npm --prefix backend run lint` sin errores (oxlint `--type-aware`, igual que el CI)
- [ ] `npm --prefix backend run build`
- [ ] `npm --prefix backend test` en verde
- [ ] Probado manualmente en Swagger o en la interfaz (describe cómo)

## Checklist

- [ ] La rama está actualizada con `main`
- [ ] Si cambia el esquema de Prisma, incluye su migración y `npx prisma validate` pasa
- [ ] Si agrega variables de entorno, están en `backend/.env.example`, `.env.production.example` y en `env.validation.ts`
- [ ] Respeta los permisos por rol (RBAC) y no expone credenciales ni datos sin enmascarar
- [ ] Documentación actualizada (`backend/docs/ARQUITECTURA.md`) si cambia un endpoint

> Si el CI falla, el PR se cierra automáticamente con un comentario que indica qué reparar. Corrige, sube los cambios y reábrelo.
