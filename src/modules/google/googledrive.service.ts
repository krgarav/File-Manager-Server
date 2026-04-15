import { BadRequestException, forwardRef, Inject, Injectable } from '@nestjs/common';
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

  async authorize(ownerId: string, userId: string) {
    this.integrationService.enforceRateLimit(`${ownerId}:${userId}:google-drive:authorize`, 20, 60_000);

    const scopes = [
      'https://www.googleapis.com/auth/drive.file',
      'https://www.googleapis.com/auth/userinfo.email',
    ];

    const state = this.integrationService.generateState();
    const redirectUrl = `${INTEGRATION_BASE_URL.replace(/\/$/, '')}/${GOOGLE_DRIVE_PATH.replace(/^\//, '')}`;

    this.integrationService.storeOAuthState(state, ownerId, userId, 'GOOGLE_DRIVE');
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
    try {
      await this.createAndSaveToken({ ownerId: authState.ownerId, userId: authState.userId, code });
    } catch (error: any) {
      const message = (error?.message ?? 'Unable to complete Google authorization').toString();
      return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Integration Error</title><style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#f7f9fb}.card{max-width:560px;background:#fff;border:1px solid #d9e3ea;border-radius:12px;padding:20px;box-shadow:0 6px 24px rgba(0,0,0,.06)}h1{margin:0 0 8px;font-size:20px}p{margin:0;color:#334e5c}</style></head><body><div class="card"><h1>Google Drive linking failed</h1><p>${message}</p></div></body></html>`;
    }

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
      userId: input.userId,
      type: 'GOOGLE_DRIVE',
      info,
      tokens: tokenData,
    });
  }

  private async getGoogleTokens(code: string): Promise<GoogleTokenResult> {
    let tokens;
    try {
      const tokenResponse = await this.oAuth2Client.getToken(code);
      tokens = tokenResponse.tokens;
    } catch {
      throw new BadRequestException('Google authorization code is invalid or expired.');
    }

    if (!tokens?.access_token) {
      throw new BadRequestException('Unable to get Google access token.');
    }

    const scope = tokens?.scope ?? '';
    if (!scope.includes('https://www.googleapis.com/auth/drive.file') && !scope.includes('drive.file')) {
      throw new BadRequestException(
        'INVALID_SCOPE: Please grant Google Drive file access and try linking again.',
      );
    }

    return {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      scope: tokens.scope,
      expiryDate: tokens.expiry_date,
    };
  }
}
