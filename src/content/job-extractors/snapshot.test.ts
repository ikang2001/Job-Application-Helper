import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createJobDescriptionSnapshot,
  normalizeJobDescription,
  sha256Hex,
} from './snapshot.ts';
import { MAX_JD_LENGTH } from './types.ts';

test('normalizes HTML JD to plain compact text without script/style content', () => {
  const normalized = normalizeJobDescription(`
    <style>.hidden { display: none }</style>
    <h2>Responsibilities</h2>
    <p>Build&nbsp;APIs &amp; tools.</p>
    <script>alert('ignored')</script>
  `);

  assert.equal(normalized, 'Responsibilities Build APIs & tools.');
});

test('SHA-256 uses the standard lowercase hex representation', async () => {
  assert.equal(
    await sha256Hex('abc'),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  );
});

test('snapshot hashes normalized full text before applying MAX_JD_LENGTH', async () => {
  const raw = `<p>${'x'.repeat(MAX_JD_LENGTH + 25)}</p>`;
  let digestInput = '';
  const snapshot = await createJobDescriptionSnapshot(
    raw,
    'https://jobs.example.com/jobs/1',
    '2026-09-03T10:00:00.000Z',
    async (text) => {
      digestInput = text;
      return 'digest';
    },
  );

  assert.equal(digestInput.length, MAX_JD_LENGTH + 25);
  assert.equal(snapshot?.text.length, MAX_JD_LENGTH);
  assert.equal(snapshot?.truncated, true);
  assert.equal(snapshot?.contentHash, 'digest');
});

test('empty normalized JD does not create a snapshot', async () => {
  const snapshot = await createJobDescriptionSnapshot(
    '<script>only script</script>',
    'https://jobs.example.com/jobs/1',
    '2026-09-03T10:00:00.000Z',
  );

  assert.equal(snapshot, undefined);
});
