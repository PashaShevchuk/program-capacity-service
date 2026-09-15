import type { Config } from 'jest';

const transform: Config['transform'] = {
  '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.json' }],
};

const config: Config = {
  projects: [
    {
      displayName: 'unit',
      preset: 'ts-jest',
      testEnvironment: 'node',
      rootDir: '.',
      moduleFileExtensions: ['js', 'json', 'ts'],
      transform,
      testMatch: ['<rootDir>/src/**/*.spec.ts', '<rootDir>/test/unit/**/*.spec.ts'],
    },
    {
      displayName: 'integration',
      preset: 'ts-jest',
      testEnvironment: 'node',
      rootDir: '.',
      moduleFileExtensions: ['js', 'json', 'ts'],
      transform,
      testMatch: ['<rootDir>/test/integration/**/*.spec.ts'],
    },
  ],
  // Integration suites start a PostgreSQL container, which may need to pull an image.
  testTimeout: 180_000,
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.module.ts',
    '!src/main.ts',
    '!src/database/migrations/**',
  ],
  coverageDirectory: 'coverage',
};

export default config;
