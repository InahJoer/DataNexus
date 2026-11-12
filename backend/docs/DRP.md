# Plan de respaldo y recuperación ante desastres (DRP)

Issue #53 · COBIT 2019 **DSS04 – Gestionar la continuidad** y **DSS01.01 – Procedimientos operativos** · ITIL 4 *Service continuity management*.

## 1. Alcance y objetivos

| Activo | Criticidad | Qué se pierde sin él |
| --- | :---: | --- |
| PostgreSQL de DataNexus (`DATABASE_URL`) | Crítica | Usuarios, workspaces, conexiones cifradas, consultas, reportes programados y **bitácora de auditoría** |
| `ENCRYPTION_KEY` | Crítica | Sin ella, las credenciales de **todas** las conexiones guardadas son irrecuperables, aunque la base esté intacta |
| `JWT_SECRET` | Alta | Si se pierde o cambia, todas las sesiones se cierran; se recupera generando otro |
| Reportes generados (`REPORTS_LOCAL_DIRECTORY` o bucket GCS) | Media | Los archivos ya enviados; se pueden regenerar ejecutando la tarea de nuevo |
| Redis (`REDIS_URL`) | Baja | Solo la cola de joins asíncronos y sus resultados temporales (TTL de 1 h): los usuarios relanzan el join |
| Imágenes Docker (GHCR) y código (GitHub) | Baja | Se reconstruyen desde el repositorio con el pipeline |

Las bases de datos externas que consultan los usuarios no forman parte del alcance: DataNexus solo lee de ellas, y cada cliente las respalda.

| Objetivo | Valor | Justificación |
| --- | --- | --- |
| **RPO** (pérdida máxima de datos) | 15 minutos | Recuperación a un punto en el tiempo (PITR) del PostgreSQL gestionado |
| **RTO** (tiempo máximo de recuperación) | 4 horas | Restaurar la base, volver a desplegar la API y validar |
| Disponibilidad objetivo | 99.9 % mensual | RNF-09; ver [SLA-OLA.md](SLA-OLA.md) |

## 2. Política de respaldo

| Qué | Cómo | Frecuencia | Retención | Dónde |
| --- | --- | --- | --- | --- |
| PostgreSQL: copia completa | `pg_dump --format=custom` o snapshot del proveedor | Diaria (02:00 UTC) | 30 diarias + 12 mensuales | Almacenamiento de otra región o proveedor, cifrado |
| PostgreSQL: WAL / PITR | Archivado continuo del proveedor (Railway, Cloud SQL, RDS) | Continuo | 7 días | Proveedor |
| `ENCRYPTION_KEY` y `JWT_SECRET` | Gestor de secretos (1Password, Vault, Secret Manager) con dos custodios | Al crearlas o rotarlas | Indefinida, con versiones | Fuera de la infraestructura de la app |
| Bucket de reportes (GCS) | Versionado de objetos + regla de ciclo de vida | Continuo | 90 días | GCS |
| Configuración (`.env.production`) | Gestor de secretos; nunca en el repositorio | En cada cambio | Con versiones | Gestor de secretos |

Copia manual de la base de datos:

```bash
pg_dump "$DATABASE_URL" --format=custom --no-owner --file "datanexus_$(date -u +%Y%m%dT%H%MZ).dump"
```

- Las copias se cifran en reposo y su acceso se limita al rol de operaciones.
- La bitácora de auditoría está dentro de la base: sus copias heredan la misma retención. Para evidencias regulatorias, exporta la bitácora (`GET /audit/logs/export`) cada mes y archívala aparte.
- **La copia de la base de datos no sirve sin la `ENCRYPTION_KEY` con la que se cifraron las credenciales.** Guarda las dos con la misma retención y en lugares distintos.

## 3. Escenarios y procedimientos

### 3.1 Caída de la API (contenedor o despliegue fallido)

1. `GET /health` no responde → la plataforma reinicia el contenedor (health check de Docker o Railway).
2. Si el fallo viene de un despliegue: vuelve a la imagen anterior (`ghcr.io/inahjoer/datanexus-backend:sha-<anterior>`) o haz *redeploy* del despliegue anterior en Railway.
3. Comprueba que `GET /health/ready` responde 200.

RTO estimado: 15 minutos.

### 3.2 Pérdida o corrupción de la base de datos

