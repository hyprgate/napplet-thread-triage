import { describe, expect, it } from 'vitest';
import {
  createInitialTriageState,
  groupInteractions,
  interactionCounts,
  interactionFromEvent,
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
});
