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

### What the occupied path costs

Because a departing daemon leaves its entry behind, `EEXIST` is the ordinary case rather than
the rare one, so step 3's probe runs on nearly every start. That probe has a 500 ms timeout,
which would be a poor thing to pay at startup — so it was measured rather than assumed:

| entry occupying the name       | p50                            | p99            | max            |
| ------------------------------ | ------------------------------ | -------------- | -------------- |
| dead socket (the steady state) | 0.03 ms darwin / 0.02 ms linux | 0.40 / 0.71 ms | 0.99 / 1.22 ms |
| regular file                   | 0.02 / 0.01 ms                 | 0.09 / 0.05 ms | 0.09 / 0.05 ms |
| dangling symlink               | 0.03 / 0.01 ms                 | 0.14 / 0.09 ms | 0.14 / 0.09 ms |

The timeout is never reached in any of these: a dead endpoint refuses immediately rather than
hanging. The 500 ms budget exists for a genuinely unresponsive host, where waiting is correct —
and where the outcome is `inconclusive`, which declines rather than replaces.

### A planted symlink cannot be turned into a write primitive

Leaving the entry on disk means a hostile local process could try to plant something at the
canonical name. Measured on darwin and linux, with a symlink pointing at a live socket that
does not belong to us:

- `link` refuses it (`EEXIST`), so the name is never silently taken.
- The probe follows the symlink, finds the target alive, and reports `occupied` — so a
  publisher will not clobber a socket that is still serving, even someone else's.
- Once the target is dead, `rename` replaces **the symlink itself**, not its target. This is the
  load-bearing property: `rename` does not follow symlinks, so there is no path by which
  publishing writes through an attacker-chosen link into an attacker-chosen location.
- The symlink's target is left byte-for-byte alone throughout.

The runtime directory is inside the user's own `userData`, so this is defence in depth rather
than a reachable threat, but the primitive is worth knowing is absent.

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

## Crash debris

A crash between step 1 and step 4 leaves a `.p<hex>` bind name behind. Publishing consumes that
name — by `unlink` after a successful link, or by the `rename` itself — and libuv removes it when
a daemon closes cleanly, so one that outlives its owner is debris.

Nothing collects it. The reasoning, and the measured cost of not collecting it, are below under
"Nothing sweeps anyone else's leftovers".

### Every scratch namespace had to move, not just the sweeper

Removing our own sweeper does not un-ship the one already in the field. Released builds sweep
`^\.b[0-9a-f]{10}$` and `\.(?:cleanup|replace)-\d+-<uuid>$` on age alone, with no liveness or
ownership check, before they adopt or launch. So every name this code creates that an old build
would match had to move out of their pattern:

| was                      | now                   | what an old build could otherwise destroy                 |
| ------------------------ | --------------------- | --------------------------------------------------------- |
| `.b<hex>`                | `.p<hex>`             | a paused daemon's only pathname, between bind and publish |
| `*.replace-<pid>-<uuid>` | `*.swap-<pid>-<uuid>` | the only copy of a live daemon's PID record, mid-claim    |
| `*.cleanup-<pid>-<uuid>` | `*.hold-<pid>-<uuid>` | the only copy of a live daemon's token, mid-claim         |

The claim cases are the sharper ones: a claim exists precisely because the protocol has renamed
the canonical artifact aside and holds the sole copy while validating it. An old build deleting
that leaves the claimant unable to restore what it took. A test pins all three namespaces against
the released regex, so reintroducing any of them fails in CI rather than in the field.

**What this cannot fix.** An already-released build's own stale-cleanup can still delete a socket
or PID record that a new daemon published during its kill window — it removes whatever occupies
the path rather than what it proved dead. That behaviour is in shipped code, reachable only while
two versions run concurrently, and it exists old-against-old too. Nothing in this branch can fence
a process that is already deployed; landing this is what stops the behaviour going forward.

## Platform notes

Windows named pipes are not directory entries, and a pipe name is exclusive to the process
holding it: a dead daemon's pipe simply ceases to exist. Steps 1–5 are therefore Unix-only by
construction, and `listen` on the canonical pipe name is the whole protocol. Every function here
returns early on `win32` rather than pretending to have a directory entry to reason about.

Unit CI shards run **ubuntu-latest only**. A test gated to darwin never executes in CI, so
platform gating in tests must be `skipIf(win32)` — never `skipIf` on anything that would also
exclude Linux, and never an early `return` that silently passes.

## What declining actually costs the user

Three of the four publish outcomes decline to serve: `occupied`, `lost`, and `inconclusive`.
Since `inconclusive` is also what exhausting the retry bound reports, it is worth stating where
that lands rather than leaving it as an abstract status.

`occupied` is the good case — the launcher adopts the incumbent, and the user gets the daemon
that is already running. `lost` and `inconclusive` fail the daemon's startup, which is caught at
the startup-service boundary and reported; the app keeps the local PTY provider it already had.
The user gets working terminals without daemon persistence, and the next launch tries again.

