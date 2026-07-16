export class TimelineCandidateReorderingService {
  reorder(selectedHotspots: any[], logTimeline: (...args: any[]) => void): any[] {
    try {
      const priorityCandidates: any[] = [];
      const nonPriorityCandidates: any[] = [];
      for (const hotspot of selectedHotspots) {
        const priority = Number(hotspot?.hotspot_priority ?? 0);
        const isManualSelection = Boolean(hotspot?.isManualSelection);
        if (isManualSelection || priority > 0) priorityCandidates.push(hotspot);
        else nonPriorityCandidates.push(hotspot);
      }

      nonPriorityCandidates.sort((a: any, b: any) => {
        const scoreA = Number(a?.matrix_score ?? 0);
        const scoreB = Number(b?.matrix_score ?? 0);
        if (scoreA !== scoreB) return scoreB - scoreA;
        const distanceA = Number(a?.hotspot_distance ?? Number.POSITIVE_INFINITY);
        const distanceB = Number(b?.hotspot_distance ?? Number.POSITIVE_INFINITY);
        return distanceA - distanceB;
      });

      const reordered = [...priorityCandidates, ...nonPriorityCandidates];
      logTimeline('[TIMELINE] Candidates reordered (priority preserved, matrix_score applied)');
      return reordered;
    } catch (error) {
      logTimeline('[TIMELINE] Candidate reorder error', String(error));
      return selectedHotspots;
    }
  }
}
