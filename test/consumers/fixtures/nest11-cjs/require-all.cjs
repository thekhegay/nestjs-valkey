// Every entry point loads through require(esm): no top-level await anywhere in the graph, and
// the "default" condition resolves for require().
const entries = [
  'nestjs-valkey',
  'nestjs-valkey/locks',
  'nestjs-valkey/idempotency',
  'nestjs-valkey/glide',
  'nestjs-valkey/ioredis',
];
const loaded = {};
for (const entry of entries) loaded[entry] = Object.keys(require(entry)).toSorted();
loaded.version = require('nestjs-valkey/package.json').version;
console.log(`REQUIRED ${JSON.stringify(loaded)}`);
