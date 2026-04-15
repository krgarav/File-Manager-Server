import { BadRequestException, Injectable } from '@nestjs/common';
import { google, drive_v3 } from 'googleapis';
import { Readable } from 'stream';
import { extname } from 'path';
import { IntegrationService } from '../integrations/integration.service';

type OperationBody = {
  action?: string;
  path?: string;
  name?: string;
  newName?: string;
  targetPath?: string;
  names?: string[];
  data?: Array<{ name?: string; isFile?: boolean }>;
};

type UploadedFile = {
  originalname?: string;
  filename?: string;
  mimetype?: string;
  buffer: Buffer;
};

type DriveItem = drive_v3.Schema$File;
type AccountSelector = { userId?: string; integrationId?: string; email?: string };

@Injectable()
export class FileManagerService {
  private readonly oAuth2Client;

  constructor(private readonly integrationService: IntegrationService) {
    this.oAuth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      process.env.MI_COMMON_CALLBACK_URL,
    );
  }

  async fileOperations(workspace: string, body: OperationBody, selector: AccountSelector = {}) {
    const action = (body?.action ?? '').toLowerCase();

    switch (action) {
      case 'read':
        return this.read(workspace, body.path ?? '/', selector);
      case 'create':
        return this.createFolder(workspace, body.path ?? '/', body.name ?? 'New Folder', selector);
      case 'delete':
        return this.deleteItems(workspace, body.path ?? '/', this.getNamesFromBody(body), selector);
      case 'rename':
        return this.renameItem(workspace, body.path ?? '/', body.name ?? '', body.newName ?? '', selector);
      case 'copy':
        return this.copyItems(workspace, body.path ?? '/', body.targetPath ?? '/', this.getNamesFromBody(body), selector);
      case 'move':
        return this.moveItems(workspace, body.path ?? '/', body.targetPath ?? '/', this.getNamesFromBody(body), selector);
      case 'details':
        return this.getDetails(workspace, body.path ?? '/', this.getNamesFromBody(body), selector);
      default:
        throw new BadRequestException(`Unsupported action: ${body?.action}`);
    }
  }

  async getImage(workspace: string, pathValue: string, id?: string, selector: AccountSelector = {}) {
    const { drive } = await this.getWorkspaceDrive(workspace, selector);

    let fileId = id ?? '';
    if (!fileId) {
      const parentId = await this.resolvePathToFolderId(workspace, pathValue, selector);
      const name = this.getLeafName(pathValue);
      if (!name) {
        throw new BadRequestException('Image identifier is missing');
      }

      const file = await this.findItemByName(drive, parentId, name);
      if (!file?.id) {
        throw new BadRequestException('Image not found');
      }
      fileId = file.id;
    }

    const response = await drive.files.get(
      { fileId, alt: 'media' },
      { responseType: 'stream' },
    );

    const meta = await drive.files.get({ fileId, fields: 'id,name,mimeType' });

    return {
      stream: response.data as NodeJS.ReadableStream,
      extension: extname(meta.data.name ?? '').toLowerCase(),
      mimeType: meta.data.mimeType ?? 'application/octet-stream',
    };
  }

  async saveUpload(workspace: string, pathValue: string, files: UploadedFile[], selector: AccountSelector = {}) {
    if (!files?.length) {
      throw new BadRequestException('No files uploaded');
    }

    const { drive } = await this.getWorkspaceDrive(workspace, selector);
    const parentId = await this.resolvePathToFolderId(workspace, pathValue, selector);

    for (const file of files) {
      const safeName = (file.originalname || file.filename || 'file').trim();
      if (!safeName) {
        continue;
      }

      await drive.files.create({
        requestBody: {
          name: safeName,
          parents: [parentId],
        },
        media: {
          mimeType: file.mimetype || 'application/octet-stream',
          body: Readable.from(file.buffer),
        },
        fields: 'id',
      });
    }

    return this.read(workspace, pathValue || '/', selector);
  }

  async getDownloadStream(workspace: string, pathValue: string, names: string[], selector: AccountSelector = {}) {
    if (!names?.length) {
      throw new BadRequestException('No file selected for download');
    }

    const { drive } = await this.getWorkspaceDrive(workspace, selector);
    const parentId = await this.resolvePathToFolderId(workspace, pathValue, selector);
    const target = await this.findItemByName(drive, parentId, names[0]);

    if (!target?.id || target.mimeType === 'application/vnd.google-apps.folder') {
      throw new BadRequestException('Only file download is supported');
    }

    const response = await drive.files.get(
      { fileId: target.id, alt: 'media' },
      { responseType: 'stream' },
    );

    return {
      stream: response.data as NodeJS.ReadableStream,
      fileName: target.name ?? 'download.bin',
      mimeType: target.mimeType ?? 'application/octet-stream',
    };
  }

  private async read(workspace: string, pathValue: string, selector: AccountSelector = {}) {
    const { drive } = await this.getWorkspaceDrive(workspace, selector);
    const currentFolderId = await this.resolvePathToFolderId(workspace, pathValue, selector);

    const listResponse = await drive.files.list({
      q: `'${currentFolderId}' in parents and trashed=false`,
      fields: 'files(id,name,mimeType,size,createdTime,modifiedTime)',
      pageSize: 1000,
    });

    const files = (listResponse.data.files ?? []).map((item) => this.mapDriveItem(item, pathValue));

    const cwdName = this.normalizePath(pathValue) === '/'
      ? `Google Drive (${workspace})`
      : this.getLeafName(pathValue) || `Google Drive (${workspace})`;

    return {
      cwd: {
        id: currentFolderId,
        name: cwdName,
        isFile: false,
        hasChild: true,
        type: '',
        filterPath: this.parentPath(pathValue),
      },
      files,
      error: null,
    };
  }

  private async createFolder(workspace: string, pathValue: string, name: string, selector: AccountSelector = {}) {
    const { drive } = await this.getWorkspaceDrive(workspace, selector);
    const parentId = await this.resolvePathToFolderId(workspace, pathValue, selector);
    const safeName = name.trim();

    if (!safeName) {
      throw new BadRequestException('Folder name is required');
    }

    const existing = await this.findItemByName(drive, parentId, safeName);
    if (!existing?.id) {
      await drive.files.create({
        requestBody: {
          name: safeName,
          mimeType: 'application/vnd.google-apps.folder',
          parents: [parentId],
        },
        fields: 'id',
      });
    }

    return this.read(workspace, pathValue, selector);
  }

  private async deleteItems(workspace: string, pathValue: string, names: string[], selector: AccountSelector = {}) {
    if (!names.length) {
      throw new BadRequestException('No file or folder selected');
    }

    const { drive } = await this.getWorkspaceDrive(workspace, selector);
    const parentId = await this.resolvePathToFolderId(workspace, pathValue, selector);

    for (const name of names) {
      const item = await this.findItemByName(drive, parentId, name);
      if (item?.id) {
        await drive.files.delete({ fileId: item.id });
      }
    }

    return this.read(workspace, pathValue, selector);
  }

  private async renameItem(workspace: string, pathValue: string, currentName: string, newName: string, selector: AccountSelector = {}) {
    const safeCurrent = currentName.trim();
    const safeNew = newName.trim();

    if (!safeCurrent || !safeNew) {
      throw new BadRequestException('Both current and new names are required');
    }

    const { drive } = await this.getWorkspaceDrive(workspace, selector);
    const parentId = await this.resolvePathToFolderId(workspace, pathValue, selector);
    const source = await this.findItemByName(drive, parentId, safeCurrent);

    if (!source?.id) {
      throw new BadRequestException('Source item not found');
    }

    await drive.files.update({
      fileId: source.id,
      requestBody: { name: safeNew },
      fields: 'id',
    });

    return this.read(workspace, pathValue, selector);
  }

  private async copyItems(workspace: string, pathValue: string, targetPath: string, names: string[], selector: AccountSelector = {}) {
    if (!names.length) {
      throw new BadRequestException('No file or folder selected');
    }

    const { drive } = await this.getWorkspaceDrive(workspace, selector);
    const sourceParentId = await this.resolvePathToFolderId(workspace, pathValue, selector);
    const targetParentId = await this.resolvePathToFolderId(workspace, targetPath, selector);

    for (const name of names) {
      const item = await this.findItemByName(drive, sourceParentId, name);
      if (!item?.id) {
        continue;
      }

      if (item.mimeType === 'application/vnd.google-apps.folder') {
        throw new BadRequestException('Folder copy is not supported by Google Drive API');
      }

      await drive.files.copy({
        fileId: item.id,
        requestBody: {
          name: item.name ?? name,
          parents: [targetParentId],
        },
        fields: 'id',
      });
    }

    return this.read(workspace, targetPath, selector);
  }

  private async moveItems(workspace: string, pathValue: string, targetPath: string, names: string[], selector: AccountSelector = {}) {
    if (!names.length) {
      throw new BadRequestException('No file or folder selected');
    }

    const { drive } = await this.getWorkspaceDrive(workspace, selector);
    const sourceParentId = await this.resolvePathToFolderId(workspace, pathValue, selector);
    const targetParentId = await this.resolvePathToFolderId(workspace, targetPath, selector);

    for (const name of names) {
      const item = await this.findItemByName(drive, sourceParentId, name);
      if (!item?.id) {
        continue;
      }

      await drive.files.update({
        fileId: item.id,
        addParents: targetParentId,
        removeParents: sourceParentId,
        fields: 'id,parents',
      });
    }

    return this.read(workspace, targetPath, selector);
  }

  private async getDetails(workspace: string, pathValue: string, names: string[], selector: AccountSelector = {}) {
    if (!names.length) {
      return { details: null, error: null };
    }

    const { drive } = await this.getWorkspaceDrive(workspace, selector);
    const parentId = await this.resolvePathToFolderId(workspace, pathValue, selector);
    const item = await this.findItemByName(drive, parentId, names[0]);

    if (!item) {
      throw new BadRequestException('File not found');
    }

    return {
      details: {
        id: item.id,
        name: item.name,
        size: Number(item.size ?? 0),
        isFile: item.mimeType !== 'application/vnd.google-apps.folder',
        dateModified: item.modifiedTime ?? null,
        dateCreated: item.createdTime ?? null,
        type: item.mimeType === 'application/vnd.google-apps.folder'
          ? ''
          : extname(item.name ?? ''),
      },
      error: null,
    };
  }

  private async getWorkspaceDrive(workspace: string, selector: AccountSelector = {}) {
    const ownerId = this.normalizeWorkspace(workspace);

    const integrationData = await this.integrationService.getTokenOrApiKey({
      ownerId,
      type: 'GOOGLE_DRIVE',
      userId: selector.userId,
      integrationId: selector.integrationId,
      email: selector.email,
    });

    this.oAuth2Client.setCredentials({
      access_token: integrationData.tokens.accessToken,
      refresh_token: integrationData.tokens.refreshToken,
    });

    return {
      ownerId,
      drive: google.drive({ version: 'v3', auth: this.oAuth2Client }),
    };
  }

  private async resolvePathToFolderId(workspace: string, pathValue: string, selector: AccountSelector = {}) {
    const { drive } = await this.getWorkspaceDrive(workspace, selector);
    const rootName = this.getWorkspaceRootName(workspace);
    const workspaceRoot = await this.ensureFolder(drive, 'root', rootName);

    const normalizedPath = this.normalizePath(pathValue);
    if (normalizedPath === '/') {
      return workspaceRoot.id as string;
    }

    const segments = normalizedPath.split('/').filter(Boolean);
    let currentParentId = workspaceRoot.id as string;

    for (const segment of segments) {
      const folder = await this.findItemByName(drive, currentParentId, segment);
      if (!folder?.id || folder.mimeType !== 'application/vnd.google-apps.folder') {
        throw new BadRequestException(`Folder not found: ${segment}`);
      }
      currentParentId = folder.id;
    }

    return currentParentId;
  }

  private async ensureFolder(drive: drive_v3.Drive, parentId: string, name: string) {
    const existing = await this.findItemByName(drive, parentId, name, true);
    if (existing?.id) {
      return existing;
    }

    const created = await drive.files.create({
      requestBody: {
        name,
        mimeType: 'application/vnd.google-apps.folder',
        parents: [parentId],
      },
      fields: 'id,name,mimeType,size,createdTime,modifiedTime',
    });

    return created.data;
  }

  private async findItemByName(
    drive: drive_v3.Drive,
    parentId: string,
    name: string,
    onlyFolder = false,
  ) {
    const escapedName = name.replace(/'/g, "\\'");
    let query = `'${parentId}' in parents and trashed=false and name='${escapedName}'`;

    if (onlyFolder) {
      query += ` and mimeType='application/vnd.google-apps.folder'`;
    }

    const response = await drive.files.list({
      q: query,
      pageSize: 1,
      fields: 'files(id,name,mimeType,size,createdTime,modifiedTime)',
    });

    return response.data.files?.[0] ?? null;
  }

  private mapDriveItem(item: DriveItem, pathValue: string) {
    const isFolder = item.mimeType === 'application/vnd.google-apps.folder';

    return {
      id: item.id,
      name: item.name,
      isFile: !isFolder,
      size: Number(item.size ?? 0),
      dateModified: item.modifiedTime ?? null,
      dateCreated: item.createdTime ?? null,
      hasChild: isFolder,
      type: isFolder ? '' : extname(item.name ?? ''),
      filterPath: this.normalizePath(pathValue),
    };
  }

  private normalizeWorkspace(workspace: string) {
    const normalized = (workspace ?? '').trim();
    if (!normalized) {
      throw new BadRequestException('workspace is required');
    }
    if (normalized.length > 120) {
      throw new BadRequestException('workspace is too long');
    }
    return normalized;
  }

  private getWorkspaceRootName(workspace: string) {
    return `MakeForms-${workspace}`;
  }

  private getLeafName(pathValue: string) {
    const parts = this.normalizePath(pathValue).split('/').filter(Boolean);
    return parts[parts.length - 1] ?? '';
  }

  private normalizePath(pathValue: string) {
    const pathString = `/${(pathValue ?? '/').replace(/\\/g, '/').replace(/^\/+/, '')}`;
    return pathString.replace(/\/+/g, '/');
  }

  private parentPath(pathValue: string) {
    const normalized = this.normalizePath(pathValue);
    if (normalized === '/') {
      return '/';
    }

    const parts = normalized.split('/').filter(Boolean);
    parts.pop();
    return parts.length ? `/${parts.join('/')}/` : '/';
  }

  private getNamesFromBody(body: OperationBody) {
    if (Array.isArray(body.names) && body.names.length) {
      return body.names.map((name) => String(name).trim()).filter(Boolean);
    }

    if (Array.isArray(body.data) && body.data.length) {
      return body.data
        .map((item) => item?.name)
        .filter((name): name is string => Boolean(name))
        .map((name) => name.trim())
        .filter(Boolean);
    }

    return [];
  }
}
