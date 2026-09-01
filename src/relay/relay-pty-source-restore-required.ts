import type { RelayDispatcher, RequestContext } from './dispatcher'
import { registerCanceledPtySourceRetirement } from './relay-pty-source-activation'
import type { RelayPtySourceDeliveryRecord } from './relay-pty-source-delivery-record'
import type { RelayPtySourceSendScheduler } from './relay-pty-source-send-scheduler'
import type { SshPtyConsumerSessionAdapter } from './ssh-pty-consumer-session-adapter'

export type PtySourceRestoreRequiredResult = Readonly<{
  status: 'restoreRequired'
  reason: string
}>

type RestoreRequiredDeps = {
  dispatcher: RelayDispatcher
  onCapacity: (id: string) => void
}

/** Publish a restore verdict only after the response reaches the requesting client. */
export function publishPtySourceRestoreRequired(
  deps: RestoreRequiredDeps,
  id: string,
  context: RequestContext,
  reason: string
): PtySourceRestoreRequiredResult {
  const result = Object.freeze({ status: 'restoreRequired' as const, reason })
  context.onResponseSettled?.((settlement) => {
    if (settlement.ok) {
      deps.dispatcher.notifyClient(context.clientId, 'pty.restoreRequired', { id, reason })
    }
  })
  deps.onCapacity(id)
  return result
}

/** Retire an unrecoverable delivery before asking its client to restore. */
export function requirePtySourceRestore(
  deps: RestoreRequiredDeps & {
    session: SshPtyConsumerSessionAdapter
    sender: RelayPtySourceSendScheduler
    deliveries: Map<string, RelayPtySourceDeliveryRecord>
  },
  id: string,
  current: RelayPtySourceDeliveryRecord,
  context: RequestContext,
  reason: string
): PtySourceRestoreRequiredResult {
  deps.session.cancelDelivery(current.identity, `recovery-${reason}`)
  current.restoreRequired = true
  current.activating = false
  deps.sender.wakeSendWaiters(current)
  registerCanceledPtySourceRetirement(current, context, deps.deliveries, deps.onCapacity)
  return publishPtySourceRestoreRequired(deps, id, context, reason)
}
