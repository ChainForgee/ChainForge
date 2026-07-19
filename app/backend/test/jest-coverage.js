const { jest: baseConfig } = require('../package.json');
const coverageBaseline = require('./coverage-baseline.json');

const baselineThresholds = Object.fromEntries(
  coverageBaseline.map(
    ([file, lines, branches, functions, statements]) => [
      file,
      { lines, branches, functions, statements },
    ],
  ),
);

module.exports = {
  ...baseConfig,
  rootDir: '..',
  testRegex: [
    '.*\\.spec\\.ts$',
    '.*verification-lifecycle\\.e2e-spec\\.ts$',
  ],
  testPathIgnorePatterns: ['/test/idempotency\\.spec\\.ts$'],
  moduleNameMapper: {
    ...baseConfig.moduleNameMapper,
    '^cache/(.*)$': '<rootDir>/cache/$1',
    '^@stellar/stellar-sdk$': '<rootDir>/test/mocks/stellar-sdk.mock.ts',
    '^openai$': '<rootDir>/test/mocks/openai.mock.ts',
  },
  coverageReporters: ['text', 'json-summary'],
  coverageThreshold: {
    global: baseConfig.coverageThreshold.global,
    ...baselineThresholds,
  },
  forceExit: true,
};
