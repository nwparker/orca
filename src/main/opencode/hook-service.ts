/* eslint-disable max-lines -- Why: holds an inline JS plugin source emitted as one file; splitting across TS modules would scatter tightly coupled string-template logic. */
import { app } from 'electron'
import { join } from 'node:path'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { createHash } from 'node:crypto'
import { mirrorEntry, safeRemoveTree } from '../pty/overlay-mirror'

const ORCA_OPENCODE_PLUGIN_FILE = 'orca-opencode-status.js'
const OPENCODE_LEGACY_HOOKS_DIR = 'opencode-hooks'
const OPENCODE_OVERLAY_DIR = 'opencode-config-overlays'
const OPENCODE_SHARED_CONFIG_DIR = 'shared'
const OPENCODE_OVERLAY_MANIFEST_FILE = '.orca-opencode-overlay-manifest.json'

type OpenCodeOverlayManifest = {
  topLevelEntries: string[]
  pluginEntries: string[]
}

// Why: bounds-check only — the id is a daemon sessionId with path separators, hashed downstream to a filesystem-safe name (an old regex rejecting "/"/":" broke every such id, #1148); 1024 just caps pathological hash input.
function isUsableId(id: string): boolean {
  return typeof id === 'string' && id.length > 0 && id.length <= 1024
}

function toSafeDirName(id: string): string {
  // Why: 32 hex chars (128 bits) makes collisions negligible and stays filesystem-portable (no base64 padding or `/`).
  return createHash('sha256').update(id).digest('hex').slice(0, 32)
}

export function getOpenCodePluginSource(): string {
  return getOpenCodeFamilyPluginSource('/hook/opencode')
}

