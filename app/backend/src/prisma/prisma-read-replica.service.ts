import { Injectable, Logger } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PrismaService } from './prisma.service';

/**
 * Service that routes read‑only Prisma operations to a read‑replica datasource.
 * It delegates write operations to the primary {@link PrismaService}.
 * Read‑only operations (find*, count*, aggregate*) are executed against a
 * PrismaClient instantiated with `DATABASE_URL_READ`.
 */
@Injectable()
export class PrismaReadReplicaService {
  private readonly logger = new Logger(PrismaReadReplicaService.name);
  private readonly readClient: PrismaClient;

  constructor(private readonly primary: PrismaService) {
    const readUrl = process.env.DATABASE_URL_READ;
    if (!readUrl) {
      this.logger.warn('DATABASE_URL_READ is not set; read replica will fall back to primary.');
    }
    this.readClient = new PrismaClient({
      datasources: { db: { url: readUrl || process.env.DATABASE_URL } },
    });
  }

  async onModuleInit(): Promise<void> {
    try {
      await this.readClient.$connect();
      this.logger.debug('Read‑replica Prisma client connected');
    } catch (err) {
      this.logger.error('Failed to connect read‑replica Prisma client', err as Error);
    }
  }

  async onModuleDestroy(): Promise<void> {
    try {
      await this.readClient.$disconnect();
      this.logger.debug('Read‑replica Prisma client disconnected');
    } catch (err) {
      this.logger.error('Failed to disconnect read‑replica Prisma client', err as Error);
    }
  }

  /** Determine the appropriate client for a given method name. */
  private getTarget(methodName: string): any {
    const readPrefixes = ['find', 'count', 'aggregate'];
    const isRead = readPrefixes.some((p) => methodName.startsWith(p));
    return isRead ? this.readClient : this.primary;
  }

  /** Generic proxy to call Prisma methods on the correct client. */
  public async invoke<T extends keyof PrismaClient>(method: T, ...args: any[]): Promise<any> {
    const target = this.getTarget(method as string);
    const fn = (target as any)[method];
    if (typeof fn !== 'function') {
      throw new Error(`Prisma method ${method} does not exist`);
    }
    return fn.apply(target, args);
  }
}
