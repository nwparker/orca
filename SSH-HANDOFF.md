# SSH/tab work handoff

## Current state

- Worktree: `/Users/nwparker/orca/workspaces/orca/SSH-handshake-HOLD`
- Branch/PR: `fix/ssh-reattach-orphan-pty` → [#17786](https://github.com/stablyai/orca/pull/17786)
- HEAD and pushed PR head: `8a998fc5203` (rebased on `origin/main` `28373fcea70`)
- Dirty: `src/renderer/src/i18n/locales/en.json` is an intended localization addition; untracked `.llm-counsel/` and `.ui-proof/` are scratch only.

## Goal

Ship the SSH reattach/relay-backpressure and terminal-tab-cycle fixes, then close the covered bug reports with final CI/readiness evidence.

## Done / verified

- Restore retry, generation/incarnation fencing, relay backpressure, split routing/parking, and tab-cycle fixes are in #17786.
- Focused current-head sweep: 18 files / 226 tests passed; `pnpm tc:node` passed.
- Tab batch: 124/124; provider/relay race coverage: 164/164.
- Real Electron/CDP keyboard proof completed (`Ctrl+PageDown` ×2, `Ctrl+PageUp`); visible selection and zero page errors.
- Changed-code quality, max-lines ratchet, formatting, and diff checks passed.
- AWIN, M4 Air, and OpenClaw focused SSH matrices passed; WSL reboot/sleep-resume remains unverified.
- [#12115](https://github.com/stablyai/orca/issues/12115) is closed; [#17159](https://github.com/stablyai/orca/pull/17159) and [#17751](https://github.com/stablyai/orca/pull/17751) are merged.

## Next actions (in order)

1. `git status --short --branch`; review and commit `en.json`; remove/leave untracked `.ui-proof/` and `.llm-counsel/` out of the PR.
2. Resolve the three current #17786 review threads: rotation-fence ownership on stale activation (`src/relay/relay-pty-source-publication.ts`), terminal-only ID fallback (`src/renderer/src/hooks/ipc-tab-switch.ts`), and shell-generated `DROP_AFTER_*` / `FLOOD_AFTER_*` markers (`tests/e2e/ssh-docker-transport-drop-recovery.spec.ts`).
3. Re-run the focused suites, `pnpm tc:node`, changed-code quality, formatting, and readiness checklist; then wait for fresh PR CI. The last remote failure was watcher-isolation E2E synchronization, not a proven relay regression.
4. Re-run AWIN/M4/OpenClaw focused checks at the final head, document the WSL/display gaps, and merge #17786 only after CI/review are green. Then close/update [#12448](https://github.com/stablyai/orca/issues/12448).

## Separate work

- [#17748](https://github.com/stablyai/orca/pull/17748) is open but should remain separate/unmerged: its queued-frame/orphan-PTY review blocker is unresolved, and it does not explain the ~900 s relay deployment. [#14830](https://github.com/stablyai/orca/issues/14830) remains open.
- Other open tab reports (#17743, #17767, #17541, #16391, #17778, etc.) are not proven fixed by this branch.

## Risks / constraints

- No WSL reboot/sleep-resume test; OpenClaw Electron UI was display-blocked.
- Do not claim the Slack idle-SSH report is conclusively resolved until the reporter retests; #17786 is the likely fix.

## Validation commands already run

```sh
corepack pnpm test src/renderer/src/hooks/ipc-tab-switch.test.ts src/renderer/src/hooks/ipc-tab-switch-group-order-hydration.test.ts  # 33/33
corepack pnpm tc:node                                                                 # passed
pnpm run lint                                                                         # passed
pnpm run check:code-quality:changed                                                   # 0 new findings
pnpm check:max-lines-ratchet                                                          # passed
pnpm run sync:localization-catalog                                                    # passed
```

Additional focused SSH/tab matrix: 18 files / 226 tests passed at `8a998fc5203`.