That is the same degradation the app already falls back to for any other daemon startup failure,
and it is the reason declining is cheap: the failure mode of being too cautious is terminals that
work but do not survive an app restart, while the failure mode of being too eager is terminals
that acknowledge input and never run it.

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

## Nothing sweeps anyone else's leftovers

The endpoint is not the only name this component creates. Publishing binds a private `.b<hex>`
socket, and the PID/token claim protocol renames artifacts aside as `.cleanup-*`/`.replace-*`.
A sweeper used to reclaim those by age.

It is gone. Deciding whether someone else's leftover is safe to delete is the same question this
design retired for the endpoint, and answering it produced the same defects in miniature: it
deleted a live listener's only pathname when a probe merely timed out, and — because `rename`
carries the original mtime across — it deleted a healthy daemon's ownership record while the
process that had claimed it was still validating. Five findings across two review rounds, every
one of them in the sweeper, none in the publish protocol.

The invariant extends to cover it:

> **No actor removes a name it did not create.**

The same reasoning covers the one dead endpoint stranded per protocol generation. Sweeping it
would mean deleting an endpoint on a liveness judgement about another daemon, and an old-protocol
daemon can still be live during an upgrade.

### What that costs, measured

Two things were initially claimed here that are not true, and the corrected versions are the
honest case for the trade rather than a tidier one.

**The directory is still enumerated.** `collectPinnedDaemonVersions` calls `readdirSync` on the
runtime directory on every launch. It matches `/^daemon-v\d+\.pid$/` exactly, so leftovers are
never mistaken for real artifacts — but they are still traversed. Measured on APFS with the same
call shape: 10k entries scan in 5.2 ms, 100k in 59 ms.

**Leftovers are not "a few bytes", and not only from crashes.** A claim file occupies a 4 KiB
block; 10k of them is ~40 MB. And `replaceDaemonPidFile` and `claimAndUnlinkOwnedFile` both
deliberately tolerate a failed unlink, so a _non-crash_ shutdown on Windows can leave a claim
behind when an AV scanner or indexer holds a delete-share lock — a case the code explicitly
anticipates. So this is slow accumulation, not a crash-only phenomenon.

At plausible rates the cost stays small. Reaching hundreds of megabytes and tens of milliseconds
of scan per launch needs on the order of 100–1000 leaked claims per day sustained for years,
which is a stress bound rather than an observed rate. Against that sits a mechanism with a
demonstrated ability to delete a running process's files. The trade still favours removal, but it
is a real cost rather than none.

**Bind-name collision is bounded and self-correcting.** Names are 40 bits of randomness. Among
leaked names the birthday probability is 0.0006% at 1 leak/day over ten years and 0.06% at
10/day; it only becomes material in the thousands-per-day regime, which requires repeatedly
killing a daemon inside the narrow bind-to-publish window rather than any ordinary crash. A
collision fails one `listen` and the next launch draws again — it does not persist.

If accumulation ever proves real in the field, the answer is an intrinsically fenced scheme where
a leftover carries proof of who may remove it, not a sweeper that guesses.

## Residual risk

Two starting daemons can interleave so the loser briefly holds a live listener no name resolves
to. It exits at step 5, or within one poll of the ownership watchdog. It has no sessions, so
nothing is lost.

### The step 4 window, stated properly

Earlier versions of this document said the loser of a publish race is always a starting daemon
with no sessions. That is wrong, and it is worth being precise about why, because it is the
sharpest thing known about this design.

Step 4's re-check and its `rename` are two syscalls. A publisher preempted between them can
resume and replace an entry it never probed. The victim is **not** necessarily a zero-session
racer: if A published, verified, armed, and accepted a terminal in that gap, then B's rename
destroys A's directory entry. B then fails its own exclusive PID publish — A already holds it —
and aborts, leaving the canonical name pointing at B's dead socket. A stays alive with the user's
terminal but is unreachable until the ownership watchdog retires it, and the user's session is
stranded in the meantime. That is the original symptom reached through a much narrower window.

The window requires B to lose the CPU between two adjacent syscalls for long enough that A
completes publish, PID, token, arm, accept, and PTY spawn. It is small but not zero, and calling
it harmless was overclaiming.

**The fix, not yet applied.** Publish the exclusive PID record _before_ the endpoint rename rather
than after. That record is already an atomic mutual exclusion — `open` with `O_EXCL` — so a
preempted B would fail it on resume and never reach its rename, leaving A intact. It reuses a
primitive the design already depends on instead of inventing a lock. It is a real reordering of
the startup sequence and wants its own review and a test that pauses a publisher between the
re-check and the rename, which is why it is recorded here rather than done in passing.

**What cannot be fixed from this branch.** An already-released build's stale cleanup unlinks the
canonical socket on the strength of an earlier kill result, even when its own probe just
connected. A new daemon publishing during that window has its live socket deleted by shipped
code. It is reachable only while two versions run concurrently, it exists old-against-old too,
and no change here can fence a process that is already deployed. Landing this is what stops the
behaviour going forward.
