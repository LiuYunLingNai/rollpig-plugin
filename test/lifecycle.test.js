import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bindContext, getContext, runSerialized, waitForOperations } from '../host/index.js';

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test('queued and in-flight work retains its original unload signal across rebinding', async () => {
  const old = new AbortController();
  const current = new AbortController();
  const before = { signal: old.signal, name: 'old' };
  const after = { signal: current.signal, name: 'new' };
  bindContext(before);
  const started = deferred();
  const release = deferred();
  const running = runSerialized(async () => {
    started.resolve();
    await release.promise;
    assert.equal(getContext().name, 'old');
    getContext().signal.throwIfAborted();
  });
  await started.promise;
  const queued = runSerialized(() => assert.fail('unloaded queued command ran'));
  const runningFailure = assert.rejects(running);
  const queuedFailure = assert.rejects(queued);
  old.abort();
  bindContext(after);
  release.resolve();
  await Promise.all([runningFailure, queuedFailure]);
  await waitForOperations();
  assert.equal(await runSerialized(() => getContext().name), 'new');

  const timeout = new AbortController();
  timeout.abort();
  await assert.rejects(runSerialized(() => assert.fail('timed-out cron ran'), timeout.signal));

  const gate = deferred();
  const holding = runSerialized(() => gate.promise);
  const jobs = Array.from({ length: 31 }, () => runSerialized(() => 'queued'));
  await assert.rejects(runSerialized(() => {}), /排队已满/);
  gate.resolve();
  await Promise.all([holding, ...jobs]);
  current.abort();
  await waitForOperations();
});
