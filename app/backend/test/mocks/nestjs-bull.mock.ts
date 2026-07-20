import { getQueueToken, InjectQueue } from './nestjs-bullmq.mock';

export { InjectQueue, getQueueToken };

export class BullModule {
  static registerQueue(..._options: any[]) {
    return {
      module: BullModule,
      providers: [],
      exports: [],
    };
  }
}
