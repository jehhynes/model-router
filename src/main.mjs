import fs from 'node:fs';
import path from 'node:path';
import { createRouter } from './router.mjs';

const root = path.resolve(import.meta.dirname, '..');
const envPath = path.join(root, '.env');
if (fs.existsSync(envPath))
  process.loadEnvFile(envPath);

const config = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));

const logFile = config.logFile && path.resolve(root, config.logFile);
if (logFile)
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
// Synchronous, so the line that explains an exit is written before it.
const log = line => {
  const entry = `${new Date().toISOString()} ${line}\n`;
  if (logFile)
    fs.appendFileSync(logFile, entry);
  else
    process.stdout.write(entry);
};

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
