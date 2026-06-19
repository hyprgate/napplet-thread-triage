import { identity, relay, storage, type Subscription } from "@napplet/sdk";
import {
  KIND_GENERIC_REPOST,
  KIND_NIP22_COMMENT,
  KIND_REACTION,
  KIND_REPOST,
  KIND_TEXT_NOTE,
  parseNoteViewerReply,
} from '@hyprgate/utils';

interface NostrEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

interface NostrFilter {
  ids?: string[];
  authors?: string[];
  kinds?: number[];
  since?: number;
  until?: number;
  limit?: number;
  [key: `#${string}`]: string[] | undefined;
}

export type InteractionKind = 'reply' | 'comment' | 'reaction' | 'zap' | 'quote';
export type TriageStatus = 'unreviewed' | 'reviewed' | 'deferred';

export interface TriageInteraction {
  id: string;
  kind: InteractionKind;
  rootId: string;
  targetId: string;
  author: string;
  summary: string;
  createdAt: number;
}

export interface TriageGroup {
  rootId: string;
  title: string;
  status: TriageStatus;
  interactions: TriageInteraction[];
}

export interface TriageState {
  groups: TriageGroup[];
  selectedRootId: string | null;
  filter: InteractionKind | 'all';
  loading: boolean;
  error: string | null;
}

export interface TriageStore {
  state: TriageState;
  load(): void;
  setFilter(filter: TriageState['filter']): void;
  select(rootId: string): void;
  setStatus(rootId: string, status: TriageStatus): void;
  destroy(): void;
}

const TRIAGE_STATUS_KEY = 'thread-triage:statuses:v1';
const KIND_ZAP_RECEIPT = 9735;
const INTERACTION_KINDS = [
  KIND_TEXT_NOTE,
  KIND_NIP22_COMMENT,
  KIND_REACTION,
  KIND_REPOST,
  KIND_GENERIC_REPOST,
  KIND_ZAP_RECEIPT,
] as const;

export function createInitialTriageState(): TriageState {
  return {
    groups: [],
    selectedRootId: null,
    filter: 'all',
    loading: false,
    error: null,
  };
}

export function createTriageStore(onUpdate?: () => void): TriageStore {
  const state = createInitialTriageState();
  const interactions = new Map<string, TriageInteraction>();
  let statuses = new Map<string, TriageStatus>();
  let sub: Subscription | null = null;

  function notify(): void {
    onUpdate?.();
  }

  function rebuild(): void {
    state.groups = groupInteractions([...interactions.values()], statuses);
    if (!state.selectedRootId || !state.groups.some((group) => group.rootId === state.selectedRootId)) {
      state.selectedRootId = state.groups[0]?.rootId ?? null;
    }
  }

  async function load(): Promise<void> {
    destroy();
    state.loading = true;
    state.error = null;
    notify();

    try {
      statuses = await restoreStatuses();
      const pubkey = await identity.getPublicKey();
      const filters: NostrFilter[] = [
        { kinds: [...INTERACTION_KINDS], '#p': [pubkey], limit: 200 },
        { kinds: [KIND_NIP22_COMMENT], '#P': [pubkey], limit: 200 },
      ];
      sub = relay.subscribe(
        filters,
        (event) => {
          const interaction = interactionFromEvent(event, pubkey);
          if (!interaction) return;
          interactions.set(interaction.id, interaction);
          rebuild();
          notify();
        },
        () => {
          state.loading = false;
          rebuild();
          notify();
        },
      );
    } catch (error) {
      state.loading = false;
      state.error = error instanceof Error ? error.message : 'Unable to load thread activity.';
      notify();
    }
  }

  function setFilter(filter: TriageState['filter']): void {
    state.filter = filter;
    notify();
  }

  function select(rootId: string): void {
    state.selectedRootId = rootId;
    notify();
  }

  function setStatus(rootId: string, status: TriageStatus): void {
    statuses.set(rootId, status);
    state.groups = state.groups.map((group) => group.rootId === rootId ? { ...group, status } : group);
    state.selectedRootId = rootId;
    persistStatuses(statuses);
    notify();
  }

  function destroy(): void {
    sub?.close();
    sub = null;
  }

  return { state, load: () => { void load(); }, setFilter, select, setStatus, destroy };
}

