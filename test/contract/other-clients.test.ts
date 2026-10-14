import { contractSuites } from '../support/contracts.js';
import { ioredisCluster, ioredisStandalone } from '../support/servers.js';

contractSuites([
  ioredisStandalone('ioredis5'),
  ioredisCluster('ioredis5'),
  ioredisStandalone('iovalkey'),
  ioredisCluster('iovalkey'),
]);
