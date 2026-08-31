// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { OrcaRuntimeWithResolveAuthoritativeTerminalWaitPermission } from './orca-runtime-resolve-authoritative-terminal-wait-permission'
import type { RuntimeTerminalWriteOptions } from './runtime-terminal-writer'
import {
  assertAgentPromptRequestActive,
  waitForAgentPromptDelay,
  waitForAgentPromptPromise,
  yieldBetweenTerminalInputChunks
} from './orca-runtime-core'
import { agentSessionPtyWriteGate } from './agent-session-pty-write-gate'
import {
  AGENT_PROMPT_BRACKETED_PASTE_END,
  AGENT_PROMPT_SUBMIT,
  getAgentPromptSubmitDelayMs,
  getTerminalPasteIngestMs
} from '../../shared/agent-prompt-injection'
import { iterateTerminalInputChunks } from '../../shared/terminal-input'
import type { AgentPromptWaitTextCache } from './agent-prompt-submission-verification'
import {
  resolveAgentPromptEffectTimeoutMs,
  verifyAgentPromptSubmission
} from './agent-prompt-submission-verification'

export class OrcaRuntimeWithWriteTerminalAgentPrompt extends OrcaRuntimeWithResolveAuthoritativeTerminalWaitPermission {
  protected async writeTerminalAgentPrompt(
    handle: string,
    ptyId: string,
    generation: number,
    pastePayload: string,
    options: RuntimeTerminalWriteOptions = {}
  ): Promise<number> {
    assertAgentPromptRequestActive(options.signal)
    this.assertAgentPromptGeneration(ptyId, generation)
    const permissionBaseline = this.getAgentPromptActivity(handle, ptyId)
    this.assertAgentPromptPermissionSafe(permissionBaseline, permissionBaseline)
    const admitted = agentSessionPtyWriteGate.assertAdmitted(ptyId)
    const writeHostPlatform = this.getPtyWriteHostPlatform(ptyId)
    const pasteByteLength = Buffer.byteLength(pastePayload, 'utf8')
    const pasteIngestMs = getTerminalPasteIngestMs(writeHostPlatform, pasteByteLength)
    const renderGate = this.createAgentPromptRenderGate(ptyId, pasteIngestMs)
    let wrotePasteBytes = false
    let completedPaste = false
    try {
      const chunks = iterateTerminalInputChunks(pastePayload)
      let chunk = chunks.next()
      let firstChunk = true
      while (!chunk.done) {
        const nextChunk = chunks.next()
        assertAgentPromptRequestActive(options.signal)
        this.assertAgentPromptGeneration(ptyId, generation)
        if (!firstChunk) {
          agentSessionPtyWriteGate.assertReadmitted(ptyId, admitted)
        }
        firstChunk = false
        await options.beforeWrite?.(ptyId)
        assertAgentPromptRequestActive(options.signal)
        this.assertAgentPromptGeneration(ptyId, generation)
        this.assertAgentPromptPermissionSafe(
          permissionBaseline,
          this.getAgentPromptActivity(handle, ptyId)
        )
        agentSessionPtyWriteGate.assertReadmitted(ptyId, admitted)
        if (nextChunk.done) {
          renderGate?.arm()
        }
        if (!this.ptyController?.write(ptyId, chunk.value)) {
          throw new Error('terminal_not_writable')
        }
        wrotePasteBytes = true
        chunk = nextChunk
        if (!chunk.done) {
          await yieldBetweenTerminalInputChunks()
        }
      }
      completedPaste = true
    } catch (error) {
      if (
        wrotePasteBytes &&
        !completedPaste &&
        this.getPtyLifecycleGeneration(ptyId) === generation
      ) {
        try {
          agentSessionPtyWriteGate.assertReadmitted(ptyId, admitted)
          this.ptyController?.write(ptyId, AGENT_PROMPT_BRACKETED_PASTE_END)
        } catch {
          // The original refusal is the actionable error.
        }
      }
      renderGate?.dispose()
      throw error
    }

    if (renderGate) {
      try {
        await waitForAgentPromptPromise(renderGate.wait(), options.signal)
      } finally {
        renderGate.dispose()
      }
    } else {
      await waitForAgentPromptDelay(
        getAgentPromptSubmitDelayMs(writeHostPlatform, pasteByteLength),
        options.signal
      )
    }
    assertAgentPromptRequestActive(options.signal)
    this.assertAgentPromptGeneration(ptyId, generation)
    agentSessionPtyWriteGate.assertReadmitted(ptyId, admitted)
    try {
      await options.beforeWrite?.(ptyId)
    } catch (error) {
      if (options.suffixFailureError) {
        throw new Error(options.suffixFailureError)
      }
      throw error
    }
    assertAgentPromptRequestActive(options.signal)
    this.assertAgentPromptGeneration(ptyId, generation)
    const waitTextCache: AgentPromptWaitTextCache = {}
    const baseline = this.getAgentPromptActivity(handle, ptyId, waitTextCache)
    this.assertAgentPromptPermissionSafe(permissionBaseline, baseline)
    agentSessionPtyWriteGate.assertReadmitted(ptyId, admitted)
    if (!this.ptyController?.write(ptyId, AGENT_PROMPT_SUBMIT)) {
      throw new Error(options.suffixFailureError ?? 'terminal_not_writable')
    }
    await verifyAgentPromptSubmission({
      baseline,
      readActivity: () => this.getAgentPromptActivity(handle, ptyId, waitTextCache),
      timeoutMs: resolveAgentPromptEffectTimeoutMs(this.getPtyAgent(ptyId)),
      signal: options.signal
    })
    return 1
  }
}
