module.exports = {
  preset: 'jest-expo',
  transformIgnorePatterns: [
    'node_modules/(?!((jest-)?react-native|@react-native(-community)?)|expo(nent)?|@expo(nent)?/.*|@expo-google-fonts/.*|react-navigation|@react-navigation/.*|@unimodules/.*|unimodules|sentry-expo|native-base|react-native-svg)',
  ],
  setupFilesAfterEnv: ['<rootDir>/jest.setup.js'],
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json', 'node'],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
  },
  testMatch: ['**/__tests__/**/*.test.[jt]s?(x)'],
  // The UI suites load the whole app on first render; under a parallel run that can pass the 5 s default.
  testTimeout: 30000,
  modulePathIgnorePatterns: ['<rootDir>/relay/'],
  collectCoverageFrom: [
    'src/**/*.{ts,tsx}',
    '!src/**/*.d.ts',
  ],
  // Floors sit a few points below current coverage; raise them as tests are added.
  coverageThreshold: {
    './src/engine/': { lines: 85, branches: 75, functions: 70 },
    './src/services/marketdata/': { lines: 85, branches: 75, functions: 80 },
    './src/services/dhan/DhanRestGateway.ts': { lines: 80, branches: 80, functions: 65 },
    './src/services/dhan/DhanBinaryCodec.ts': { lines: 90, branches: 70, functions: 90 },
    './src/services/JournalRepository.ts': { lines: 90, branches: 80, functions: 90 },
    './src/strategies/*Strategy.ts': { lines: 90, branches: 75, functions: 90 },
  },
};
