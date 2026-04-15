import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  InternalServerErrorException,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { createHash, randomBytes } from 'crypto';
import { IntegrationRecord, IntegrationType, SaveRedirectDto } from './integration.dto';
import { Integration, IntegrationDocument } from './integration.schema';

type RedirectRecord = {
  redirectUrl: string;
  expiresAt: number;
};

type OAuthStateRecord = {
  ownerId: string;
  userId: string;
  type: IntegrationType;
  expiresAt: number;
};

@Injectable()
export class IntegrationService implements OnModuleInit {
  private readonly logger = new Logger(IntegrationService.name);
  private readonly allowedTypes = new Set<IntegrationType>(['GOOGLE_DRIVE']);
  private readonly oauthStates = new Map<string, OAuthStateRecord>();
  private readonly redirects = new Map<string, RedirectRecord>();
  private readonly rateLimits = new Map<string, { count: number; resetAt: number }>();

  constructor(
    @InjectModel(Integration.name)
    private readonly integrationModel: Model<IntegrationDocument>,
  ) {}

  async onModuleInit() {
    // Remove legacy single-account index if it exists so one workspace can link multiple Google accounts.
    try {
      const indexes = await this.integrationModel.collection.indexes();
      const legacyIndex = indexes.find(
        (index) =>
          index?.unique === true &&
          index?.key?.ownerId === 1 &&
          index?.key?.type === 1 &&
          !Object.prototype.hasOwnProperty.call(index?.key, 'userId'),
      );

      if (legacyIndex?.name) {
        await this.integrationModel.collection.dropIndex(legacyIndex.name);
        this.logger.log(`Dropped legacy index: ${legacyIndex.name}`);
      }
    } catch (error: any) {
      this.logger.warn(`Index migration skipped: ${error?.message ?? 'unknown error'}`);
    }
  }

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

  storeOAuthState(state: string, ownerId: string, userId: string, type: IntegrationType) {
    this.oauthStates.set(state, {
      ownerId,
      userId,
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

  async saveIntegrationDB(integrationData: {
    ownerId: string;
    userId: string;
    type: IntegrationType;
    tokens: IntegrationRecord['tokens'];
    info?: string;
  }) {
    const { ownerId, userId, type, tokens, info } = integrationData;
    const normalizedEmail = this.normalizeEmail(info);

    const updatePayload = {
      ownerId,
      userId,
      type,
      encryptedAccessToken: this.encryptToken(tokens.accessToken),
      encryptedRefreshToken: tokens.refreshToken ? this.encryptToken(tokens.refreshToken) : null,
      scope: tokens.scope ?? null,
      expiryDate: tokens.expiryDate ?? null,
      info: normalizedEmail,
      isActive: true,
      isDeleted: false,
    };

    try {
      const saved = await this.integrationModel
        .findOneAndUpdate(
          { ownerId, userId, type, info: normalizedEmail },
          { $set: updatePayload },
          { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true },
        )
        .lean();

      if (!saved) {
        throw new InternalServerErrorException('Unable to save integration');
      }

      return this.mapDocumentToRecord(saved as IntegrationDocument);
    } catch (error: any) {
      if (error?.code === 11000) {
        throw new BadRequestException('This Google email is already linked for this user.');
      }
      throw error;
    }
  }

  async getTokenOrApiKey({
    ownerId,
    type,
    userId,
    integrationId,
    email,
  }: {
    ownerId: string;
    type: IntegrationType;
    userId?: string;
    integrationId?: string;
    email?: string;
  }) {
    const query: Record<string, unknown> = {
      ownerId,
      type,
      isActive: true,
      isDeleted: false,
    };

    if (integrationId) {
      query._id = integrationId;
    }

    if (userId) {
      query.userId = userId;
    }

    if (email) {
      query.info = this.normalizeEmail(email);
    }

    const integration = await this.integrationModel
      .findOne(query)
      .sort({ updatedAt: -1 })
      .lean();

    if (!integration) {
      throw new BadRequestException('Integration not connected');
    }

    return this.mapDocumentToRecord(integration as IntegrationDocument);
  }

  async getConnectedIntergrations(ownerId: string, userId?: string) {
    const query: Record<string, unknown> = { ownerId, isActive: true, isDeleted: false };

    if (userId) {
      query.userId = userId;
    }

    const integrations = await this.integrationModel
      .find(query)
      .select({ _id: 1, userId: 1, type: 1, info: 1, isActive: 1, updatedAt: 1 })
      .lean();

    return integrations.map((item) => {
      const raw = item as unknown as Record<string, any>;

      return {
        id: String(raw._id),
        userId: raw.userId,
        type: raw.type as IntegrationType,
        info: raw.info,
        isActive: Boolean(raw.isActive),
        updatedAt: raw.updatedAt
          ? new Date(raw.updatedAt).toISOString()
          : new Date().toISOString(),
      };
    });
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

  private mapDocumentToRecord(doc: IntegrationDocument | Record<string, any>): IntegrationRecord {
    const rawDoc = doc as Record<string, any>;

    return {
      id: rawDoc._id ? String(rawDoc._id) : undefined,
      ownerId: rawDoc.ownerId,
      userId: rawDoc.userId,
      type: rawDoc.type,
      tokens: {
        accessToken: this.decryptToken(rawDoc.encryptedAccessToken),
        refreshToken: rawDoc.encryptedRefreshToken ? this.decryptToken(rawDoc.encryptedRefreshToken) : undefined,
        scope: rawDoc.scope ?? undefined,
        expiryDate: rawDoc.expiryDate ?? undefined,
      },
      info: rawDoc.info ?? '',
      isActive: Boolean(rawDoc.isActive),
      isDeleted: Boolean(rawDoc.isDeleted),
      updatedAt: rawDoc.updatedAt ? new Date(rawDoc.updatedAt).toISOString() : new Date().toISOString(),
    };
  }

  private normalizeEmail(value?: string) {
    return (value ?? '').trim().toLowerCase();
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
