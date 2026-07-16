import { timeToSeconds } from './time.helper';

export interface TimelineDay1CutoffMasterInput {
  route: any;
  hotspot: any;
  hotspotMap: Map<number, any>;
  bucket: string;
  currentTime: string;
  shouldApplySourceHotspotCutoff: boolean;
  logHotspotCandidateEvaluation: (...args: any[]) => void;
}

export class TimelineDay1CutoffMasterService {
  resolve(input: TimelineDay1CutoffMasterInput): any | null {
    const hotspotId = Number(input.hotspot?.hotspot_ID || 0);
    const currentSeconds = timeToSeconds(input.currentTime);
    const cutoffHit =
      (input.bucket === 'source' && input.shouldApplySourceHotspotCutoff && currentSeconds >= timeToSeconds('12:00:00')) ||
      (input.bucket === 'via' && currentSeconds >= timeToSeconds('19:00:00')) ||
      (input.bucket === 'destination' && currentSeconds >= timeToSeconds('21:00:00'));

    if (cutoffHit) {
      this.logRejected(
        input,
        input.bucket || null,
        false,
        `Rejected: PHP ${input.bucket}_cutoff_time breached (currentTime=${input.currentTime})`,
      );
      return null;
    }

    const hotspotData = input.hotspotMap.get(hotspotId);
    if (!hotspotData) {
      this.logRejected(input, input.hotspot?.matched_bucket ?? null, Number(input.hotspot?.hotspot_priority ?? 0) > 0, 'Rejected: hotspot master missing');
      return null;
    }

    return hotspotData;
  }

  private logRejected(
    input: TimelineDay1CutoffMasterInput,
    matchedBucket: string | null,
    isMustVisit: boolean,
    reason: string,
  ): void {
    const hotspotId = Number(input.hotspot?.hotspot_ID || 0);
    input.logHotspotCandidateEvaluation({
      routeId: input.route.itinerary_route_ID,
      hotspotId,
      name: `hotspot_${hotspotId}`,
      matchedBucket,
      priority: Number(input.hotspot?.hotspot_priority ?? 0),
      isMustVisit,
      distanceFromRoute: reason === 'Rejected: hotspot master missing'
        ? (Number.isFinite(Number(input.hotspot?.hotspot_distance)) ? Number(input.hotspot.hotspot_distance) : null)
        : null,
      openingTime: null,
      closingTime: null,
      visitTime: `${input.currentTime} - ${input.currentTime}`,
      isOpenAtVisitTime: false,
      selected: false,
      rejectedReasons: [reason],
    });
  }
}
