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
  ) {
    return this.fileManagerService.fileOperations(this.requiredWorkspace(workspace), body);
  }

  @Get('GetImage')
  async getImage(
    @Query('workspace') workspace: string,
    @Query('path') pathValue: string,
    @Query('id') id: string,
  ) {
    const data = await this.fileManagerService.getImage(
      this.requiredWorkspace(workspace),
      pathValue,
      id,
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
    @Query('path') pathQuery: string,
    @Body('path') pathBody: string,
    @UploadedFiles() files: UploadedFile[],
  ) {
    const pathValue = pathQuery ?? pathBody ?? '/';
    return this.fileManagerService.saveUpload(
      this.requiredWorkspace(workspace),
      pathValue,
      files ?? [],
    );
  }

  @Post('Download')
  @Header('Access-Control-Expose-Headers', 'Content-Disposition')
  async download(
    @Query('workspace') workspace: string,
    @Body() body: { path?: string; names?: string[]; data?: Array<{ name?: string }> },
    @Res({ passthrough: true }) response: Response,
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
      this.requiredWorkspace(workspace),
      body?.path ?? '/',
      names,
    );

    response.setHeader('Content-Disposition', `attachment; filename="${fileData.fileName}"`);
    return new StreamableFile(fileData.stream as unknown as Readable, { type: fileData.mimeType });
  }

  private requiredWorkspace(workspace: string) {
    const normalized = (workspace ?? '').trim();
    if (!normalized) {
      throw new BadRequestException('workspace is required');
    }
    if (normalized.length > 120) {
      throw new BadRequestException('workspace is too long');
    }
    return normalized;
  }
}
