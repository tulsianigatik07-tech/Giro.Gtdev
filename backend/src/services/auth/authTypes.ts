// Auth types. Payloads are intentionally minimal — never include sensitive data.

export interface AuthTokenPayload {
  userId: string;
  email: string;
}

export interface AuthenticatedUser {
  userId: string;
  email: string;
}
