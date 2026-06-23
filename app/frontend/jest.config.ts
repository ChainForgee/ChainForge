import type { Config } from 'jest';

const config: Config = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
  },
  /**
   * Load global setup modules AFTER the testing framework is installed so
   * custom matchers (e.g. jest-axe's `toHaveNoViolations`) can be registered
   * via `expect.extend(...)`.
   */
  setupFilesAfterEnv: ['<rootDir>/jest.setup.a11y.ts'],
};

export default config;
