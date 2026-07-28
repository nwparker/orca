import { describe, expect, it } from 'vitest'
import { ORCHESTRATION_COMMAND_SPECS } from './orchestration'

describe('orchestration check help', () => {
  it('enumerates every accepted message type (#10663)', () => {
    const spec = ORCHESTRATION_COMMAND_SPECS.find(
      (candidate) => candidate.path.join(' ') === 'orchestration check'
    )

    expect(spec?.notes?.join('\n')).toContain(
      'status, dispatch, worker_done, merge_ready, escalation, handoff, decision_gate, question, heartbeat'
    )
  })
})
