<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { parseIntentResult, type IntentRequest } from '@hyprgate/types';
  import {
    buildMentionReference,
    createNoteViewerOpenIntentRequest,
    createNoteViewerOpenPayload,
    createProfileIntentRequest,
    invokeNappletIntent,
    pubkeyColorStyle,
    resourceImage,
  } from '@hyprgate/utils';
  import {
    createTriageStore,
    interactionCounts,
    parseAddress,
    selectedTriageGroup,
    statusCounts,
    viewInteractionCounts,
    visibleTriageGroups,
    type InteractionKind,
    type TriageGroup,
    type TriageState,
    type TriageStatus,
  } from './lib/thread-triage-store';

  let state = $state.raw<TriageState>({
    groups: [], selectedRootId: null, filter: 'all', view: 'unreviewed', profiles: {}, lastChange: null, loading: true, error: null,
  });
  const store = createTriageStore(() => {
    state = { ...store.state };
  });
  const groups = $derived(visibleTriageGroups(state));
  const selected = $derived(selectedTriageGroup(state));
  const viewCounts = $derived(statusCounts(state.groups));
  const kindCounts = $derived(viewInteractionCounts(state));
  let detailOpen = $state(false);
  let backButton = $state<HTMLButtonElement | null>(null);

  const views: Array<{ id: TriageState['view']; label: string }> = [
    { id: 'unreviewed', label: 'To review' },
    { id: 'deferred', label: 'Deferred' },
    { id: 'reviewed', label: 'Reviewed' },
    { id: 'all', label: 'All threads' },
  ];
  const kinds: Array<{ id: InteractionKind; plural: string; singular: string; verb: string }> = [
    { id: 'reply', plural: 'Replies', singular: 'reply', verb: 'replied' },
    { id: 'comment', plural: 'Comments', singular: 'comment', verb: 'commented' },
    { id: 'reaction', plural: 'Reactions', singular: 'reaction', verb: 'reacted' },
    { id: 'zap', plural: 'Zaps', singular: 'zap', verb: 'zapped' },
    { id: 'repost', plural: 'Reposts', singular: 'repost', verb: 'reposted' },
    { id: 'quote', plural: 'Quotes', singular: 'quote', verb: 'quoted' },
    { id: 'mention', plural: 'Mentions', singular: 'mention', verb: 'mentioned you' },
  ];
  const verbs = Object.fromEntries(kinds.map((kind) => [kind.id, kind.verb])) as Record<InteractionKind, string>;
  const statusLabels: Record<TriageStatus, string> = { unreviewed: 'To review', reviewed: 'Reviewed', deferred: 'Deferred' };
  const emptyCopy: Record<TriageState['view'], { title: string; hint: string }> = {
    unreviewed: { title: 'You\'re all caught up', hint: 'New replies, reactions, zaps and quotes on your notes land here.' },
    deferred: { title: 'Nothing deferred', hint: 'Threads you defer wait here until someone replies again.' },
    reviewed: { title: 'Nothing reviewed yet', hint: 'Threads you mark as reviewed move here.' },
    all: { title: 'No activity yet', hint: 'Replies, reactions, zaps and quotes on your notes will show up here.' },
  };

  onMount(() => {
    store.load();
    return () => store.destroy();
  });

  function npub(pubkey: string): string {
    try {
      return buildMentionReference(pubkey).replace(/^nostr:/, '');
    } catch {
      return pubkey;
    }
  }

  function displayName(pubkey: string): string {
    const name = state.profiles[pubkey]?.name;
    if (name) return name;
    const key = npub(pubkey);
    return `${key.slice(0, 12)}...${key.slice(-6)}`;
  }

  function initial(pubkey: string): string {
    return state.profiles[pubkey]?.name?.slice(0, 1).toUpperCase() ?? '?';
  }

  function participants(group: TriageGroup): string[] {
    return [...new Set(group.interactions.map((interaction) => interaction.author))];
  }

  function countSummary(group: TriageGroup): string {
    const counts = interactionCounts(group);
    return kinds
      .filter((kind) => counts[kind.id] > 0)
      .map((kind) => `${counts[kind.id]} ${counts[kind.id] === 1 ? kind.singular : kind.id === 'reply' ? 'replies' : `${kind.singular}s`}`)
      .join(' · ');
  }

  function timeAgo(createdAt: number): string {
    const seconds = Math.max(0, Math.floor(Date.now() / 1000) - createdAt);
    if (seconds < 60) return 'just now';
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    return `${Math.floor(seconds / 86400)}d ago`;
  }

  async function selectGroup(group: TriageGroup): Promise<void> {
    store.select(group.rootId);
    detailOpen = true;
    await tick();
    if (backButton?.offsetParent) backButton.focus();
  }

  async function closeDetail(): Promise<void> {
    detailOpen = false;
    await tick();
    document.querySelector<HTMLElement>('.group.selected')?.focus();
  }

  function toggle(status: 'reviewed' | 'deferred'): void {
    if (!selected) return;
    store.setStatus(selected.rootId, selected.status === status ? 'unreviewed' : status);
  }

  async function invokeNavigation(request: IntentRequest | null): Promise<void> {
    if (!request) return;
    try {
      const result = parseIntentResult(await invokeNappletIntent(request));
      if (!result || result.archetype !== request.archetype || result.action !== (request.action ?? 'open')) return;
      if (!result.ok) return;
    } catch {
      // Keep the existing no-op behavior when navigation is unavailable.
    }
  }

  async function openProfile(pubkey: string): Promise<void> {
    await invokeNavigation(createProfileIntentRequest({ pubkey }));
  }

  async function openNote(rootId: string): Promise<void> {
    const address = parseAddress(rootId);
    const payload = createNoteViewerOpenPayload({
      target: address ? { type: 'address', ...address } : { type: 'event', id: rootId },
      source: { napplet: 'thread-triage' },
      behavior: { focus: true, reuse: false },
    });
    await invokeNavigation(payload ? createNoteViewerOpenIntentRequest(payload, { behavior: payload.behavior }) : null);
  }
