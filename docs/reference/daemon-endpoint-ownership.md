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

1. **Bind a private name.** `.p<10 hex>` in the same directory. Same directory because
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

4. **Check the proof still describes the entry, ask once more whether anything is serving it,
   then replace it.** Re-`stat` the canonical path and compare against what was there when step 3
   began; if it changed hands, start the whole protocol over. Then probe again. Only if that
   still proves nothing is serving does `rename(bind, canonical)` run — one syscall, with **no
   instant at which the canonical name is absent**, so no client and no concurrent daemon can
   observe a gap.

   The second probe is there because the entry proved dead can be unlinked and its inode number
   handed straight back to a replacement, which then matches on `dev`+`ino` and looks like
   continuity. An earlier version used the file's birth time to separate those. That cannot be
   relied on: Node documents the field as sometimes holding the ctime, filesystems without a
   birth time report the epoch, and granularity is often coarser than the events it would have to
   separate — measured on overlayfs, entries created at visibly different moments reported an
   identical birth time. Three attempts to patch around those produced three further defects.
   Whether something is _serving_ is the property that actually matters, and connecting answers
   it directly, so that is what the protocol asks.

5. **Verify we kept it.** `stat` the canonical path and compare against the identity of the
   inode we bound. If it is not ours, another daemon replaced us in the microseconds after our
   rename — exit immediately, before accepting a single connection. If the `stat` itself fails,
   **decline**: `ENOENT` means the name we took is gone, and any other error means we cannot
   show we are reachable. A starting daemon has no sessions to protect, so declining costs
   nothing, while serving a name that resolves elsewhere is the entire bug.

   `dev`+`ino` is the whole identity, here and everywhere in this file. Our own listener holds
   the inode open, so the kernel cannot recycle its number while we are asking.

   The identity recorded at this step is the one read **after** publishing, not the one read
   before it. That matters because this value is what the ownership watchdog later compares the
   entry against, and that comparison does include `birthtimeMs` — which Node documents as
   sometimes holding the ctime instead, on Linux kernels without `statx`. `link` and `rename`
   both bump ctime, so a pre-publish reading could never match again on such a host, and the
   daemon would declare itself lost on its first session and stand down permanently. Invisible on
   APFS and on CI, which is why it is asserted by a test that simulates the ctime fallback.

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
that fencing — a claim-by-rename, a liveness probe, and a restore path —
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

Against `origin/main`, this removes:

- the endpoint-probe-and-reclaim tail of `killStaleDaemon` — the launcher no longer touches the
  endpoint at all
- three unfenced `unlinkSync(socketPath)` calls in the launcher
- `unlinkOwnedDaemonSocketPath`, and with it the removal of the endpoint at shutdown
- the aged-scratch-name sweeper

Those three unfenced unlinks are worth calling out. They were plain check-then-act — `existsSync`
and then an unlink of whatever is at the path — with no fencing at all, which is the original
bug's exact shape. Seven review rounds never surfaced them because every round was scoped to the
health checker and the ownership module, and these live in the launcher. One of them runs over
every previous protocol version on every app start. Stating the invariant as a property of the
_system_ rather than of one module is what made them findable.

## Filesystems without hard links

Step 2 needs `link` for its exclusivity, and some POSIX and FUSE filesystems accept a bound Unix
socket and `rename` while refusing hard links. Requiring the link there would mean no daemon
persistence at all, which is a capability the previous implementation had — so a `link` failure
that means _this filesystem cannot do it_ (`EPERM`, `EOPNOTSUPP`, `ENOTSUP`, `ENOSYS`) falls back
to publishing by replacement.

The fallback runs the rest of the protocol unchanged: the death proof, the continuity re-check
and the post-publish verification all still apply. Only `link`'s exclusivity is lost, and step 5
is what covers its absence — two publishers can both replace an absent name, and the loser finds
out immediately. An earlier version of this design deleted this fallback because the version it
inherited was a bare "if absent, rename" with nothing verifying the result. That objection was
correct then and does not apply now.

Any other `link` failure still propagates. `ENOSPC` or `EIO` must surface rather than silently
downgrade to a replace, and a test pins that boundary.

Note that absent-then-absent counts as a stable entry **only** on this path. Where an entry
demonstrably existed, two unreadable reads prove nothing and must not authorise a rename — the
continuity check takes that as a parameter rather than a global rule, and reads the directory
entry with `lstat` so a dangling symlink is seen as occupying the name rather than as absent.

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

## What a daemon does after it loses the endpoint

The race above means a serving daemon can find that the canonical name no longer resolves to it.
Four rules govern what happens then. They are stated together here because they were arrived at
one at a time, and every defect in this area came from an interaction between them rather than
from any one being wrong.

1. **Loss is remembered, and never un-remembered.** A later client completing its handshake used
   to cancel a pending retirement. It must not cancel this one: a client that connected before
   the takeover cannot make the daemon reachable again, and treating it as re-ownership reopens
   session creation on a daemon nothing can find.

2. **No new session is created on an endpoint we do not hold.** This is what makes the race
   harmless rather than merely narrow. A session accepted after loss would be reachable by
   nobody, which is the original bug.

