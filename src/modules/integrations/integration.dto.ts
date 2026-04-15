export type IntegrationType = 'GOOGLE_DRIVE';

export interface AddIntegrationDto {
  type: IntegrationType;
}

export interface GetTokenDto {
  code: string;
  state: string;
}

export interface SaveRedirectDto {
  state: string;
  redirect_url: string;
}

export interface IntegrationRecord {
  ownerId: string;
  userId: string;
  type: IntegrationType;
  tokens: {
    accessToken: string;
    refreshToken?: string;
    scope?: string;
    expiryDate?: number;
  };
  info?: string;
  isActive: boolean;
  isDeleted: boolean;
  updatedAt: string;
  id?: string;
}
