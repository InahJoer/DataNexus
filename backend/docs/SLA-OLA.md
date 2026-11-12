# Acuerdos de nivel de servicio (SLA) y operativos (OLA)

Issue #53 · ITIL 4 *Service level management* · COBIT 2019 **APO09 – Gestionar los acuerdos de servicio**.

## 1. Servicio

**DataNexus** ofrece a cada workspace:

- Conexión a fuentes de datos externas.
- Cruce de datos (*cross-joins*), exploración y exportación.
- Consultas guardadas y reportes programados por correo.
- Bitácora de auditoría.
- Acceso por API con tokens de acceso personal.

| Componente | Incluido en el SLA |
| --- | :---: |
| API (`/auth`, `/connections`, `/engine`, `/queries`, `/reports`, `/audit`, `/users`, `/workspaces`) | ✅ |
| Frontend web | ✅ |
| Envío de correos de reportes | ✅ (entrega al servidor SMTP) |
| Disponibilidad y rendimiento de las bases externas del cliente | ❌ |

## 2. SLA: compromisos con los usuarios

| Indicador | Objetivo | Cómo se mide |
| --- | --- | --- |
| **Disponibilidad mensual** (RNF-09) | ≥ 99.9 %: como máximo 43 min 49 s fuera de servicio al mes | Monitor externo cada minuto sobre `GET /health/ready` (200 = disponible) |
| Carga inicial del frontend (RNF-05) | < 2 s (p95) | Monitoreo sintético / Lighthouse |
| Latencia de la API, endpoints de lectura | < 500 ms (p95) | `durationMs` de los logs de acceso |
| Cross-join síncrono hasta los límites configurados | < 10 s (p95), sin contar la latencia de las fuentes externas | `durationMs` de `POST /engine/join` |
| Reportes programados | Ejecutados en los 5 min siguientes a su hora, con hasta 3 intentos (`REPORT_RETRY_MAX_ATTEMPTS`) | Historial de ejecuciones (`/reports/schedules/:id/executions`) |
| Retención de la bitácora de auditoría | 5 años como mínimo | Política de respaldo ([DRP.md](DRP.md)) |
| Recuperación ante desastres | RPO 15 min · RTO 4 h | Pruebas trimestrales del DRP |

**Exclusiones:**
- Mantenimiento programado avisado con 72 h de antelación, en una ventana de domingo 02:00–04:00 (America/Managua) y como máximo 4 h al mes.
- Caídas de las bases externas o del servidor SMTP del cliente.
- Fuerza mayor.
- Uso que supere los límites publicados (rate limiting, tamaño de los joins).

### Soporte e incidentes

| Prioridad | Definición | Primera respuesta | Resolución o solución temporal |
| --- | --- | --- | --- |
| **P1 · Crítica** | Servicio caído para todos, pérdida o exposición de datos, incidente de seguridad | 30 min (24/7) | 4 h |
| **P2 · Alta** | Función principal degradada para varios workspaces (joins, login, reportes) | 2 h hábiles | 1 día hábil |
| **P3 · Media** | Función secundaria con error o con alternativa disponible | 1 día hábil | 5 días hábiles |
| **P4 · Baja** | Consulta, mejora o error estético | 2 días hábiles | Según la planificación |

Para agilizar cualquier reporte, incluye el `requestId` que aparece en la respuesta de error.

## 3. OLA: compromisos internos que sostienen el SLA

| Equipo | Compromiso | Objetivo |
| --- | --- | --- |
| **Operaciones / DevOps** | Monitoreo de `/health/ready` con alertas a la guardia | Alerta en menos de 2 min desde la caída |
| | Copias de base de datos y pruebas de restauración | Diarias / trimestrales ([DRP.md](DRP.md)) |
| | Parches de seguridad de la plataforma e imágenes | Críticos en 48 h, altos en 7 días |
| **Backend** | Atender incidentes P1 y P2 escalados por Operaciones | Toma del incidente en 30 min (P1) y 4 h hábiles (P2) |
| | Mantener el CI en verde en `main` (lint, pruebas, e2e, `npm audit`) | `main` en rojo menos de 1 día hábil |
| | Vulnerabilidades altas o críticas de dependencias | Corregidas en 7 días |
| **Frontend** | Errores bloqueantes de la interfaz (P1/P2) | Mismos plazos que Backend |
| **Base de datos (DBA)** | Revisión de migraciones antes de fusionarlas | 1 día hábil |
| | Soporte en restauraciones | Disponible en 1 h durante un P1 |
| **Seguridad** | Revisión OWASP tras cambios de autenticación o permisos | Antes de fusionar el PR |
| | Investigación de incidentes de seguridad | Inicio en 1 h (P1) |

**Escalamiento:**
1. Guardia de Operaciones.
2. Responsable del equipo afectado, a los 30 min en P1.
3. Líder técnico del proyecto, a 1 h en P1.
4. Comunicación a los ADMIN de los workspaces afectados, a 2 h en P1.

## 4. Revisión y mejora continua

- **Informe mensual:**
  - Disponibilidad real frente al objetivo.
  - Incidentes por prioridad, con su tiempo de respuesta y de resolución.
  - Reportes fallidos.
  - p95 de latencia.
- **Revisión post-incidente** sin culpables tras cada P1, en un máximo de 5 días hábiles. Incluye causa raíz, acciones y responsables.
- Este documento se revisa cada semestre, o cuando cambien los requisitos regulatorios. Para clientes del sector financiero supervisados por la CONAMI, los requisitos de continuidad y de conservación de evidencias del cliente prevalecen si son más estrictos.
