/**
 * Fuentes de ejemplo para la demo (issue #49).
 *
 * Registra en el workspace demo una conexión a cada motor del docker-compose (SQL Server, MySQL, PostgreSQL,
 * MongoDB y el emulador de Firestore), dos consultas guardadas que las cruzan y carga los tickets de soporte
 * en el emulador. Idempotente: actualiza lo existente en lugar de duplicarlo.
 *
 *   npm run db:seed && npm run db:seed:demo
 *
 * Los hosts por defecto son los nombres de servicio de docker-compose. Para ejecutar el backend fuera de Docker
 * contra las fuentes del compose: DEMO_SOURCES_HOST=localhost (usa los puertos publicados).
 * Las credenciales son solo de desarrollo; nunca apuntes este seed a bases reales.
 */
import { PrismaClient, type Prisma, type TipoMotor } from '@prisma/client';
import { Firestore } from '@google-cloud/firestore';
import { createCipheriv, createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const DEMO_WORKSPACE_ID = '00000000-0000-4000-8000-000000000001';
export const DEMO_FIRESTORE_PROJECT = 'datanexus-demo';

export const DEMO_CONNECTION_IDS = {
  SQLSERVER: '00000000-0000-4000-8000-0000000000a1',
  MYSQL: '00000000-0000-4000-8000-0000000000a2',
  POSTGRESQL: '00000000-0000-4000-8000-0000000000a3',
  MONGODB: '00000000-0000-4000-8000-0000000000a4',
  FIRESTORE: '00000000-0000-4000-8000-0000000000a5',
} as const;

export const DEMO_QUERY_IDS = {
  ventas: '00000000-0000-4000-8000-0000000000b1',
  actividad: '00000000-0000-4000-8000-0000000000b2',
} as const;

type Env = Record<string, string | undefined>;

/**
 * Cifra igual que EncryptionService (AES-256-CBC, "iv_hex:contenido_hex" y la misma derivación de la clave).
 * El seed corre con Node sin compilar, así que no puede importar el servicio de Nest; un test verifica que
 * EncryptionService descifra lo que produce esta función.
 */
export function encryptLikeEncryptionService(text: string, rawKey: string): string {
  let key: Buffer;
  if (/^[0-9a-fA-F]{64}$/.test(rawKey)) key = Buffer.from(rawKey, 'hex');
  else if (Buffer.byteLength(rawKey, 'utf8') === 32) key = Buffer.from(rawKey, 'utf8');
  else key = createHash('sha256').update(rawKey).digest();

  const iv = randomBytes(16);
  const cipher = createCipheriv('aes-256-cbc', key, iv);
  return `${iv.toString('hex')}:${cipher.update(text, 'utf8', 'hex')}${cipher.final('hex')}`;
}

interface DemoConnection {
  id: string;
  nombre: string;
  tipoMotor: TipoMotor;
  host: string;
  dbName: string;
  credentials: Record<string, unknown>;
  detalles: Record<string, string | number | boolean>;
}

/** Las 5 fuentes del docker-compose. Mismo formato de credenciales que guarda el backend (versión 2). */
export function demoConnections(env: Env = process.env): DemoConnection[] {
  const sharedHost = env.DEMO_SOURCES_HOST;
  const host = (service: string, specific?: string) => specific ?? sharedHost ?? service;
  // Dentro de la red de Docker se usan los puertos internos; desde el host, los publicados.
  const port = (internal: number, published: string | undefined, fallbackPublished: number) =>
    sharedHost ? Number(published ?? fallbackPublished) : internal;

  const sqlserverPassword = env.DEMO_SQLSERVER_PASSWORD ?? 'DataNexus_Demo2026!';
  const mysqlPassword = env.DEMO_MYSQL_PASSWORD ?? 'datanexus_demo';
  const postgresPassword = env.DEMO_POSTGRES_PASSWORD ?? 'datanexus_demo';
  const mongoHost = host('mongo', env.DEMO_MONGO_HOST);
  const mongoPort = port(27017, env.DEMO_MONGO_PORT, 27017);

  const sqlserver = {
    host: host('sqlserver', env.DEMO_SQLSERVER_HOST),
    port: port(1433, env.DEMO_SQLSERVER_PORT, 1433),
    database: 'erp',
    username: 'sa',
    password: sqlserverPassword,
    encrypt: true,
    trustServerCertificate: true,
  };
  const mysql = {
    host: host('mysql', env.DEMO_MYSQL_HOST),
    port: port(3306, env.DEMO_MYSQL_PORT, 3306),
    database: 'tienda',
    username: 'datanexus',
    password: mysqlPassword,
    ssl: false,
  };
  const postgres = {
    host: host('postgres-demo', env.DEMO_POSTGRES_HOST),
    port: port(5432, env.DEMO_POSTGRES_PORT, 5433),
    database: 'logistica',
    username: 'datanexus',
    password: postgresPassword,
    ssl: false,
  };

  // El emulador no valida la clave, pero el adaptador exige una clave PEM: se genera una desechable.
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const serviceAccount = {
    type: 'service_account',
    project_id: DEMO_FIRESTORE_PROJECT,
    private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    client_email: `demo@${DEMO_FIRESTORE_PROJECT}.iam.gserviceaccount.com`,
  };

  return [
    {
      id: DEMO_CONNECTION_IDS.SQLSERVER,
      nombre: 'ERP Clientes (demo)',
      tipoMotor: 'SQLSERVER',
      host: sqlserver.host,
      dbName: sqlserver.database,
      credentials: sqlserver,
      detalles: { puerto: sqlserver.port, usuario: sqlserver.username, encrypt: true, trustServerCertificate: true },
    },
    {
      id: DEMO_CONNECTION_IDS.MYSQL,
      nombre: 'Tienda Pedidos (demo)',
      tipoMotor: 'MYSQL',
      host: mysql.host,
      dbName: mysql.database,
      credentials: mysql,
      detalles: { puerto: mysql.port, usuario: mysql.username, ssl: false },
    },
    {
      id: DEMO_CONNECTION_IDS.POSTGRESQL,
      nombre: 'Logística Envíos (demo)',
      tipoMotor: 'POSTGRESQL',
      host: postgres.host,
      dbName: postgres.database,
      credentials: postgres,
      detalles: { puerto: postgres.port, usuario: postgres.username, ssl: false },
    },
    {
      id: DEMO_CONNECTION_IDS.MONGODB,
      nombre: 'App Eventos (demo)',
      tipoMotor: 'MONGODB',
      host: `${mongoHost}:${mongoPort}`,
      dbName: 'app_eventos',
      credentials: { uri: `mongodb://${mongoHost}:${mongoPort}/?directConnection=true`, database: 'app_eventos' },
      detalles: { srv: false },
    },
    {
      id: DEMO_CONNECTION_IDS.FIRESTORE,
      nombre: 'Soporte Tickets (emulador Firestore)',
      tipoMotor: 'FIRESTORE',
      host: 'firestore.googleapis.com',
      dbName: '(default)',
      credentials: { serviceAccount, databaseId: '(default)' },
      detalles: { projectId: serviceAccount.project_id, clientEmail: serviceAccount.client_email },
    },
  ];
}

/** Consultas guardadas publicadas: el cuerpo de POST /engine/join, listo para el editor y para reportes. */
export function demoSavedQueries(): { id: string; nombre: string; descripcion: string; definicion: Prisma.InputJsonObject }[] {
  return [
    {
      id: DEMO_QUERY_IDS.ventas,
      nombre: 'Clientes, pedidos y envíos (demo)',
      descripcion: 'SQL Server × MySQL × PostgreSQL: cada pedido con su cliente y, si existe, su envío.',
      definicion: {
        fuentes: [
          { alias: 'clientes', conexionId: DEMO_CONNECTION_IDS.SQLSERVER, entidad: 'clientes', esquema: 'dbo' },
          { alias: 'pedidos', conexionId: DEMO_CONNECTION_IDS.MYSQL, entidad: 'pedidos' },
          { alias: 'envios', conexionId: DEMO_CONNECTION_IDS.POSTGRESQL, entidad: 'envios', esquema: 'public' },
        ],
        relaciones: [
          { izquierda: 'clientes', derecha: 'pedidos', tipo: 'INNER', llaves: [{ izquierda: 'id', derecha: 'cliente_id' }] },
          { izquierda: 'pedidos', derecha: 'envios', tipo: 'LEFT', llaves: [{ izquierda: 'id', derecha: 'pedido_id' }] },
        ],
        limiteFilas: 500,
      },
    },
    {
      id: DEMO_QUERY_IDS.actividad,
      nombre: 'Actividad y soporte por cliente (demo)',
      descripcion: 'SQL Server × MongoDB × Firestore: eventos de la app y tickets de soporte de cada cliente.',
      definicion: {
        fuentes: [
          { alias: 'clientes', conexionId: DEMO_CONNECTION_IDS.SQLSERVER, entidad: 'clientes', esquema: 'dbo' },
          { alias: 'eventos', conexionId: DEMO_CONNECTION_IDS.MONGODB, entidad: 'eventos' },
          { alias: 'tickets', conexionId: DEMO_CONNECTION_IDS.FIRESTORE, entidad: 'tickets' },
        ],
        relaciones: [
          { izquierda: 'clientes', derecha: 'eventos', tipo: 'LEFT', llaves: [{ izquierda: 'id', derecha: 'cliente_id' }] },
          { izquierda: 'clientes', derecha: 'tickets', tipo: 'LEFT', llaves: [{ izquierda: 'id', derecha: 'cliente_id' }] },
        ],
        limiteFilas: 500,
      },
    },
  ];
}

/** Carga los tickets en el emulador. Nunca escribe en un Firestore real: sin FIRESTORE_EMULATOR_HOST no hace nada. */
async function seedFirestoreEmulator(env: Env): Promise<string> {
  if (!env.FIRESTORE_EMULATOR_HOST) return 'omitido (sin FIRESTORE_EMULATOR_HOST)';
  const tickets = JSON.parse(readFileSync(new URL('./demo/firestore-tickets.json', import.meta.url), 'utf8')) as {
    id: string;
    [field: string]: unknown;
  }[];
  const firestore = new Firestore({ projectId: DEMO_FIRESTORE_PROJECT });
  try {
    const batch = firestore.batch();
    for (const { id, ...ticket } of tickets) batch.set(firestore.collection('tickets').doc(id), ticket);
    await batch.commit();
    return `${tickets.length} tickets en ${env.FIRESTORE_EMULATOR_HOST}`;
  } catch (error) {
    // El emulador puede tardar en aceptar escrituras: la demo sigue y el seed se puede repetir.
    return `no se pudo cargar (${error instanceof Error ? error.message.split('\n')[0] : String(error)})`;
  } finally {
    await firestore.terminate();
  }
}

export async function seedDemo(prisma: PrismaClient, env: Env = process.env): Promise<void> {
  const encryptionKey = env.ENCRYPTION_KEY;
  if (!encryptionKey) throw new Error('Falta ENCRYPTION_KEY: es la misma que usa el backend para cifrar credenciales.');

  const workspace = await prisma.workspace.findUnique({ where: { id: DEMO_WORKSPACE_ID } });
  if (!workspace) throw new Error('No existe el workspace demo: ejecuta antes "npm run db:seed".');

  const adminEmail = (env.SEED_ADMIN_EMAIL || 'admin@datanexus.demo').toLowerCase();
  const admin = await prisma.user.findUnique({ where: { email: adminEmail }, select: { id: true } });

  for (const connection of demoConnections(env)) {
    const data = {
      nombre: connection.nombre,
      tipoMotor: connection.tipoMotor,
      host: connection.host,
      dbName: connection.dbName,
      connectionStringEncriptada: encryptLikeEncryptionService(
        JSON.stringify({ v: 2, tipoMotor: connection.tipoMotor, credentials: connection.credentials }),
        encryptionKey,
      ),
      credencialesVersion: 2,
      detalles: connection.detalles,
    };
    await prisma.conexionDB.upsert({
      where: { id: connection.id },
      update: data,
      create: { id: connection.id, workspaceId: DEMO_WORKSPACE_ID, ...data },
    });
  }

  for (const query of demoSavedQueries()) {
    await prisma.savedQuery.upsert({
      where: { id: query.id },
      // Solo se crean: si alguien la edita en la demo, repetir el seed no pisa sus versiones.
      update: {},
      create: {
        id: query.id,
        workspaceId: DEMO_WORKSPACE_ID,
        nombre: query.nombre,
        descripcion: query.descripcion,
        definicion: query.definicion,
        visibilidad: 'PUBLICADA',
        autorId: admin?.id ?? null,
      },
    });
    await prisma.savedQueryVersion.upsert({
      where: { savedQueryId_version: { savedQueryId: query.id, version: 1 } },
      update: {},
      create: { savedQueryId: query.id, version: 1, definicion: query.definicion, autorId: admin?.id ?? null },
    });
  }

  const firestore = await seedFirestoreEmulator(env);
  console.log('Demo lista en el workspace "%s":', workspace.nombreEmpresa);
  for (const connection of demoConnections(env)) console.log(`  ${connection.tipoMotor.padEnd(10)} ${connection.nombre} → ${connection.host}`);
  for (const query of demoSavedQueries()) console.log(`  Consulta   ${query.nombre}`);
  console.log(`  Firestore  ${firestore}`);
}

// Solo se ejecuta como script (npm run db:seed:demo); los tests importan las funciones.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const prisma = new PrismaClient();
  seedDemo(prisma)
    .catch((error: unknown) => {
      console.error('Error ejecutando el seed de la demo:', error);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
