<script lang="ts">
  import { onMount } from 'svelte';
  import { intent } from '@napplet/sdk';
  import { parseIntentResult, type IntentRequest } from '@hyprgate/types';
  import {
    createNoteViewerOpenIntentRequest,
    createNoteViewerOpenPayload,
    pubkeyColorStyle,
  } from '@hyprgate/utils';
  import {
    createTriageStore,
    interactionCounts,
    selectedTriageGroup,
    visibleTriageGroups,
    type InteractionKind,
    type TriageGroup,
    type TriageState,
  } from './lib/thread-triage-store';

  let state = $state<TriageState>({ groups: [], selectedRootId: null, filter: 'all', loading: true, error: null });
  const store = createTriageStore(() => {
    state = { ...store.state };
  });
  const groups = $derived(visibleTriageGroups(state));
  const selected = $derived(selectedTriageGroup(state));
  const filters: Array<InteractionKind | 'all'> = ['all', 'reply', 'comment', 'reaction', 'zap', 'quote'];

  onMount(() => {
    store.load();
    return () => store.destroy();
  });

  function setFilter(filter: TriageState['filter']): void {
    store.setFilter(filter);
  }

  function selectGroup(group: TriageGroup): void {
    store.select(group.rootId);
  }

  function mark(status: 'reviewed' | 'deferred'): void {
    if (!selected) return;
    store.setStatus(selected.rootId, status);
  }

  async function invokeNavigation(request: IntentRequest | null): Promise<void> {
    if (!request) return;
    try {
      const result = parseIntentResult(await intent.invoke(request));
      if (!result || result.archetype !== request.archetype || result.action !== (request.action ?? 'open')) return;
      if (!result.ok || !result.handled) return;
    } catch {
      // Keep the existing no-op behavior when navigation is unavailable.
    }
  }

  async function openSelected(): Promise<void> {
    if (!selected) return;
    const payload = createNoteViewerOpenPayload({
      target: { type: 'event', id: selected.rootId },
      source: { napplet: 'thread-triage' },
      behavior: { focus: true, newWindow: true },
    });
    await invokeNavigation(payload ? createNoteViewerOpenIntentRequest(payload, { behavior: payload.behavior }) : null);
  }
</script>

<main class="triage-shell">
  <header class="toolbar">
    <div class="filters" aria-label="Interaction filters">
      {#each filters as filter}
        <button type="button" class:active={state.filter === filter} onclick={() => setFilter(filter)}>
          {filter}
        </button>
      {/each}
    </div>
  </header>

  <section class="content">
    <section class="groups" aria-label="Grouped threads">
      {#each groups as group}
        {@const counts = interactionCounts(group)}
        <button type="button" class="group" class:selected={selected?.rootId === group.rootId} onclick={() => selectGroup(group)}>
          <span class="status">{group.status}</span>
          <span class="title">{group.title}</span>
          <span class="counts">{counts.reply} replies / {counts.comment} comments / {counts.reaction} reactions / {counts.zap} zaps</span>
        </button>
      {/each}
      {#if state.loading}
        <p class="empty">Loading thread activity...</p>
      {:else if state.error}
        <p class="empty">{state.error}</p>
      {:else if groups.length === 0}
        <p class="empty">No current interaction activity found.</p>
      {/if}
    </section>

    <aside class="detail">
      {#if selected}
        <p class="eyebrow">{selected.status}</p>
        <h2>{selected.title}</h2>
        <code>{selected.rootId}</code>
        <div class="actions">
          <button type="button" onclick={openSelected}>Open Note</button>
          <button type="button" onclick={() => mark('reviewed')}>Reviewed</button>
          <button type="button" onclick={() => mark('deferred')}>Defer</button>
        </div>
        <div class="interactions">
          {#each selected.interactions as interaction}
            <article>
              <span>{interaction.kind}</span>
              <strong style={pubkeyColorStyle(interaction.author)}>{interaction.author}</strong>
              <p>{interaction.summary}</p>
            </article>
          {/each}
        </div>
      {/if}
    </aside>
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
    justify-content: space-between;
    gap: 16px;
    padding: 8px 12px;
    border-bottom: 1px solid var(--hg-border, #303030);
    background: var(--hg-surface, #101010);
  }

  h2, p {
    margin: 0;
    letter-spacing: 0;
  }

  h2 {
    font-size: 16px;
  }

  .eyebrow, .status {
    color: var(--hg-accent, #9ee493);
    font-size: 11px;
    text-transform: uppercase;
  }

  .filters, .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
  }

  button {
    border: 1px solid var(--hg-border, #303030);
    border-radius: 6px;
    background: var(--hg-surface, #111);
    color: var(--hg-text, #f3f1e8);
    font: inherit;
    padding: 8px 10px;
    cursor: pointer;
  }

  button:hover, button.active, button.selected {
    border-color: var(--hg-accent, #9ee493);
  }

  .content {
    min-height: 0;
    flex: 1;
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(300px, 0.8fr);
  }

  .groups {
    overflow: auto;
    padding: 12px;
  }

  .group {
    width: 100%;
    display: grid;
    grid-template-columns: 96px minmax(140px, 0.5fr) minmax(0, 1fr);
    gap: 10px;
    text-align: left;
    margin-bottom: 8px;
  }

  .counts {
    color: var(--hg-text-muted, #b8b1a4);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .empty {
    color: var(--hg-text-muted, #b8b1a4);
    padding: 10px;
  }

  .detail {
    border-left: 1px solid var(--hg-border, #303030);
    background: var(--hg-surface, #101010);
    padding: 14px;
    display: flex;
    flex-direction: column;
    gap: 12px;
    min-width: 0;
  }

  code {
    color: var(--hg-accent-cyan, #82d8f7);
    overflow-wrap: anywhere;
  }

  .interactions {
    overflow: auto;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  article {
    border: 1px solid var(--hg-border, #303030);
    border-radius: 6px;
    padding: 10px;
  }

  article span {
    color: var(--hg-accent, #9ee493);
    font-size: 11px;
    text-transform: uppercase;
  }

  article p {
    color: var(--hg-text-muted, #b8b1a4);
    margin-top: 6px;
  }

  @media (max-width: 760px) {
    .toolbar, .content {
      display: flex;
      flex-direction: column;
    }

    .detail {
      border-left: 0;
      border-top: 1px solid var(--hg-border, #303030);
    }

    .group {
      grid-template-columns: 1fr;
    }
  }
</style>
