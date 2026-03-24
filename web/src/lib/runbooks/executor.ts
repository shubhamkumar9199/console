import type { Runbook, RunbookContext, EvidenceStepResult, RunbookResult } from './types'
import { authFetch } from '../api'
import { FETCH_DEFAULT_TIMEOUT_MS } from '../constants/network'

const API_BASE = import.meta.env.VITE_API_BASE_URL || ''

/**
 * Resolve template variables in a string.
 * Replaces {{cluster}}, {{namespace}}, {{resource}}, {{alertMessage}} etc.
 */
function resolveTemplate(template: string, context: RunbookContext): string {
  return template
    .replace(/\{\{cluster\}\}/g, context.cluster || 'unknown')
    .replace(/\{\{namespace\}\}/g, context.namespace || 'default')
    .replace(/\{\{resource\}\}/g, context.resource || 'unknown')
    .replace(/\{\{resourceKind\}\}/g, context.resourceKind || 'unknown')
    .replace(/\{\{alertMessage\}\}/g, context.alertMessage || '')
}

/**
 * Resolve template variables in an args map.
 */
function resolveArgs(args: Record<string, string>, context: RunbookContext): Record<string, unknown> {
  const resolved: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(args)) {
    const resolvedValue = resolveTemplate(value, context)
    // Convert numeric strings to numbers
    const num = Number(resolvedValue)
    resolved[key] = !isNaN(num) && resolvedValue.trim() !== '' ? num : resolvedValue
  }
  return resolved
}

/**
 * Execute a single evidence step via MCP or Gadget API.
 */
async function executeStep(
  step: { source: string; tool: string; args: Record<string, string> },
  context: RunbookContext
): Promise<unknown> {
  const resolvedArgs = resolveArgs(step.args, context)

  if (step.source === 'gadget') {
    const resp = await authFetch(`${API_BASE}/api/gadget/trace`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool: step.tool, args: resolvedArgs }),
      signal: AbortSignal.timeout(FETCH_DEFAULT_TIMEOUT_MS),
    })
    if (!resp.ok) throw new Error(`Gadget trace failed: ${resp.status}`)
    const data = await resp.json()
    if (data.isError) throw new Error('Gadget tool error')
    return data.result
  }

  // MCP tools go through the ops endpoint
  const resp = await authFetch(`${API_BASE}/api/mcp/ops/call`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tool: step.tool, args: resolvedArgs }),
    signal: AbortSignal.timeout(FETCH_DEFAULT_TIMEOUT_MS),
  })
  if (!resp.ok) throw new Error(`MCP call failed: ${resp.status}`)
  return resp.json()
}

/**
 * Execute a runbook, yielding progress via callback.
 * Returns the full result with enriched AI prompt.
 */
export async function executeRunbook(
  runbook: Runbook,
  context: RunbookContext,
  onProgress?: (results: EvidenceStepResult[]) => void
): Promise<RunbookResult> {
  const startedAt = new Date().toISOString()
  const stepResults: EvidenceStepResult[] = runbook.evidenceSteps.map(step => ({
    stepId: step.id,
    label: step.label,
    status: 'pending' as const,
  }))

  // Notify initial state
  onProgress?.(stepResults)

  // Execute steps sequentially
  for (let i = 0; i < runbook.evidenceSteps.length; i++) {
    const step = runbook.evidenceSteps[i]
    stepResults[i] = { ...stepResults[i], status: 'running' }
    onProgress?.([...stepResults])

    const startTime = Date.now()
    try {
      const data = await executeStep(step, context)
      stepResults[i] = {
        ...stepResults[i],
        status: 'success',
        data,
        durationMs: Date.now() - startTime,
      }
    } catch (error) {
      if (step.optional) {
        stepResults[i] = {
          ...stepResults[i],
          status: 'skipped',
          error: error instanceof Error ? error.message : 'Unknown error',
          durationMs: Date.now() - startTime,
        }
      } else {
        stepResults[i] = {
          ...stepResults[i],
          status: 'failed',
          error: error instanceof Error ? error.message : 'Unknown error',
          durationMs: Date.now() - startTime,
        }
      }
    }
    onProgress?.([...stepResults])
  }

  // Build evidence summary for the AI prompt
  const evidenceText = stepResults
    .filter(r => r.status === 'success' && r.data)
    .map(r => `### ${r.label}\n${JSON.stringify(r.data, null, 2)}`)
    .join('\n\n')

  const enrichedPrompt = resolveTemplate(runbook.analysisPrompt, context)
    .replace('{{evidence}}', evidenceText || 'No evidence could be gathered.')

  return {
    runbookId: runbook.id,
    runbookTitle: runbook.title,
    stepResults,
    enrichedPrompt,
    startedAt,
    completedAt: new Date().toISOString(),
  }
}
