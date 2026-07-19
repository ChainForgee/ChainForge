import { Module, DynamicModule, Inject } from '@nestjs/common';

export const getQueueToken = (name: string) => `BullQueue_${name}`;
export const InjectQueue = (name: string) => Inject(getQueueToken(name));

@Module({})
export class MockBullModule {
  static forRoot(): DynamicModule {
    return {
      module: MockBullModule,
      providers: [],
      exports: [],
    };
  }

  static forRootAsync(): DynamicModule {
    return {
      module: MockBullModule,
      providers: [],
      exports: [],
    };
  }

  static registerQueue(...queues: any[]): DynamicModule {
    const providers = queues.map(queue => {
      const name = typeof queue === 'string' ? queue : queue.name;
      return {
        provide: getQueueToken(name),
        useValue: {
          add: jest.fn().mockResolvedValue({ id: 'mock-job-id' }),
          getJobs: jest.fn().mockResolvedValue([]),
          getJob: jest.fn().mockResolvedValue(null),
          obliterate: jest.fn().mockResolvedValue(undefined),
          pause: jest.fn().mockResolvedValue(undefined),
          resume: jest.fn().mockResolvedValue(undefined),
        },
      };
    });
    return {
      module: MockBullModule,
      providers: providers,
      exports: providers,
    };
  }

  static registerQueueAsync(...queues: any[]): DynamicModule {
    const providers = queues.map(queue => {
      const name =
        typeof queue === 'string' ? queue : (queue.name ?? 'default');
      return {
        provide: getQueueToken(name),
        useValue: {
          add: jest.fn().mockResolvedValue({ id: 'mock-job-id' }),
          getJobs: jest.fn().mockResolvedValue([]),
          getJob: jest.fn().mockResolvedValue(null),
          obliterate: jest.fn().mockResolvedValue(undefined),
          pause: jest.fn().mockResolvedValue(undefined),
          resume: jest.fn().mockResolvedValue(undefined),
        },
      };
    });
    return {
      module: MockBullModule,
      providers: providers,
      exports: providers,
    };
  }

  static registerFlowProducer(..._producers: any[]): DynamicModule {
    return {
      module: MockBullModule,
      providers: [],
      exports: [],
    };
  }

  static registerFlowProducerAsync(..._producers: any[]): DynamicModule {
    return {
      module: MockBullModule,
      providers: [],
      exports: [],
    };
  }
}

export const BullModule = MockBullModule;

export const Processor = (_name?: string) => (_target: any) => {};

export class WorkerHost {
  worker: any = {
    on: jest.fn(),
    close: jest.fn().mockResolvedValue(undefined),
  };
}

export const OnWorkerEvent =
  (_event: string) =>
  (_target: any, _propertyKey: string, _descriptor: PropertyDescriptor) => {};
