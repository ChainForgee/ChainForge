import * as fs from 'fs';

function logSync(msg: string) {
  try {
    fs.writeSync(1, msg + '\n');
  } catch (e) {}
}

// Define a lightweight stub of the global Jest object for standalone execution
const dummyFn = (impl?: any) => {
  const fn: any = function(this: any, ...args: any[]) {
    if (fn._implementation) {
      return fn._implementation.apply(this, args);
    }
    return fn._returnValue;
  };
  fn._implementation = impl;
  fn.mockImplementation = (newImpl: any) => {
    fn._implementation = newImpl;
    return fn;
  };
  fn.mockResolvedValue = (val: any) => {
    fn._implementation = () => Promise.resolve(val);
    return fn;
  };
  fn.mockReturnValue = (val: any) => {
    fn._implementation = () => val;
    return fn;
  };
  fn.mockReturnThis = () => {
    fn._implementation = function(this: any) {
      return this;
    };
    return fn;
  };
  return fn;
};

(global as any).jest = {
  fn: dummyFn,
};

import mockRedis from './mocks/ioredis.mock';
import mockStellar from './mocks/stellar-sdk.mock';
import mockOpenAI from './mocks/openai.mock';

const Module = require('module');
const originalRequire = Module.prototype.require;
Module.prototype.require = function(id: string) {
  if (id === 'ioredis') {
    return mockRedis;
  }
  if (id === '@stellar/stellar-sdk') {
    return mockStellar;
  }
  if (id === 'openai') {
    return mockOpenAI;
  }
  return originalRequire.apply(this, arguments);
};

// Set DATABASE_URL to test.db
process.env.DATABASE_URL = 'file:./test.db';
process.env.NODE_ENV = 'test';

import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';

async function bootstrap() {
  logSync('=== [1] Starting NestFactory.create ===');
  const app = await NestFactory.create(AppModule, { logger: ['error', 'warn', 'log'] });
  logSync('=== [2] App created, calling app.init() ===');
  await app.init();
  logSync('=== [3] App initialized successfully! Closing app ===');
  await app.close();
  logSync('=== [4] App closed successfully! ===');
}

bootstrap().catch(err => {
  logSync('=== [!] Bootstrap failed === ' + String(err));
});
