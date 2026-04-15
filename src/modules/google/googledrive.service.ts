import { forwardRef, Inject, Injectable } from '@nestjs/common';
import { google } from 'googleapis';
import { IntegrationService } from '../integrations/integration.service';
import { GetTokenDto } from '../integrations/integration.dto';
import { GoogleCreateTokenInput, GoogleTokenResult } from './googledrive.dto';

const INTEGRATION_BASE_URL = process.env.CURRENT_BASE_URL ?? 'http://localhost:3000';
const GOOGLE_DRIVE_PATH = process.env.GOOGLE_DRIVE_PATH ?? 'v1/integrations/GOOGLE_DRIVE';

@Injectable()
export class GoogleDriveService {
  private readonly oAuth2Client;

  constructor(
    @Inject(forwardRef(() => IntegrationService))
    private readonly integrationService: IntegrationService,
  ) {
    this.oAuth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      process.env.MI_COMMON_CALLBACK_URL,
    );
  }

  async authorize(ownerId: string) {
    this.integrationService.enforceRateLimit(`${ownerId}:google-drive:authorize`, 20, 60_000);

    const scopes = [
      'https://www.googleapis.com/auth/drive.file',
      'https://www.googleapis.com/auth/userinfo.email',
    ];

    const state = this.integrationService.generateState();
    const redirectUrl = `${INTEGRATION_BASE_URL.replace(/\/$/, '')}/${GOOGLE_DRIVE_PATH.replace(/^\//, '')}`;

    this.integrationService.storeOAuthState(state, ownerId, 'GOOGLE_DRIVE');
    this.integrationService.saveRedirectToCommon({ state, redirect_url: redirectUrl });

    return this.oAuth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: scopes,
      prompt: 'consent',
      state,
    });
  }

  async getGetAccessToken(data: GetTokenDto, type: 'GOOGLE_DRIVE') {
    const { code, state } = data;

    if (!code || code === 'undefined') {
      return `<a href="javascript:window.open('','_self').close();">Linked successfully. Close current tab.</a><script type="text/javascript">window.close();</script>`;
    }

    const authState = this.integrationService.consumeOAuthState(state, type);
    await this.createAndSaveToken({ ownerId: authState.ownerId, code });

    return `<a href="javascript:window.open('','_self').close();">Linked successfully. Close current tab.</a><script type="text/javascript">window.close();</script>`;
  }

  async createAndSaveToken(input: GoogleCreateTokenInput) {
    const tokenData = await this.getGoogleTokens(input.code);
    this.oAuth2Client.setCredentials({
      access_token: tokenData.accessToken,
      refresh_token: tokenData.refreshToken,
    });

    const oauth2 = google.oauth2({ auth: this.oAuth2Client, version: 'v2' });
    const userInfo = await oauth2.userinfo.get();
    const info = userInfo?.data?.email ?? '';

    return this.integrationService.saveIntegrationDB({
      ownerId: input.ownerId,
      type: 'GOOGLE_DRIVE',
      info,
      tokens: tokenData,
    });
  }

  private async getGoogleTokens(code: string): Promise<GoogleTokenResult> {
    const tokenResponse = await this.oAuth2Client.getToken(code);
    const tokens = tokenResponse.tokens;

    if (!tokens?.access_token) {
      throw new Error('Unable to get Google access token');
    }

    if (!tokens?.scope?.includes('https://www.googleapis.com/auth/drive.file')) {
      throw new Error('INVALID_SCOPE');
    }

    return {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      scope: tokens.scope,
      expiryDate: tokens.expiry_date,
    };
  }
}
