// Shared API response envelope. Every endpoint returns this shape.

export interface ApiError {
  code: string;
  message: string;
  details?: unknown;
}

export type ApiResponse<T> =
  | {
      success: true;
      data: T;
      requestId: string;
    }
  | {
      success: false;
      error: ApiError;
      requestId: string;
    };
