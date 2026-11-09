import { identity, relay, storage, type Subscription } from "@napplet/sdk";
import {
  KIND_GENERIC_REPOST,
  KIND_NIP22_COMMENT,
  KIND_REACTION,
  KIND_REPOST,
  KIND_TEXT_NOTE,
  parseNoteContent,
  parseNoteViewerReply,
  parseZapReceipt,
  formatMillisatsAsSats,
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

export type InteractionKind = 'reply' | 'comment' | 'reaction' | 'zap' | 'repost' | 'quote' | 'mention';
export type TriageStatus = 'unreviewed' | 'reviewed' | 'deferred';
export type TriageRootType = 'event' | 'address' | 'profile';

/** A decision on a thread, and the newest activity it covered. */
export interface TriageStatusRecord {
  status: Exclude<TriageStatus, 'unreviewed'>;
  coveredUntil: number;
}

export interface TriageRootNote {
  pubkey: string;
  title: string;
  text: string;
}

export interface TriageProfile {
  name?: string;
  picture?: string;
}

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
  rootType: TriageRootType;
  title: string;
  /** The root note's text, when it could be loaded. */
  text: string | null;
  status: TriageStatus;
  interactions: TriageInteraction[];
}

export interface TriageState {
  groups: TriageGroup[];
  selectedRootId: string | null;
  filter: InteractionKind | 'all';
  view: TriageStatus | 'all';
  profiles: Record<string, TriageProfile>;
  /** The last status change, for undo. */
  lastChange: { rootId: string; title: string; status: TriageStatus; previous: TriageStatusRecord | null } | null;
  loading: boolean;
  error: string | null;
}

export interface TriageStore {
  state: TriageState;
  load(): void;
  setFilter(filter: TriageState['filter']): void;
  setView(view: TriageState['view']): void;
  select(rootId: string): void;
  setStatus(rootId: string, status: TriageStatus): void;
  undo(): void;
  destroy(): void;
}

const TRIAGE_STATUS_KEY = 'thread-triage:statuses:v1';
const KIND_ZAP_RECEIPT = 9735;
const PROFILE_ROOT_PREFIX = 'profile:';
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
    view: 'unreviewed',
    profiles: {},
    lastChange: null,
    loading: false,
    error: null,
  };
}

