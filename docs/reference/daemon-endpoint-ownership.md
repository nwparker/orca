# Daemon Endpoint Ownership

How Orca decides which process may serve on the daemon's canonical socket path, and why the
rule is shaped the way it is.

## The invariant

> **Only a daemon publishing itself onto the canonical endpoint may mutate that directory
> entry, and it may only do so by replacing an entry it has itself just proven dead.**

No launcher, health checker, or sweeper ever removes the endpoint. A departing daemon does not
remove it either. One actor, one syscall.

Everything below follows from that sentence.

## Background: what goes wrong without it

Node/libuv unlinks the pathname a server bound to when that server closes, with **no ownership
check**. A daemon exiting late therefore deleted whichever socket happened to sit at the
canonical path — including a live replacement's. The replacement stayed alive hosting PTYs that
no client could reach. From the user's seat this reads as terminals that acknowledge input and
never run it, app-wide, until the process is killed by hand.

That specific mechanism is fixed: daemons bind a private name and hard-link it into place, so
libuv can only ever unlink the private name. But the fix left the surrounding shape intact — a
launcher still decided that _another_ process was dead and reclaimed its name on its behalf.

Seven review rounds against that shape produced twenty-three distinct defects. Every one was an
interleaving of the same pattern: **a third party observing liveness at time T and acting on the
directory entry at time T+1.** Rename-claiming made the removal atomic with respect to the
directory entry, but nothing makes the observe-then-act sequence atomic, because the two steps
are separated by a process boundary as well as a time gap.

The invariant above removes the pattern rather than narrowing the window.

## The publish protocol

A starting daemon runs exactly this:

1. **Bind a private name.** `.b<10 hex>` in the same directory. Same directory because
   `sockaddr_un.sun_path` caps a Unix socket path at ~104 bytes, so the private name replaces
   the basename rather than extending the path — it is always strictly shorter than the
   canonical endpoint the caller already requires to fit.

2. **Try to take the name exclusively.** `link(bind, canonical)`.
   - Succeeds → published. Cold start, nothing was there. Done.
   - `EEXIST` → something occupies the name. Continue.

3. **Prove the incumbent dead, or lose.** Connect to the canonical path.
   - Connects → a live daemon owns this endpoint. **We lose.** Do not touch the entry. Report
     `occupied` and let the caller adopt the incumbent instead of forking beside it.
   - `ECONNREFUSED` — a socket inode with no listener. Proven dead.
   - `ENOTSOCK` — a regular file sits on the name. Nothing can ever serve it. Proven dead.
     Note macOS reports `ENOTSOCK` here but Linux reports `ECONNREFUSED` for the same
     situation, so both errnos must be accepted; neither platform is the reference.
   - `ENOENT` — the entry vanished between the link and the connect, or it is a dangling
     symlink (`existsSync` follows links, `lstatSync` does not). Proven dead.
   - anything else, including a timeout → **not** proof. Report `inconclusive` and leave it
     alone. A probe that merely timed out is not a second opinion.

4. **Check the proof still describes the entry, then replace it.** Re-`stat` the canonical path
   and compare against what was there when step 3 began. If it changed hands while we were
   probing, our death proof describes an entry that is no longer present — start the whole
   protocol over rather than act on it. Only then `rename(bind, canonical)`. One syscall. The
   dead entry is replaced by our live one with **no instant at which the canonical name is
   absent**, so no client and no concurrent daemon can observe a gap.

5. **Verify we kept it.** `stat` the canonical path and compare against the identity of the
   inode we bound. If it is not ours, another daemon replaced us in the microseconds after our
   rename — exit immediately, before accepting a single connection. If the `stat` itself fails,
   **decline**: `ENOENT` means the name we took is gone, and any other error means we cannot
   show we are reachable. A starting daemon has no sessions to protect, so declining costs
   nothing, while serving a name that resolves elsewhere is the entire bug.

   `dev`+`ino` alone is sufficient _here_, unlike everywhere else in this file: our own listener
   still holds the inode open, so the kernel cannot recycle its number while we are asking. The
   `birthtimeMs` tiebreak exists for the third-party case, where the inode being compared was
   already freed and Linux hands the number straight back to the next socket.

## Empirical validation

