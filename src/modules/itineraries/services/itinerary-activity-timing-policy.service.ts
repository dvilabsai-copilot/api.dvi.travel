import { Injectable } from '@nestjs/common';

@Injectable()
export class ItineraryActivityTimingPolicyService {
  timeToMinutes(time: Date | null): number {
    if (!time) return 0;
    const date = new Date(time);
    return date.getUTCHours() * 60 + date.getUTCMinutes();
  }

  formatTime(time: Date | null): string {
    if (!time) return 'N/A';
    const date = new Date(time);
    return `${date.getUTCHours().toString().padStart(2, '0')}:${date.getUTCMinutes().toString().padStart(2, '0')}`;
  }

  addMinutesToTime(time: Date, minutes: number): Date {
    const result = new Date(time);
    result.setUTCMinutes(result.getUTCMinutes() + minutes);
    return result;
  }

  checkActivityTimingConflicts(
    activity: any,
    timeSlots: any[],
    proposedStartTime: Date,
    proposedEndTime: Date,
  ): Array<{ reason: string; severity: string }> {
    if (timeSlots.length === 0) return [];
    const proposedStart = this.timeToMinutes(proposedStartTime);
    const proposedEnd = this.timeToMinutes(proposedEndTime);
    const fitsAnySlot = timeSlots.some((slot: any) => {
      const slotStart = this.timeToMinutes(slot.start_time);
      const slotEnd = this.timeToMinutes(slot.end_time);
      return proposedStart >= slotStart && proposedEnd <= slotEnd;
    });
    if (fitsAnySlot) return [];
    const slotRanges = timeSlots
      .map((slot: any) => `${this.formatTime(slot.start_time)} - ${this.formatTime(slot.end_time)}`)
      .join(', ');
    return [{
      reason: `Activity "${activity.activity_title}" is available only at ${slotRanges}, but it would be inserted at ${this.formatTime(proposedStartTime)} - ${this.formatTime(proposedEndTime)}`,
      severity: 'warning',
    }];
  }
}
