// FILE: src/modules/itineraries/services/itinerary-matrix-rescheduled-preview.service.ts

import { Injectable } from '@nestjs/common';

type MatrixRescheduledPreviewCallbacks = Record<string, (...args: any[]) => any>;

@Injectable()
export class ItineraryMatrixRescheduledPreviewService {
  private callbacks: MatrixRescheduledPreviewCallbacks = {};

  setCallbacks(callbacks: MatrixRescheduledPreviewCallbacks): void {
    this.callbacks = { ...this.callbacks, ...callbacks };
  }

  public buildMatrixMergedPreviewTimeline(params: {
    baselineTimeline: any[];
    enginePreviewTimeline: any[];
    manualInsertionFit: any;
    selectedHotspotId: number;
    hotspotMasters: any[];
  }): any[] {
    const {
      baselineTimeline,
      enginePreviewTimeline,
      manualInsertionFit,
      selectedHotspotId,
      hotspotMasters,
    } = params;

    const baselineRows = Array.isArray(baselineTimeline) ? [...baselineTimeline] : [];
    if (!manualInsertionFit || baselineRows.length === 0) return Array.isArray(enginePreviewTimeline) ? enginePreviewTimeline : baselineRows;

    const selectedIdNum = Number(selectedHotspotId || 0);
    if (selectedIdNum <= 0) return Array.isArray(enginePreviewTimeline) ? enginePreviewTimeline : baselineRows;

    const bestSlot = manualInsertionFit?.chosenSlot || manualInsertionFit?.bestSlot || null;
    if (!bestSlot) return Array.isArray(enginePreviewTimeline) ? enginePreviewTimeline : baselineRows;

    const engineRows = Array.isArray(enginePreviewTimeline) ? enginePreviewTimeline : [];
    const selectedFromEngine = engineRows.find((row: any) => {
      const rowHotspotId = Number(row?.locationId || row?.hotspot_ID || row?.hotspotId || 0);
      const rowType = String(row?.type || '').toLowerCase();
      const isAttraction = rowType === 'attraction' || Number(row?.item_type || 0) === 4;
      return rowHotspotId === selectedIdNum && isAttraction;
    }) || null;
    const selectedFromMaster = hotspotMasters?.find((row: any) => Number(row?.hotspot_ID || 0) === selectedIdNum) || null;

    const selectedRow = {
      ...(selectedFromEngine || {}),
      type: 'attraction',
      item_type: 4,
      locationId: selectedIdNum,
      hotspot_ID: selectedIdNum,
      hotspotId: selectedIdNum,
      text: String(
        selectedFromMaster?.hotspot_name
        || selectedFromEngine?.text
        || selectedFromEngine?.name
        || manualInsertionFit?.selectedHotspotName
        || `Hotspot #${selectedIdNum}`,
      ),
      name: String(
        selectedFromMaster?.hotspot_name
        || selectedFromEngine?.name
        || selectedFromEngine?.text
        || manualInsertionFit?.selectedHotspotName
        || `Hotspot #${selectedIdNum}`,
      ),
      duration: selectedFromEngine?.duration || selectedFromMaster?.hotspot_duration || null,
      timeRange: selectedFromEngine?.timeRange || (selectedFromMaster?.hotspot_duration ? String(selectedFromMaster.hotspot_duration) : 'Needs reschedule'),
      isManual: true,
    };

    const normalizedBaseline = baselineRows.filter((row: any) => {
      const hotspotId = Number(row?.locationId || row?.hotspot_ID || row?.hotspotId || 0);
      return hotspotId !== selectedIdNum;
    });

    const fromId = Number(bestSlot.fromHotspotId || 0);
    const toId = Number(bestSlot.toHotspotId || 0);
    const isAttractionRow = (row: any): boolean => {
      const rowType = String(row?.type || '').toLowerCase();
      return rowType === 'attraction' || Number(row?.item_type || 0) === 4;
    };

    let insertAfterIndex = normalizedBaseline.findIndex((row: any) => (
      isAttractionRow(row)
      && Number(row?.locationId || row?.hotspot_ID || row?.hotspotId || 0) === fromId
    ));
    if (insertAfterIndex < 0 && bestSlot.fromName) {
      insertAfterIndex = normalizedBaseline.findIndex((row: any) => (
        isAttractionRow(row)
        && String(row?.text || row?.name || '').trim() === String(bestSlot.fromName || '').trim()
      ));
    }
    if (insertAfterIndex < 0) insertAfterIndex = Math.max(0, normalizedBaseline.length - 1);

    const toRowIndex = normalizedBaseline.findIndex((row: any, index: number) =>
      index > insertAfterIndex
      && isAttractionRow(row)
      && Number(row?.locationId || row?.hotspot_ID || row?.hotspotId || 0) === toId,
    );

    const fromRow = normalizedBaseline[insertAfterIndex] || null;
    const toRow = (toRowIndex >= 0 ? normalizedBaseline[toRowIndex] : null)
      || normalizedBaseline[insertAfterIndex + 1]
      || null;

    const fromEndMinutes = this.callbacks.parseSegmentEndMinutes(fromRow);
    const toStartMinutes = this.callbacks.parseSegmentStartMinutes(toRow);
    const selectedDurationMinutes =
      this.callbacks.getHotspotDurationMinutesFromMasterFirst(selectedFromMaster, selectedRow)
      || this.callbacks.getPreviewRowDurationFromDurationFieldsOnly(selectedRow)
      || 60;

    const timingPossible = fromEndMinutes !== null
      && toStartMinutes !== null
      && toStartMinutes >= fromEndMinutes
      && (toStartMinutes - fromEndMinutes) >= selectedDurationMinutes;

    const timingDecisionReason = timingPossible
      ? 'Timing fits within the available gap.'
      : 'Timing requires reschedule because available gap is not enough.';

    const selectedTimeRange = timingPossible && fromEndMinutes !== null
      ? this.callbacks.minutesRangeToTimeString(fromEndMinutes, fromEndMinutes + selectedDurationMinutes)
      : 'Needs reschedule';

    const selectedRowWithMatrix = {
      ...selectedRow,
      type: 'attraction',
      item_type: 4,
      locationId: selectedIdNum,
      hotspot_ID: selectedIdNum,
      hotspotId: selectedIdNum,
      isManual: true,
      isUserSelectedPreview: true,
      isMatrixPositioned: true,
      routeFitType: bestSlot.routeFitType,
      label: bestSlot.label,
      displayLabel: bestSlot.displayLabel || bestSlot.label,
      shortLabel: bestSlot.shortLabel || bestSlot.label,
      text: selectedRow?.text || selectedRow?.name || manualInsertionFit?.selectedHotspotName,
      name: selectedRow?.name || selectedRow?.text || manualInsertionFit?.selectedHotspotName,
      timeRange: selectedTimeRange,
      isConflict: !timingPossible,
      conflictReason: timingPossible
        ? null
        : 'Route-fit is feasible, but current time gap is not enough. Timeline needs reschedule.',
      matrixFit: {
        routeFitType: bestSlot.routeFitType,
        label: bestSlot.label,
        displayLabel: bestSlot.displayLabel || bestSlot.label,
        shortLabel: bestSlot.shortLabel || bestSlot.label,
        fromName: bestSlot.fromName,
        toName: bestSlot.toName,
        roadDetourKm: bestSlot.roadDetourKm,
        isZeroExtraDetour: bestSlot.isZeroExtraDetour === true,
        distanceComparisonNote: bestSlot.distanceComparisonNote || null,
        roadDetourRatio: bestSlot.roadDetourRatio,
        routeDecisionReason: bestSlot.routeDecisionReason || bestSlot.decisionReason || null,
        timingDecisionReason,
        finalDecisionReason: bestSlot.finalDecisionReason || 'Selected: best lower-detour feasible slot.',
        routeLegSummary: {
          directDistanceKm: bestSlot?.abOsrmDistanceKm != null ? Number(bestSlot.abOsrmDistanceKm) : null,
          viaDistanceKm: bestSlot?.insertedRouteDistanceKm != null ? Number(bestSlot.insertedRouteDistanceKm) : null,
          extraDistanceKm: bestSlot?.roadDetourKm != null ? Number(bestSlot.roadDetourKm) : null,
          acDistanceKm: bestSlot?.acOsrmDistanceKm != null ? Number(bestSlot.acOsrmDistanceKm) : null,
          cbDistanceKm: bestSlot?.cbOsrmDistanceKm != null ? Number(bestSlot.cbOsrmDistanceKm) : null,
          acDurationMin: null,
          cbDurationMin: null,
        },
      },
    };

    const travelRowIndex = (() => {
      if (toRowIndex <= insertAfterIndex) return -1;
      for (let i = insertAfterIndex + 1; i < toRowIndex; i += 1) {
        const row = normalizedBaseline[i];
        const type = String(row?.type || '').toLowerCase();
        const text = String(row?.text || row?.name || '').toLowerCase();
        if (type === 'travel' || text.startsWith('travel to')) {
          return i;
        }
      }
      return -1;
    })();

    const createSplitTravelRow = (
      baseRow: any,
      fromLabel: string,
      toLabel: string,
      leg: 'A_TO_C' | 'C_TO_B',
      distanceKm: number | null,
    ) => {
      const normalizedDistance = distanceKm != null && Number.isFinite(Number(distanceKm))
        ? Number(distanceKm)
        : null;
      const roundedDistance = normalizedDistance != null ? Number(normalizedDistance.toFixed(1)) : null;

      return {
        ...(baseRow || {}),
        type: String(baseRow?.type || '').toLowerCase() === 'travel' ? baseRow.type : 'travel',
        item_type: Number(baseRow?.item_type || 3),
        text: `Travel to ${toLabel}`,
        name: `Travel to ${toLabel}`,
        fromName: fromLabel,
        toName: toLabel,
        from: fromLabel,
        to: toLabel,
        displayFromName: fromLabel,
        displayToName: toLabel,
        isMatrixSplitTravel: true,
        isMatrixReconnectedTravel: true,
        matrixTravelLeg: leg,
        matrixDistanceKm: normalizedDistance,
        distanceKm: normalizedDistance,
        travelDistanceKm: normalizedDistance,
        distance: roundedDistance != null ? `${roundedDistance.toFixed(1)} km` : null,
        matrixDurationMin: null,
        duration: null,
        timeRange: 'Needs recalculation',
      };
    };

    const selectedLabel = String(
      selectedRowWithMatrix?.text
      || selectedRowWithMatrix?.name
      || manualInsertionFit?.selectedHotspotName
      || `Hotspot #${selectedIdNum}`,
    ).trim();
    const toLabel = String(bestSlot?.toName || toRow?.text || toRow?.name || 'Next Stop').trim();

    const travelBase = travelRowIndex >= 0 ? normalizedBaseline[travelRowIndex] : null;
    const travelAToC = createSplitTravelRow(
      travelBase,
      String(bestSlot?.fromName || fromRow?.text || fromRow?.name || 'Previous Stop').trim(),
      selectedLabel,
      'A_TO_C',
      bestSlot?.acOsrmDistanceKm != null ? Number(bestSlot.acOsrmDistanceKm) : null,
    );
    const travelCToB = createSplitTravelRow(
      travelBase,
      selectedLabel,
      toLabel,
      'C_TO_B',
      bestSlot?.cbOsrmDistanceKm != null ? Number(bestSlot.cbOsrmDistanceKm) : null,
    );

    const isHotelLikeRow = (row: any) => {
      const type = String(row?.type || '').toLowerCase();
      const text = String(row?.text || row?.name || '').toLowerCase();
      return (
        type === 'hotel'
        || Number(row?.item_type || 0) === 6
        || text.includes('check-in at hotel')
      );
    };

    const slotContextUpper = String(bestSlot?.slotContext || '').toUpperCase();
    const isCityEndpointEmptyRoute =
      manualInsertionFit?.emptyRouteCityEndpointMode === true
      || bestSlot?.emptyRouteCityEndpointMode === true
      || slotContextUpper === 'CITY_TO_CITY';

    if (isCityEndpointEmptyRoute) {
      const hotelIndex = normalizedBaseline.findIndex((row: any) => isHotelLikeRow(row));
      const hotelRow = hotelIndex >= 0
        ? {
            ...normalizedBaseline[hotelIndex],
            timeRange: 'Needs recalculation',
            hotspot_start_time: null,
            hotspot_end_time: null,
            isConflict: false,
            conflictReason: null,
          }
        : {
            type: 'hotel',
            item_type: 6,
            text: 'Check-in at Hotel',
            name: 'Check-in at Hotel',
            timeRange: 'Needs recalculation',
            isZeroDurationHotel: true,
            isConflict: false,
            conflictReason: null,
          };

      const keepUntilIndex =
        travelRowIndex >= 0
          ? travelRowIndex
          : Math.max(0, insertAfterIndex + 1);

      const prefixRows = normalizedBaseline
        .slice(0, keepUntilIndex)
        .filter((row: any) => !isHotelLikeRow(row));

      const merged = [
        ...prefixRows,
        travelAToC,
        selectedRowWithMatrix,
        travelCToB,
        hotelRow,
      ];

      return this.callbacks.finalizeMatrixPreviewTimeline(merged);
    }

    const merged = [...normalizedBaseline];
    if (travelRowIndex >= 0) {
      merged.splice(travelRowIndex, 1, travelAToC, selectedRowWithMatrix, travelCToB);
    } else {
      merged.splice(insertAfterIndex + 1, 0, travelAToC, selectedRowWithMatrix, travelCToB);
    }
    return this.callbacks.finalizeMatrixPreviewTimeline(merged);
  }


