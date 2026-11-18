import { fileURLToPath } from 'node:url';
import { createApplication, fileAudit } from './lib/app.mjs';

const port = Number(process.env.PORT ?? 4321);
if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) {
  throw new Error('PORT must be an integer between 1024 and 65535.');
}
const auditPath = fileURLToPath(new URL('./.local/audit.jsonl', import.meta.url));
const app = await createApplication({ port, environment: process.env, audit: fileAudit(auditPath) });
console.log(`OneDoor is ready at ${app.origin}`);
console.log('Local preview only: synthetic accounts, read-only sample data, no Entra authentication.');
console.log(`Model provider: ${process.env.MODEL_PROVIDER ?? 'demo'}. Press Ctrl+C to stop.`);

let closing = false;
async function stop() {
  if (closing) return;
  closing = true;
  await app.close();
}
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