export function getOpenCodeFamilyPluginSource(hookPathname: string): string {
  // Why: plugin runs in OpenCode's Node process and POSTs Orca's ORCA_* PTY env to the shared agent-hooks server; events are mapped plugin-side to fit the server's per-case switch.
  return [
    '// Why: process-lifetime guard so a recurring parse error on a malformed',
    "// endpoint file does not spam OpenCode's stderr once per hook post.",
    '// This guard lives inside the plugin source because the plugin runs in',
    "// OpenCode's Node process (not Orca's) and has no access to server.ts's",
    '// equivalent warnedVersions / warnedEnvs Sets.',
    'let warnedBadEndpoint = false;',
    '',
    '// Why: message.part.updated can fire many times per second during a',
    '// streaming assistant reply, and each post() calls resolveHookCoords()',
    '// which reads the endpoint file. The file only changes on Orca restart',
    '// (rare), so a stat+mtime check is substantially cheaper than a full',
    '// readFileSync+parse on every streamed part. On stat error we fall',
    '// through to parse so the fail-open behavior is preserved.',
    'let cachedEndpointKey = "";',
    'let cachedEndpointValues = null;',
    '',
    'function readEndpointFile() {',
    '  const path = process.env.ORCA_AGENT_HOOK_ENDPOINT;',
    '  if (!path) return null;',
    '  try {',
    '    const fs = require("fs");',
    '    try {',
    '      const stat = fs.statSync(path);',
    '      // Why: cache key combines mtime + size + inode. renameSync (used by',
    '      // writeEndpointFile on the Orca side) allocates a fresh inode on',
    '      // POSIX and a new Windows file ID on NTFS, so ino changes on every',
    '      // legitimate rewrite even when mtimeMs resolution is coarse and size',
    '      // happens to match.',
    '      const cacheKey = stat.mtimeMs + ":" + stat.size + ":" + stat.ino;',
    '      if (cacheKey === cachedEndpointKey && cachedEndpointValues) {',
    '        return cachedEndpointValues;',
    '      }',
    '      const contents = fs.readFileSync(path, "utf8");',
    '      const out = {};',
    '      for (const line of contents.split(/\\r?\\n/)) {',
    '        // Why: Windows endpoint.cmd uses `set KEY=VALUE`; Unix endpoint.env',
    '        // uses `KEY=VALUE`. Making `set ` optional lets the same parser',
    '        // handle both without platform detection in the plugin. Allow',
    '        // digits in the key for forward-compat with future ORCA_AGENT_HOOK_*',
    '        // names that may contain numerics, and strip a trailing CR so',
    '        // mixed-EOL files with lone `\\r` do not leak CR into the value.',
    '        const m = line.match(/^(?:set\\s+)?([A-Z0-9_]+)=(.*)$/);',
    '        if (m) out[m[1]] = m[2].replace(/\\r$/, "");',
    '      }',
    '      cachedEndpointKey = cacheKey;',
    '      cachedEndpointValues = out;',
    '      return out;',
    '    } catch (ioErr) {',
    '      // Why: any stat or read failure (file yanked mid-read, permission',
    '      // race, unlink between stat and readFileSync) must invalidate the',
    '      // cache so a transient failure does not lock in a stale parse for',
    '      // the remaining process lifetime; rethrow to the outer catch.',
    '      cachedEndpointKey = "";',
    '      cachedEndpointValues = null;',
    '      throw ioErr;',
    '    }',
    '  } catch (err) {',
    '    // Why: warn once per process if the file exists but is unreadable or',
    '    // malformed — a persistent, silently-swallowed parse error would',
    '    // otherwise leave the plugin falling back to stale process.env on',
    '    // every post with no signal. ENOENT / missing env var is the normal',
    '    // pre-install case; stay silent for it.',
    '    if (err && err.code !== "ENOENT" && !warnedBadEndpoint) {',
    '      warnedBadEndpoint = true;',
    '      console.warn("[orca-hook] failed to parse endpoint file:", err.message);',
    '    }',
    '    return null;',
    '  }',
    '}',
    '',
    'function resolveHookCoords() {',
    '  // Why: prefer the on-disk endpoint file over process.env because env was',
    '  // frozen when OpenCode was fork()ed — stale after an Orca restart. The',
    '  // file is rewritten on every Orca start(), so sourcing it per post lets',
    '  // a long-running OpenCode session reach the current server. Falls back',
    '  // to process.env when the file is absent (first-run / pre-endpoint-file / Orca',
    '  // never started writing the file).',
    '  const fileEnv = readEndpointFile() || {};',
    '  return {',
    '    port: fileEnv.ORCA_AGENT_HOOK_PORT || process.env.ORCA_AGENT_HOOK_PORT,',
    '    token: fileEnv.ORCA_AGENT_HOOK_TOKEN || process.env.ORCA_AGENT_HOOK_TOKEN,',
    '    env: fileEnv.ORCA_AGENT_HOOK_ENV || process.env.ORCA_AGENT_HOOK_ENV || "",',
    '    version: fileEnv.ORCA_AGENT_HOOK_VERSION || process.env.ORCA_AGENT_HOOK_VERSION || "",',
    '  };',
    '}',
    '',
    'function hookEndpointKey() {',
    '  const coords = resolveHookCoords();',
    '  return [coords.port || "", coords.token || "", coords.env, coords.version].join("\\u0000");',
    '}',
    '',
    'function getStatusType(event) {',
    '  return event?.properties?.status?.type ?? event?.status?.type ?? null;',
    '}',
    '',
    'const HOOK_POST_TIMEOUT_MS = 2000;',
    'const SESSION_LOOKUP_TIMEOUT_MS = 2000;',
    'const STATUS_RETRY_BASE_MS = 500;',
    'const STATUS_RETRY_MAX_MS = 30000;',
    'let desiredStatus = "idle";',
    'let desiredHookEventName = "SessionIdle";',
    'let desiredStatusKey = "idle:";',
    'let desiredStatusProperties = {};',
    'let desiredFactoryID = null;',
    'let deliveredStatusKey = "idle:";',
    'let deliveredEndpointKey = "";',
    'let statusDeliveryDirty = false;',
    'let statusRevision = 0;',
    'let statusRetryAttempt = 0;',
    'let statusRetryTimer = null;',
    'let lifecycleQueue = Promise.resolve();',
    'let busyRecoveryQueued = false;',
    'let busyRecoveryUsed = false;',
    'let busyRecoveryEndpointKey = "";',
    'let stateArrivalRevision = 0;',
    '// Why: OpenCode can create directory-scoped factories and concurrent root',
    '// sessions in one pane; module ownership lets waiting/busy aggregate safely.',
    'let nextFactoryID = 0;',
    'const activeFactoryIDs = new Set();',
    'const disposingFactoryIDs = new Set();',
    'const busyRootOwnerBySessionID = new Map();',
    'const pendingAttentionByKey = new Map();',
    'const childSessionById = new Map();',
    'const childSessionLookupById = new Map();',
    '',
    '// Why: message.part.updated re-sends the FULL accumulated text of the part',
    '// after every streamed append, so posting each event forwards O(n^2) bytes',
    '// per turn through Orca (loopback HTTP -> main JSON parse -> status compare',
    '// -> IPC -> renderer store update -> React commit). On Windows that flood',
    '// saturated both event loops and froze the whole UI a few seconds into a',
    '// streaming reply. The dashboard only needs a bounded preview at a human',
    '// cadence: cap the text and trailing-edge coalesce assistant parts.',
    'const MESSAGE_PART_THROTTLE_MS = 250;',
    'const MESSAGE_PART_MAX_CHARS = 4000;',
    'let pendingAssistantPart = null;',
    'let assistantPartFlushTimer = null;',
    'let messagePartPostInFlight = null;',
    'let deliveredMessagePartFactoryID = null;',
    'let lastAssistantPartPostAt = 0;',
    '',
    'function capMessagePartText(text) {',
    '  return text.length > MESSAGE_PART_MAX_CHARS ? text.slice(0, MESSAGE_PART_MAX_CHARS) : text;',
    '}',
    '',
    'async function postMessagePart(properties, factoryID) {',
    '  while (messagePartPostInFlight) await messagePartPostInFlight;',
    '  const delivery = post("MessagePart", properties);',
    '  messagePartPostInFlight = delivery;',
    '  try {',
    '    const delivered = await delivery;',
    '    if (delivered) deliveredMessagePartFactoryID = factoryID;',
    '  } finally {',
    '    if (messagePartPostInFlight === delivery) messagePartPostInFlight = null;',
    '  }',
    '}',
    '',
    'async function flushPendingAssistantPart(force = false) {',
    '  if (assistantPartFlushTimer) {',
    '    clearTimeout(assistantPartFlushTimer);',
    '    assistantPartFlushTimer = null;',
    '  }',
    '  // Why: an idle/waiting transition must wait for every older preview;',
    '  // keep one post in flight while later snapshots coalesce in memory.',
    '  while (messagePartPostInFlight) await messagePartPostInFlight;',
    '  const pending = pendingAssistantPart;',
    '  pendingAssistantPart = null;',
    '  if (!pending) return;',
    '  if (',
    '    !activeFactoryIDs.has(pending.factoryID) ||',
    '    disposingFactoryIDs.has(pending.factoryID)',
    '  ) return;',
    '  if (!force && pending.authorityRevision !== stateArrivalRevision) return;',
    '  lastAssistantPartPostAt = Date.now();',
    '  await postMessagePart({',
    '    role: pending.role,',
    '    text: capMessagePartText(pending.text),',
    '    messageID: pending.messageID,',
    '    sessionID: pending.sessionID,',
    '  }, pending.factoryID);',
    '}',
    '',
    'function queueAssistantPart(part) {',
    '  // Why: keep only the latest snapshot — each event already contains the',
    '  // full accumulated text, so intermediate snapshots are pure waste.',
    '  pendingAssistantPart = part;',
    '  const sinceLastPost = Date.now() - lastAssistantPartPostAt;',
    '  if (sinceLastPost >= MESSAGE_PART_THROTTLE_MS) {',
    '    void flushPendingAssistantPart();',
    '    return;',
    '  }',
    '  if (!assistantPartFlushTimer) {',
    '    assistantPartFlushTimer = setTimeout(() => {',
    '      void flushPendingAssistantPart();',
    '    }, MESSAGE_PART_THROTTLE_MS - sinceLastPost);',
    '    if (assistantPartFlushTimer.unref) assistantPartFlushTimer.unref();',
    '  }',
    '}',
    '',
    '// Why: message.part.updated fires for every Part (text, tool, reasoning)',
    '// but does not include the message role — that lives on the parent',
    '// message.updated event. Cache the role per messageID so the plugin can',
    '// tag a TextPart as user vs assistant when POSTing. Capped at 128 entries',
    '// so long-running sessions do not grow this map unboundedly.',
    'const messageRoleById = new Map();',
    'function rememberMessageRole(messageID, role) {',
    '  if (!messageID || !role) return;',
    '  if (messageRoleById.size >= 128) {',
    '    const first = messageRoleById.keys().next().value;',
    '    if (first !== undefined) messageRoleById.delete(first);',
    '  }',
    '  messageRoleById.set(messageID, role);',
    '}',
    '',
    '// Why: oh-my-opencode style tools spawn child sessions that emit their',
    '// own session.idle / message events. Those child completions must not',
    '// flip the root Orca pane to done or overwrite the parent turn preview.',
    '// Detect child sessions by checking `parentID` via client.session.list(),',
    '// cache completed and in-flight lookups, and fail closed on errors/timeouts',
    '// so a bad SDK request cannot false-complete or deadlock every later event.',
    'async function isChildSession(client, sessionID) {',
    '  if (!sessionID) return true;',
    '  if (childSessionById.has(sessionID)) return childSessionById.get(sessionID);',
    '  if (!client?.session?.list) return null;',
    '  if (childSessionLookupById.has(sessionID)) return childSessionLookupById.get(sessionID);',
    '  const lookup = lookupChildSession(client, sessionID);',
    '  childSessionLookupById.set(sessionID, lookup);',
    '  try {',
    '    return await lookup;',
    '  } finally {',
    '    if (childSessionLookupById.get(sessionID) === lookup) {',
    '      childSessionLookupById.delete(sessionID);',
    '    }',
    '  }',
    '}',
    '',
    'async function lookupChildSession(client, sessionID) {',
    '  const controller = new AbortController();',
    '  let timeout;',
    '  const deadline = new Promise((_, reject) => {',
    '    timeout = setTimeout(() => {',
    '      controller.abort();',
    '      reject(new Error("session lookup timed out"));',
    '    }, SESSION_LOOKUP_TIMEOUT_MS);',
    '    if (timeout.unref) timeout.unref();',
    '  });',
    '  try {',
    '    const sessions = await Promise.race([',
    '      lookupSessionList(client, sessionID, controller.signal),',
    '      deadline,',
    '    ]);',
    '    const list = Array.isArray(sessions?.data) ? sessions.data : [];',
    '    const session = list.find((entry) => entry?.id === sessionID);',
    '    if (!session) return null;',
    '    const isChild = !!session?.parentID;',
    '    if (childSessionById.size >= 128) {',
    '      const first = childSessionById.keys().next().value;',
    '      if (first !== undefined) childSessionById.delete(first);',
    '    }',
    '    childSessionById.set(sessionID, isChild);',
    '    return isChild;',
    '  } catch {',
    '    return null;',
    '  } finally {',
    '    clearTimeout(timeout);',
    '  }',
    '}',
    '',
    'async function lookupSessionList(client, sessionID, signal) {',
    '  // Why: point lookup avoids the SDK list page dropping older children;',
    '  // current SDKs put AbortSignal in a second options argument, while legacy',
    '  // generated clients accept one request-options object.',
    '  if (client?.session?.get) {',
    '    const calls = client.session.get.length >= 2',
    '      ? [',
    '          [{ sessionID }, { signal }],',
    '          [{ path: { id: sessionID }, signal }],',
    '        ]',
    '      : [[{ path: { id: sessionID }, signal }]];',
    '    for (const args of calls) {',
    '      try {',
    '        const result = await client.session.get(...args);',
    '        if (result?.data?.id === sessionID) return { data: [result.data] };',
    '      } catch {',
    '        if (signal.aborted) throw new Error("session lookup aborted");',
    '        // Try the other supported SDK generation, then list fallback.',
    '      }',
    '    }',
    '  }',
    '  if (client.session.list.length >= 2) {',
    '    return client.session.list({}, { signal });',
    '  }',
    '  return client.session.list({ signal });',
    '}',
    '',
    'async function post(hookEventName, extraProperties) {',
    '  // Why: resolve coords per post — the endpoint file may have been',
    '  // rewritten by a newer Orca since the last call. Pane/tab/worktree IDs',
    '  // stay on process.env because they are per-PTY (stable for the life of',
    '  // the OpenCode process), not per-Orca-instance.',
    '  const coords = resolveHookCoords();',
    '  const paneKey = process.env.ORCA_PANE_KEY;',
    '  if (!coords.port || !coords.token || !paneKey) return false;',
    `  const url = \`http://127.0.0.1:\${coords.port}${hookPathname}\`;`,
    '  const body = JSON.stringify({',
    '    paneKey,',
    '    launchToken: process.env.ORCA_AGENT_LAUNCH_TOKEN || "",',
    '    tabId: process.env.ORCA_TAB_ID || "",',
    '    worktreeId: process.env.ORCA_WORKTREE_ID || "",',
    '    env: coords.env,',
    '    version: coords.version,',
    '    payload: { hook_event_name: hookEventName, ...(extraProperties || {}) },',
    '  });',
    '  const controller = new AbortController();',
    '  const timeout = setTimeout(() => controller.abort(), HOOK_POST_TIMEOUT_MS);',
    '  if (timeout.unref) timeout.unref();',
    '  try {',
    '    const response = await fetch(url, {',
    '      method: "POST",',
    '      headers: {',
    '        "Content-Type": "application/json",',
    '        "X-Orca-Agent-Hook-Token": coords.token,',
    '      },',
    '      body,',
    '      signal: controller.signal,',
    '    });',
    '    return response.ok;',
    '  } catch {',
    '    // Why: OpenCode session events must never fail the agent run just',
    '    // because Orca is unavailable or the local loopback request failed.',
    '    return false;',
    '  } finally {',
    '    clearTimeout(timeout);',
    '  }',
    '}',
    '',
    'function enqueueLifecycle(task) {',
    '  // Why: OpenCode intentionally fire-and-forgets hook promises, so async',
    '  // lookups and posts need their own FIFO to preserve event order.',
    '  const run = lifecycleQueue.then(async () => {',
    '    try {',
    '      await task();',
    '    } catch {',
    '      // Hook delivery must never reject into OpenCode.',
    '    }',
    '  });',
    '  lifecycleQueue = run;',
    '  return run;',
    '}',
    '',
    'function clearStatusRetry() {',
    '  if (statusRetryTimer) clearTimeout(statusRetryTimer);',
    '  statusRetryTimer = null;',
    '}',
    '',
    'function scheduleStatusRetry(revision) {',
    '  if (',
    '    statusRetryTimer ||',
    '    revision !== statusRevision ||',
    '    !statusDeliveryDirty ||',
    '    !activeFactoryIDs.has(desiredFactoryID)',
    '  ) return;',
    '  const delay = Math.min(',
    '    STATUS_RETRY_BASE_MS * Math.pow(2, Math.min(statusRetryAttempt, 6)),',
    '    STATUS_RETRY_MAX_MS',
    '  );',
    '  statusRetryAttempt = Math.min(statusRetryAttempt + 1, 7);',
    '  statusRetryTimer = setTimeout(() => {',
    '    statusRetryTimer = null;',
    '    void enqueueLifecycle(async () => {',
    '      if (',
    '        revision !== statusRevision ||',
    '        !statusDeliveryDirty ||',
    '        !activeFactoryIDs.has(desiredFactoryID)',
    '      ) return;',
    '      await publishDesiredStatus(revision);',
    '    });',
    '  }, delay);',
    '  if (statusRetryTimer.unref) statusRetryTimer.unref();',
    '}',
    '',
    'async function publishDesiredStatus(revision) {',
    '  if (revision !== statusRevision) return;',
    '  if (!activeFactoryIDs.has(desiredFactoryID)) return;',
    '  const endpointKey = hookEndpointKey();',
    '  if (',
    '    !statusDeliveryDirty &&',
    '    deliveredStatusKey === desiredStatusKey &&',
    '    deliveredEndpointKey === endpointKey &&',
    '    deliveredMessagePartFactoryID === null',
    '  ) return;',
    '  const delivered = await post(desiredHookEventName, desiredStatusProperties);',
    '  if (revision !== statusRevision) return;',
    '  if (!delivered) {',
    '    statusDeliveryDirty = true;',
    '    scheduleStatusRetry(revision);',
    '    return;',
    '  }',
    '  clearStatusRetry();',
    '  statusRetryAttempt = 0;',
    '  deliveredStatusKey = desiredStatusKey;',
    '  deliveredEndpointKey = endpointKey;',
    '  deliveredMessagePartFactoryID = null;',
    '  statusDeliveryDirty = false;',
    '}',
    '',
    'async function setDeliveryTarget(',
    '  next,',
    '  nextKey,',
    '  hookEventName,',
    '  extraProperties,',
    '  factoryID',
    ') {',
    '  const endpointChanged = deliveredEndpointKey !== hookEndpointKey();',
    '  if (',
    '    nextKey === desiredStatusKey &&',
    '    nextKey === deliveredStatusKey &&',
    '    desiredFactoryID === factoryID &&',
    '    !statusDeliveryDirty &&',
    '    !endpointChanged &&',
    '    deliveredMessagePartFactoryID === null',
    '  ) return;',
    '  const targetChanged = nextKey !== desiredStatusKey || desiredFactoryID !== factoryID;',
    '  clearStatusRetry();',
    '  if (targetChanged) {',
    '    statusRetryAttempt = 0;',
    '    busyRecoveryUsed = false;',
    '    busyRecoveryEndpointKey = "";',
    '  }',
    '  desiredStatus = next;',
    '  desiredHookEventName = hookEventName;',
    '  desiredStatusKey = nextKey;',
    '  desiredStatusProperties = extraProperties || {};',
    '  desiredFactoryID = factoryID;',
    '  statusDeliveryDirty =',
    '    statusDeliveryDirty ||',
    '    deliveredMessagePartFactoryID !== null ||',
    '    deliveredStatusKey !== nextKey ||',
    '    endpointChanged;',
    '  const revision = ++statusRevision;',
    '  await publishDesiredStatus(revision);',
    '}',
    '',
    'async function setStatus(next, extraProperties, factoryID) {',
    '  const nextKey = next + ":" + (extraProperties?.sessionID || "");',
    '  const hookEventName = next === "busy" ? "SessionBusy" : "SessionIdle";',
    '  await setDeliveryTarget(next, nextKey, hookEventName, extraProperties, factoryID);',
    '}',
    '',
    'async function setAttention(hookEventName, properties, factoryID) {',
    '  const requestID = properties?.id || properties?.sessionID || "";',
    '  await flushPendingAssistantPart(true);',
    '  await setDeliveryTarget(',
    '    "waiting",',
    '    "waiting:" + hookEventName + ":" + requestID,',
    '    hookEventName,',
    '    properties,',
    '    factoryID',
    '  );',
    '}',
    '',
    'function recoverBusyFromDelta(client, sessionID, factoryID) {',
    '  if (busyRecoveryQueued) return lifecycleQueue;',
    '  if (',
    '    busyRecoveryUsed &&',
    '    busyRecoveryEndpointKey === hookEndpointKey()',
    '  ) return lifecycleQueue;',
    '  busyRecoveryQueued = true;',
    '  return enqueueLifecycle(async () => {',
    '    try {',
    '      if (!activeFactoryIDs.has(factoryID)) return;',
    '      if (sessionID && (await isChildSession(client, sessionID)) === true) return;',
    '      if (!activeFactoryIDs.has(factoryID)) return;',
    '      const endpointKey = hookEndpointKey();',
    '      const endpointChanged = deliveredEndpointKey !== endpointKey;',
    '      if (desiredStatus !== "busy" || (!statusDeliveryDirty && !endpointChanged)) return;',
    '      if (busyRecoveryUsed && !endpointChanged) return;',
    '      busyRecoveryUsed = true;',
    '      busyRecoveryEndpointKey = endpointKey;',
    '      clearStatusRetry();',
    '      statusDeliveryDirty = true;',
    '      const revision = ++statusRevision;',
    '      await publishDesiredStatus(revision);',
    '    } finally {',
    '      busyRecoveryQueued = false;',
    '    }',
    '  });',
    '}',
    '',
    'function currentAttention() {',
    '  let latestQuestion = null;',
    '  for (const attention of pendingAttentionByKey.values()) {',
    '    if (attention.hookEventName === "PermissionRequest") return attention;',
    '    latestQuestion = attention;',
    '  }',
    '  return latestQuestion;',
    '}',
    '',
    'function clearAttentionForSession(sessionID) {',
    '  for (const [key, attention] of pendingAttentionByKey) {',
    '    if (attention.properties?.sessionID === sessionID) pendingAttentionByKey.delete(key);',
    '  }',
    '}',
    '',
    'function clearQuestionForToolPart(part) {',
    '  if (',
    '    part?.type !== "tool" ||',
    '    part.tool !== "question" ||',
    '    (part.state?.status !== "completed" && part.state?.status !== "error")',
    '  ) return false;',
    '  let cleared = false;',
    '  for (const [key, attention] of pendingAttentionByKey) {',
    '    const tool = attention.properties?.tool;',
    '    if (',
    '      attention.hookEventName === "AskUserQuestion" &&',
    '      tool?.messageID === part.messageID &&',
    '      tool?.callID === part.callID',
    '    ) {',
    '      pendingAttentionByKey.delete(key);',
    '      cleared = true;',
    '    }',
    '  }',
    '  return cleared;',
    '}',
    '',
    'function latestBusyRoot() {',
    '  let latest = null;',
    '  for (const [sessionID, factoryID] of busyRootOwnerBySessionID) {',
    '    latest = { sessionID, factoryID };',
    '  }',
    '  return latest;',
    '}',
    '',
    'async function publishAggregateStatus(fallbackFactoryID, preferredSessionID) {',
    '  const attention = currentAttention();',
    '  if (attention) {',
    '    await setAttention(',
    '      attention.hookEventName,',
    '      attention.properties,',
    '      attention.factoryID',
    '    );',
    '    return;',
    '  }',
    '  const busyRoot = latestBusyRoot();',
    '  if (busyRoot) {',
    '    await setStatus("busy", { sessionID: busyRoot.sessionID }, busyRoot.factoryID);',
    '    return;',
    '  }',
    '  await setStatus("idle", { sessionID: preferredSessionID }, fallbackFactoryID);',
    '}',
    '',
    'async function handleLifecycleEvent(client, event, factoryID) {',
    '  const sessionID = event.properties?.sessionID;',
    '  const statusType = getStatusType(event);',
    '  const isAttentionEvent =',
    '    event.type === "permission.asked" ||',
    '    event.type === "question.asked" ||',
    '    event.type === "permission.replied" ||',
    '    event.type === "question.replied" ||',
    '    event.type === "question.rejected";',
    '  const canFailOpen =',
    '    statusType === "busy" || statusType === "retry" || isAttentionEvent;',
    '  const childState = sessionID ? await isChildSession(client, sessionID) : null;',
    '  if (childState === true || (childState === null && !canFailOpen)) return;',
    '  if (childState === null && (statusType === "busy" || statusType === "retry")) {',
    '    // Unknown lineage may be child work (so Busy is still truthful), but',
    '    // do not retain it as a root that could stay busy after child idle.',
    '    await setStatus("busy", { sessionID }, factoryID);',
    '    return;',
    '  }',
    '  if (event.type === "permission.asked" || event.type === "question.asked") {',
    '    // Why: attention must share the lifecycle FIFO and retry target so a',
    '    // delayed Busy post cannot overwrite a newer human blocker.',
    '    const hookEventName =',
    '      event.type === "permission.asked" ? "PermissionRequest" : "AskUserQuestion";',
    '    const properties = event.properties || {};',
    '    const key = properties.id || hookEventName + ":" + (sessionID || "");',
    '    if (pendingAttentionByKey.size >= 128 && !pendingAttentionByKey.has(key)) {',
    '      const first = pendingAttentionByKey.keys().next().value;',
    '      if (first !== undefined) pendingAttentionByKey.delete(first);',
    '    }',
    '    pendingAttentionByKey.set(key, { hookEventName, properties, factoryID });',
    '    await publishAggregateStatus(factoryID, sessionID);',
    '    return;',
    '  }',
    '  if (',
    '    event.type === "permission.replied" ||',
    '    event.type === "question.replied" ||',
    '    event.type === "question.rejected"',
    '  ) {',
    '    pendingAttentionByKey.delete(event.properties?.requestID);',
    '    await publishAggregateStatus(factoryID, sessionID);',
    '    return;',
    '  }',
    '  if (',
    '    event.type === "session.idle" ||',
    '    statusType === "idle"',
    '  ) {',
    '    const idleKey = "idle:" + (sessionID || "");',
    '    // Why: current OpenCode emits canonical idle followed by deprecated',
    '    // session.idle; a failed canonical post should keep its backoff.',
    '    if (',
    '      event.type === "session.idle" &&',
    '      desiredStatusKey === idleKey &&',
    '      statusDeliveryDirty &&',
    '      statusRetryTimer',
    '    ) return;',
    '    // Why: flush the coalesced final reply snapshot before the idle',
    '    // transition so the done-state preview shows the completed message.',
    '    await flushPendingAssistantPart(true);',
    '    clearAttentionForSession(sessionID);',
    '    if (busyRootOwnerBySessionID.get(sessionID) === factoryID) {',
    '      busyRootOwnerBySessionID.delete(sessionID);',
    '    }',
    '    await publishAggregateStatus(factoryID, sessionID);',
    '    return;',
    '  }',
    '  // Why: recoverable compaction failures emit session.error and continue;',
    '  // canonical session.status is the authority for actual completion.',
    '  if (event.type === "session.error") return;',
    '  if (statusType === "busy" || statusType === "retry") {',
    '    clearAttentionForSession(sessionID);',
    '    busyRootOwnerBySessionID.delete(sessionID);',
    '    busyRootOwnerBySessionID.set(sessionID, factoryID);',
    '    await publishAggregateStatus(factoryID, sessionID);',
    '  }',
    '}',
    '',
    '// Why: accept the factory argument as an optional opaque parameter instead',
    '// of destructuring (`async ({ client }) => …`). OpenCode can invoke the',
    '// plugin factory with undefined during startup, which makes the',
    '// destructuring form throw synchronously and crash OpenCode with an opaque',
    '// UnknownError before any event is ever dispatched.',
    'export const OrcaOpenCodeStatusPlugin = async (_ctx) => {',
    '  const client = _ctx?.client;',
    '  const factoryID = ++nextFactoryID;',
    '  activeFactoryIDs.add(factoryID);',
    '  let disposed = false;',
    '  return {',
    '  event: async ({ event }) => {',
    '    if (disposed || !event?.type) return;',
    '    const authorityRevision = stateArrivalRevision;',
    '    const statusType = getStatusType(event);',
    '    if (',
    '      event.type === "session.idle" ||',
    '      event.type === "permission.asked" ||',
    '      event.type === "question.asked" ||',
    '      (event.type === "session.status" && statusType === "idle")',
    '    ) {',
    '      stateArrivalRevision += 1;',
    '    }',
    '',
    '    // Why: cache the message role BEFORE the async isChildSession check.',
    '    // OpenCode fires message.updated (user) and message.part.updated (text)',
    '    // back-to-back; if we awaited isChildSession first, the part.updated',
    '    // handler could reach messageRoleById.get(...) while the user message.updated',
    '    // is still suspended on that await — so the part would see an empty cache',
    '    // and drop the user prompt. Caching is a cheap Map.set with bounded size,',
    '    // safe to run even for child sessions (the part POST still filters them).',
    '    if (event.type === "message.updated") {',
    '      const info = event.properties && event.properties.info;',
    '      rememberMessageRole(info && info.id, info && info.role);',
    '    }',
    '',
    '    const sessionID = event.properties?.sessionID;',
    '    const updatedPart = event.properties?.part;',
    '    if (',
    '      event.type === "message.part.updated" &&',
    '      updatedPart?.type === "tool" &&',
    '      updatedPart.tool === "question" &&',
    '      (updatedPart.state?.status === "completed" || updatedPart.state?.status === "error")',
    '    ) {',
    '      await enqueueLifecycle(async () => {',
    '        if (disposed) return;',
    '        if (sessionID && (await isChildSession(client, sessionID)) === true) return;',
    '        if (disposed) return;',
    '        if (!clearQuestionForToolPart(updatedPart)) return;',
    '        await publishAggregateStatus(factoryID, sessionID);',
    '      });',
    '      return;',
    '    }',
    '',
    '    if (',
    '      event.type === "session.status" ||',
    '      event.type === "session.idle" ||',
    '      event.type === "session.error" ||',
    '      event.type === "permission.asked" ||',
    '      event.type === "question.asked" ||',
    '      event.type === "permission.replied" ||',
    '      event.type === "question.replied" ||',
    '      event.type === "question.rejected"',
    '    ) {',
    '      await enqueueLifecycle(() =>',
    '        disposed ? undefined : handleLifecycleEvent(client, event, factoryID)',
    '      );',
    '      return;',
    '    }',
    '',
    '    if (event.type === "message.part.delta") {',
    '      const properties = event.properties || {};',
    '      if (',
    '        properties.field === "text" &&',
    '        typeof properties.delta === "string" &&',
    '        properties.delta.length > 0',
    '      ) {',
    '        await recoverBusyFromDelta(client, sessionID, factoryID);',
    '      }',
    '      return;',
    '    }',
    '',
    '    if (sessionID && (await isChildSession(client, sessionID)) !== false) {',
    '      return;',
    '    }',
    '    if (disposed) return;',
    '    if (authorityRevision !== stateArrivalRevision) return;',
    '    if (desiredStatus === "waiting") return;',
    '',
    '    if (event.type === "message.updated") {',
    '      // Why: role is already cached above the isChildSession await so the',
    '      // back-to-back message.part.updated for the same messageID is not',
    '      // racing against this handler. Nothing more to do here — return to',
    '      // avoid falling through to the part/session handlers below.',
    '      return;',
    '    }',
    '',
    '    if (event.type === "message.part.updated") {',
    '      // Why: a TextPart carries the actual user prompt or assistant reply',
    '      // text. Skip non-text parts (tool, reasoning, file, …) so we only',
    '      // forward what the dashboard renders. Role came from the earlier',
    '      // message.updated event; if we never saw one (e.g. plugin loaded',
    '      // mid-turn) the role is unknown, and mislabeling the part — a user',
    '      // prompt displayed as the assistant reply, or vice versa — is worse',
    '      // than silently dropping a single in-flight text chunk. The next',
    '      // message.updated event will re-seed the role cache, so subsequent',
    '      // parts in the same session flow normally.',
    '      const part = event.properties && event.properties.part;',
    '      if (!part || part.type !== "text" || !part.text) return;',
    '      const role = messageRoleById.get(part.messageID);',
    '      if (!role) return;',
    '      if (role === "user") {',
    '        // Why: user prompts arrive as a single event, not a stream — post',
    '        // immediately (still capped) so the throttle slot stays free for',
    '        // the assistant reply that follows within the same window.',
    '        await postMessagePart(',
    '          { role, text: capMessagePartText(part.text), messageID: part.messageID, sessionID },',
    '          factoryID',
    '        );',
    '        return;',
    '      }',
    '      queueAssistantPart({',
    '        role,',
    '        text: part.text,',
    '        messageID: part.messageID,',
    '        sessionID,',
    '        authorityRevision,',
    '        factoryID,',
    '      });',
    '      return;',
    '    }',
    '',
    '  },',
    '  dispose: async () => {',
    '    if (disposed) return;',
    '    disposed = true;',
    '    disposingFactoryIDs.add(factoryID);',
    '    await enqueueLifecycle(async () => {',
    '      // An older MessagePart must settle before disposal publishes the',
    '      // replacement state, or its late Working update could win.',
    '      while (messagePartPostInFlight) await messagePartPostInFlight;',
    '      for (const [sessionID, ownerID] of busyRootOwnerBySessionID) {',
    '        if (ownerID === factoryID) busyRootOwnerBySessionID.delete(sessionID);',
    '      }',
    '      for (const [key, attention] of pendingAttentionByKey) {',
    '        if (attention.factoryID === factoryID) pendingAttentionByKey.delete(key);',
    '      }',
    '      if (pendingAssistantPart?.factoryID === factoryID) {',
    '        if (assistantPartFlushTimer) clearTimeout(assistantPartFlushTimer);',
    '        assistantPartFlushTimer = null;',
    '        pendingAssistantPart = null;',
    '      }',
    '      const ownsDeliveredMessagePart = deliveredMessagePartFactoryID === factoryID;',
    '      if (desiredFactoryID === factoryID || ownsDeliveredMessagePart) {',
    '        clearStatusRetry();',
    '        statusRevision += 1;',
    '        // A MessagePart may have changed the listener to Working after the',
    '        // same lifecycle key was delivered; force that key to be reasserted.',
    '        statusDeliveryDirty = ownsDeliveredMessagePart;',
    '        busyRecoveryUsed = false;',
    '        busyRecoveryEndpointKey = "";',
    '        const fallbackFactoryID = Array.from(activeFactoryIDs).find(',
    '          (id) => id !== factoryID',
    '        );',
    '        if (fallbackFactoryID !== undefined) {',
    '          await publishAggregateStatus(',
    '            fallbackFactoryID,',
    '            desiredStatusProperties?.sessionID',
    '          );',
    '        } else {',
    '          // Why: Instance disposal can happen while the PTY stays alive;',
    '          // publish a final idle so Orca does not retain a dead owner.',
    '          if (!deliveredStatusKey.startsWith("idle:") || ownsDeliveredMessagePart) {',
    '            await setStatus(',
    '              "idle",',
    '              { sessionID: desiredStatusProperties?.sessionID },',
    '              factoryID',
    '            );',
    '          }',
    '          clearStatusRetry();',
    '          desiredStatus = "idle";',
    '          desiredHookEventName = "SessionIdle";',
    '          desiredStatusKey = "idle:";',
    '          desiredStatusProperties = {};',
    '          desiredFactoryID = null;',
    '        }',
    '      }',
    '      activeFactoryIDs.delete(factoryID);',
    '      disposingFactoryIDs.delete(factoryID);',
    '    });',
    '  },',
    '  };',
    '};',
    ''
  ].join('\n')
}

