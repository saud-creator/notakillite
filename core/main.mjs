import { createInterface } from 'node:readline';
import { CoreService } from './service.mjs';
const arg = name => { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : undefined; };
const core = await new CoreService({ dataRoot: arg('--data-dir') }).init();
const send = data => process.stdout.write(`${JSON.stringify(data)}\n`);
let publishedRevision = -1;
core.on('state', state => { const includeLibrary = publishedRevision !== state.revision; publishedRevision = state.revision; send({ event: 'state', data: includeLibrary ? state : { ...state, notes: undefined, library: undefined } }); });
core.on('browserCommand', data => send({ event: 'browserCommand', data }));
send({ event: 'state', data: core.snapshot() });
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
let closing = false;
input.on('line', line => {
  let message;
  try { message = JSON.parse(line); if (typeof message.id !== 'number' || typeof message.type !== 'string') return; }
  catch { return; }
  if (message.type === 'shutdown') { void shutdown(); return; }
  core.handle(message.type, message.params).then(result => send({ id: message.id, result }), error => send({ id: message.id, error: error.message || 'The operation could not be completed.', code: error.code || 'OPERATION_FAILED' }));
});
async function shutdown() { if (closing) return; closing = true; input.close(); await core.close(); process.exit(0); }
input.on('close', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
