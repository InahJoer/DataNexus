# Pruebas del backend

| Comando | Qué ejecuta | Requiere |
| --- | --- | --- |
| `npm test` | Pruebas unitarias (`src/**/*.spec.ts`). Las de integración (`*.integration.spec.ts`) se omiten solas si falta `DATABASE_URL` | — |
| `npm run test:cov` | Lo mismo, con cobertura | — |
| `npm run test:e2e` | Pruebas e2e (`test/*.e2e-spec.ts`) contra la API completa | PostgreSQL |

## Pruebas e2e (issue #50)

Levantan `AppModule` con la misma configuración HTTP que `main.ts` (`configureApp`) y hacen peticiones reales con supertest.

**Base de datos aislada por suite.** `test/e2e/setup.ts` se ejecuta antes de cada archivo:

1. Crea un esquema `e2e_<aleatorio>` en el PostgreSQL de `E2E_DATABASE_URL` o, si no existe, de `DATABASE_URL`.
2. Le aplica las migraciones (`prisma migrate deploy`).
3. Apunta `DATABASE_URL` a ese esquema antes de importar la app.
4. Lo elimina (`DROP SCHEMA … CASCADE`) al terminar la suite.

Las suites corren en paralelo sin compartir datos y nunca tocan el esquema `public`.

```bash
# Con el PostgreSQL de docker-compose
docker compose up -d postgres
DATABASE_URL="postgresql://datanexus:datanexus@localhost:5432/datanexus" npm run test:e2e
```

| Suite | Cubre |
| --- | --- |
| `auth.e2e-spec.ts` | Registro, correo duplicado, validación, login, perfil, refresh rotativo con invalidación del token anterior, logout, tokens falsificados y bloqueo por intentos |
| `rbac.e2e-spec.ts` | Matriz completa: cada permiso de `ROLE_PERMISSIONS` × los 4 roles, sin token, endpoints comunes y escalada de rol. Falla si se añade un permiso sin probarlo |
| `data-flows.e2e-spec.ts` | Conexión PostgreSQL real → probar conexión → explorar → cross-join con filtros → exportar Excel/JSON → consulta guardada → reporte programado ejecutado → bitácora (AUDITOR) e inmutabilidad |
| `workspace-isolation.e2e-spec.ts` | Un ADMIN de otro workspace recibe 404 al leer, editar, borrar o usar en joins conexiones, consultas, miembros y eventos de auditoría ajenos |
| `platform.e2e-spec.ts` | `/health`, `/health/ready`, `X-Request-Id`, cabeceras de helmet, 413 por tamaño, JSON mal formado, CORS y formato de error |

En CI (`.github/workflows/ci-cd.yml`) las e2e corren después de las unitarias, con el servicio PostgreSQL del job.