// Why: installs the plugin into OPENCODE_CONFIG_DIR so it POSTs to the shared agent-hooks server, unifying OpenCode status with Claude/Codex/Gemini (the old loopback-IPC path never reached agentStatusByPaneKey).
export class OpenCodeHookService {
  clearPty(_ptyId: string): void {
    // Why: no-op — config dirs are app/source-scoped now, and recursive delete on the main-process hot path could freeze on Windows.
  }

  buildPtyEnv(ptyId: string, existingConfigDir?: string | undefined): Record<string, string> {
    if (!isUsableId(ptyId)) {
      // Why: on a bad id, still preserve a user-set OPENCODE_CONFIG_DIR; only the Orca status plugin is forfeited.
      return existingConfigDir ? { OPENCODE_CONFIG_DIR: existingConfigDir } : {}
    }

    if (!existingConfigDir) {
      // Why: share one config root so OpenCode's plugin deps don't churn node_modules per terminal.
      const configDir = this.writeSharedPluginConfig()
      if (!configDir) {
        return {}
      }
      return { OPENCODE_CONFIG_DIR: configDir }
    }

    // Why: don't mkdir the user's (possibly typoed) path — that's the config-replacement failure mode in docs/opencode-config-dir-collision.md; let OpenCode surface it.
    if (!existsSync(existingConfigDir)) {
      return { OPENCODE_CONFIG_DIR: existingConfigDir }
    }

    const overlayDir = this.getSourceOverlayDir(existingConfigDir)

    try {
      mkdirSync(overlayDir, { recursive: true })
      this.mirrorUserConfig(existingConfigDir, overlayDir)
      this.writePluginIntoOverlay(overlayDir)
    } catch {
      // Why: best-effort — symlink creation needs Windows developer mode (else EPERM) and userData may be read-only; preserve the user's config over dropping their auth/models/keymap.
      return { OPENCODE_CONFIG_DIR: existingConfigDir }
    }

    return { OPENCODE_CONFIG_DIR: overlayDir }
  }

