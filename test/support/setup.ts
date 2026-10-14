import { Logger } from '@valkey/valkey-glide';

// glide logs every NOSCRIPT it recovers from as a warning, from Rust, straight to stdout.
Logger.setLoggerConfig('error');
