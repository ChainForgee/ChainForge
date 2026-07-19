const { PrismaClient } = require('@prisma/client');
const { createHash } = require('node:crypto');

(async () => {
  const prisma = new PrismaClient();

  const keys = await prisma.apiKey.findMany({
    where: { key: { not: null } },
    select: { id: true, key: true },
  });

  for (const { id, key } of keys) {
    if (!key) continue;
    const hash = createHash('sha256').update(key).digest('hex');
    const preview = `${key.slice(0, 4)}…${key.slice(-4)}`;
    await prisma.apiKey.update({
      where: { id },
      data: { keyHash: hash, keyPreview: preview },
    });
    console.log(`Migrated API key ${id}`);
  }

  await prisma.$disconnect();
})();
