import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { checkEvidence, makeEvidence, messageLookupKey } from '../../supabase/functions/_shared/mm/evidence.ts';
import { resolveGoldSpan } from '../../supabase/functions/_shared/mm/evaluation.ts';
import { inventoryShard, mergeInventories, selectConversations, extractSelected } from '../../supabase/functions/_shared/mm/parser.ts';

const load = (name) => JSON.parse(readFileSync(new URL(`../../fixtures/synthetic/eval/${name}`, import.meta.url), 'utf8'));
const dataset = load('heldout-v3.json');
const manifest = load('manifest.json');
const hash = (value) => createHash('sha256').update(value).digest('hex');
function canon(value) {
  if (Array.isArray(value)) return `[${value.map(canon).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canon(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
const selection = { conversationIds: null, from: null, to: null, includeUnknownDate: true, branchChoices: {} };
const inventory = inventoryShard(dataset.export, 0, dataset.id, null);
const selected = selectConversations(mergeInventories([inventory]), selection);
const parsed = extractSelected(dataset.export, 0, selected, selection, { messages: 0, textBytes: 0 });
const messages = new Map(parsed.conversations.flatMap((conversation) => conversation.messages.map((message) => [messageLookupKey(message.conversationId, message.messageId), message])));

test('v3 freeze, previous edition and all exact source identities verify without extraction', () => {
  assert.equal(hash(canon(dataset)), manifest.files['heldout-v3.json'].labelSha256);
  assert.equal(hash(readFileSync(new URL('../../fixtures/synthetic/eval/heldout-v2.json', import.meta.url))), manifest.files['heldout-v3.json'].derivedFrom.rawSha256);
  assert.equal(parsed.issues.length, 0);
  assert.equal(parsed.conversations.length, 6);
  for (const label of dataset.labels) {
    assert.equal(checkEvidence(label.source, messages), 'verified', label.id);
    assert.deepEqual(resolveGoldSpan(label, messages), { label, start: label.source.start, end: label.source.end });
    assert.equal(label.eligible, true);
    assert.equal(label.durable, true);
    assert.ok(label.groupRationale.length > 20);
  }
  assert.equal(dataset.labels.length, 30);
  const family = dataset.labels.find((label) => label.id === 'fresh-v3-family-label-29');
  assert.equal(family.supported, false);
  assert.deepEqual(family.sensitivity, ['minors']);
  const relationship = dataset.labels.find((label) => label.id === 'fresh-v3-relationship-label-30');
  assert.equal(relationship.supported, false);
  assert.deepEqual(relationship.sensitivity, ['intimate']);
  assert.deepEqual([...new Set(dataset.sensitivityCases.flatMap((item) => item.categories))].sort(), ['belief', 'finance', 'health', 'intimate', 'minors', 'precise_location']);
  const first = dataset.labels[0];
  const message = messages.get(messageLookupKey(first.conversationId, first.messageId));
  assert.notEqual(message.text.indexOf(first.quote), first.source.start, 'astral prefix must distinguish UTF-16 and code-point offsets');
});

// what_bug_this_catches: new gold evidence metadata cannot be decorative. Wrong
// source identities, offsets and hashes must fail without quote-search fallback.
test('gold resolver rejects altered pins instead of accepting matching text elsewhere', () => {
  const label = dataset.labels[0];
  for (const change of [
    { sourceDigest: '0'.repeat(64) }, { textSha256: '0'.repeat(64) },
    { quoteSha256: '0'.repeat(64) }, { start: label.source.start + 1, end: label.source.end + 1 },
    { role: 'assistant' }, { parserVersion: 'foreign/999' }, { sourceTime: '1900-01-01T00:00:00Z' },
    { conversationId: 'different-conversation' }, { messageId: 'different-message' },
  ]) assert.equal(resolveGoldSpan({ ...label, source: { ...label.source, ...change } }, messages), null);
});

test('duplicate quote occurrences use explicit code-point pins; ambiguous legacy labels are refused', () => {
  const label = dataset.labels[0];
  const original = messages.get(messageLookupKey(label.conversationId, label.messageId));
  const text = `${label.quote} / ${label.quote}`;
  const message = { ...original, text, textSha256: hash(text) };
  const local = new Map([[messageLookupKey(message.conversationId, message.messageId), message]]);
  const evidence = makeEvidence(message, message.sourceDigest, label.quote.length + 3, text.length);
  assert.equal(evidence.ok, true);
  const pinned = { ...label, source: evidence.evidence };
  assert.equal(resolveGoldSpan(pinned, local).start, [...`${label.quote} / `].length);
  assert.equal(resolveGoldSpan({ ...label, source: undefined }, local), null);
});

test('group reasons and each label membership agree', () => {
  for (const group of dataset.groups) {
    assert.ok(group.reason.length > 20);
    for (const id of group.members) {
      const label = dataset.labels.find((item) => item.id === id);
      assert.ok(label.groupIds.includes(group.id));
      assert.ok(label.groupRationale.includes(group.reason));
    }
  }
  for (const label of dataset.labels) assert.deepEqual(label.groupIds, dataset.groups.filter((group) => group.members.includes(label.id)).map((group) => group.id));
});
