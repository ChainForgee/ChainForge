import type { Config } from 'jest';

const config: Config = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
  },
  // Playwright's own test runner owns everything under e2e/ (see
  // playwright.config.ts's testDir) — Jest's default testMatch would
  // otherwise pick up *.spec.ts files there too and fail, since Playwright
  // tests can only run via `playwright test`, not `jest`.
  testPathIgnorePatterns: ['<rootDir>/node_modules/', '<rootDir>/e2e/'],
};

export default config;
