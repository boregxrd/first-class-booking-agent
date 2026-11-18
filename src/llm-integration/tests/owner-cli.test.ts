import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { spawnSync } from 'node:child_process';

test('OAuth client importer validates the Web redirect and passes secrets only through stdin', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dwc-owner-cli-'));
  try {
    const file = join(dir, 'google-client.json'), log = join(dir, 'calls.jsonl');
    const script = fileURLToPath(new URL('../../../scripts/owner.mjs', import.meta.url));
    const client = { web: { client_id: 'test.apps.googleusercontent.com', client_secret: 'private-test-client-secret',
      redirect_uris: ['https://first-class-booking-agent.dallaswellnessclubweb.workers.dev/connections/callback/google'] } };
    await writeFile(file, JSON.stringify(client));
    await writeFile(join(dir, 'npx'), `#!${process.execPath}\nconst fs=require('node:fs');fs.appendFileSync(process.env.OWNER_CLI_TEST_LOG,JSON.stringify({args:process.argv.slice(2),input:fs.readFileSync(0,'utf8')})+'\\n');`, { mode: 0o700 });
    const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${dir}${delimiter}${process.env.PATH}`, OWNER_CLI_TEST_LOG: log };
    delete env.OWNER_PORTAL_URL;
    const installed = spawnSync(process.execPath, [script, '--google-client', file], { env, encoding: 'utf8' });
    assert.equal(installed.status, 0, installed.stderr);
    assert.doesNotMatch(installed.stdout + installed.stderr, /private-test-client-secret/);
    const calls = (await readFile(log, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(calls.map((call) => call.args), [['wrangler', 'secret', 'put', 'GOOGLE_OAUTH_CLIENT_ID'], ['wrangler', 'secret', 'put', 'GOOGLE_OAUTH_CLIENT_SECRET']]);
    assert.equal(calls[1]?.input, 'private-test-client-secret');
    client.web.redirect_uris = ['https://wrong.example/callback'];
    await writeFile(file, JSON.stringify(client));
    const rejected = spawnSync(process.execPath, [script, '--google-client', file], { env, encoding: 'utf8' });
    assert.equal(rejected.status, 1);
    assert.doesNotMatch(rejected.stderr, /private-test-client-secret/);
    assert.equal((await readFile(log, 'utf8')).trim().split('\n').length, 2, 'invalid redirect must not update Cloudflare secrets');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
