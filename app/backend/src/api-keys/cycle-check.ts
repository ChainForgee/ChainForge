import { BadRequestException, NotFoundException } from '@nestjs/common';

type PrismaApiKeyFindUnique = (args: {
  where: { id: string };
  select: { replacedById: true };
}) => Promise<{ replacedById: string | null } | null>;

type CyclablePrisma = {
  apiKey: {
    findUnique: PrismaApiKeyFindUnique;
  };
};

export async function assertNoCycle(
  keyId: string,
  replacedById: string,
  prisma: CyclablePrisma,
): Promise<void> {
  const visited = new Set<string>();
  let currentId: string | null = replacedById;

  while (currentId) {
    if (currentId === keyId || visited.has(currentId)) {
      throw new BadRequestException('Cyclic rotation detected');
    }
    visited.add(currentId);

    const record = await prisma.apiKey.findUnique({
      where: { id: currentId },
      select: { replacedById: true },
    });

    if (!record) {
      throw new NotFoundException(`ApiKey ${currentId} not found`);
    }

    currentId = record.replacedById;
  }
}
