import type { PtySourceDeliveryIdentity } from '../shared/pty-source-credit-contract'
import type { PtySourceRecoveryCheckpoint } from '../shared/pty-source-recovery-contract'
import type { PtySourceReceivingActivation } from '../shared/pty-source-receiving-activation'

export type RelayPtySourceDeliveryRecord = {
  clientId: number
  /** Transport incarnation of clientId; undefined preserves legacy harness behavior. */
  clientTransportGeneration?: number
  identity: PtySourceDeliveryIdentity
  sourceActivation: PtySourceReceivingActivation
  displayEnd: number
  activating: boolean
  activationRecoveryRequest: PtySourceRecoveryCheckpoint | null
  sealed: boolean
  legacyExitAccepted: boolean
  sourceExitState: 'idle' | 'pending' | 'published'
  sending: boolean
  turnFrames: number
  turnSourceSu: number
  turnScheduled: boolean
  sendWaiters: Set<() => void>
  recoveryCheckpointSourceEndSu: number | null
  recoveryEndSu: number | null
  recoveryCompletionPending: boolean
  restoreRequired: boolean
  rotationPending: boolean
}

/** Match a delivery owner, including the socket incarnation when available. */
export function sameClientTransport(
  record: { clientId: number; clientTransportGeneration?: number },
  context: { clientId: number; transportGeneration?: number }
): boolean {
  return (
    record.clientId === context.clientId &&
    record.clientTransportGeneration === context.transportGeneration
  )
}
