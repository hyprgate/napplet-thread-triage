<!-- HYPRGATE NAPPLET MIRROR NOTICE:START -->
> This repository is a read-only mirror of the `thread-triage` napplet from `hyprgate/gui`.
> Open issues and pull requests in https://github.com/hyprgate/gui.
> Do not push commits to this standalone napplet repository; direct changes are overwritten by Hyprgate's mirror workflow.
<!-- HYPRGATE NAPPLET MIRROR NOTICE:END -->

# Thread Triage

Work through the replies, comments, reactions, zaps, reposts, quotes and mentions on
your notes, one thread at a time. Threads you mark as reviewed or deferred leave the
review list until someone new shows up in them.

The source lives in the Hyprgate monorepo at `napplets/thread-triage`. The standalone
`hyprgate/napplet-thread-triage` repository is a generated, read-only mirror, so send
changes to [hyprgate/web](https://github.com/hyprgate/web).

## Developing

Run these from the root of a Hyprgate checkout so workspace dependencies resolve:

```bash
pnpm install --frozen-lockfile
pnpm --filter ./napplets/thread-triage paja        # Kehto Paja plus the Vite dev server
pnpm --filter ./napplets/thread-triage test
pnpm --filter ./napplets/thread-triage type-check
pnpm --filter ./napplets/thread-triage conformance # builds, then checks dist/
```
