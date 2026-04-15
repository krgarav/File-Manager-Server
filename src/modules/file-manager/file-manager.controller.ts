import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  Post,
  Query,
  Res,
  StreamableFile,
  UploadedFiles,
  UseInterceptors,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { Response } from 'express';
import { Readable } from 'stream';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtPayload } from '../auth/auth.dto';
import { FileManagerService } from './file-manager.service';

type UploadedFile = {
  originalname?: string;
  filename?: string;
  mimetype?: string;
  buffer: Buffer;
};

@Controller('api/FileManager')
export class FileManagerController {
  constructor(private readonly fileManagerService: FileManagerService) {}

  @Post('FileOperations')
  async fileOperations(
    @Query('workspace') workspace: string,
    @Body() body: Record<string, unknown>,
    @CurrentUser() user: JwtPayload,
    @Query('integrationId') integrationId?: string,
    @Query('integrationEmail') integrationEmail?: string,
  ) {
    return this.fileManagerService.fileOperations(
      this.requiredWorkspace(workspace, user.workspace),
      body,
      this.selector(user.sub, integrationId, integrationEmail),
    );
  }

  @Get('GetImage')
  async getImage(
    @Query('workspace') workspace: string,
    @CurrentUser() user: JwtPayload,
    @Query('path') pathValue: string,
    @Query('id') id: string,
    @Query('integrationId') integrationId?: string,
    @Query('integrationEmail') integrationEmail?: string,
  ) {
    const data = await this.fileManagerService.getImage(
      this.requiredWorkspace(workspace, user.workspace),
      pathValue,
      id,
      this.selector(user.sub, integrationId, integrationEmail),
    );

    return new StreamableFile(data.stream as unknown as Readable, {
      type: data.mimeType,
      disposition: 'inline',
    });
  }

  @Post('Upload')
  @UseInterceptors(
    FilesInterceptor('uploadFiles', 50, {
      storage: memoryStorage(),
      limits: { fileSize: 25 * 1024 * 1024 },
    }),
  )
  async upload(
    @Query('workspace') workspace: string,
    @CurrentUser() user: JwtPayload,
    @Query('path') pathQuery: string,
    @Body('path') pathBody: string,
    @UploadedFiles() files: UploadedFile[],
    @Query('integrationId') integrationId?: string,
    @Query('integrationEmail') integrationEmail?: string,
  ) {
    const pathValue = pathQuery ?? pathBody ?? '/';
    return this.fileManagerService.saveUpload(
      this.requiredWorkspace(workspace, user.workspace),
      pathValue,
      files ?? [],
      this.selector(user.sub, integrationId, integrationEmail),
    );
  }

  @Post('Download')
  @Header('Access-Control-Expose-Headers', 'Content-Disposition')
  async download(
    @Query('workspace') workspace: string,
    @CurrentUser() user: JwtPayload,
    @Body() body: { path?: string; names?: string[]; data?: Array<{ name?: string }> },
    @Res({ passthrough: true }) response: Response,
    @Query('integrationId') integrationId?: string,
    @Query('integrationEmail') integrationEmail?: string,
  ) {
    const names =
      body?.names && body.names.length
        ? body.names
        : Array.isArray(body?.data)
          ? body.data
              .map((item) => item?.name)
              .filter((name): name is string => Boolean(name))
          : [];

    const fileData = await this.fileManagerService.getDownloadStream(
      this.requiredWorkspace(workspace, user.workspace),
      body?.path ?? '/',
      names,
      this.selector(user.sub, integrationId, integrationEmail),
    );

    response.setHeader('Content-Disposition', `attachment; filename="${fileData.fileName}"`);
    return new StreamableFile(fileData.stream as unknown as Readable, { type: fileData.mimeType });
  }

  private requiredWorkspace(workspace: string, tokenWorkspace: string) {
    const normalized = (workspace ?? '').trim();
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

  private selector(userId: string, integrationId?: string, integrationEmail?: string) {
    const normalizedUserId = userId?.trim();
    if (!normalizedUserId) {
      throw new BadRequestException('userId is required');
    }
    if (normalizedUserId.length > 120) {
      throw new BadRequestException('userId is too long');
    }

    return {
      userId: normalizedUserId,
      integrationId: integrationId?.trim() || undefined,
      email: integrationEmail?.trim() || undefined,
    };
  }
}