  public async buildMatrixRescheduledPreviewTimeline(params: {
    baselineTimeline: any[];
    enginePreviewTimeline: any[];
    manualInsertionFit: any;
    selectedHotspotId: number;
    hotspotMasters: any[];
    tx?: any;
    routeId?: number;
    routeEndMinutes?: number;
  }): Promise<any[]> {
    const {
      baselineTimeline,
      enginePreviewTimeline,
      manualInsertionFit,
      selectedHotspotId,
      hotspotMasters,
      tx,
      routeId,
    } = params;

    const baseMerged = this.buildMatrixMergedPreviewTimeline({
      baselineTimeline,
      enginePreviewTimeline,
      manualInsertionFit,
      selectedHotspotId,
      hotspotMasters,
    });

    if (!manualInsertionFit || baseMerged.length === 0 || !tx) {
      return this.callbacks.finalizeMatrixPreviewTimeline(baseMerged);
    }

    const selectedIdNum = Number(selectedHotspotId || 0);
    if (selectedIdNum <= 0) return baseMerged;

    const bestSlot = manualInsertionFit?.bestSlot || manualInsertionFit?.chosenSlot || null;
    if (!bestSlot) return baseMerged;

    const isTravelRow = (row: any) => {
      const type = String(row?.type || '').toLowerCase();
      return type === 'travel' || Number(row?.item_type || 0) === 3 || Number(row?.item_type || 0) === 5;
    };
    const isAttractionRow = (row: any) => {
      const type = String(row?.type || '').toLowerCase();
      return type === 'attraction' || Number(row?.item_type || 0) === 4;
    };
    const isHotelLikeRow = (row: any) => {
      const type = String(row?.type || '').toLowerCase();
      const text = String(row?.text || row?.name || '').toLowerCase();
      return type === 'hotel' || Number(row?.item_type || 0) === 6 || text.includes('check-in at hotel');
    };

    const fromHotspotId = Number(bestSlot?.fromHotspotId || 0);
    const toHotspotId = Number(bestSlot?.toHotspotId || 0);
 console.log('[ManualTimelineBuild] selected_slot', {
      selectedHotspotId: selectedIdNum,
      fromHotspotId,
      toHotspotId,
      routeFitType: bestSlot?.routeFitType || null,
      source: bestSlot?.source || null,
      label: bestSlot?.label || null,
    });
    const isTravelToHotelRow = (row: any) => {
      const type = String(row?.type || '').toLowerCase();
      const text = String(row?.text || row?.name || '').toLowerCase();
      return (type === 'travel' || Number(row?.item_type || 0) === 3 || Number(row?.item_type || 0) === 5) && text.includes('travel to hotel');
    };

    if (!fromHotspotId && toHotspotId > 0) {
      const toRowIndex = baseMerged.findIndex(
        (row: any) => Number(row?.locationId || row?.hotspot_ID || row?.hotspotId || 0) === toHotspotId
          && isAttractionRow(row),
      );
      const insertedRowIndex = baseMerged.findIndex(
        (row: any) => row?.isMatrixPositioned === true && Number(row?.locationId || row?.hotspot_ID || row?.hotspotId || 0) === selectedIdNum,
      );

      if (toRowIndex >= 0 && insertedRowIndex >= 0 && tx && Number(routeId || 0) > 0) {
        const prefix = baseMerged
          .slice(0, toRowIndex)
          .filter((row: any) => !isHotelLikeRow(row) && !isTravelRow(row))
          .map((row: any) => ({ ...row }));

        let cursor = prefix.length > 0
          ? (this.callbacks.parseSegmentEndMinutes(prefix[prefix.length - 1]) ?? this.callbacks.parseSegmentStartMinutes(baseMerged[0]) ?? 8 * 60)
          : (this.callbacks.parseSegmentStartMinutes(baseMerged[0]) ?? 8 * 60);

        const selectedRow = baseMerged[insertedRowIndex];
        const selectedHotspotMaster = hotspotMasters.find((hotspot: any) => Number(hotspot?.hotspot_ID || hotspot?.id || 0) === selectedIdNum) || null;
        const selectedDurationMinutes =
          this.callbacks.getHotspotDurationMinutesFromMasterFirst(selectedHotspotMaster, selectedRow)
          || this.callbacks.getPreviewRowDurationFromDurationFieldsOnly(selectedRow)
          || 60;

        const sourceLeg = await this.callbacks.resolveSavedRuleSourceToHotspotLeg(tx, Number(routeId || 0), selectedIdNum);
        const selectedToAnchorLeg = await this.callbacks.resolveSavedRuleHotspotToHotspotLeg(tx, selectedIdNum, toHotspotId);
        const anchorRow = baseMerged[toRowIndex];
        const anchorLabel = String(selectedToAnchorLeg?.toName || anchorRow?.text || anchorRow?.name || bestSlot?.toName || `Hotspot #${toHotspotId}`).trim();
        const selectedLabel = String(sourceLeg?.destinationName || selectedRow?.text || selectedRow?.name || manualInsertionFit?.selectedHotspotName || `Hotspot #${selectedIdNum}`).trim();

        const sourceTravelDuration = Math.max(
          1,
          Math.round(Number(sourceLeg?.durationMin || this.callbacks.estimateDurationFromDistance(Number(sourceLeg?.distanceKm || null)) || 10)),
        );
        const selectedToAnchorDuration = Math.max(
          1,
          Math.round(Number(selectedToAnchorLeg?.durationMin || this.callbacks.estimateDurationFromDistance(Number(selectedToAnchorLeg?.distanceKm || null)) || 10)),
        );
        const sourceTravelDistance = this.callbacks.chooseReliableTravelDistanceKm(
          sourceLeg?.distanceKm != null ? Number(sourceLeg.distanceKm) : null,
          null,
        );
        const selectedToAnchorDistance = this.callbacks.chooseReliableTravelDistanceKm(
          selectedToAnchorLeg?.distanceKm != null ? Number(selectedToAnchorLeg.distanceKm) : null,
          null,
        );

        const scheduleTravel = (
          row: any,
          start: number,
          duration: number,
          fromLabel: string,
          toLabel: string,
          distanceKm: number | null,
          leg: 'A_TO_C' | 'C_TO_B',
          locationId: number,
        ) => ({
          ...row,
          type: 'travel',
          item_type: Number(row?.item_type || 3),
          isMatrixSplitTravel: true,
          isMatrixReconnectedTravel: true,
          matrixTravelLeg: leg,
          fromName: fromLabel,
          toName: toLabel,
          from: fromLabel,
          to: toLabel,
          displayFromName: fromLabel,
          displayToName: toLabel,
          text: `Travel to ${toLabel}`,
          name: `Travel to ${toLabel}`,
          matrixDistanceKm: distanceKm,
          distanceKm: distanceKm,
          travelDistanceKm: distanceKm,
          matrixDurationMin: duration,
          duration: `${duration} Min`,
          distance: distanceKm != null ? `${Number(distanceKm).toFixed(1)} km` : null,
          timeRange: this.callbacks.minutesRangeToTimeString(start, start + duration),
          locationId,
          hotspot_ID: locationId,
          hotspotId: locationId,
          hotspot_start_time: null,
          hotspot_end_time: null,
        });

        const sourceTravel = scheduleTravel(
          {},
          cursor,
          sourceTravelDuration,
          String(sourceLeg?.sourceName || 'Route Start').trim(),
          selectedLabel,
          sourceTravelDistance,
          'A_TO_C',
          selectedIdNum,
        );
        cursor += sourceTravelDuration;

        const insertedRow = {
          ...selectedRow,
          type: 'attraction',
          item_type: 4,
          locationId: selectedIdNum,
          hotspot_ID: selectedIdNum,
          hotspotId: selectedIdNum,
          text: selectedLabel,
          name: selectedLabel,
          isManual: true,
          isMatrixPositioned: true,
          timeRange: this.callbacks.minutesRangeToTimeString(cursor, cursor + selectedDurationMinutes),
          hotspot_start_time: null,
          hotspot_end_time: null,
          isConflict: false,
          conflictReason: null,
        };
        cursor += selectedDurationMinutes;

        const selectedToAnchorTravel = scheduleTravel(
          {},
          cursor,
          selectedToAnchorDuration,
          selectedLabel,
          anchorLabel,
          selectedToAnchorDistance,
          'C_TO_B',
          toHotspotId,
        );
        cursor += selectedToAnchorDuration;

        const tailSource = baseMerged.slice(toRowIndex);
        const bodyRows = [sourceTravel, insertedRow, selectedToAnchorTravel, ...tailSource]
          .filter((row: any, index: number) => {
            if (index < 3) return true;
            if (!row) return false;
            if (row?.isMatrixSplitTravel === true) return false;
            if (Number(row?.locationId || row?.hotspot_ID || row?.hotspotId || 0) === selectedIdNum) return false;
            return true;
          });

        const rescheduledBody: any[] = [];
        const pendingHotelTravelRows: any[] = [];
        const pendingHotelRows: any[] = [];
        cursor = prefix.length > 0
          ? (this.callbacks.parseSegmentEndMinutes(prefix[prefix.length - 1]) ?? this.callbacks.parseSegmentStartMinutes(baseMerged[0]) ?? 8 * 60)
          : (this.callbacks.parseSegmentStartMinutes(baseMerged[0]) ?? 8 * 60);

        for (const row of bodyRows) {
          if (isTravelToHotelRow(row)) {
            pendingHotelTravelRows.push({ ...row });
            continue;
          }
          if (isHotelLikeRow(row)) {
            pendingHotelRows.push({ ...row });
            continue;
          }
          if (isTravelRow(row)) {
            const duration = Math.max(1, Math.round(Number(row?.matrixDurationMin || this.callbacks.getPreviewRowDurationMinutes(row) || 10)));
            rescheduledBody.push({
              ...row,
              timeRange: this.callbacks.minutesRangeToTimeString(cursor, cursor + duration),
              hotspot_start_time: null,
              hotspot_end_time: null,
            });
            cursor += duration;
            continue;
          }
          if (isAttractionRow(row)) {
            const duration = Math.max(1, Math.round(Number(this.callbacks.getPreviewRowDurationMinutes(row) || 60)));
            rescheduledBody.push({
              ...row,
              timeRange: this.callbacks.minutesRangeToTimeString(cursor, cursor + duration),
              hotspot_start_time: null,
              hotspot_end_time: null,
            });
            cursor += duration;
            continue;
          }
          rescheduledBody.push({ ...row });
        }

        for (const row of pendingHotelTravelRows) {
          const previousStop = [...rescheduledBody].reverse().find((candidate: any) => isAttractionRow(candidate)) || null;
          const previousStopId = Number(previousStop?.locationId || previousStop?.hotspot_ID || previousStop?.hotspotId || 0) || 0;
          const savedHotelLeg: any = previousStopId > 0
            ? await this.callbacks.resolveSavedRuleHotspotToRouteHotelLeg(
                tx,
                0,
                Number(routeId || 0),
                previousStopId,
              )
            : null;
          const duration = Math.max(
            1,
            Math.round(Number(savedHotelLeg?.durationMin || this.callbacks.getPreviewRowDurationMinutes(row) || row?.matrixDurationMin || 10)),
          );
          const previousStopLabel = String(savedHotelLeg?.fromName || previousStop?.text || previousStop?.name || row?.fromName || 'Previous Stop').trim();
          const hotelRow = pendingHotelRows[0] || null;
          const hotelCheckinText = String(hotelRow?.text || hotelRow?.name || '').trim();
          const hotelCheckinMatch = hotelCheckinText.match(/check-?in\s+at\s+(.+)/i);
          const hotelNameFromCheckin = String(hotelCheckinMatch?.[1] || '').trim();
          const hotelLabel = hotelNameFromCheckin && hotelNameFromCheckin.toLowerCase() !== 'hotel'
            ? hotelNameFromCheckin
            : String(savedHotelLeg?.hotelLabel || 'Hotel').trim();
          const hotelDistanceKm = this.callbacks.chooseReliableTravelDistanceKm(
            savedHotelLeg?.distanceKm != null ? Number(savedHotelLeg.distanceKm) : null,
            row?.matrixDistanceKm != null ? Number(row.matrixDistanceKm) : (row?.distanceKm != null ? Number(row.distanceKm) : null),
          );
          rescheduledBody.push({
            ...row,
            item_type: 5,
            text: `Travel to ${hotelLabel}`,
            name: `Travel to ${hotelLabel}`,
            fromName: previousStopLabel,
            toName: hotelLabel,
            from: previousStopLabel,
            to: hotelLabel,
            displayFromName: previousStopLabel,
            displayToName: hotelLabel,
            timeRange: this.callbacks.minutesRangeToTimeString(cursor, cursor + duration),
            matrixDistanceKm: hotelDistanceKm,
            distanceKm: hotelDistanceKm,
            travelDistanceKm: hotelDistanceKm,
            distance: hotelDistanceKm != null ? `${Number(hotelDistanceKm).toFixed(2)} km` : row?.distance,
            matrixDurationMin: duration,
            duration: this.callbacks.formatPreviewTravelDuration(duration),
            hotspot_start_time: null,
            hotspot_end_time: null,
          });
          cursor += duration;
        }

        for (const hotelRow of pendingHotelRows) {
          rescheduledBody.push({
            ...hotelRow,
            timeRange: this.callbacks.minutesRangeToTimeString(cursor, cursor),
            hotspot_start_time: null,
            hotspot_end_time: null,
            isZeroDurationHotel: true,
          });
        }

        const rescheduled = this.callbacks.finalizeMatrixPreviewTimeline([...prefix, ...rescheduledBody]);
        this.callbacks.assertTimelineOrderForMatrixPreview(rescheduled, selectedIdNum);
        return rescheduled;
      }
    }

    if (!fromHotspotId) {
      return this.callbacks.finalizeMatrixPreviewTimeline(baseMerged);
    }

    const destinationSideHotelSlot =
      manualInsertionFit?.destinationInsertionMode === true
      || String(bestSlot?.routeFitType || '').toUpperCase() === 'DESTINATION_SIDE_INSERTION'
      || String(bestSlot?.slotContext || '').toUpperCase() === 'LAST_SOURCE_HOTSPOT_TO_DESTINATION_HOTEL'
      || String(bestSlot?.source || '').toUpperCase() === 'FINAL_TRAVEL_TO_HOTEL_SPLIT'
      || String(bestSlot?.source || '').toUpperCase() === 'DESTINATION_CITY_AFTER_REACHED';

 // Find key matrix indices
    const fromRowIndex = baseMerged.findIndex(
      (row: any) => Number(row?.locationId || row?.hotspot_ID || row?.hotspotId || 0) === fromHotspotId
        && isAttractionRow(row),
    );
    let toRowIndex = baseMerged.findIndex(
      (row: any) => Number(row?.locationId || row?.hotspot_ID || row?.hotspotId || 0) === toHotspotId
        && isAttractionRow(row),
    );

    if (toRowIndex < 0 && destinationSideHotelSlot) {
      toRowIndex = baseMerged.findIndex((row: any, index: number) => (
        index > fromRowIndex && isHotelLikeRow(row)
      ));
    }

    if (fromRowIndex < 0 || toRowIndex < 0 || fromRowIndex >= toRowIndex) {
 console.warn('[ManualTimelineBuild] cannot_reschedule_matrix_slot', {
        selectedHotspotId: selectedIdNum,
        fromHotspotId,
        toHotspotId,
        destinationSideHotelSlot,
        fromRowIndex,
        toRowIndex,
        slotSource: bestSlot?.source || null,
        slotContext: bestSlot?.slotContext || null,
      });
      return this.callbacks.finalizeMatrixPreviewTimeline(baseMerged);
    }

    const insertedRowIndex = baseMerged.findIndex(
      (row: any) => row?.isMatrixPositioned === true && Number(row?.locationId || row?.hotspot_ID || row?.hotspotId || 0) === selectedIdNum,
    );
    if (insertedRowIndex < 0) return baseMerged;

 // Find A_TO_C and C_TO_B split travel rows
    const aToCRowIndex = baseMerged.findIndex(
      (row: any) => row?.isMatrixSplitTravel === true && row?.matrixTravelLeg === 'A_TO_C',
    );
    const cToBRowIndex = baseMerged.findIndex(
      (row: any) => row?.isMatrixSplitTravel === true && row?.matrixTravelLeg === 'C_TO_B',
    );

    if (aToCRowIndex < 0 || cToBRowIndex < 0) return baseMerged;

 console.log('[ManualTimelineBuild] replacing_travel_row', {
      fromHotspotId,
      toHotspotId,
      fromRowIndex,
      toRowIndex,
      aToCRowIndex,
      cToBRowIndex,
      selectedRowIndex: insertedRowIndex,
    });

 // Fetch or estimate durations
    const normalizePositiveMinutes = (value: any): number | null => {
      const num = Number(value);
      return Number.isFinite(num) && num > 0 ? Math.max(1, Math.round(num)) : null;
    };
    const savedAcLeg: any = tx
      ? await this.callbacks.resolveSavedRuleHotspotToHotspotLeg(tx, fromHotspotId, selectedIdNum)
      : null;
    const savedCbLeg: any = tx
      ? (
          destinationSideHotelSlot || toHotspotId <= 0
            ? await this.callbacks.resolveSavedRuleHotspotToRouteHotelLeg(
                tx,
                0,
                Number(routeId || 0),
                selectedIdNum,
              )
            : await this.callbacks.resolveSavedRuleHotspotToHotspotLeg(tx, selectedIdNum, toHotspotId)
        )
      : null;
    const slotAcDurationMin =
      normalizePositiveMinutes(savedAcLeg?.durationMin)
      ?? normalizePositiveMinutes(bestSlot?.acDurationMin)
      ?? normalizePositiveMinutes(bestSlot?.routeLegSummary?.acDurationMin);
    const slotCbDurationMin =
      normalizePositiveMinutes(savedCbLeg?.durationMin)
      ?? normalizePositiveMinutes(bestSlot?.cbDurationMin)
      ?? normalizePositiveMinutes(bestSlot?.routeLegSummary?.cbDurationMin);
    const cachedAcDurationMin = tx ? await this.callbacks.getCachedRouteDurationMinutes(tx, fromHotspotId, selectedIdNum) : null;
    const cachedCbDurationMin = tx && toHotspotId > 0 && !destinationSideHotelSlot
      ? await this.callbacks.getCachedRouteDurationMinutes(tx, selectedIdNum, toHotspotId)
      : null;
    const acDurationMin =
      slotAcDurationMin
      ?? normalizePositiveMinutes(cachedAcDurationMin)
      ?? this.callbacks.estimateDurationFromDistance(Number(bestSlot?.acOsrmDistanceKm || null))
      ?? 10;
    const cbDurationMin =
      slotCbDurationMin
      ?? normalizePositiveMinutes(cachedCbDurationMin)
      ?? this.callbacks.estimateDurationFromDistance(Number(bestSlot?.cbOsrmDistanceKm || null))
      ?? 10;
    const acEstimated = slotAcDurationMin == null && normalizePositiveMinutes(cachedAcDurationMin) == null;
    const cbEstimated = slotCbDurationMin == null && normalizePositiveMinutes(cachedCbDurationMin) == null;

    const selectedRow = baseMerged[insertedRowIndex];
    const selectedHotspotMaster = hotspotMasters.find((hotspot: any) => Number(hotspot?.hotspot_ID || hotspot?.id || 0) === selectedIdNum) || null;
    const selectedDurationMinutes =
      this.callbacks.getHotspotDurationMinutesFromMasterFirst(selectedHotspotMaster, selectedRow)
      || this.callbacks.getPreviewRowDurationFromDurationFieldsOnly(selectedRow)
      || 60;

    const fromRow = baseMerged[fromRowIndex];
    const fromEndMinutes = this.callbacks.parseSegmentEndMinutes(fromRow);
    if (fromEndMinutes === null) return baseMerged;

 // 1) Keep all rows through A unchanged.
    const prefix = baseMerged.slice(0, fromRowIndex + 1).map((row: any) => ({ ...row }));

 // 2) Build the mandatory matrix split block with single forward cursor.
    let cursor = fromEndMinutes;
    const acStartMin = cursor;
    const acEndMin = cursor + acDurationMin;
    cursor = acEndMin;

    const cStartMin = cursor;
    const cEndMin = cursor + selectedDurationMinutes;
    cursor = cEndMin;

    const cbStartMin = cursor;
    const cbEndMin = cursor + cbDurationMin;
    cursor = cbEndMin;

    const acDistanceKm = this.callbacks.chooseReliableTravelDistanceKm(
      savedAcLeg?.distanceKm != null ? Number(savedAcLeg.distanceKm) : null,
      bestSlot?.acOsrmDistanceKm != null ? Number(bestSlot.acOsrmDistanceKm) : null,
    );
    const cbDistanceKm = this.callbacks.chooseReliableTravelDistanceKm(
      savedCbLeg?.distanceKm != null ? Number(savedCbLeg.distanceKm) : null,
      bestSlot?.cbOsrmDistanceKm != null ? Number(bestSlot.cbOsrmDistanceKm) : null,
    );

    const aToCRow = {
      ...baseMerged[aToCRowIndex],
      item_type: Number(baseMerged[aToCRowIndex]?.item_type || 3),
      isMatrixSplitTravel: true,
      isMatrixReconnectedTravel: true,
      matrixTravelLeg: 'A_TO_C',
      fromName: String(bestSlot?.fromName || prefix[prefix.length - 1]?.text || prefix[prefix.length - 1]?.name || 'Previous Stop').trim(),
      toName: String(baseMerged[insertedRowIndex]?.text || baseMerged[insertedRowIndex]?.name || manualInsertionFit?.selectedHotspotName || `Hotspot #${selectedIdNum}`).trim(),
      from: String(bestSlot?.fromName || prefix[prefix.length - 1]?.text || prefix[prefix.length - 1]?.name || 'Previous Stop').trim(),
      to: String(baseMerged[insertedRowIndex]?.text || baseMerged[insertedRowIndex]?.name || manualInsertionFit?.selectedHotspotName || `Hotspot #${selectedIdNum}`).trim(),
      displayFromName: String(bestSlot?.fromName || prefix[prefix.length - 1]?.text || prefix[prefix.length - 1]?.name || 'Previous Stop').trim(),
      displayToName: String(baseMerged[insertedRowIndex]?.text || baseMerged[insertedRowIndex]?.name || manualInsertionFit?.selectedHotspotName || `Hotspot #${selectedIdNum}`).trim(),
      text: `Travel to ${String(baseMerged[insertedRowIndex]?.text || baseMerged[insertedRowIndex]?.name || manualInsertionFit?.selectedHotspotName || `Hotspot #${selectedIdNum}`).trim()}`,
      name: `Travel to ${String(baseMerged[insertedRowIndex]?.text || baseMerged[insertedRowIndex]?.name || manualInsertionFit?.selectedHotspotName || `Hotspot #${selectedIdNum}`).trim()}`,
      matrixDistanceKm: acDistanceKm,
      distanceKm: acDistanceKm,
      travelDistanceKm: acDistanceKm,
      matrixDurationMin: acDurationMin,
      isEstimatedTravel: acEstimated,
      duration: `${Math.round(acDurationMin)} Min`,
      distance: acDistanceKm != null ? `${Number(acDistanceKm).toFixed(1)} km` : null,
      timeRange: this.callbacks.minutesRangeToTimeString(acStartMin, acEndMin),
      locationId: selectedIdNum,
      hotspot_ID: selectedIdNum,
      hotspotId: selectedIdNum,
      hotspot_start_time: null,
      hotspot_end_time: null,
    };
 console.log('[ManualTimelineBuild] split_A_TO_C', {
      fromName: aToCRow.fromName,
      toName: aToCRow.toName,
      text: aToCRow.text,
      locationId: aToCRow.locationId,
      hotspot_ID: aToCRow.hotspot_ID,
      timeRange: aToCRow.timeRange,
    });

    const insertedRow = {
      ...baseMerged[insertedRowIndex],
      type: 'attraction',
      item_type: 4,
      locationId: selectedIdNum,
      hotspot_ID: selectedIdNum,
      hotspotId: selectedIdNum,
      text: String(baseMerged[insertedRowIndex]?.text || baseMerged[insertedRowIndex]?.name || manualInsertionFit?.selectedHotspotName || `Hotspot #${selectedIdNum}`).trim(),
      name: String(baseMerged[insertedRowIndex]?.name || baseMerged[insertedRowIndex]?.text || manualInsertionFit?.selectedHotspotName || `Hotspot #${selectedIdNum}`).trim(),
      isManual: true,
      isMatrixPositioned: true,
      timeRange: this.callbacks.minutesRangeToTimeString(cStartMin, cEndMin),
      isConflict: false,
      conflictReason: null,
      matrixFit: {
        ...(baseMerged[insertedRowIndex]?.matrixFit || {}),
        routeLegSummary: {
          directDistanceKm: bestSlot?.abOsrmDistanceKm != null ? Number(bestSlot.abOsrmDistanceKm) : null,
          viaDistanceKm: bestSlot?.insertedRouteDistanceKm != null ? Number(bestSlot.insertedRouteDistanceKm) : null,
          extraDistanceKm: bestSlot?.roadDetourKm != null ? Math.max(0, Number(bestSlot.roadDetourKm)) : null,
          acDistanceKm: acDistanceKm,
          cbDistanceKm: cbDistanceKm,
          acDurationMin,
          cbDurationMin,
        },
      },
      hotspot_start_time: null,
      hotspot_end_time: null,
    };

 console.log('[ManualTimelineBuild] inserted_C_attraction', {
      selectedHotspotId: selectedIdNum,
      fromHotspotId,
      toHotspotId,
      text: insertedRow.text,
      insertedTimeRange: insertedRow?.timeRange || null,
    });

    const cToBRow = {
      ...baseMerged[cToBRowIndex],
      item_type: Number(baseMerged[cToBRowIndex]?.item_type || 3),
      isMatrixSplitTravel: true,
      isMatrixReconnectedTravel: true,
      matrixTravelLeg: 'C_TO_B',
      fromName: String(insertedRow?.text || insertedRow?.name || manualInsertionFit?.selectedHotspotName || `Hotspot #${selectedIdNum}`).trim(),
      toName: String(savedCbLeg?.hotelLabel || savedCbLeg?.toName || bestSlot?.toName || baseMerged[toRowIndex]?.text || baseMerged[toRowIndex]?.name || 'Next Stop').trim(),
      from: String(insertedRow?.text || insertedRow?.name || manualInsertionFit?.selectedHotspotName || `Hotspot #${selectedIdNum}`).trim(),
      to: String(savedCbLeg?.hotelLabel || savedCbLeg?.toName || bestSlot?.toName || baseMerged[toRowIndex]?.text || baseMerged[toRowIndex]?.name || 'Next Stop').trim(),
      displayFromName: String(insertedRow?.text || insertedRow?.name || manualInsertionFit?.selectedHotspotName || `Hotspot #${selectedIdNum}`).trim(),
      displayToName: String(savedCbLeg?.hotelLabel || savedCbLeg?.toName || bestSlot?.toName || baseMerged[toRowIndex]?.text || baseMerged[toRowIndex]?.name || 'Next Stop').trim(),
      text: `Travel to ${String(savedCbLeg?.hotelLabel || savedCbLeg?.toName || bestSlot?.toName || baseMerged[toRowIndex]?.text || baseMerged[toRowIndex]?.name || 'Next Stop').trim()}`,
      name: `Travel to ${String(savedCbLeg?.hotelLabel || savedCbLeg?.toName || bestSlot?.toName || baseMerged[toRowIndex]?.text || baseMerged[toRowIndex]?.name || 'Next Stop').trim()}`,
      matrixDistanceKm: cbDistanceKm,
      distanceKm: cbDistanceKm,
      travelDistanceKm: cbDistanceKm,
      matrixDurationMin: cbDurationMin,
      isEstimatedTravel: cbEstimated,
      duration: `${Math.round(cbDurationMin)} Min`,
      distance: cbDistanceKm != null ? `${Number(cbDistanceKm).toFixed(1)} km` : null,
      timeRange: this.callbacks.minutesRangeToTimeString(cbStartMin, cbEndMin),
      locationId: toHotspotId,
      hotspot_ID: toHotspotId,
      hotspotId: toHotspotId,
      hotspot_start_time: null,
      hotspot_end_time: null,
    };
 console.log('[ManualTimelineBuild] split_C_TO_B', {
      fromName: cToBRow.fromName,
      toName: cToBRow.toName,
      text: cToBRow.text,
      locationId: cToBRow.locationId,
      hotspot_ID: cToBRow.hotspot_ID,
      timeRange: cToBRow.timeRange,
    });

 // 3) Continue with remaining rows in logical baseline order, skipping replaced originals.
    const tailSource = baseMerged.slice(toRowIndex);
    const tailRows: any[] = [];

    for (const row of tailSource) {
      if (!row) continue;
      if (Number(row?.locationId || row?.hotspot_ID || row?.hotspotId || 0) === selectedIdNum) continue;
      if (row?.isMatrixSplitTravel === true) continue;

 // Remove original A->B travel if matrix C_TO_B split is present.
      if (isTravelRow(row)) {
        const rowTarget = String(row?.toName || row?.text || row?.name || '').trim().toLowerCase();
        const bTarget = String(bestSlot?.toName || '').trim().toLowerCase();
        if (rowTarget && bTarget && rowTarget.includes(bTarget) && tailRows.length === 0) {
          continue;
        }
      }

      tailRows.push({ ...row });
    }

 // RESET cursor before scheduling loop
 // The cursor was advanced during aToCRow/insertedRow/cToBRow construction for pre-calculation.
 // The actual scheduling must start from fromEndMinutes so travel AC begins immediately after A ends.
    cursor = fromEndMinutes;

    const bodyRows = [aToCRow, insertedRow, cToBRow, ...tailRows];

 // 4) Reschedule body rows with one forward cursor.
    const rescheduledBody: any[] = [];
    const pendingHotelTravelRows: any[] = [];
    const pendingHotelRows: any[] = [];

    for (const row of bodyRows) {
      if (isTravelToHotelRow(row)) {
        pendingHotelTravelRows.push({ ...row });
        continue;
      }

      if (isHotelLikeRow(row)) {
        pendingHotelRows.push({ ...row });
        continue;
      }

      if (isTravelRow(row)) {
        const duration = row?.isMatrixSplitTravel === true
          ? Math.max(1, Math.round(Number(row?.matrixDurationMin || this.callbacks.getPreviewRowDurationMinutes(row) || 10)))
          : Math.max(1, Math.round(Number(this.callbacks.getPreviewRowDurationMinutes(row) || 10)));
        const start = cursor;
        const end = cursor + duration;
        cursor = end;
        rescheduledBody.push({
          ...row,
          matrixDurationMin: row?.isMatrixSplitTravel === true ? duration : row?.matrixDurationMin,
          duration: row?.isMatrixSplitTravel === true ? `${duration} Min` : row?.duration,
          timeRange: this.callbacks.minutesRangeToTimeString(start, end),
          hotspot_start_time: null,
          hotspot_end_time: null,
        });
 console.log('[ManualTimelineBuild] recalculated_downstream_row', {
          type: 'travel',
          text: String(row?.text || row?.name || ''),
          timeRange: this.callbacks.minutesRangeToTimeString(start, end),
        });
        continue;
      }

      if (isAttractionRow(row)) {
        const duration = Math.max(1, Math.round(Number(this.callbacks.getPreviewRowDurationMinutes(row) || 60)));
        const start = cursor;
        const end = cursor + duration;
        cursor = end;
        rescheduledBody.push({
          ...row,
          timeRange: this.callbacks.minutesRangeToTimeString(start, end),
          hotspot_start_time: null,
          hotspot_end_time: null,
        });
 console.log('[ManualTimelineBuild] recalculated_downstream_row', {
          type: 'attraction',
          text: String(row?.text || row?.name || ''),
          timeRange: this.callbacks.minutesRangeToTimeString(start, end),
        });
        continue;
      }

 // Preserve other segment types while advancing cursor if they carry duration.
      const fallbackDuration = Math.max(0, Math.round(Number(this.callbacks.getPreviewRowDurationMinutes(row) || 0)));
      const start = cursor;
      const end = cursor + fallbackDuration;
      cursor = end;
      rescheduledBody.push({
        ...row,
        timeRange: fallbackDuration > 0 ? this.callbacks.minutesRangeToTimeString(start, end) : row?.timeRange,
        hotspot_start_time: null,
        hotspot_end_time: null,
      });
 console.log('[ManualTimelineBuild] recalculated_downstream_row', {
        type: String(row?.type || 'other').toLowerCase(),
        text: String(row?.text || row?.name || ''),
        timeRange: fallbackDuration > 0 ? this.callbacks.minutesRangeToTimeString(start, end) : row?.timeRange,
      });
    }

    for (const row of pendingHotelTravelRows) {
      const duration = Math.max(1, Math.round(Number(this.callbacks.getPreviewRowDurationMinutes(row) || row?.matrixDurationMin || 10)));
      const start = cursor;
      const end = cursor + duration;
      const previousStop = [...rescheduledBody].reverse().find((candidate: any) => isAttractionRow(candidate)) || null;
      const previousStopLabel = String(previousStop?.text || previousStop?.name || row?.fromName || 'Previous Stop').trim();
      const hotelRow = pendingHotelRows[0] || null;
      const hotelCheckinText = String(hotelRow?.text || hotelRow?.name || '').trim();
      const hotelCheckinMatch = hotelCheckinText.match(/check-?in\s+at\s+(.+)/i);
      const hotelNameFromCheckin = String(hotelCheckinMatch?.[1] || '').trim();
      const hotelLabel = hotelNameFromCheckin && hotelNameFromCheckin.toLowerCase() !== 'hotel'
        ? hotelNameFromCheckin
        : 'Hotel';
      cursor = end;
      rescheduledBody.push({
        ...row,
        item_type: 5,
        text: `Travel to ${hotelLabel}`,
        name: `Travel to ${hotelLabel}`,
        fromName: previousStopLabel,
        toName: hotelLabel,
        from: previousStopLabel,
        to: hotelLabel,
        displayFromName: previousStopLabel,
        displayToName: hotelLabel,
        isMatrixReconnectedTravel: true,
        timeRange: this.callbacks.minutesRangeToTimeString(start, end),
        matrixDurationMin: row?.matrixDurationMin ?? duration,
        duration: row?.duration || `${duration} Min`,
        hotspot_start_time: null,
        hotspot_end_time: null,
      });
    }

    for (const hotelRow of pendingHotelRows) {
      rescheduledBody.push({
        ...hotelRow,
        timeRange: this.callbacks.minutesRangeToTimeString(cursor, cursor),
        hotspot_start_time: null,
        hotspot_end_time: null,
        isZeroDurationHotel: true,
      });
    }

 // 5) Deduplicate consecutive travel rows targeting same destination, preferring split rows.
    const dedupedBody: any[] = [];
    for (const row of rescheduledBody) {
      if (!row) continue;
      const prev = dedupedBody[dedupedBody.length - 1];
      const rowIsTravel = isTravelRow(row);
      const prevIsTravel = prev ? isTravelRow(prev) : false;
      if (rowIsTravel && prevIsTravel) {
        const prevTarget = String(prev?.toName || prev?.text || prev?.name || '').trim().toLowerCase();
        const rowTarget = String(row?.toName || row?.text || row?.name || '').trim().toLowerCase();
        if (prevTarget && rowTarget && prevTarget === rowTarget) {
          const prevIsSplit = prev?.isMatrixSplitTravel === true;
          const rowIsSplit = row?.isMatrixSplitTravel === true;
          if (prevIsSplit && !rowIsSplit) {
            continue;
          }
          if (!prevIsSplit && rowIsSplit) {
            dedupedBody[dedupedBody.length - 1] = row;
            continue;
          }
          continue;
        }
      }
      dedupedBody.push(row);
    }

    const rescheduled = [...prefix, ...dedupedBody];

    const dayEndMinutes = Number(params.routeEndMinutes || 20 * 60);
    const finalArrivalMin = Math.max(0, cursor);
    const exceedsDayEnd = finalArrivalMin > dayEndMinutes;
    const dayOverflowMinutes = exceedsDayEnd ? Math.ceil(finalArrivalMin - dayEndMinutes) : 0;

    if (manualInsertionFit) {
      manualInsertionFit.timingMode = 'RESCHEDULED';
      manualInsertionFit.rescheduleApplied = true;
      manualInsertionFit.timeShiftMinutes = null;
      manualInsertionFit.finalArrivalTime = this.callbacks.minutesRangeToTimeString(finalArrivalMin, finalArrivalMin);
      manualInsertionFit.exceedsDayEnd = exceedsDayEnd;
      manualInsertionFit.dayOverflowMinutes = dayOverflowMinutes;
    }

    const withOrder = this.callbacks.finalizeMatrixPreviewTimeline(rescheduled);

 console.log('[ManualTimelineBuild] final_order', withOrder.map((row: any, index: number) => ({
      index,
      type: String(row?.type || '').toLowerCase(),
      text: String(row?.text || row?.name || ''),
      hotspotId: Number(row?.locationId || row?.hotspot_ID || row?.hotspotId || row?.hotspot_id || 0) || null,
      matrixLeg: row?.matrixTravelLeg || null,
      timeRange: String(row?.timeRange || ''),
    })));

    this.callbacks.assertTimelineOrderForMatrixPreview(withOrder, selectedIdNum);

    return withOrder;
  }

}
