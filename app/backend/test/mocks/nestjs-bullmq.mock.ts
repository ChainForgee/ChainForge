import { DynamicModule, Module, Provider } from '@nestjs/common';

const mockQueue = {
  add: jest.fn().mockResolvedValue({ id: 'mock-job-id' }),
  getJob: jest.fn().mockResolvedValue(null),
  getJobs: jest.fn().mockResolvedValue([]),
  pause: jest.fn().mockResolvedValue(undefined),
  resume: jest.fn().mockResolvedValue(undefined),
  clean: jest.fn().mockResolvedValue([]),
  close: jest.fn().mockResolvedValue(undefined),
};

@Module({})
export class BullModule {
  static forRoot(options: any): DynamicModule {
    return {
      module: BullModule,
      providers: [],
      exports: [],
    };
  }

  static forRootAsync(options: any): DynamicModule {
    return {
      module: BullModule,
      providers: [],
      exports: [],
    };
  }

  static registerQueue(...options: any[]): DynamicModule {
    const providers: Provider[] = options.map(opt => {
      const name = typeof opt === 'string' ? opt : opt.name;
      return {
        provide: getQueueToken(name),
        useValue: mockQueue,
      };
    });
    return {
      module: BullModule,
      providers,
      exports: providers,
    };
  }

  static registerQueueAsync(...options: any[]): DynamicModule {
    const providers: Provider[] = options.map(opt => {
      return {
        provide: getQueueToken(opt.name),
        useValue: mockQueue,
      };
    });
    return {
      module: BullModule,
      providers,
      exports: providers,
    };
  }
}

export function InjectQueue(name: string) {
  return (target: any, key: string | symbol, index: number) => {
    const token = getQueueToken(name);
    const Inject = require('@nestjs/common').Inject;
    Inject(token)(target, key, index);
  };
}

export function getQueueToken(name: string): string {
  return `BullQueue_${name}`;
}

export function Processor(name?: string) {
  return (target: any) => {};
}

export class WorkerHost {
  async process(job: any): Promise<any> {}
}

export function OnWorkerEvent(event: string) {
  return (target: any, key: string | symbol, descriptor: PropertyDescriptor) => {};
}