1. Declara el incidente (P1, ver [SLA-OLA.md](SLA-OLA.md)) y detén la API para que no se escriban datos inconsistentes.
2. Elige el punto de restauración: el último consistente antes del incidente (PITR) o la última copia diaria.
3. Restaura en una instancia **nueva**, no sobre la dañada, para conservar la evidencia:
   ```bash
   createdb datanexus_restore
   pg_restore --no-owner --dbname "$RESTORE_URL" datanexus_<fecha>.dump
   ```
4. Aplica las migraciones que falten: `DATABASE_URL=$RESTORE_URL npm run db:deploy`.
5. Apunta `DATABASE_URL` de la API a la nueva instancia, con **la misma `ENCRYPTION_KEY`**, y vuelve a desplegar.
6. Valida:
   - `GET /health/ready` responde 200.
   - Se puede iniciar sesión con un usuario de prueba.
   - "Probar conexión" funciona en una conexión existente, lo que confirma que la clave es correcta.
   - La bitácora muestra los últimos eventos antes del punto de restauración.
7. Registra en la bitácora del incidente el intervalo de datos perdido (RPO real) y avisa a los workspaces afectados.

RTO estimado: 2 a 4 horas.

### 3.3 Compromiso o pérdida de `ENCRYPTION_KEY`

- **Pérdida:** las credenciales guardadas no se pueden descifrar. Restaura la clave desde el gestor de secretos. Si no existe ninguna copia, cada ADMIN debe volver a introducir las credenciales de sus conexiones; los demás datos siguen intactos.
- **Compromiso:**
  1. Pide a los clientes que roten las contraseñas de las bases externas.
  2. Genera una clave nueva.
  3. Despliega la clave nueva y pide a cada ADMIN que vuelva a introducir las credenciales de sus conexiones. La API todavía no tiene re-cifrado automático con rotación de clave; queda como mejora pendiente.
  4. Revoca el acceso de quien la expuso.

### 3.4 Compromiso de `JWT_SECRET` o de cuentas

1. Cambia `JWT_SECRET` y vuelve a desplegar: todas las sesiones se invalidan.
2. Revoca las sesiones (`POST /users/sessions/revoke-all`) y los tokens de acceso personal afectados (`DELETE /auth/tokens/:id`).
3. Revisa la bitácora: eventos `LOGIN_SUCCESS` desde IPs inusuales, `REFRESH_TOKEN_REUSED` y `PAT_USED`.

### 3.5 Pérdida de la región o del proveedor

1. Crea un PostgreSQL en otra región o proveedor y restaura la última copia externa (§3.2).
2. Despliega las imágenes de GHCR con `docker-compose.prod.yml` en la infraestructura alternativa, usando los secretos del gestor.
3. Actualiza el DNS de la API y del frontend, y las URLs públicas (`FRONTEND_URL`, `API_PUBLIC_URL`, `NEXT_PUBLIC_API_URL`).

RTO estimado: 4 horas.

## 4. Pruebas del plan

| Prueba | Frecuencia | Criterio de éxito |
| --- | --- | --- |
| Restaurar la última copia en una base temporal y ejecutar `npm run test:e2e` contra ella | Trimestral | Restauración en menos de 2 h y e2e en verde |
| Verificar que la `ENCRYPTION_KEY` del gestor de secretos descifra las conexiones restauradas | Trimestral | "Probar conexión" funciona en una conexión real |
| Simulacro de caída de la API (§3.1) | Semestral | Servicio de vuelta en menos de 15 min |
| Revisión del plan | Anual o tras cada incidente P1 | Plan actualizado y aprobado |

Cada prueba se registra con la fecha, el responsable, los tiempos obtenidos (RPO y RTO reales) y las acciones de mejora.

## 5. Roles

| Rol | Responsabilidad |
| --- | --- |
| Responsable de operaciones (DevOps) | Copias, monitoreo, ejecución de este plan y pruebas de restauración |
| Equipo backend | Migraciones, validación funcional tras restaurar, rotación de claves |
| Custodios de secretos (2 personas) | Acceso a `ENCRYPTION_KEY` y `JWT_SECRET`; ninguno actúa solo |
| ADMIN de cada workspace | Volver a introducir credenciales externas si fuera necesario; comunicar el incidente a su organización |
