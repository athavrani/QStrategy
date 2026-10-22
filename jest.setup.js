jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);


jest.mock('react-native-background-actions', () => {
  let running = false;
  return {
    __esModule: true,
    default: {
      isRunning: () => running,
      start: jest.fn(async () => {
        running = true;
      }),
      stop: jest.fn(async () => {
        running = false;
      }),
    },
  };
});

// Pacing and caching are covered by DhanRestGateway.test.ts; elsewhere they would slow or couple tests.
require('./src/services/dhan/DhanRestGateway').dhanRestGateway.configure({ pacing: false, cache: false });
