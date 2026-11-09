import { describe, expect, it } from 'vitest';
import {
  createInitialTriageState,
  groupInteractions,
  interactionCounts,
  interactionFromEvent,
  parseStoredStatuses,
  readableText,
  rootNoteFromEvent,
  selectedTriageGroup,
  statusCounts,
  visibleTriageGroups,
  type TriageInteraction,
} from './thread-triage-store';

const SELF = 'a'.repeat(64);

function event(partial: Partial<Parameters<typeof interactionFromEvent>[0]>): Parameters<typeof interactionFromEvent>[0] {
  return {
    id: partial.id ?? 'e'.repeat(64),
    pubkey: partial.pubkey ?? 'b'.repeat(64),
    created_at: partial.created_at ?? 1,
    kind: partial.kind ?? 1,
    tags: partial.tags ?? [],
    content: partial.content ?? 'hello',
    sig: partial.sig ?? 's',
  };
}

describe('thread triage store', () => {
  it('starts empty instead of loading sample interactions', () => {
    expect(createInitialTriageState().groups).toEqual([]);
  });

  it('converts kind 1 replies into interactions', () => {
    const interaction = interactionFromEvent(event({
      tags: [['e', '1'.repeat(64), '', 'root'], ['p', SELF]],
    }), SELF);

    expect(interaction?.kind).toBe('reply');
    expect(interaction?.rootId).toBe('1'.repeat(64));
  });

  it('converts reactions into interactions', () => {
    const interaction = interactionFromEvent(event({
      kind: 7,
      tags: [['e', '2'.repeat(64)], ['p', SELF]],
      content: '+',
    }), SELF);

    expect(interaction?.kind).toBe('reaction');
    expect(interaction?.rootId).toBe('2'.repeat(64));
  });

  it('groups and filters interactions by root event', () => {
    const interactions: TriageInteraction[] = [
      { id: 'a', kind: 'reply', rootId: 'root-a', targetId: 'root-a', author: 'alice', summary: 'reply', createdAt: 2 },
      { id: 'b', kind: 'comment', rootId: 'root-b', targetId: 'root-b', author: 'bob', summary: 'comment', createdAt: 1 },
    ];
    const state = { ...createInitialTriageState(), groups: groupInteractions(interactions), filter: 'comment' as const };

    expect(visibleTriageGroups(state)).toHaveLength(1);
    expect(visibleTriageGroups(state)[0]!.rootId).toBe('root-b');
  });

  it('counts interaction kinds in a group', () => {
    const group = groupInteractions([
      { id: 'a', kind: 'reply', rootId: 'root', targetId: 'root', author: 'alice', summary: 'reply', createdAt: 2 },
      { id: 'b', kind: 'reaction', rootId: 'root', targetId: 'root', author: 'bob', summary: '+', createdAt: 1 },
    ])[0]!;

    const counts = interactionCounts(group);

    expect(counts.reply).toBe(1);
    expect(counts.reaction).toBe(1);
  });

  it('credits a zap to the sender in the embedded request, not the provider', () => {
    const sender = 'c'.repeat(64);
    const interaction = interactionFromEvent(event({
      kind: 9735,
      pubkey: 'd'.repeat(64),
      content: '',
      tags: [
        ['p', SELF],
        ['e', '3'.repeat(64)],
        ['bolt11', 'lnbc1'],
        ['description', JSON.stringify({ kind: 9734, pubkey: sender, content: 'nice one', tags: [['amount', '2100000'], ['p', SELF]] })],
      ],
    }), SELF);

    expect(interaction?.kind).toBe('zap');
    expect(interaction?.author).toBe(sender);
    expect(interaction?.rootId).toBe('3'.repeat(64));
    expect(interaction?.summary).toContain('nice one');
    expect(interaction?.summary).toMatch(/2,?100 sats/);
  });

  it('never prints a repost body, which is the reposted event as JSON', () => {
    const reposted = { id: '4'.repeat(64), kind: 1, content: 'original', tags: [] };
    const interaction = interactionFromEvent(event({
      kind: 6,
      content: JSON.stringify(reposted),
      tags: [['e', reposted.id], ['p', SELF]],
    }), SELF);

    expect(interaction?.kind).toBe('repost');
    expect(interaction?.rootId).toBe(reposted.id);
    expect(interaction?.summary).toBe('Reposted your note');
  });

  it('reads a reaction target from the last e tag and words the content', () => {
    const interaction = interactionFromEvent(event({
      kind: 7,
      content: '+',
      tags: [['e', '5'.repeat(64)], ['e', '6'.repeat(64)], ['p', SELF]],
    }), SELF);

    expect(interaction?.rootId).toBe('6'.repeat(64));
    expect(interaction?.summary).toBe('Liked this');
  });

  it('separates mentions from replies and ignores your own events', () => {
    const tags = [['p', SELF]];
    expect(interactionFromEvent(event({ tags }), SELF)?.kind).toBe('mention');
    expect(interactionFromEvent(event({ pubkey: SELF, tags }), SELF)).toBeNull();
  });

  it('titles a thread from its root note instead of its id', () => {
    const root = event({ content: '\nFirst real line\nSecond line' });
    const roots = new Map([[root.id, rootNoteFromEvent(root)]]);
    const interactions: TriageInteraction[] = [
      { id: 'a', kind: 'reply', rootId: root.id, targetId: root.id, author: 'alice', summary: 'x', createdAt: 2 },
      { id: 'b', kind: 'reply', rootId: 'f'.repeat(64), targetId: 'f', author: 'alice', summary: 'x', createdAt: 1 },
      { id: 'c', kind: 'reply', rootId: '9'.repeat(64), targetId: '9', author: 'alice', summary: 'x', createdAt: 0 },
    ];

    const [known, missing, pending] = groupInteractions(interactions, new Map(), roots, new Set(['f'.repeat(64)]));

    expect(known!.title).toBe('First real line');
    expect(missing!.title).toBe('Note not found on your relays');
    expect(pending!.title).toBe('Loading note...');
  });

  it('keeps nostr entities out of readable text', () => {
    const npub = 'npub10xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqpkge6d';
    const self = '79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';
    expect(readableText(`hello nostr:${npub}!`, self)).toBe('hello @you!');
    expect(readableText(`hello nostr:${npub}!`)).toBe('hello @someone!');
  });

  it('shows only threads and interactions that match the filter in the detail pane', () => {
    const groups = groupInteractions([
      { id: 'a', kind: 'reply', rootId: 'root-a', targetId: 'root-a', author: 'alice', summary: 'reply', createdAt: 3 },
      { id: 'b', kind: 'quote', rootId: 'root-a', targetId: 'root-a', author: 'alice', summary: 'quote', createdAt: 2 },
      { id: 'c', kind: 'comment', rootId: 'root-b', targetId: 'root-b', author: 'bob', summary: 'comment', createdAt: 1 },
    ]);

    const quotes = { ...createInitialTriageState(), groups, selectedRootId: 'root-b', filter: 'quote' as const };
    expect(selectedTriageGroup(quotes)?.rootId).toBe('root-a');
    expect(selectedTriageGroup(quotes)?.interactions.map((item) => item.id)).toEqual(['b']);
  });

  it('moves decided threads out of the review list and back when new activity arrives', () => {
    const reply = (id: string, createdAt: number): TriageInteraction => ({ id, kind: 'reply', rootId: 'root', targetId: 'root', author: 'alice', summary: id, createdAt });
    const statuses = new Map([['root', { status: 'reviewed' as const, coveredUntil: 5 }]]);

    const decided = groupInteractions([reply('a', 5)], statuses);
    expect(statusCounts(decided)).toEqual({ unreviewed: 0, reviewed: 1, deferred: 0 });
    expect(visibleTriageGroups({ ...createInitialTriageState(), groups: decided })).toHaveLength(0);

    const resurfaced = groupInteractions([reply('a', 5), reply('b', 6)], statuses);
    expect(resurfaced[0]!.status).toBe('unreviewed');
  });

  it('keeps decisions saved in the older storage shape', () => {
    const statuses = parseStoredStatuses(JSON.stringify([['old', 'reviewed'], ['new', 'deferred', 9], ['bad', 'nope']]));

    expect(statuses.get('new')).toEqual({ status: 'deferred', coveredUntil: 9 });
    expect(statuses.get('old')?.coveredUntil).toBe(Number.MAX_SAFE_INTEGER);
    expect(statuses.has('bad')).toBe(false);
  });
});
