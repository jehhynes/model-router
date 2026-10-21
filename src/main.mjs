import fs from 'node:fs';
import path from 'node:path';
import { createLog } from './log.mjs';
import { createRouter } from './router.mjs';

const root = path.resolve(import.meta.dirname, '..');
const envPath = path.join(root, '.env');
if (fs.existsSync(envPath))
  process.loadEnvFile(envPath);

const configPath = path.join(root, 'config.json');
if (!fs.existsSync(configPath)) {
  console.error(`Create ${configPath} from config.json.example first.`);
  process.exit(1);
}
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

for (const [field, min, max] of [['logMaxBytes', 1, Number.MAX_SAFE_INTEGER], ['logMaxFiles', 0, 1000]])
  if (config[field] !== undefined && !(Number.isInteger(config[field]) && config[field] >= min && config[field] <= max)) {
    console.error(`${field} in ${configPath} must be a whole number from ${min} to ${max}.`);
    process.exit(1);
  }
const log = createLog({
  file: config.logFile && path.resolve(root, config.logFile),
  maxBytes: config.logMaxBytes,
  maxFiles: config.logMaxFiles,
});

for (const listener of config.listeners) {
  const apiKey = process.env[listener.model.apiKeyEnv];
  if (!apiKey) {
    log(`${listener.name}: ${listener.model.apiKeyEnv} is not set in ${envPath}`);
    process.exit(1);
  }
  const server = createRouter({ ...listener, model: { ...listener.model, apiKey } }, log);
  server.on('error', err => {
    log(`${listener.name} listener on 127.0.0.1:${listener.port} failed: ${err.message}`);
    process.exit(1);
  });
  server.listen(listener.port, '127.0.0.1', () => log(`${listener.name} listening on 127.0.0.1:${listener.port}`));
}
