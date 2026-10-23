# DataNexus Backend

API NestJS del backend de DataNexus. Este repositorio mantiene el esquema Prisma, migraciones, reglas de autorización y contratos HTTP. Los demás repositorios del Polyrepo integran la API por HTTP usando el contrato OpenAPI versionado.

## Desarrollo

```bash
npm ci
cp .env.example .env
```

Configura `DATABASE_URL`, `JWT_SECRET` y `ENCRYPTION_KEY` en `.env`, y aplica las migraciones Prisma antes de iniciar la API:

```bash
./node_modules/.bin/prisma migrate deploy
npm run start:dev
```

La documentación Swagger se sirve en `/api/docs`. El contrato estable para consumo entre repositorios se mantiene en [`docs/openapi/v1.yaml`](docs/openapi/v1.yaml); las modificaciones de rutas o respuestas deben actualizar este archivo en el mismo cambio.

## Auditoría y permisos

- Se registran logins exitosos y fallidos, cambios de rol y creación, actualización o eliminación de conexiones.
- Los eventos de cambios de rol y conexiones se guardan en la misma transacción que el cambio.
- Solo `ADMIN` puede cambiar roles o modificar conexiones. Las consultas y exploraciones siempre se limitan al `workspaceId` del JWT.
- Las respuestas de conexiones no incluyen credenciales en claro ni cifradas. El endpoint de exploración devuelve únicamente metadatos.

El registro público todavía recibe el `workspaceId` del cliente. La política de admisión de nuevos usuarios a workspaces sigue pendiente de definición; no considerar resuelta esa decisión por las restricciones añadidas a las operaciones de esta fase.

## Exploración de esquemas externos

`GET /data-engine/connections/{connectionId}/schema` lista tablas y vistas de SQL Server, PostgreSQL y MySQL, o colecciones de nivel raíz de Cloud Firestore. No recorre subcolecciones anidadas, filas ni documentos. La operación tiene un límite de 10 segundos.

Formatos de `connectionString` al crear una conexión:

- PostgreSQL: URL `postgres://` o `postgresql://`.
- MySQL: URL `mysql://` con usuario/contraseña; `dbName` selecciona la base de datos.
- SQL Server: cadena ADO.NET, por ejemplo `Server=host,1433;Database=db;User Id=user;Password=...;Encrypt=true`.
- Firestore: JSON de cuenta de servicio de Google Cloud, con `project_id`, `client_email` y `private_key`; `dbName` puede ser `(default)` o el ID de una base Firestore.

## Extracción y joins reales

El join real admite SQL Server y Firebase/Cloud Firestore. PostgreSQL y MySQL siguen disponibles para explorar el catálogo, pero aún no tienen extractor real para el join. Firestore lee colecciones de nivel raíz y agrega el ID del documento como `__documentId`. En SQL Server se puede enviar `esquemaSql`; los identificadores se citan antes de formar la consulta.

Para mantener acotado el join en memoria, `DATA_ENGINE_MAX_SOURCE_ROWS` limita cada origen (10 000 por defecto) y `DATA_ENGINE_MAX_SOURCE_BYTES` limita el tamaño serializado por origen (32 MiB). `DATA_ENGINE_MAX_JOIN_ROWS` limita las filas resultantes (100 000) y `DATA_ENGINE_MAX_JOIN_BYTES` su tamaño serializado (64 MiB). Los límites se leen al ejecutar cada extracción o join. Si se supera uno, la API devuelve HTTP 413. Las columnas con el mismo nombre se conservan como `sql.<campo>` y `nosql.<campo>`.

La API debe ejecutarse en un entorno backend confiable para poder conectarse a los motores externos. Trata las cadenas de conexión y las cuentas de servicio como secretos; nunca las registres ni las expongas a clientes.

## Verificación enfocada

```bash
npm test -- src/audit/audit.service.spec.ts src/auth/auth.service.spec.ts src/users/users.service.spec.ts src/connections/connections.service.spec.ts src/data-engine/data-engine.service.spec.ts
```
