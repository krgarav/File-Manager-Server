import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Patch,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtPayload } from '../auth/auth.dto';
import { Public } from '../auth/public.decorator';
import { GoogleDriveService } from '../google/googledrive.service';
import { AddIntegrationDto, GetTokenDto } from './integration.dto';
import { IntegrationService } from './integration.service';

@Controller('v1')
export class IntegrationController {
  constructor(
    private readonly integrationService: IntegrationService,
    private readonly googleDriveService: GoogleDriveService,
  ) {}

  @Post('addcredentials')
  async addCredentials(
    @Query('workspace') workspace: string,
    @Body() body: AddIntegrationDto,
    @CurrentUser() user: JwtPayload,
  ) {
    const ownerId = this.requiredWorkspace(workspace, user.workspace);
    const userId = user.sub;
    this.integrationService.enforceRateLimit(`${ownerId}:${userId}:add-credentials`, 40, 60_000);

    this.integrationService.verifyType(body?.type);

    if (body.type === 'GOOGLE_DRIVE') {
      const url = await this.googleDriveService.authorize(ownerId, userId);
      return { success: true, data: { url } };
    }

    throw new BadRequestException('Unsupported integration type.');
  }

  @Public()
  @Get('integrations/get-code')
  async getGetAccessToken(@Query() queryData: GetTokenDto) {
    this.integrationService.enforceRateLimit('oauth-callback:get-code', 50, 60_000);
    return this.googleDriveService.getGetAccessToken(queryData, 'GOOGLE_DRIVE');
  }

  @Public()
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
  async getConnected(
    @Query('workspace') workspace: string,
    @CurrentUser() user: JwtPayload,
  ) {
    const ownerId = this.requiredWorkspace(workspace, user.workspace);
    const data = await this.integrationService.getConnectedIntergrations(ownerId, user.sub);
    return { success: true, data };
  }

  @Get('integrations')
  async getAllIntegrations(
    @Query('workspace') workspace: string,
    @CurrentUser() user: JwtPayload,
  ) {
    const ownerId = this.requiredWorkspace(workspace, user.workspace);
    const data = await this.integrationService.getIntegrations(ownerId, user.sub, true);
    return { success: true, data };
  }

  @Patch('integrations/:integrationId/status')
  async setIntegrationStatus(
    @Param('integrationId') integrationId: string,
    @Query('workspace') workspace: string,
    @Body() body: { isActive?: boolean },
    @CurrentUser() user: JwtPayload,
  ) {
    const ownerId = this.requiredWorkspace(workspace, user.workspace);
    this.integrationService.enforceRateLimit(`${ownerId}:${user.sub}:integration-status`, 60, 60_000);

    if (typeof body?.isActive !== 'boolean') {
      throw new BadRequestException('isActive must be boolean');
    }

    const data = await this.integrationService.setIntegrationStatus({
      ownerId,
      userId: user.sub,
      integrationId,
      isActive: body.isActive,
    });

    return { success: true, data };
  }

  private requiredWorkspace(value: string, tokenWorkspace: string): string {
    const normalized = (value ?? '').trim();
    if (!normalized) {
      throw new BadRequestException('workspace is required');
    }
    if (normalized.length > 120) {
      throw new BadRequestException('workspace is too long');
    }
    if (normalized !== tokenWorkspace) {
      throw new BadRequestException('workspace does not match authenticated user');
    }
    return normalized;
  }
}
