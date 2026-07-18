import ioredisMock from 'ioredis-mock';
import * as fs from 'fs';

function logSync(msg: string) {
  // No-op to avoid massive logs in test runner
}

class MockRedis extends ioredisMock {
  pendingBlockingPromises: Array<{ resolve: Function, reject: Function }> = [];
  isClosed = false;
  status = 'ready';

  constructor() {
    super();

    // Wrap in Proxy to intercept all accesses and mock commands
    return new Proxy(this, {
      get(target, prop, receiver) {
        if (prop === 'isClosed') {
          return target.isClosed;
        }

        // If client is closed, return delayed resolved promises for any command methods to allow graceful shutdown without looping
        if (typeof prop === 'string' && prop !== 'emit' && prop !== 'on' && prop !== 'addListener' && prop !== 'removeListener' && prop !== 'off' && prop !== 'disconnect' && prop !== 'quit' && prop !== 'status') {
          if (target.isClosed || target.status === 'end') {
            const val = Reflect.get(target, prop, receiver);
            if (typeof val === 'function' || prop === 'bzpopmin' || prop === 'brpop' || prop === 'blpop') {
              return function(this: any, ...args: any[]) {
                logSync(`[MockRedis] Command ${String(prop)} called on closed client (isClosed=${target.isClosed}, status=${target.status}) - returning delayed promise`);
                return new Promise((resolve, reject) => {
                  setTimeout(() => {
                    reject(new Error('Connection is closed.'));
                  }, 100);
                });
              };
            }
          }
        }

        // Intercept defineCommand to completely bypass ioredis-mock Lua VM compiler/loader
        if (prop === 'defineCommand') {
          return function(name: string, definition: any) {
            logSync(`[MockRedis] Proxy intercepted defineCommand for: ${name}`);
            (target as any)[name] = function(...args: any[]) {
              logSync(`[MockRedis] DYNAMIC COMMAND CALLED: ${name} with args: ${JSON.stringify(args)}`);
              const arrayCommands = [
                'moveToActive',
                'moveStalledJobsToWait',
                'cleanJobsInSet',
                'getRanges',
                'getCountsPerPriority',
                'getDependencyCounts',
                'getMetrics'
              ];
              if (arrayCommands.some(cmd => name.startsWith(cmd))) {
                return Promise.resolve([]);
              }
              if (name.startsWith('getCounts')) {
                return Promise.resolve([0, 0, 0, 0, 0]);
              }
              if (name.startsWith('isFinished')) {
                return Promise.resolve([0, null]);
              }
              if (name.startsWith('add')) {
                return Promise.resolve('mock-job-id');
              }
              return Promise.resolve(null);
            };
            return receiver;
          };
        }

        // Intercept blocking queue commands to avoid infinite busy-loops in workers
        if (prop === 'bzpopmin' || prop === 'brpop' || prop === 'blpop') {
          return function(...args: any[]) {
            const lastArg = args[args.length - 1];
            const timeoutMs = (typeof lastArg === 'number' && lastArg > 0) ? lastArg * 1000 : 5000;
            logSync(`[MockRedis] BLOCKING COMMAND CALLED (PENDING): ${String(prop)} with args: ${JSON.stringify(args)} (resolving in ${timeoutMs}ms)`);
            return new Promise((resolve, reject) => {
              const timer = setTimeout(() => {
                target.pendingBlockingPromises = target.pendingBlockingPromises.filter(p => p.resolve !== resolveWrapper);
                resolve(null);
              }, timeoutMs);

              const resolveWrapper = (val: any) => {
                clearTimeout(timer);
                resolve(val);
              };
              const rejectWrapper = (err: any) => {
                clearTimeout(timer);
                reject(err);
              };

              target.pendingBlockingPromises.push({ resolve: resolveWrapper, reject: rejectWrapper });
            });
          };
        }

        // Intercept stream commands to return null instead of throwing "Unsupported command"
        const stubbedCommands = [
          'xadd', 'xack', 'xclaim', 'xdel', 'xgroup', 'xinfo', 'xlen', 
          'xpending', 'xrange', 'xreadgroup', 'xrevrange', 'xtrim'
        ];
        if (typeof prop === 'string' && stubbedCommands.includes(prop)) {
          return function(...args: any[]) {
            logSync(`[MockRedis] STUBBED STREAM COMMAND CALLED: ${prop} with args: ${JSON.stringify(args)}`);
            return Promise.resolve(null);
          };
        }

        const val = Reflect.get(target, prop, receiver);
        if (typeof prop === 'string' && typeof val === 'function' && prop !== 'emit' && prop !== 'on' && prop !== 'addListener') {
          return function(this: any, ...args: any[]) {
            logSync(`[MockRedis] METHOD CALLED: ${prop} with args: ${JSON.stringify(args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)))}`);
            try {
              const res = val.apply(this === receiver ? target : this, args);
              if (res && typeof res.then === 'function') {
                return res.then((resolvedVal: any) => {
                  logSync(`[MockRedis] METHOD RESOLVED: ${prop} -> ${typeof resolvedVal === 'object' ? JSON.stringify(resolvedVal) : String(resolvedVal)}`);
                  return resolvedVal;
                }).catch((err: any) => {
                  logSync(`[MockRedis] METHOD REJECTED: ${prop} -> ${String(err)}`);
                  throw err;
                });
              }
              logSync(`[MockRedis] METHOD RETURNED: ${prop} -> ${typeof res === 'object' ? JSON.stringify(res) : String(res)}`);
              return res;
            } catch (err: any) {
              logSync(`[MockRedis] METHOD THREW: ${prop} -> ${String(err)}`);
              throw err;
            }
          };
        }
        return val;
      }
    });
  }

  disconnect() {
    logSync('[MockRedis] disconnect() called');
    this.isClosed = true;
    this.status = 'end';
    this.resolvePendingBlockingCommands();
    return super.disconnect();
  }

  quit() {
    logSync('[MockRedis] quit() called');
    this.isClosed = true;
    this.status = 'end';
    this.resolvePendingBlockingCommands();
    return super.quit();
  }

  private resolvePendingBlockingCommands() {
    if (this.pendingBlockingPromises && this.pendingBlockingPromises.length > 0) {
      logSync(`[MockRedis] Resolving ${this.pendingBlockingPromises.length} pending blocking promises with null`);
      for (const p of this.pendingBlockingPromises) {
        try {
          p.resolve(null);
        } catch (e) {}
      }
      this.pendingBlockingPromises = [];
    }
  }

  duplicate() {
    logSync('[MockRedis] duplicate() called - returning new MockRedis');
    return new MockRedis();
  }
}

const Mock = MockRedis;
(Mock as any).Redis = MockRedis;
(Mock as any).default = MockRedis;

export default Mock;
export { MockRedis as Redis };
