import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';

@Catch()
export class StaahExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(StaahExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse();
    const request = ctx.getRequest();

    let httpStatus = HttpStatus.INTERNAL_SERVER_ERROR;
    let errorDesc = 'Internal server error';
    let details: string[] | undefined;

    if (exception instanceof HttpException) {
      httpStatus = exception.getStatus();
      const payload = exception.getResponse() as
        | string
        | { error_desc?: string; message?: string | string[]; error?: string };

      if (typeof payload === 'string') {
        errorDesc = payload;
      } else if (payload?.error_desc) {
        errorDesc = payload.error_desc;
      } else if (Array.isArray(payload?.message)) {
        details = payload.message;
        errorDesc = payload.message.join('; ');
      } else if (typeof payload?.message === 'string') {
        errorDesc = payload.message;
      } else if (typeof payload?.error === 'string') {
        errorDesc = payload.error;
      }
    } else if (exception instanceof Error) {
      errorDesc = exception.message || errorDesc;
    }

    if (httpStatus >= 500) {
      this.logger.error(
        `STAAH request failed: ${request.method} ${request.url} -> ${httpStatus} ${errorDesc}`,
        exception instanceof Error ? exception.stack : undefined,
      );
    } else {
      this.logger.warn(
        `STAAH request rejected: ${request.method} ${request.url} -> ${httpStatus} ${errorDesc}`,
      );
    }

    response.status(httpStatus).json({
      status: 'fail',
      error_desc: errorDesc,
      ...(details && details.length > 0 ? { details } : {}),
    });
  }
}
