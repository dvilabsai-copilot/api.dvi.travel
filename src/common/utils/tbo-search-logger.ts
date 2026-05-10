import * as fs from 'fs';
import * as path from 'path';

/**
 * Dedicated logger for TBO search requests and responses
 * Writes to: logs/tbo-search-results.log
 */
export class TBOSearchResultsLogger {
  private static logDir = path.join(process.cwd(), 'logs');
  private static logFile = path.join(this.logDir, 'tbo-search-results.log');
  private static maxLogSize = 50 * 1024 * 1024; // 50MB

  static {
    // Ensure logs directory exists
    if (!fs.existsSync(this.logDir)) {
      fs.mkdirSync(this.logDir, { recursive: true });
    }
  }

  /**
   * Log a TBO search request
   */
  static logSearchRequest(data: {
    cityCode: string;
    checkIn: string;
    checkOut: string;
    hotelCodes: string[];
    hotelCount: number;
    guests: { adults: number; children: number };
    guestNationality: string;
    chunkIndex?: number;
    totalChunks?: number;
    filters?: any;
  }): void {
    const timestamp = new Date().toISOString();
    const entry = {
      timestamp,
      type: 'REQUEST',
      ...data,
    };

    this.writeToLog(JSON.stringify(entry));
  }

  /**
   * Log a TBO search response with detailed hotel data
   */
  static logSearchResponse(data: {
    cityCode: string;
    checkIn: string;
    checkOut: string;
    hotelCodes: string[];
    requestDurationMs: number;
    statusCode?: number;
    statusDescription?: string;
    hotelCount: number;
    hotels?: Array<{
      HotelCode: string;
      HotelName?: string;
      HotelCategory?: string | number;
      HotelRating?: string | number;
      StarRating?: number;
      RoomCount?: number;
      Rooms?: Array<{
        RoomId?: string;
        RoomName?: string;
        TotalFare?: number;
        NetAmount?: number;
        Currency?: string;
        Inclusion?: string;
        CancelPolicies?: Array<{
          ChargeType?: string;
          Description?: string;
        }>;
        DayRates?: Array<Array<any>>;
      }>;
      Latitude?: number | string;
      Longitude?: number | string;
      StarRating?: number;
      Address?: string;
      Currency?: string;
    }>;
    error?: string;
    chunkIndex?: number;
    totalChunks?: number;
  }): void {
    const timestamp = new Date().toISOString();
    
    // Enrich hotels with detailed room information
    const enrichedHotels = (data.hotels || []).map((hotel) => ({
      HotelCode: hotel.HotelCode,
      HotelName: hotel.HotelName,
      HotelCategory: hotel.HotelCategory,
      HotelRating: hotel.HotelRating,
      StarRating: hotel.StarRating,
      Address: hotel.Address,
      Latitude: hotel.Latitude,
      Longitude: hotel.Longitude,
      Currency: hotel.Currency,
      RoomCount: hotel.RoomCount || (hotel.Rooms?.length || 0),
      Rooms: (hotel.Rooms || []).map((room, idx) => ({
        Index: idx,
        RoomId: room.RoomId,
        RoomName: room.RoomName,
        NetAmount: room.NetAmount,
        TotalFare: room.TotalFare,
        Currency: room.Currency,
        Inclusion: room.Inclusion,
        CancellationPolicy: room.CancelPolicies?.[0]?.ChargeType,
      })),
    }));

    const entry = {
      timestamp,
      type: 'RESPONSE',
      cityCode: data.cityCode,
      checkIn: data.checkIn,
      checkOut: data.checkOut,
      hotelCodes: data.hotelCodes,
      requestDurationMs: data.requestDurationMs,
      statusCode: data.statusCode,
      statusDescription: data.statusDescription,
      hotelCount: data.hotelCount,
      hotels: enrichedHotels,
      error: data.error,
      chunkIndex: data.chunkIndex,
      totalChunks: data.totalChunks,
    };

    this.writeToLog(JSON.stringify(entry));
  }

  /**
   * Log a TBO search error
   */
  static logSearchError(data: {
    cityCode?: string;
    checkIn?: string;
    checkOut?: string;
    error: string;
    errorType?: string;
    stack?: string;
    retryCount?: number;
    chunkIndex?: number;
  }): void {
    const timestamp = new Date().toISOString();
    const entry = {
      timestamp,
      type: 'ERROR',
      ...data,
    };

    this.writeToLog(JSON.stringify(entry));
  }

  /**
   * Log a summary of batch search
   */
  static logBatchSummary(data: {
    description: string;
    totalHotels: number;
    chunksProcessed: number;
    totalHotelsReturned: number;
    durationMs: number;
    successCount: number;
    failureCount: number;
    averageResponseTimeMs?: number;
  }): void {
    const timestamp = new Date().toISOString();
    const separator = '\n' + '='.repeat(100) + '\n';
    const entry = {
      timestamp,
      type: 'BATCH_SUMMARY',
      ...data,
    };

    this.writeToLog(separator + JSON.stringify(entry) + separator);
  }

  /**
   * Internal method to write to log file with rotation
   */
  private static writeToLog(entry: string): void {
    try {
      // Check if log file needs rotation
      if (fs.existsSync(this.logFile)) {
        const stats = fs.statSync(this.logFile);
        if (stats.size > this.maxLogSize) {
          this.rotateLogFile();
        }
      }

      // Append entry with timestamp
      const logEntry = `${entry}\n`;
      fs.appendFileSync(this.logFile, logEntry, 'utf8');
    } catch (error) {
      // Silently fail if logging fails (don't break the main flow)
      console.error('[TBOSearchResultsLogger] Failed to write log:', error);
    }
  }

  /**
   * Rotate log file when it exceeds max size
   */
  private static rotateLogFile(): void {
    try {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const backupFile = path.join(
        this.logDir,
        `tbo-search-results.${timestamp}.log`
      );
      fs.renameSync(this.logFile, backupFile);
      console.log(`[TBOSearchResultsLogger] Log rotated: ${backupFile}`);
    } catch (error) {
      console.error('[TBOSearchResultsLogger] Log rotation failed:', error);
    }
  }

  /**
   * Get the log file path (useful for debugging)
   */
  static getLogFilePath(): string {
    return this.logFile;
  }

  /**
   * Clear the log file (for testing)
   */
  static clearLog(): void {
    try {
      if (fs.existsSync(this.logFile)) {
        fs.unlinkSync(this.logFile);
      }
    } catch (error) {
      console.error('[TBOSearchResultsLogger] Failed to clear log:', error);
    }
  }
}
