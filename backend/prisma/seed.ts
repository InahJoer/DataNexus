/**
 * Seed de datos demo de DataNexus: un workspace con un usuario de cada rol.
 * Idempotente: se puede ejecutar varias veces sin duplicar datos.
 *
 *   npm run db:seed
 *
 * Variables opcionales: SEED_PASSWORD (por defecto "DataNexus2026!") y SEED_ADMIN_EMAIL.
 */
import { PrismaClient, type Role } from '@prisma/client';
import bcrypt from 'bcrypt';

const prisma = new PrismaClient();

const WORKSPACE_ID = '00000000-0000-4000-8000-000000000001';
const password = process.env.SEED_PASSWORD || 'DataNexus2026!';
const adminEmail = (process.env.SEED_ADMIN_EMAIL || 'admin@datanexus.demo').toLowerCase();

const USERS: { email: string; name: string; role: Role }[] = [
  { email: adminEmail, name: 'Administrador Demo', role: 'ADMIN' },
  { email: 'operador@datanexus.demo', name: 'Operador Demo', role: 'OPERADOR' },
  { email: 'lector@datanexus.demo', name: 'Lector Demo', role: 'LECTOR' },
  { email: 'auditor@datanexus.demo', name: 'Auditor Demo', role: 'AUDITOR' },
];

async function main() {
  const workspace = await prisma.workspace.upsert({
    where: { id: WORKSPACE_ID },
    update: {},
    create: { id: WORKSPACE_ID, nombreEmpresa: 'DataNexus Demo S.A.' },
  });

  const hashed = await bcrypt.hash(password, 10);

  for (const user of USERS) {
    await prisma.user.upsert({
      where: { email: user.email },
      update: { name: user.name, role: user.role, workspaceId: workspace.id },
      create: { ...user, password: hashed, workspaceId: workspace.id },
    });
  }

  console.log(`Seed listo: workspace "${workspace.nombreEmpresa}" con ${USERS.length} usuarios.`);
  for (const user of USERS) console.log(`  ${user.role.padEnd(8)} ${user.email}`);
  console.log('  Contraseña: la definida en SEED_PASSWORD (o la de ejemplo de .env.example).');
}

main()
  .catch((error: unknown) => {
    console.error('Error ejecutando el seed:', error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
