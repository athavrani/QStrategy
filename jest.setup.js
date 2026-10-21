jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);


// Pacing and caching are covered by DhanRestGateway.test.ts; elsewhere they would slow or couple tests.
require('./src/services/dhan/DhanRestGateway').dhanRestGateway.configure({ pacing: false, cache: false });
