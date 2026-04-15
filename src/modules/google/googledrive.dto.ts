export interface GoogleTokenResult {
  accessToken: string;
  refreshToken?: string;
  scope?: string;
  expiryDate?: number;
}

export interface GoogleCreateTokenInput {
  ownerId: string;
  code: string;
}