  private getOverlayRoot(): string {
    return join(app.getPath('userData'), OPENCODE_OVERLAY_DIR)
  }

  private getSourceOverlayDir(sourceConfigDir: string): string {
    return join(this.getOverlayRoot(), toSafeDirName(`source:${sourceConfigDir}`))
  }

  private getSharedConfigDir(): string {
    return join(app.getPath('userData'), OPENCODE_LEGACY_HOOKS_DIR, OPENCODE_SHARED_CONFIG_DIR)
  }

  private readOverlayManifest(overlayDir: string): OpenCodeOverlayManifest {
    try {
      const parsed = JSON.parse(
        readFileSync(join(overlayDir, OPENCODE_OVERLAY_MANIFEST_FILE), 'utf8')
      ) as Partial<OpenCodeOverlayManifest>
      return {
        topLevelEntries: Array.isArray(parsed.topLevelEntries) ? parsed.topLevelEntries : [],
        pluginEntries: Array.isArray(parsed.pluginEntries) ? parsed.pluginEntries : []
      }
    } catch {
      return { topLevelEntries: [], pluginEntries: [] }
    }
  }

  private writeOverlayManifest(overlayDir: string, manifest: OpenCodeOverlayManifest): void {
    writeFileSync(
      join(overlayDir, OPENCODE_OVERLAY_MANIFEST_FILE),
      `${JSON.stringify(manifest, null, 2)}\n`
    )
  }

