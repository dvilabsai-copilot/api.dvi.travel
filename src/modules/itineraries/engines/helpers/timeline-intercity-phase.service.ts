/**
 * Keep intercity candidates in route order while the source phase is active.
 * Source candidates must be tried first, but strict movement/destination
 * candidates must remain queued so they can be tried after the source phase.
 */
export function buildIntercityPhaseCandidateQueue<T>(
  candidates: T[],
  isSourcePhaseEligible: (candidate: T) => boolean,
  priorityCandidate?: T | null,
): T[] {
  const sourceCandidates = candidates.filter(isSourcePhaseEligible);
  const postSourceCandidates = candidates.filter((candidate) => !isSourcePhaseEligible(candidate));
  if (priorityCandidate && candidates.includes(priorityCandidate)) {
    return [
      priorityCandidate,
      ...sourceCandidates,
      ...postSourceCandidates.filter((candidate) => candidate !== priorityCandidate),
    ];
  }
  return [...sourceCandidates, ...postSourceCandidates];
}

export function shouldAdvanceToPostSourceCandidate<T>(
  candidates: T[],
  currentIndex: number,
  isSourcePhaseEligible: (candidate: T) => boolean,
  isAlreadyPlanned: (candidate: T) => boolean,
): boolean {
  return candidates.slice(currentIndex + 1).every((candidate) => {
    return isAlreadyPlanned(candidate) || !isSourcePhaseEligible(candidate);
  });
}
