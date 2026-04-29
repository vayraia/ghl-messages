import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const status =
      exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;

    const payload =
      exception instanceof HttpException
        ? exception.getResponse()
        : { statusCode: status, message: 'Internal server error' };

    if (status >= 500) {
      this.logger.error(
        {
          method: request.method,
          path: request.url,
          status,
          err:
            exception instanceof Error
              ? { name: exception.name, message: exception.message }
              : exception,
        },
        'Unhandled exception',
      );
    } else if (status === HttpStatus.BAD_REQUEST) {
      this.logger.warn(
        {
          method: request.method,
          path: request.url,
          status,
          requestId: request.headers['x-request-id'],
          body: request.body,
          response: payload,
        },
        'Validation failed',
      );
    }

    response
      .status(status)
      .json(
        typeof payload === 'string'
          ? { statusCode: status, message: payload }
          : { statusCode: status, ...(payload as object) },
      );
  }
}