  private clearManifestEntries(overlayDir: string, manifest: OpenCodeOverlayManifest): void {
    for (const entryName of manifest.topLevelEntries) {
      safeRemoveTree(join(overlayDir, entryName))
    }

    const overlayPluginsDir = join(overlayDir, 'plugins')
    for (const entryName of manifest.pluginEntries) {
      if (entryName === ORCA_OPENCODE_PLUGIN_FILE) {
        continue
      }
      safeRemoveTree(join(overlayPluginsDir, entryName))
    }
  }

  // Why: mirror user config entries as symlinks so edits propagate live; only plugins/ becomes a real overlay dir so Orca can drop a sibling plugin file.
  private mirrorUserConfig(sourceDir: string, overlayDir: string): void {
    const previousManifest = this.readOverlayManifest(overlayDir)
    // Why: overlays persist across terminals; remove only Orca-mirrored paths so stale user config clears but OpenCode runtime dirs (node_modules) survive.
    this.clearManifestEntries(overlayDir, previousManifest)

    const nextManifest: OpenCodeOverlayManifest = { topLevelEntries: [], pluginEntries: [] }

    for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
      const sourcePath = join(sourceDir, entry.name)

      if (entry.name === 'plugins') {
        // Why: check isSymbolicLink before isDirectory — a Windows junction reports both, and the symlink branch must win.
        const isSymlink = entry.isSymbolicLink()
        let isLinkPointingToDir = false
        if (isSymlink) {
          try {
            isLinkPointingToDir = statSync(sourcePath).isDirectory()
          } catch {
            // Why: broken/inaccessible symlink — mirror the dangling link verbatim instead of resolving through it.
            isLinkPointingToDir = false
          }
        }

        if ((!isSymlink && entry.isDirectory()) || isLinkPointingToDir) {
          // Why: resolve a symlinked plugins/ to its real target so <overlay>/plugins stays a real dir and writePluginIntoOverlay can't write through the user's link.
          const resolvedSource = isLinkPointingToDir ? realpathSync(sourcePath) : sourcePath
          const overlayPluginsDir = join(overlayDir, 'plugins')
          mkdirSync(overlayPluginsDir, { recursive: true })
          for (const pluginEntry of readdirSync(resolvedSource, { withFileTypes: true })) {
            // Why: skip a user plugin sharing Orca's filename; mirroring it would let writePluginIntoOverlay clobber the user's file.
            if (pluginEntry.name === ORCA_OPENCODE_PLUGIN_FILE) {
              continue
            }
            mirrorEntry(
              join(resolvedSource, pluginEntry.name),
              join(overlayPluginsDir, pluginEntry.name)
            )
            nextManifest.pluginEntries.push(pluginEntry.name)
          }
          continue
        }
      }

      mirrorEntry(sourcePath, join(overlayDir, entry.name))
      nextManifest.topLevelEntries.push(entry.name)
    }

