import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';
import {
  IntegrationRecord,
  IntegrationType,
  SaveRedirectDto,
} from './integration.dto';

type RedirectRecord = {
  redirectUrl: string;
  expiresAt: number;
};

type OAuthStateRecord = {
  ownerId: string;
  type: IntegrationType;
  expiresAt: number;
};

@Injectable()
export class IntegrationService {
  private readonly allowedTypes = new Set<IntegrationType>(['GOOGLE_DRIVE']);
  private readonly integrations = new Map<string, IntegrationRecord>();
  private readonly oauthStates = new Map<string, OAuthStateRecord>();
  private readonly redirects = new Map<string, RedirectRecord>();
  private readonly rateLimits = new Map<string, { count: number; resetAt: number }>();

  verifyType(type: string): asserts type is IntegrationType {
    if (!this.allowedTypes.has(type as IntegrationType)) {
      throw new BadRequestException('Unsupported integration type.');
    }
  }

  saveRedirectToCommon(data: SaveRedirectDto) {
    this.redirects.set(data.state, {
      redirectUrl: data.redirect_url,
      expiresAt: Date.now() + 10 * 60_000,
    });

    return { success: true };
  }

  storeOAuthState(state: string, ownerId: string, type: IntegrationType) {
    this.oauthStates.set(state, {
      ownerId,
      type,
      expiresAt: Date.now() + 5 * 60_000,
    });
  }

  consumeOAuthState(state: string, type: IntegrationType): OAuthStateRecord {
    const record = this.oauthStates.get(state);
    this.oauthStates.delete(state);

    if (!record || record.expiresAt < Date.now()) {
      throw new BadRequestException('Code verify error');
    }

    if (record.type !== type) {
      throw new BadRequestException('OAuth state mismatch');
    }

    return record;
  }

  saveIntegrationDB(integrationData: {
    ownerId: string;
    type: IntegrationType;
    tokens: IntegrationRecord['tokens'];
    info?: string;
  }) {
    const { ownerId, type, tokens, info } = integrationData;

    const record: IntegrationRecord = {
      ownerId,
      type,
      tokens: {
        accessToken: this.encryptToken(tokens.accessToken),
        refreshToken: tokens.refreshToken
          ? this.encryptToken(tokens.refreshToken)
          : undefined,
        scope: tokens.scope,
        expiryDate: tokens.expiryDate,
      },
      info,
      isActive: true,
      isDeleted: false,
      updatedAt: new Date().toISOString(),
    };

    this.integrations.set(this.key(ownerId, type), record);
    return record;
  }

  getTokenOrApiKey({ ownerId, type }: { ownerId: string; type: IntegrationType }) {
    const integration = this.integrations.get(this.key(ownerId, type));

    if (!integration || !integration.isActive || integration.isDeleted) {
      throw new BadRequestException('Integration not connected');
    }

    return {
      ...integration,
      tokens: {
        accessToken: this.decryptToken(integration.tokens.accessToken),
        refreshToken: integration.tokens.refreshToken
          ? this.decryptToken(integration.tokens.refreshToken)
          : undefined,
        scope: integration.tokens.scope,
        expiryDate: integration.tokens.expiryDate,
      },
    };
  }

  getConnectedIntergrations(ownerId: string) {
    const items: Array<{ type: IntegrationType; isActive: boolean; updatedAt: string }> = [];

    for (const value of this.integrations.values()) {
      if (value.ownerId === ownerId && value.isActive && !value.isDeleted) {
        items.push({ type: value.type, isActive: value.isActive, updatedAt: value.updatedAt });
      }
    }

    return items;
  }

  enforceRateLimit(key: string, limit = 40, windowMs = 60_000) {
    const now = Date.now();
    const existing = this.rateLimits.get(key);

    if (!existing || existing.resetAt <= now) {
      this.rateLimits.set(key, { count: 1, resetAt: now + windowMs });
      return;
    }

    if (existing.count >= limit) {
      throw new HttpException('Rate limit exceeded', HttpStatus.TOO_MANY_REQUESTS);
    }

    existing.count += 1;
  }

  generateState(): string {
    return randomBytes(24).toString('base64url');
  }

  private key(ownerId: string, type: IntegrationType): string {
    return `${ownerId}:${type}`;
  }

  private encryptToken(value: string): string {
    const secret = process.env.INTEGRATION_ENCRYPTION_KEY ?? '';
    if (!secret) {
      throw new HttpException('Integration encryption key is missing', HttpStatus.INTERNAL_SERVER_ERROR);
    }

    const mask = createHash('sha256').update(secret).digest('hex').slice(0, 24);
    return Buffer.from(`${mask}:${value}`).toString('base64url');
  }

  private decryptToken(value: string): string {
    const decoded = Buffer.from(value, 'base64url').toString('utf8');
    const tokenValue = decoded.split(':').slice(1).join(':');

    if (!tokenValue) {
      throw new BadRequestException('Stored token is invalid');
    }

    return tokenValue;
  }
}