The protocol's load-bearing claims were measured against real kernels rather than reasoned
about, on darwin/APFS and linux/overlayfs (`node:24-slim`). Both platforms: `link` publishes and
is exclusive (`EEXIST`); a closed listener leaves the entry behind and `connect` to it yields
`ECONNREFUSED`; regular files and dangling symlinks both occupy the name and both classify as
dead; `rename` clears either and publishes.

The decisive measurement is step 4's gaplessness. Hammering `connect` across a live handover:

| handover primitive             | probes                     | saw the name absent |
| ------------------------------ | -------------------------- | ------------------- |
| `rename` (this design)         | 6,525 darwin / 8,004 linux | **0**               |
| `unlink`-then-`link` (control) | 200                        | **200**             |

The control is the shape the code used before this change. It does not narrowly race; it gaps
essentially every time it is observed.

## Why each step is load-bearing

**Why link before rename, rather than rename always.** `rename` replaces whatever it finds.
Using it unconditionally would let a starting daemon silently destroy a perfectly healthy
daemon's endpoint. `link` fails loudly with `EEXIST` instead, which forces the liveness question
to be asked. The exclusive link is also the kernel-enforced claim on the common path.

**Why rename and not unlink-then-link.** Unlink-then-link leaves the canonical name absent
between the two calls. Every concurrent observer — a client connecting, another daemon's
publish, the ownership watchdog — can land in that gap and draw a wrong conclusion. `rename` has
no gap.

**Why the liveness proof must be positive.** Three outcomes prove death (`ECONNREFUSED`,
`ENOTSOCK`, `ENOENT`); everything else, notably a timeout, does not. Collapsing "could not
classify" into "dead" is how a live daemon's endpoint gets deleted, and it is the single most
recurrent defect across all seven review rounds.

**Why the losing racer is usually harmless.** Two daemons can both prove the same dead entry
dead and both rename over it; the second wins. The loser detects it at step 5 and exits, and in
the ordinary case it is _still starting up with zero sessions_, so nothing is lost.

This is the crux. The redesign does not eliminate the race. It moves it to a point in the
lifecycle where losing it normally costs nothing.

**Where that stops being true, and what step 4 is for.** The claim above is not free. Without
step 4's re-check, a publisher could gather its death proof, stall arbitrarily long before
acting on it, and then rename over a daemon that had meanwhile published, started serving, and
acquired sessions. The victim would be an _established_ daemon, not a zero-session racer — the
original bug, reached through a narrow window. Step 4 exists precisely to reject a proof that no
longer describes the entry it was gathered about.

Step 4 shrinks that window; it does not close it. Two adjacent syscalls still separate the
re-check from the rename, and POSIX has no "rename only if the target is still inode X". Closing
it completely would require serialising the whole protocol behind a publication lock among
cooperating publishers. That is a real option if this ever proves reachable in the field, and it
is why `endpoint-publish-declined` is logged — but a two-syscall window is on the same order as
any lock-free protocol's residual, and paying for a lock now would add a stale-lock problem of
exactly the kind this design set out to remove.

**Why the departing daemon leaves its entry behind.** Deleting it requires fencing the delete
against a replacement that published in the meantime, which reintroduces observe-then-act — and
that fencing (`unlinkOwnedDaemonSocketPath`, the `.c<hex>` claim, `restoreClaimedDaemonSocketPath`)
accounted for roughly half of the defects found. A stale socket entry costs zero bytes in the
app's own runtime directory, and every startup already handles an occupied-but-dead name
natively via steps 2–4. Leaving it also makes the occupied path the _hot_ path, exercised on
every single start rather than only in rare races.

**Why the launcher's decisions stop being correctness-critical.** `killStaleDaemon` still kills
processes and still removes PID records fenced to the owner it killed. What it no longer does is
touch the endpoint. Because the publisher refuses to overwrite anything it cannot prove dead,
every launcher judgement about the endpoint degrades from a correctness dependency to a
performance hint. A launcher that guesses wrong now costs one extra probe, not a split brain.

## What this deletes

- `reclaimDeadDaemonSocketPath` and its five-way outcome type
- `unlinkOwnedDaemonSocketPath` and `restoreClaimedDaemonSocketPath`
- the `.c<hex>` claim protocol and the sweeper's recovery policy for it
- the endpoint-probe-and-reclaim tail of `killStaleDaemon`
- three unfenced `unlinkSync(socketPath)` calls in the launcher