    this.writeOverlayManifest(overlayDir, nextManifest)
  }

  // Why: pre-write unlink guards against POSIX writeFileSync writing through a mirrored symlink and clobbering a same-named user plugin.
  private writePluginIntoOverlay(overlayDir: string): void {
    const pluginsDir = join(overlayDir, 'plugins')
    mkdirSync(pluginsDir, { recursive: true })
    const pluginPath = join(pluginsDir, ORCA_OPENCODE_PLUGIN_FILE)
    try {
      unlinkSync(pluginPath)
    } catch {
      // File may not exist on a fresh overlay; a real failure surfaces on writeFileSync below.
    }
    writeFileSync(pluginPath, getOpenCodePluginSource())
  }

  private writeSharedPluginConfig(): string | null {
    const configDir = this.getSharedConfigDir()
    const pluginsDir = join(configDir, 'plugins')
    try {
      mkdirSync(pluginsDir, { recursive: true })
      writeFileSync(join(pluginsDir, ORCA_OPENCODE_PLUGIN_FILE), getOpenCodePluginSource())
    } catch {
      // Why: userData can be locked on Windows (EPERM/EBUSY); plugin is non-critical, so spawn without it.
      return null
    }
    return configDir
  }
}

export const openCodeHookService = new OpenCodeHookService()
export const _internals = {
  getOpenCodePluginSource,
  isUsableId,
  toSafeDirName
}