export function groupInteractions(interactions: TriageInteraction[], statuses = new Map<string, TriageStatus>()): TriageGroup[] {
  const grouped = new Map<string, TriageInteraction[]>();
  for (const interaction of interactions) {
    const existing = grouped.get(interaction.rootId) ?? [];
    existing.push(interaction);
    grouped.set(interaction.rootId, existing);
  }
  return Array.from(grouped.entries())
    .map(([rootId, groupInteractionsForRoot]) => ({
      rootId,
      title: `Thread ${rootId.slice(0, 12)}`,
      status: statuses.get(rootId) ?? 'unreviewed',
      interactions: [...groupInteractionsForRoot].sort((a, b) => b.createdAt - a.createdAt),
    }))
    .sort((a, b) => b.interactions[0]!.createdAt - a.interactions[0]!.createdAt);
}

export function visibleTriageGroups(state: TriageState): TriageGroup[] {
  if (state.filter === 'all') return state.groups;
  return state.groups
    .map((group) => ({
      ...group,
      interactions: group.interactions.filter((interaction) => interaction.kind === state.filter),
    }))
    .filter((group) => group.interactions.length > 0);
}

export function selectedTriageGroup(state: TriageState): TriageGroup | null {
  return state.groups.find((group) => group.rootId === state.selectedRootId) ?? visibleTriageGroups(state)[0] ?? null;
}

export function interactionCounts(group: TriageGroup): Record<InteractionKind, number> {
  return group.interactions.reduce<Record<InteractionKind, number>>((counts, interaction) => {
    counts[interaction.kind] += 1;
    return counts;
  }, { reply: 0, comment: 0, reaction: 0, zap: 0, quote: 0 });
}

export function interactionFromEvent(event: NostrEvent, selfPubkey: string): TriageInteraction | null {
  const reply = parseNoteViewerReply(event);
  if (reply?.type === 'kind1-reply') {
    return createInteraction(event, 'reply', reply.root.id, reply.parent.id);
  }
  if (reply?.type === 'nip22-comment') {
    const rootId = reply.root.type === 'event' ? reply.root.id : reply.root.address;
    const targetId = reply.parent.type === 'event' ? reply.parent.id : reply.parent.address;
    return createInteraction(event, 'comment', rootId, targetId);
  }
  if (event.kind === KIND_REACTION) {
    const target = firstTagValue(event.tags, 'e') ?? firstTagValue(event.tags, 'a');
    if (!target) return null;
    return createInteraction(event, 'reaction', target, target);
  }
  if (event.kind === KIND_ZAP_RECEIPT) {
    const target = firstTagValue(event.tags, 'e') ?? firstTagValue(event.tags, 'a') ?? selfPubkey;
    return createInteraction(event, 'zap', target, target);
  }
  if (event.kind === KIND_REPOST || event.kind === KIND_GENERIC_REPOST || firstTagValue(event.tags, 'q')) {
    const target = firstTagValue(event.tags, 'q') ?? firstTagValue(event.tags, 'e') ?? event.id;
    return createInteraction(event, 'quote', target, target);
  }
  if (event.kind === KIND_TEXT_NOTE && event.tags.some((tag) => tag[0] === 'p' && tag[1] === selfPubkey)) {
    return createInteraction(event, 'reply', event.id, event.id);
  }
  return null;
}

async function restoreStatuses(): Promise<Map<string, TriageStatus>> {
  try {
    const raw = await storage.getItem(TRIAGE_STATUS_KEY);
    if (!raw) return new Map();
    const entries = JSON.parse(raw) as Array<[string, TriageStatus]>;
    return new Map(entries.filter(([, status]) => ['unreviewed', 'reviewed', 'deferred'].includes(status)));
  } catch {
    return new Map();
  }
}

function persistStatuses(statuses: Map<string, TriageStatus>): void {
  void storage.setItem(TRIAGE_STATUS_KEY, JSON.stringify([...statuses.entries()])).catch(() => {});
}

function createInteraction(event: NostrEvent, kind: InteractionKind, rootId: string, targetId: string): TriageInteraction {
  return {
    id: event.id,
    kind,
    rootId,
    targetId,
    author: event.pubkey,
    summary: summarizeEvent(event),
    createdAt: event.created_at,
  };
}

function summarizeEvent(event: NostrEvent): string {
  const trimmed = event.content.trim();
  if (!trimmed) return `kind ${event.kind}`;
  return trimmed.length > 140 ? `${trimmed.slice(0, 140)}...` : trimmed;
}

function firstTagValue(tags: string[][], name: string): string | null {
  return tags.find((tag) => tag[0] === name && tag[1])?.[1] ?? null;
}