Those last three are worth calling out. They were plain check-then-act — `existsSync` and then
an unlink of whatever is at the path — with no fencing at all, which is the original bug's exact
shape. Seven review rounds never surfaced them because every round was scoped to the health
checker and the ownership module, and these live in the launcher. They are reachable only on the
pre-`CLEAN_DISCONNECT` protocol path, so they bite during an upgrade from an old daemon — which
is precisely when a mixed-version race is most likely. Stating the invariant as a property of
the _system_ rather than of one module is what made them findable: under "only a publisher
mutates the entry", they are deletions with nothing to replace them.

## Why there is no fallback for filesystems without hard links

Step 2 requires `link` to work, and the previous rename-based fallback was deleted rather than
kept, so a filesystem that refuses hard links means the daemon does not start. That is a real
single point of failure and worth stating why it is acceptable.

The link's source is a Unix domain socket **we have just successfully bound in that same
directory**. A filesystem that can host a bound socket is one with full POSIX file semantics —
network filesystems that lack hard links generally refuse to create the socket at all, so the
bind in step 1 fails first and the link is never reached. The two failures are therefore not
independent: any filesystem that gets us to step 2 supports step 2.

The fallback also cannot be kept safely. It checked for an absent canonical name and then
renamed over it — check-then-act with an operation that replaces whatever it finds, so a daemon
publishing in that gap was silently overwritten and stranded. Requiring the link additionally
guarantees that publishing proves the filesystem supports the operation, rather than discovering
it later at a point where failing is worse.

If `link` does fail with something other than `EEXIST`, the error propagates and the daemon
fails to start cleanly. Terminals fall back to the local provider without daemon persistence —
a visible degradation, not a silent split brain.

## Platform notes

Windows named pipes are not directory entries, and a pipe name is exclusive to the process
holding it: a dead daemon's pipe simply ceases to exist. Steps 1–5 are therefore Unix-only by
construction, and `listen` on the canonical pipe name is the whole protocol. Every function here
returns early on `win32` rather than pretending to have a directory entry to reason about.

Unit CI shards run **ubuntu-latest only**. A test gated to darwin never executes in CI, so
platform gating in tests must be `skipIf(win32)` — never `skipIf` on anything that would also
exclude Linux, and never an early `return` that silently passes.

## Upgrades and mixed versions

Users update the app while a daemon from the previous version may still be running and hosting
live terminals, so both directions matter.

The socket path is protocol-scoped (`daemon-v<N>.sock`), so daemons at different protocol
versions never contend for a name at all. This change does not alter the protocol version, so
the interesting case is a same-protocol version mismatch:

- **Old daemon running, user upgrades.** If it is healthy the new app adopts it and nothing
  touches the entry. If it is not, the launcher kills it; the old daemon's own shutdown path
  removes its entry (old behaviour), and the new daemon's link then finds a free name. If it
  crashed instead, the new daemon proves the leftover dead and renames over it.
- **New daemon running, user downgrades.** The new daemon leaves its entry behind on exit. The
  old code's reclaim path exists precisely to clear a stale entry: it probes, gets
  `ECONNREFUSED`, unlinks, and forks. That path is the one being deleted going forward, but it
  still works in the old build.

Neither direction produces two live daemons or a daemon that cannot start.

**The already-affected user.** Someone sitting on two live daemons today — one owning the socket,
one hosting their sessions — is not rescued by this change specifically. The retirement watchdog
that makes the orphan stand down already shipped separately; this change is what stops the state
from being reachable again. Retirement also drains rather than kills, so an orphan holding a
shell that never exits can still linger. That is worth saying plainly rather than claiming this
change recovers them.

## Residual risk

Two starting daemons can interleave so that the loser briefly holds a live listener no name
resolves to. It exits at step 5, or failing that within one poll of the ownership watchdog. It
has no sessions, so nothing is lost.

The sharper residual is the one described under step 4: a publisher preempted between its
re-check and its `rename` can still replace an entry that changed hands in those two syscalls.
Unlike the pre-step-4 behaviour, this no longer widens with probe duration or scheduling delay,
so the victim is overwhelmingly likely to be another zero-session racer rather than an
established daemon. It is bounded rather than eliminated, and it is the honest limit of a
lock-free protocol here.
