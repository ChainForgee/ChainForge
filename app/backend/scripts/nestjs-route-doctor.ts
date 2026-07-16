import { NestFactory } from '@nestjs/core';
import { DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { ROLES_KEY } from '../src/auth/roles.decorator';
import { NO_AUTH_STRICT_KEY } from '../src/common/decorators/no-auth-strict.decorator';

async function runRouteDoctor() {
  // Use createApplicationContext for light-weight boot without opening HTTP ports
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });

  const discoveryService = app.get(DiscoveryService);
  const metadataScanner = app.get(MetadataScanner);
  const reflector = app.get(Reflector);

  const controllers = discoveryService.getControllers();
  let undecoratedCount = 0;

  // Retrieve bypass paths from environment
  const bypassEnv = process.env.PUBLIC_AUTH_BYPASS ?? '';
  const bypassedPaths = bypassEnv
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);

  console.log('🔍 Running NestJS Route Doctor...');
  console.log(`Bypass list: ${JSON.stringify(bypassedPaths)}`);

  for (const wrapper of controllers) {
    const { instance, name: controllerName } = wrapper;
    if (!instance) continue;

    const controllerClass = wrapper.metatype;
    const classPath = Reflect.getMetadata('path', controllerClass) ?? '';

    const prototype = Object.getPrototypeOf(instance);
    const methodNames = metadataScanner.getAllMethodNames(prototype);

    for (const methodName of methodNames) {
      const handler = instance[methodName];
      const methodPath = Reflect.getMetadata('path', handler);

      // If methodPath is undefined, this method is not a route handler
      if (methodPath === undefined) continue;

      // Construct the paths to check
      const methodPaths = Array.isArray(methodPath) ? methodPath : [methodPath];

      for (const mPath of methodPaths) {
        // Build the combined path
        let fullPath = `/${classPath}/${mPath}`.replace(/\/+/g, '/').replace(/\/$/, '');
        if (fullPath === '') fullPath = '/';

        // Prepend api/v1 to simulate typical route prefixing in this app
        const fullPathWithPrefix = `/api/v1${fullPath}`.replace(/\/+/g, '/').replace(/\/$/, '');

        // Check if bypassed
        const isBypassed = bypassedPaths.some((bpath) => {
          const cleanBPath = bpath.replace(/^\/+|\/+$/g, '');
          const cleanReqPath = fullPathWithPrefix.replace(/^\/+|\/+$/g, '');
          if (cleanBPath === cleanReqPath) return true;
          if (cleanReqPath.endsWith(cleanBPath)) {
            const index = cleanReqPath.lastIndexOf(cleanBPath);
            if (index > 0 && cleanReqPath.charAt(index - 1) === '/') return true;
          }
          return false;
        });

        if (isBypassed) {
          continue;
        }

        // Check decorators
        const requiredRoles = reflector.getAllAndOverride<string[]>(ROLES_KEY, [
          handler,
          controllerClass,
        ]);
        const isNoAuthStrict = reflector.getAllAndOverride<boolean>(NO_AUTH_STRICT_KEY, [
          handler,
          controllerClass,
        ]);

        if (!requiredRoles && !isNoAuthStrict) {
          console.error(
            `❌ Undecorated route found: ${controllerName}.${methodName} [${fullPathWithPrefix}] is missing @Roles() or @NoAuthStrict()`,
          );
          undecoratedCount++;
        }
      }
    }
  }

  await app.close();

  if (undecoratedCount > 0) {
    console.error(`\n🚨 Route Doctor found ${undecoratedCount} undecorated route(s). Failing build.`);
    process.exit(1);
  } else {
    console.log('✅ Route Doctor: All routes are properly decorated or bypassed!');
    process.exit(0);
  }
}

void runRouteDoctor();
