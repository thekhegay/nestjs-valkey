import { contractSuites } from '../support/contracts.js';
import { ioredisCluster, ioredisSentinel, ioredisStandalone } from '../support/servers.js';

contractSuites([
  ioredisStandalone(),
  ioredisCluster(),
  ioredisSentinel(),
  ioredisStandalone('ioredis', 'redis'),
]);