</script>

{#snippet avatar(pubkey: string)}
  <span class="avatar" style={pubkeyColorStyle(pubkey)} aria-hidden="true">
    <span class="avatar-initial">{initial(pubkey)}</span>
    {#if state.profiles[pubkey]?.picture}
      <img use:resourceImage={state.profiles[pubkey]?.picture} alt="" loading="lazy" />
    {/if}
  </span>
{/snippet}

<main class="triage-shell">
  <header class="toolbar">
    <div class="views" role="group" aria-label="Show threads">
      {#each views as view}
        <button type="button" class="view" aria-pressed={state.view === view.id} onclick={() => store.setView(view.id)}>
          {view.label}
          {#if view.id !== 'all'}<span class="count">{viewCounts[view.id]}</span>{/if}
        </button>
      {/each}
    </div>
    <div class="filters" role="group" aria-label="Filter by interaction">
      <button type="button" class="chip" aria-pressed={state.filter === 'all'} onclick={() => store.setFilter('all')}>All</button>
      {#each kinds as kind}
        <button type="button" class="chip" aria-pressed={state.filter === kind.id} onclick={() => store.setFilter(kind.id)}>
          {kind.plural} <span class="count">{kindCounts[kind.id]}</span>
        </button>
      {/each}
    </div>
  </header>

  {#if state.lastChange}
    <div class="change-note" role="status">
      <span>
        {#if state.lastChange.status === 'unreviewed'}Back in To review:{:else}{statusLabels[state.lastChange.status]}:{/if}
        {state.lastChange.title}
      </span>
      <button type="button" class="link" onclick={() => store.undo()}>Undo</button>
    </div>
  {/if}

  <section class="content" class:detail-open={detailOpen && selected} class:no-selection={!selected}>
    <section class="groups" aria-label="Threads">
      {#each groups as group (group.rootId)}
        {@const people = participants(group)}
        <button
          type="button"
          class="group"
          class:selected={selected?.rootId === group.rootId}
          aria-current={selected?.rootId === group.rootId ? 'true' : undefined}
          onclick={() => selectGroup(group)}
        >
          <span class="title">{group.title}</span>
          <span class="meta">
            <span class="stack">
              {#each people.slice(0, 3) as pubkey (pubkey)}
                {@render avatar(pubkey)}
              {/each}
              {#if people.length > 3}<span class="more">+{people.length - 3}</span>{/if}
            </span>
            <span class="counts">{countSummary(group)}</span>
            <span class="time">{timeAgo(group.interactions[0]!.createdAt)}</span>
          </span>
          {#if state.view === 'all' && group.status !== 'unreviewed'}
            <span class="status">{statusLabels[group.status]}</span>
          {/if}
        </button>
      {/each}
      {#if groups.length === 0}
        {#if state.loading}
          <p class="empty-title">Looking for activity on your notes...</p>
        {:else if state.error}
          <div class="empty">
            <p class="empty-title">Couldn't load your thread activity</p>
            <p class="empty-hint">{state.error}</p>
            <button type="button" onclick={() => store.load()}>Try again</button>
          </div>
        {:else if state.filter !== 'all'}
          <div class="empty">
            <p class="empty-title">Nothing matches that filter here</p>
            <button type="button" onclick={() => store.setFilter('all')}>Show all interactions</button>
          </div>
        {:else}
          <div class="empty">
            <p class="empty-title">{emptyCopy[state.view].title}</p>
            <p class="empty-hint">{emptyCopy[state.view].hint}</p>
          </div>
        {/if}
      {/if}
    </section>

    {#if selected}
      <aside class="detail" aria-label="Thread detail">
        <button type="button" class="back" bind:this={backButton} onclick={closeDetail}>Back to threads</button>
        <div class="root">
          <p class="eyebrow">{selected.rootType === 'profile' ? 'Zaps on your profile' : statusLabels[selected.status]}</p>
          {#if selected.text}
            <p class="root-text">{selected.text}</p>
          {:else}
            <h2>{selected.title}</h2>
          {/if}
        </div>
        <div class="actions">
          {#if selected.rootType !== 'profile'}
            <button type="button" onclick={() => openNote(selected.rootId)}>Open note</button>
          {/if}
          <button type="button" class="toggle" aria-pressed={selected.status === 'reviewed'} onclick={() => toggle('reviewed')}>
            {selected.status === 'reviewed' ? 'Reviewed ✓' : 'Reviewed'}
          </button>
          <button type="button" class="toggle" aria-pressed={selected.status === 'deferred'} onclick={() => toggle('deferred')}>
            {selected.status === 'deferred' ? 'Deferred ✓' : 'Defer'}
          </button>
        </div>
        <div class="interactions">
          {#each selected.interactions as interaction (interaction.id)}
            <article>
              <header>
                <button type="button" class="person" title={npub(interaction.author)} onclick={() => openProfile(interaction.author)}>
                  {@render avatar(interaction.author)}
                  <strong style={pubkeyColorStyle(interaction.author)}>{displayName(interaction.author)}</strong>
                </button>
                <span class="verb">{verbs[interaction.kind]}</span>
                <span class="time">{timeAgo(interaction.createdAt)}</span>
              </header>
              <p>{interaction.summary}</p>
              {#if interaction.kind === 'reply' || interaction.kind === 'comment' || interaction.kind === 'quote'}
                <button type="button" class="link" onclick={() => openNote(interaction.id)}>Open {interaction.kind}</button>
              {/if}
            </article>
          {/each}
        </div>
      </aside>
    {/if}
  </section>
</main>

<style>
  :global(body) {
    margin: 0;
    background: var(--hg-bg, #070707);
    color: var(--hg-text, #f3f1e8);
    font-family: var(--hg-font-body, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
  }

  .triage-shell {
    height: 100vh;
    display: flex;
    flex-direction: column;
  }

  .toolbar {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 10px 12px;
    border-bottom: 1px solid var(--hg-border, #303030);
    background: var(--hg-surface, #101010);
  }

  h2, p {
    margin: 0;
    letter-spacing: 0;
  }

  h2 {
    font-size: 15px;
    font-weight: 600;
  }

  .eyebrow, .status {
    color: var(--hg-accent, #9ee493);
    font-size: 11px;
    text-transform: uppercase;
  }

  .views, .filters, .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    align-items: center;
  }

  button {
    border: 1px solid var(--hg-border, #303030);
    border-radius: 6px;
    background: var(--hg-surface, #111);
    color: var(--hg-text, #f3f1e8);
    font: inherit;
    padding: 7px 10px;
    cursor: pointer;
  }

  button:hover {
    border-color: var(--hg-accent, #9ee493);
  }

  button:focus-visible {
    outline: 2px solid var(--hg-accent, #9ee493);
    outline-offset: 1px;
  }

  button[aria-pressed='true'] {
    border-color: var(--hg-accent, #9ee493);
    background: color-mix(in srgb, var(--hg-accent, #9ee493) 18%, transparent);
  }

  .view {
    font-weight: 600;
  }

  .chip {
    padding: 3px 8px;
    font-size: 12px;
  }

  .count {
    color: var(--hg-text-muted, #b8b1a4);
    font-weight: 400;
    margin-left: 2px;
  }

  .change-note {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 6px 12px;
    font-size: 13px;
    border-bottom: 1px solid var(--hg-border, #303030);
    color: var(--hg-text-muted, #b8b1a4);
  }

  .change-note span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .link {
    border: 0;
    background: none;
    padding: 2px 4px;
    color: var(--hg-accent, #9ee493);
    text-decoration: underline;
    flex: none;
  }

  .content {
    min-height: 0;
    flex: 1;
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(300px, 0.9fr);
  }

  .content.no-selection {
    grid-template-columns: minmax(0, 1fr);
  }

  .groups {
    overflow: auto;
    padding: 12px;
  }

  .group {
    width: 100%;
    display: flex;
    flex-direction: column;
    gap: 6px;
    text-align: left;
    margin-bottom: 8px;
    padding: 10px;
  }

  .group.selected {
    border-color: var(--hg-accent, #9ee493);
    background: color-mix(in srgb, var(--hg-accent, #9ee493) 10%, transparent);
  }

  .title {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .meta {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
    color: var(--hg-text-muted, #b8b1a4);
  }

  .stack {
    display: inline-flex;
    align-items: center;
    flex: none;
  }

  .stack .avatar + .avatar {
    margin-left: -6px;
  }

  .more {
    margin-left: 4px;
  }

  .counts {
    min-width: 0;
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .time {
    flex: none;
    font-size: 12px;
    color: var(--hg-text-muted, #b8b1a4);
  }

  .avatar {
    position: relative;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: none;
    width: 22px;
    height: 22px;
    border-radius: 50%;
    overflow: hidden;
    border: 1px solid var(--hg-border, #303030);
    background: var(--hg-surface, #111);
    font-size: 11px;
    font-weight: 600;
  }

  .avatar img {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 10px;
    text-align: center;
    padding: 56px 16px;
  }

  .empty-title {
    font-weight: 600;
  }

  .empty-hint {
    color: var(--hg-text-muted, #b8b1a4);
    font-size: 13px;
    max-width: 42ch;
  }

  .detail {
    border-left: 1px solid var(--hg-border, #303030);
    background: var(--hg-surface, #101010);
    padding: 14px;
    display: flex;
    flex-direction: column;
    gap: 12px;
    min-width: 0;
    min-height: 0;
    overflow: auto;
  }

  .back {
    display: none;
    align-self: flex-start;
  }

  .root {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .root-text {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    max-height: 9.5em;
    overflow: auto;
  }

  .interactions {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  article {
    border: 1px solid var(--hg-border, #303030);
    border-radius: 6px;
    padding: 10px;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 6px;
  }

  article header {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    width: 100%;
    font-size: 13px;
  }

  .person {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    max-width: 100%;
    border: 0;
    background: none;
    padding: 0;
  }

  .person strong {
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .person:hover strong {
    text-decoration: underline;
  }

  .verb {
    color: var(--hg-text-muted, #b8b1a4);
  }

  article header .time {
    margin-left: auto;
  }

  article p {
    overflow-wrap: anywhere;
    white-space: pre-wrap;
  }

  article .link {
    padding: 0;
    font-size: 12px;
  }

  @media (max-width: 760px) {
    .content, .content.no-selection {
      grid-template-columns: minmax(0, 1fr);
    }

    .detail {
      border-left: 0;
      display: none;
    }

    .content.detail-open .groups {
      display: none;
    }

    .content.detail-open .detail {
      display: flex;
    }

    .back {
      display: block;
    }
  }
</style>
