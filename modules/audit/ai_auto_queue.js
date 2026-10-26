/**
 * Run one complete AI discovery pass and submit only that pass' valid semantic
 * relations to the full local dedupe worker. The worker remains responsible
 * for archive/content/source evidence and for producing the review queue.
 */
async function discoverAndQueue({ startDiscovery, waitForIdle, getState, getValidCandidatePairs, getValidCoveragePairs = async () => [], startDedupe, force = false, forceRecompute = force }) {
  const started = await startDiscovery({ task: 'discovery', force: force === true })
  const runId = started?.runId || null
  if (!runId) throw Object.assign(new Error('AI_RUN_MISSING'), { code: 'AI_RUN_MISSING' })
  await waitForIdle()
  const finalState = await getState()
  if (['failed', 'cancelled', 'interrupted'].includes(finalState?.status)) {
    const error = Object.assign(new Error(finalState.error || 'AI_ANALYSIS_FAILED'), { code: finalState.error || 'AI_ANALYSIS_FAILED', state: finalState })
    throw error
  }
  if (finalState?.status !== 'completed' || finalState.partial || finalState.limited || finalState.candidateTruncated ||
      finalState.normalizationFailedBooks > 0 || finalState.normalizationMissing > 0 || finalState.classificationFailed > 0 ||
      finalState.classificationMissing > 0 || finalState.normalizationSucceeded < finalState.totalBooks ||
      finalState.classificationSucceeded < finalState.candidateCount) {
    throw Object.assign(new Error('AI_ANALYSIS_INCOMPLETE'), { code: 'AI_ANALYSIS_INCOMPLETE', state: finalState })
  }
  const pairs = await getValidCandidatePairs({ runId })
  const coveragePairs = await getValidCoveragePairs({ runId })
  const dedupeState = await startDedupe({
    scanMode: 'full',
    forceRecompute: forceRecompute === true,
    semanticPairs: pairs,
    coveragePairs,
    aiRunId: runId,
    aiSource: 'ai-discovery',
    aiPartial: finalState.partial === true
  })
  return { runId, pairCount: pairs.length, coveragePairCount: coveragePairs.length, aiState: finalState, dedupeState }
}

module.exports = { discoverAndQueue }
