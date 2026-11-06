# Docker, CI/CD y Railway para DataNexus

## Intención

Adaptar la guía del curso, creada para un sitio estático servido por Nginx, al monorepo real de DataNexus: Next.js 16 en la raíz y NestJS 12 en `backend/`. El propósito es tener contenedores funcionales y CI desde ahora, dejando Railway y el CD configurados para habilitarlos cuando el equipo esté listo.

## Objetivos

- Construir imágenes independientes para frontend y backend, aptas para producción y Railway.
- Levantar frontend, backend y PostgreSQL localmente con Docker Compose y conservar el volumen existente; ejecutar las imágenes de producción contra PostgreSQL externo.
- Separar el ciclo de desarrollo local del modo de contenedor de producción mediante un Compose override explícito.
- Ejecutar compilación, lint, pruebas y validaciones de contenedores en GitHub Actions.
- Publicar imágenes versionadas en GHCR después de pasar CI.
- Dejar el despliegue Railway preparado y apagado; no desplegar a producción ni subir commits durante esta tarea.

## Fuera de alcance

- Migrar o mantener SQLite como persistencia interna. La decisión confirmada es PostgreSQL.
- Cambiar funcionalidades de DataNexus o el diseño de sus servicios.
- Crear o modificar servicios, secretos, dominios o datos en Railway/GitHub.
- Hacer push o commit.

## Enfoques considerados

1. **Una imagen conjunta con Nginx**, como el ejemplo estático del curso. Se descarta porque Next.js y NestJS son servidores Node independientes y el monorepo requiere desplegarlos por separado.
2. **Dos imágenes multi-stage, Compose local con PostgreSQL y CI que publica a GHCR; CD a Railway bajo una condición apagada por defecto.** Elegido porque conserva los límites reales entre servicios, sigue el flujo del profesor y permite activar CD más tarde sin rehacer las imágenes.
3. **Desplegar el código fuente directamente desde Railway.** Se descarta como camino principal porque no valida el uso de imágenes publicadas en GHCR que presenta la guía del curso.

## Decisiones

- PostgreSQL es la persistencia interna de Prisma. El Compose de desarrollo reutilizará el servicio PostgreSQL existente en `backend/docker-compose.yml` con su nombre de proyecto y volumen actuales; el Compose de producción y Railway recibirán `DATABASE_URL` para una instancia PostgreSQL externa.
- El frontend y el backend tendrán Dockerfiles multi-stage separados. Next.js usará salida `standalone` si la configuración local de Next.js lo permite.
- `docker-compose.yml` será el entorno local de desarrollo con código montado; `docker-compose.prod.yml` ejecutará los targets optimizados sin bind mounts ni un contenedor de base de datos.
- Prisma CLI seguirá en la misma versión, pero será dependencia de producción para que el contenedor backend pueda ejecutar el script existente `db:deploy`.
- El script `backend` `db:up` usará el Compose raíz para compartir la definición PostgreSQL y evitar mantener configuraciones divergentes.
- El backend aplicará únicamente migraciones pendientes con `prisma migrate deploy` antes de iniciar; los cambios de esquema siguen siendo explícitos y versionados.
- CI correrá en pushes a `DOCKERCICD` y `main`, y en Pull Requests hacia `main`. La publicación GHCR solo ocurrirá después de validar y fuera de Pull Requests.
- CI validará ambas imágenes antes de publicar una y serializará ejecuciones por rama para evitar que un build anterior actualice `latest` después de uno más nuevo.
- CD solo podrá correr en `main` cuando `ENABLE_RAILWAY_CD` sea `true`, exista `NEXT_PUBLIC_API_URL` y estén configurados los secretos de Railway. El job usará Railway CLI 5.71.0 con `railway redeploy --from-source` para recoger el tag de imagen actualizado. La variable no se configura en esta tarea, por lo que ningún deploy se ejecutará.
- Las migraciones se aplicarán con `prisma migrate deploy`; no se ejecutarán resets ni se modificarán migraciones existentes.
- `NEXT_PUBLIC_API_URL` es público y se incorpora durante el build del frontend. Localmente apunta al puerto publicado del backend; al preparar Railway se tendrá que definir para el dominio de la API antes de construir la imagen correspondiente.

## Restricciones

- Mantener las versiones y gestores de paquetes actuales, usando `npm ci`.
- Requerir Docker Compose v2.20 o posterior para reutilizar la configuración PostgreSQL con `include`.
- No copiar archivos `.env` ni secretos a las imágenes.
- Mantener la conexión actual de NestJS a `PORT` y exponer servicios en `0.0.0.0`.
- Proteger el checkout actual: trabajar en `DOCKERCICD`, creado desde `rama-chris`.
- No hacer commit ni push.

## Riesgos a revisar

- Los secretos requeridos por la validación del backend deben estar disponibles en Compose sin quedar en la imagen.
- El servicio backend debe esperar a que PostgreSQL esté saludable antes de aplicar migraciones.
- Las imágenes GHCR deben llevar tags identificables por commit y distinguir frontend de backend.
- Los Pull Requests no deben publicar imágenes ni desplegar.
- La variable pública del frontend debe corresponder al backend del entorno al que se publique.
