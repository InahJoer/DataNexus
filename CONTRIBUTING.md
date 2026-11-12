# Guía de contribución

## Flujo de ramas

`main` siempre está desplegable. Está protegida: no admite push directo ni force push, y exige CI en verde y una revisión aprobada (`.github/branch-protection.json`).

1. Parte de `main` actualizado:
   ```bash
   git switch main && git pull --ff-only
   git switch -c feat/<tema-corto>
   ```
2. Nombra la rama según el tipo de cambio:

   | Prefijo | Uso |
   | --- | --- |
   | `feat/` | Funcionalidad nueva |
   | `fix/` | Corrección de errores |
   | `refactor/` | Cambio interno sin efecto funcional |
   | `docs/` | Solo documentación |
   | `ci/` | Pipeline, Docker o despliegue |

3. Un issue por PR, o un grupo pequeño de issues muy relacionados.
4. Mantén la rama al día con `git pull --rebase origin main` o con un merge de `main`, antes de pedir revisión.

## Commits

Usa [Conventional Commits](https://www.conventionalcommits.org/es/) en español, en imperativo y con el issue entre paréntesis:

```
feat(auth): tokens de acceso personal para integraciones (#65)
fix(reports): no reintentar envíos aceptados parcialmente (#108)
```

Ámbitos habituales: `auth`, `connections`, `data-engine`, `queries`, `reports`, `audit`, `workspaces`, `frontend`, `ci` y `docs`.

## Pull Requests

- Rellena la plantilla (`.github/pull_request_template.md`) e incluye `Closes #N` para cerrar el issue al fusionar.
- El CI ejecuta `prisma validate`, migraciones, lint (`oxlint --type-aware`), build, pruebas unitarias con cobertura, pruebas e2e, `npm audit` y la construcción de las imágenes Docker.
- **Si el CI falla, el PR se cierra solo** con un comentario que indica qué falló (`pr-ci-guard`). Corrige, sube los cambios y reábrelo.
- Comprueba en local antes de subir:
  ```bash
  npm --prefix backend run lint
  npm --prefix backend run build
  npm --prefix backend test
  npm --prefix backend run test:e2e   # necesita PostgreSQL
  ```

## Reglas del código

- **RBAC:** protege cada endpoint nuevo con `@RequirePermission()`. Los permisos viven solo en `ROLE_PERMISSIONS` (`backend/src/auth/interfaces/user-role.ts`). Si añades uno, añade su caso a `test/rbac.e2e-spec.ts`; la prueba falla si queda un permiso sin cubrir.
- **Multi-tenant:** toda consulta filtra por el `workspaceId` del usuario autenticado.
- **Base de datos:** todo cambio de `schema.prisma` va con su migración (`npm --prefix backend run db:migrate -- --name <nombre>`). No edites migraciones ya fusionadas.
- **Variables de entorno:** decláralas en `env.validation.ts`, `backend/.env.example` y `.env.production.example`.
- **Secretos:** nunca en el código, los logs ni los mensajes de error. Los archivos `.env` no se versionan.
- **API:** si cambia un endpoint, regenera el contrato y los tipos del frontend:
  ```bash
  npm --prefix backend run openapi:generate
  npx openapi-typescript backend/docs/openapi/v1.json --default-non-nullable false -o lib/api/schema.d.ts
  ```
- **Auditoría:** las acciones que cambian seguridad, infraestructura o datos registran un evento con `AuditService.record()`. La bitácora es solo de inserción.
