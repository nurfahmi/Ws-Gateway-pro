import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  const existing = await prisma.user.findUnique({ where: { username: 'admin' } });
  if (!existing) {
    const hash = await bcrypt.hash('admin123', 10);
    await prisma.user.create({
      data: {
        username: 'admin',
        password: hash,
        name: 'Super Admin',
        role: 'superadmin',
      },
    });
    console.log('Default superadmin created (admin / admin123)');
  } else {
    console.log('Superadmin already exists, skipping seed');
  }
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