3. **Attaching is still allowed.** An attach reaches a session already here, over a connection
   already established. Refusing it would break the drain, and it strands nothing.

4. **Once drained, it stands down — without waiting for its clients.** Idleness normally waits
   for every connection to close. After loss it must not: a pre-takeover client can hold one open
   indefinitely, and the daemon would outlive its last session as an orphan. Live sessions and
   in-flight creates still hold it open, so it never exits out from under real work.

Only positive evidence triggers any of this. An unreadable stat leaves the daemon serving,
because treating `EACCES` as loss would take down a daemon hosting every terminal on the machine.

The two detectors deliberately use different bars. The watchdog wants two _consecutive_ losses
before retiring a daemon that is still serving; admission refuses on a single observation,
because there the cost of waiting is a session nobody can reach, and publishing by `rename` is
gapless so there is no transient-absence window to guard against. Only the streak accounting is
shared between them, so a positive reading through either path breaks the run.

The refusal in rule 2 is a shared constant the client's retry predicate recognises, so the caller
reconnects to whoever owns the endpoint instead of surfacing an error. Rule 4 means that refusal
can begin a shutdown in the same call that sends it; the reply still reaches the client, and a
test pins that.

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
that leaves the claimant unable to restore what it took, and losing the token stops new clients
authenticating at all. Their age gate is weaker than it looks, too — `rename` carries the
original mtime across, so a claim on an already-old record is immediately sweep-eligible rather
than protected for an hour.

A test pins all three namespaces against the released regex, so reintroducing any of them fails
in CI rather than in the field.

## Nothing sweeps anyone else's leftovers

The endpoint is not the only name this component creates. Publishing binds a private `.p<hex>`
socket, and the PID/token claim protocol renames artifacts aside as `.swap-*`/`.hold-*`.
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

Step 4 ends with a probe and then a `rename`, and those are two syscalls. A publisher preempted
between them can resume and replace an entry that went live in the gap. The victim is **not**
necessarily a zero-session racer: if A published, verified, armed, and accepted a terminal in that gap, then B's rename
destroys A's directory entry. B then fails its own exclusive PID publish — A already holds it —
and aborts, leaving the canonical name pointing at B's dead socket. A stays alive with the user's
terminal but is unreachable until the ownership watchdog retires it, and the user's session is
stranded in the meantime. That is the original symptom reached through a much narrower window.

The window requires B to lose the CPU between two adjacent syscalls for long enough that A
completes publish, PID, token, arm, accept, and PTY spawn. It is small but not zero, and calling
it harmless was overclaiming.

**What the second probe bought, precisely.** Not a smaller window — the gap between the last
check and the `rename` is the same one syscall either way. What changed is that the check inside
it became sound. The birth-time comparison it replaced could fail to notice a replacement that
had _already_ arrived, because the field it compared is unreliable; the probe cannot, because it
asks whether anything is serving rather than inferring it from metadata. So the residual is now
genuinely just the one-syscall preemption above, rather than that plus an unknown rate of missed
detections.

It also costs almost nothing. The second probe runs only after the first proved the entry dead,
and a dead endpoint refuses immediately — measured at ~0.02 ms — so the 500 ms budget is not
doubled on any ordinary start. An unresponsive endpoint returns `unknown` from the first probe
and declines before the second is ever reached.

**Why the obvious fix is worse.** Publishing the exclusive PID record _before_ the rename looks
like the answer — it is already an `O_EXCL` mutual exclusion, so a preempted B would fail it on
resume and never reach its rename. But it makes the daemon a target while it is still starting: a
concurrent `killStaleDaemon` reads the fresh record, finds the process alive and the identity
matching, and SIGTERMs a daemon that is mid-publish. That trades a narrow race for a worse one.

**What is done instead: make the harm unreachable rather than the race impossible.** The race
only damages anything because the loser might be hosting a session nobody can reach. So no
session is ever created on an endpoint this daemon does not currently hold — `createOrAttach`
checks ownership first, refuses if the endpoint demonstrably resolves elsewhere, and stands the
daemon down. A late publisher can still overwrite us; we simply never accept a session we cannot
keep, and the client reconnects to whoever owns the name.

Two things narrow it further, and both are pinned by tests. Only positive evidence refuses — an
unreadable stat leaves the daemon serving, because treating `EACCES` as loss would take a healthy
daemon hosting every terminal on the machine offline. And only _creation_ is refused: an attach
reaches a session this daemon already hosts over a connection that already exists, so it strands
nothing, and refusing it would break the drain a retiring daemon depends on to let live sessions
finish.

The cost is one `stat` per session creation — per terminal, not per keystroke. What remains is
that a starting daemon can still lose the name to a preempted publisher, but it has no sessions
to strand at that point, which is the property the earlier text wrongly claimed for every case.

**What cannot be fixed from this branch.** An already-released build's stale cleanup unlinks the
canonical socket on the strength of an earlier kill result, even when its own probe just
connected. A new daemon publishing during that window has its live socket deleted by shipped
code. It is reachable only while two versions run concurrently, it exists old-against-old too,
and no change here can fence a process that is already deployed. Landing this is what stops the
behaviour going forward.
