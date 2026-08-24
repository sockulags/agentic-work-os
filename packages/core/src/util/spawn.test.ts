import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { HUMAN_AUTH_TOKEN_ENV } from '../config.js';
import { spawnCli, workerEnvironment } from './spawn.js';

const savedOrdinary = process.env['AWOS_TOKEN'];
const humanEnvKeys = [HUMAN_AUTH_TOKEN_ENV, HUMAN_AUTH_TOKEN_ENV.toLowerCase(), 'AwOs_HuMaN_AuTh_ToKeN'];
const savedHuman = new Map(humanEnvKeys.map((key) => [key, process.env[key]]));

after(() => {
  if (savedOrdinary === undefined) delete process.env['AWOS_TOKEN'];
  else process.env['AWOS_TOKEN'] = savedOrdinary;
  for (const key of humanEnvKeys) {
    delete process.env[key];
    const value = savedHuman.get(key);
    if (value !== undefined) process.env[key] = value;
  }
});

test('worker children retain ordinary bearer context but strip every human-token casing', async () => {
  process.env['AWOS_TOKEN'] = 'ordinary-worker-token';
  humanEnvKeys.forEach((key, index) => { process.env[key] = `human-worker-token-${index}`; });
  const child = spawnCli(
    process.execPath,
    ['-e', 'process.stdout.write(JSON.stringify({ ordinary: process.env.AWOS_TOKEN, canonical: process.env.AWOS_HUMAN_AUTH_TOKEN, lower: process.env.awos_human_auth_token, mixed: process.env.AwOs_HuMaN_AuTh_ToKeN }))'],
    { cwd: process.cwd() },
  );
  let output = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => { output += chunk; });
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => code === 0 ? resolve() : reject(new Error(`child exited ${code}`)));
  });

  assert.deepEqual(JSON.parse(output), { ordinary: 'ordinary-worker-token' });
  const filtered = workerEnvironment({
    AWOS_TOKEN: 'ordinary-override-token',
    aWoS_ToKeN: 'ordinary-mixed-token',
    [HUMAN_AUTH_TOKEN_ENV.toLowerCase()]: 'override-human-lower',
    AwOs_HuMaN_AuTh_ToKeN: 'override-human-mixed',
  });
  assert.equal(filtered.AWOS_TOKEN, 'ordinary-override-token');
  assert.equal(Object.keys(filtered).some((key) => key.toLowerCase() === 'awos_token'), true);
  assert.equal(Object.keys(filtered).some((key) => key.toLowerCase() === HUMAN_AUTH_TOKEN_ENV.toLowerCase()), false);
});