export function createTriageStore(onUpdate?: () => void): TriageStore {
  const state = createInitialTriageState();
  const interactions = new Map<string, TriageInteraction>();
  const roots = new Map<string, TriageRootNote>();
  const lookedUpRoots = new Set<string>();
  const requestedRoots = new Set<string>();
  const requestedProfiles = new Set<string>();
  const openLookups = new Set<Subscription>();
  let statuses = new Map<string, TriageStatusRecord>();
  let sub: Subscription | null = null;
  let lookupTimer: ReturnType<typeof setTimeout> | null = null;
  let selfPubkey: string | undefined;

  function notify(): void {
    onUpdate?.();
  }

  function rebuild(): void {
    state.groups = groupInteractions([...interactions.values()], statuses, roots, lookedUpRoots);
  }

  function scheduleLookups(): void {
    if (lookupTimer !== null) return;
    lookupTimer = setTimeout(() => {
      lookupTimer = null;
      lookUpRootsAndProfiles();
    }, 100);
  }

  function lookUpRootsAndProfiles(): void {
    const wantedRoots = [...new Set([...interactions.values()].map((item) => item.rootId))]
      .filter((rootId) => !requestedRoots.has(rootId) && rootTypeOf(rootId) !== 'profile' && !roots.has(rootId));
    const wantedProfiles = [...new Set([...interactions.values()].map((item) => item.author))]
      .filter((pubkey) => !requestedProfiles.has(pubkey));
    wantedRoots.forEach((rootId) => requestedRoots.add(rootId));
    wantedProfiles.forEach((pubkey) => requestedProfiles.add(pubkey));

    const filters = rootFilters(wantedRoots);
    if (wantedProfiles.length > 0) filters.push({ kinds: [0], authors: wantedProfiles });
    if (filters.length === 0) return;

    const profileAt = new Map<string, number>();
    const lookup: Subscription = relay.subscribe(
      filters,
      (result) => {
        const event = result.event as NostrEvent;
        if (event.kind === 0) {
          if ((profileAt.get(event.pubkey) ?? -1) > event.created_at) return;
          const profile = parseProfile(event);
          if (!profile) return;
          profileAt.set(event.pubkey, event.created_at);
          state.profiles = { ...state.profiles, [event.pubkey]: profile };
        } else {
          for (const rootId of wantedRoots) {
            if (rootId === event.id || rootId === addressOf(event)) roots.set(rootId, rootNoteFromEvent(event, selfPubkey));
          }
          rebuild();
        }
        notify();
      },
      () => {
        wantedRoots.forEach((rootId) => lookedUpRoots.add(rootId));
        lookup.close();
        openLookups.delete(lookup);
        rebuild();
        notify();
      },
    );
    openLookups.add(lookup);
  }

  async function load(): Promise<void> {
    destroy();
    state.loading = true;
    state.error = null;
    notify();

    try {
      statuses = await restoreStatuses();
      const pubkey = await identity.getPublicKey();
      selfPubkey = pubkey;
      const filters: NostrFilter[] = [
        { kinds: [...INTERACTION_KINDS], '#p': [pubkey], limit: 200 },
        { kinds: [KIND_NIP22_COMMENT], '#P': [pubkey], limit: 200 },
      ];
      sub = relay.subscribe(
        filters,
        (result) => {
          const event = result.event as NostrEvent;
          const interaction = interactionFromEvent(event, pubkey);
          if (!interaction) return;
          interactions.set(interaction.id, interaction);
          // A mention is its own thread, so its text is already here.
          if (interaction.rootId === event.id) roots.set(event.id, rootNoteFromEvent(event, pubkey));
          rebuild();
          scheduleLookups();
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

  function setView(view: TriageState['view']): void {
    state.view = view;
    state.lastChange = null;
    notify();
  }

  function select(rootId: string): void {
    state.selectedRootId = rootId;
    notify();
  }

  function applyStatus(rootId: string, record: TriageStatusRecord | null): void {
    if (record) statuses.set(rootId, record);
    else statuses.delete(rootId);
    rebuild();
    persistStatuses(statuses);
  }

  function setStatus(rootId: string, status: TriageStatus): void {
    const group = state.groups.find((candidate) => candidate.rootId === rootId);
    if (!group) return;
    const previous = statuses.get(rootId) ?? null;
    applyStatus(rootId, status === 'unreviewed' ? null : { status, coveredUntil: latestActivity(group) });
    state.lastChange = { rootId, title: group.title, status, previous };
    notify();
  }

  function undo(): void {
    const change = state.lastChange;
    if (!change) return;
    applyStatus(change.rootId, change.previous);
    state.selectedRootId = change.rootId;
    state.lastChange = null;
    notify();
  }

  function destroy(): void {
    sub?.close();
    sub = null;
    if (lookupTimer !== null) clearTimeout(lookupTimer);
    lookupTimer = null;
    openLookups.forEach((lookup) => lookup.close());
    openLookups.clear();
  }

  return { state, load: () => { void load(); }, setFilter, setView, select, setStatus, undo, destroy };
}

function latestActivity(group: Pick<TriageGroup, 'interactions'>): number {
  return group.interactions.reduce((latest, item) => Math.max(latest, item.createdAt), 0);
}

function rootTypeOf(rootId: string): TriageRootType {
  if (rootId.startsWith(PROFILE_ROOT_PREFIX)) return 'profile';
  return rootId.includes(':') ? 'address' : 'event';
}

function rootFilters(rootIds: string[]): NostrFilter[] {
  const filters: NostrFilter[] = [];
  const ids = rootIds.filter((rootId) => rootTypeOf(rootId) === 'event');
  if (ids.length > 0) filters.push({ ids });
  for (const rootId of rootIds) {
    const address = parseAddress(rootId);
    if (address) filters.push({ kinds: [address.kind], authors: [address.pubkey], '#d': [address.identifier] });
  }
  return filters;
}

export function parseAddress(rootId: string): { kind: number; pubkey: string; identifier: string } | null {
  if (rootTypeOf(rootId) !== 'address') return null;
  const [kind, pubkey, ...identifier] = rootId.split(':');
  const parsedKind = Number(kind);
  if (!Number.isInteger(parsedKind) || !pubkey) return null;
  return { kind: parsedKind, pubkey, identifier: identifier.join(':') };
}

function addressOf(event: NostrEvent): string | null {
  const identifier = firstTagValue(event.tags, 'd');
  return identifier === null ? null : `${event.kind}:${event.pubkey}:${identifier}`;
}

function parseProfile(event: NostrEvent): TriageProfile | null {
  try {
    const metadata = JSON.parse(event.content) as Record<string, unknown>;
    const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : undefined);
    return {
      name: text(metadata.display_name) ?? text(metadata.displayName) ?? text(metadata.name) ?? text(metadata.nip05),
      picture: text(metadata.picture),
    };
  } catch {
    return null;
  }
}

/** Note text as a person reads it: mentions and links to events stay short. */
export function readableText(content: string, selfPubkey?: string): string {
  return parseNoteContent(content).map((block) => {
    switch (block.type) {
      case 'text': return block.value;
      case 'profile': return block.value === selfPubkey ? '@you' : '@someone';
      case 'event':
      case 'address': return '[linked note]';
      case 'media':
      case 'resource': return block.mediaType === 'image' ? '[image]' : '[video]';
      default: return block.source;
    }
  }).join('').replace(/[ \t]+\n/g, '\n').trim();
}

export function rootNoteFromEvent(event: NostrEvent, selfPubkey?: string): TriageRootNote {
  const text = readableText(event.content, selfPubkey);
  const firstLine = text.split('\n').find((line) => line.trim())?.trim() ?? '';
  const named = firstTagValue(event.tags, 'title') ?? firstTagValue(event.tags, 'name');
  return { pubkey: event.pubkey, title: named ?? truncate(firstLine, 90), text };
}

function rootTitle(rootId: string, root: TriageRootNote | undefined, lookedUp: boolean): string {
  if (rootTypeOf(rootId) === 'profile') return 'Your profile';
  if (root?.title) return root.title;
  if (root) return 'A note with no text';
  return lookedUp ? 'Note not found on your relays' : 'Loading note...';
}

export function groupInteractions(
  interactions: TriageInteraction[],
  statuses = new Map<string, TriageStatusRecord>(),
  roots = new Map<string, TriageRootNote>(),
  lookedUpRoots = new Set<string>(),
): TriageGroup[] {
  const grouped = new Map<string, TriageInteraction[]>();
  for (const interaction of interactions) {
    const existing = grouped.get(interaction.rootId) ?? [];
    existing.push(interaction);
    grouped.set(interaction.rootId, existing);
  }
  return Array.from(grouped.entries())
    .map(([rootId, groupInteractionsForRoot]) => {
      const record = statuses.get(rootId);
      const sorted = [...groupInteractionsForRoot].sort((a, b) => b.createdAt - a.createdAt);
      const root = roots.get(rootId);
      return {
        rootId,
        rootType: rootTypeOf(rootId),
        title: rootTitle(rootId, root, lookedUpRoots.has(rootId)),
        text: root?.text || null,
        // New activity after a decision puts the thread back in front of you.
        status: record && sorted[0]!.createdAt <= record.coveredUntil ? record.status : 'unreviewed' as TriageStatus,
        interactions: sorted,
      };
    })
    .sort((a, b) => b.interactions[0]!.createdAt - a.interactions[0]!.createdAt);
}

export function statusCounts(groups: TriageGroup[]): Record<TriageStatus, number> {
  const counts: Record<TriageStatus, number> = { unreviewed: 0, reviewed: 0, deferred: 0 };
  for (const group of groups) counts[group.status] += 1;
  return counts;
}

function groupsInView(state: Pick<TriageState, 'groups' | 'view'>): TriageGroup[] {
  return state.view === 'all' ? state.groups : state.groups.filter((group) => group.status === state.view);
}

export function visibleTriageGroups(state: TriageState): TriageGroup[] {
  const groups = groupsInView(state);
  if (state.filter === 'all') return groups;
  return groups
    .map((group) => ({
      ...group,
      interactions: group.interactions.filter((interaction) => interaction.kind === state.filter),
    }))
    .filter((group) => group.interactions.length > 0);
}

/** Always one of the visible threads, showing only the interactions that match the filter. */
export function selectedTriageGroup(state: TriageState): TriageGroup | null {
  const visible = visibleTriageGroups(state);
  return visible.find((group) => group.rootId === state.selectedRootId) ?? visible[0] ?? null;
}

/** How many interactions of each kind the current status view holds, for the filter buttons. */
export function viewInteractionCounts(state: Pick<TriageState, 'groups' | 'view'>): Record<InteractionKind, number> {
  const counts = emptyCounts();
  for (const group of groupsInView(state)) {
    for (const interaction of group.interactions) counts[interaction.kind] += 1;
  }
  return counts;
}

function emptyCounts(): Record<InteractionKind, number> {
  return { reply: 0, comment: 0, reaction: 0, zap: 0, repost: 0, quote: 0, mention: 0 };
}

export function interactionCounts(group: TriageGroup): Record<InteractionKind, number> {
  return group.interactions.reduce<Record<InteractionKind, number>>((counts, interaction) => {
    counts[interaction.kind] += 1;
    return counts;
  }, emptyCounts());
}

export function interactionFromEvent(event: NostrEvent, selfPubkey: string): TriageInteraction | null {
  // Your own posts that tag you are not activity to triage.
  if (event.pubkey === selfPubkey && event.kind !== KIND_ZAP_RECEIPT) return null;
  const reply = parseNoteViewerReply(event);
  if (reply?.type === 'kind1-reply') {
    return createInteraction(event, 'reply', reply.root.id, reply.parent.id, selfPubkey);
  }
  if (reply?.type === 'nip22-comment') {
    const rootId = reply.root.type === 'event' ? reply.root.id : reply.root.address;
    const targetId = reply.parent.type === 'event' ? reply.parent.id : reply.parent.address;
    return createInteraction(event, 'comment', rootId, targetId, selfPubkey);
  }
  if (event.kind === KIND_REACTION) {
    const target = lastTagValue(event.tags, 'e') ?? lastTagValue(event.tags, 'a');
    if (!target) return null;
    return { ...createInteraction(event, 'reaction', target, target), summary: reactionSummary(event.content) };
  }
  if (event.kind === KIND_ZAP_RECEIPT) {
    const zap = parseZapReceipt(event);
    const target = zap?.targetEventIds[0] ?? zap?.targetAddresses[0] ?? `${PROFILE_ROOT_PREFIX}${selfPubkey}`;
    // The receipt is signed by the zap provider; the zapper signed the embedded request.
    const zapper = zap?.senderPubkey ?? firstTagValue(event.tags, 'P');
    if (!zapper || zapper === selfPubkey) return null;
    const amount = zap?.amountMillisats ? `Zapped ${formatMillisatsAsSats(zap.amountMillisats)}` : 'Zapped you';
    return {
      ...createInteraction(event, 'zap', target, target),
      author: zapper,
      summary: zap?.comment ? `${amount}: ${truncate(zap.comment, 140)}` : amount,
    };
  }
  if (event.kind === KIND_REPOST || event.kind === KIND_GENERIC_REPOST) {
    const target = lastTagValue(event.tags, 'e') ?? firstTagValue(event.tags, 'a') ?? event.id;
    return { ...createInteraction(event, 'repost', target, target), summary: 'Reposted your note' };
  }
  const quoted = firstTagValue(event.tags, 'q');
  if (quoted) return createInteraction(event, 'quote', quoted, quoted, selfPubkey);
  if (event.kind === KIND_TEXT_NOTE && event.tags.some((tag) => tag[0] === 'p' && tag[1] === selfPubkey)) {
    return createInteraction(event, 'mention', event.id, event.id, selfPubkey);
  }
  return null;
}

function reactionSummary(content: string): string {
  const reaction = content.trim();
  if (reaction === '' || reaction === '+') return 'Liked this';
  if (reaction === '-') return 'Disliked this';
  return `Reacted ${reaction}`;
}

export function parseStoredStatuses(raw: string | null): Map<string, TriageStatusRecord> {
  if (!raw) return new Map();
  try {
    const entries = JSON.parse(raw) as Array<[string, TriageStatus, number?]>;
    const statuses = new Map<string, TriageStatusRecord>();
    for (const [rootId, status, coveredUntil] of entries) {
      if (status !== 'reviewed' && status !== 'deferred') continue;
      // Decisions saved before coveredUntil existed stay put rather than all resurfacing.
      statuses.set(rootId, { status, coveredUntil: coveredUntil ?? Number.MAX_SAFE_INTEGER });
    }
    return statuses;
  } catch {
    return new Map();
  }
}

async function restoreStatuses(): Promise<Map<string, TriageStatusRecord>> {
  try {
    return parseStoredStatuses(await storage.getItem(TRIAGE_STATUS_KEY));
  } catch {
    return new Map();
  }
}

function persistStatuses(statuses: Map<string, TriageStatusRecord>): void {
  const entries = [...statuses.entries()].map(([rootId, record]) => [rootId, record.status, record.coveredUntil]);
  void storage.setItem(TRIAGE_STATUS_KEY, JSON.stringify(entries)).catch(() => {});
}

function createInteraction(event: NostrEvent, kind: InteractionKind, rootId: string, targetId: string, selfPubkey?: string): TriageInteraction {
  return {
    id: event.id,
    kind,
    rootId,
    targetId,
    author: event.pubkey,
    summary: summarizeEvent(event, selfPubkey),
    createdAt: event.created_at,
  };
}

function summarizeEvent(event: NostrEvent, selfPubkey?: string): string {
  const text = readableText(event.content, selfPubkey);
  return text ? truncate(text, 140) : 'No text';
}

function truncate(text: string, length: number): string {
  return text.length > length ? `${text.slice(0, length).trimEnd()}...` : text;
}

function firstTagValue(tags: string[][], name: string): string | null {
  return tags.find((tag) => tag[0] === name && tag[1])?.[1] ?? null;
}

function lastTagValue(tags: string[][], name: string): string | null {
  return tags.filter((tag) => tag[0] === name && tag[1]).at(-1)?.[1] ?? null;
}
