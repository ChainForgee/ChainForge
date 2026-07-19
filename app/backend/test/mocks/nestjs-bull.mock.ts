import { getQueueToken, InjectQueue } from './nestjs-bullmq.mock';

export { InjectQueue, getQueueToken };

export class BullModule {
  static registerQueue(...options: any[]) {
    return {
      module: BullModule,
      providers: [],
      exports: [],
    };
  }
}
