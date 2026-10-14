import { contractSuites } from '../support/contracts.js';
import { glideCluster, glideStandalone } from '../support/servers.js';

contractSuites([glideStandalone(), glideCluster(), glideStandalone('redis')]);
