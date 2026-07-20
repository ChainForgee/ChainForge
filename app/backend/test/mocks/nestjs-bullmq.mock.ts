import { DynamicModule, Inject, Module, Provider } from '@nestjs/common';

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
  static forRoot(_options: any): DynamicModule {
    return {
      module: BullModule,
      providers: [],
      exports: [],
    };
  }

  static forRootAsync(_options: any): DynamicModule {
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
    Inject(token)(target, key, index);
  };
}

export function getQueueToken(name: string): string {
  return `BullQueue_${name}`;
}

export function Processor(_name?: string) {
  return (_target: any) => {};
}

export class WorkerHost {
  async process(_job: any): Promise<any> {}
}

export function OnWorkerEvent(_event: string) {
  return (
    _target: any,
    _key: string | symbol,
    _descriptor: PropertyDescriptor,
  ) => {};
}
