import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { GoogleDriveService } from '../google/googledrive.service';
import { AddIntegrationDto, GetTokenDto } from './integration.dto';
import { IntegrationService } from './integration.service';

@Controller('v1')
// @UsePipes(new ValidationPipe({ transform: true }))
export class IntegrationController {
  constructor(
    private readonly integrationService: IntegrationService,
    private readonly googleDriveService: GoogleDriveService,
  ) {}

  @Post('addcredentials')
  async addCredentials(
    @Query('workspace') workspace: string,
    @Query('userId') userId: string,
    @Body() body: AddIntegrationDto,
  ) {
    const ownerId = this.required(workspace, 'workspace');
    const normalizedUserId = this.optionalUserId(userId);
    this.integrationService.enforceRateLimit(`${ownerId}:${normalizedUserId}:add-credentials`, 40, 60_000);

    this.integrationService.verifyType(body?.type);

    if (body.type === 'GOOGLE_DRIVE') {
      const url = await this.googleDriveService.authorize(ownerId, normalizedUserId);
      return { success: true, data: { url } };
    }

    throw new BadRequestException('Unsupported integration type.');
  }

  @Get('integrations/get-code')
  async getGetAccessToken(
    @Query() queryData: GetTokenDto,
  ) {
    this.integrationService.enforceRateLimit('oauth-callback:get-code', 50, 60_000);
    return this.googleDriveService.getGetAccessToken(queryData, 'GOOGLE_DRIVE');
  }

  @Get('integrations/:type')
  async getGetAccessTokenByType(
    @Param('type') type: string,
    @Query() queryData: GetTokenDto,
  ) {
    this.integrationService.enforceRateLimit(`oauth-callback:${type}`, 50, 60_000);
    this.integrationService.verifyType(type);

    if (type === 'GOOGLE_DRIVE') {
      return this.googleDriveService.getGetAccessToken(queryData, type);
    }

    throw new BadRequestException('Unsupported integration type.');
  }

  @Get('connected')
  async getConnected(@Query('workspace') workspace: string, @Query('userId') userId?: string) {
    const ownerId = this.required(workspace, 'workspace');
    const normalizedUserId = this.optionalUserId(userId);
    const data = await this.integrationService.getConnectedIntergrations(ownerId, normalizedUserId);
    return { success: true, data };
  }

  private required(value: string, name: string): string {
    const normalized = (value ?? '').trim();
    if (!normalized) {
      throw new BadRequestException(`${name} is required`);
    }
    if (normalized.length > 120) {
      throw new BadRequestException(`${name} is too long`);
    }
    return normalized;
  }

  private optionalUserId(userId?: string, fallback?: string): string {
    const normalized = (userId ?? fallback ?? '').trim();
    if (!normalized) {
      throw new BadRequestException('userId is required');
    }
    if (normalized.length > 120) {
      throw new BadRequestException('userId is too long');
    }
    return normalized;
  }
}
