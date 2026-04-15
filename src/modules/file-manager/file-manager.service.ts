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
type AccountSelector = { userId: string; integrationId?: string; email?: string };

type LinkedIntegration = {
  id: string;
  type: 'GOOGLE_DRIVE';
  info?: string;
  isActive: boolean;
  updatedAt: string;
  userId: string;
};

type AccountContext = {
  ownerId: string;
  userId: string;
  integration: LinkedIntegration;
  accountFolderName: string;
  subPath: string;
};

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

  async fileOperations(workspace: string, body: OperationBody, selector: AccountSelector) {
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

  async getImage(workspace: string, pathValue: string, id: string | undefined, selector: AccountSelector) {
    const account = await this.resolveAccountContext(workspace, pathValue, selector);
    const { drive } = await this.getWorkspaceDrive(account.ownerId, account.userId, account.integration.id);

    let fileId = id ?? '';
    if (!fileId) {
      const parentId = await this.resolvePathToFolderId(account, selector);
      const name = this.getLeafName(account.subPath);
      if (!name) {
        throw new BadRequestException('Image identifier is missing');
      }

      const file = await this.findItemByName(drive, parentId, name);
      if (!file?.id) {
        throw new BadRequestException('Image not found');
      }
      fileId = file.id;
    }

    const response = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'stream' });
    const meta = await drive.files.get({ fileId, fields: 'id,name,mimeType' });

    return {
      stream: response.data as NodeJS.ReadableStream,
      extension: extname(meta.data.name ?? '').toLowerCase(),
      mimeType: meta.data.mimeType ?? 'application/octet-stream',
    };
  }

  async saveUpload(workspace: string, pathValue: string, files: UploadedFile[], selector: AccountSelector) {
    if (!files?.length) {
      throw new BadRequestException('No files uploaded');
    }

    const account = await this.resolveAccountContext(workspace, pathValue, selector);
    const { drive } = await this.getWorkspaceDrive(account.ownerId, account.userId, account.integration.id);
    const parentId = await this.resolvePathToFolderId(account, selector);

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

    return this.read(workspace, pathValue, selector);
  }

  async getDownloadStream(workspace: string, pathValue: string, names: string[], selector: AccountSelector) {
    if (!names?.length) {
      throw new BadRequestException('No file selected for download');
    }

    const account = await this.resolveAccountContext(workspace, pathValue, selector);
    const { drive } = await this.getWorkspaceDrive(account.ownerId, account.userId, account.integration.id);
    const parentId = await this.resolvePathToFolderId(account, selector);
    const target = await this.findItemByName(drive, parentId, names[0]);

    if (!target?.id || target.mimeType === 'application/vnd.google-apps.folder') {
      throw new BadRequestException('Only file download is supported');
    }

    const response = await drive.files.get({ fileId: target.id, alt: 'media' }, { responseType: 'stream' });

    return {
      stream: response.data as NodeJS.ReadableStream,
      fileName: target.name ?? 'download.bin',
      mimeType: target.mimeType ?? 'application/octet-stream',
    };
  }

  private async read(workspace: string, pathValue: string, selector: AccountSelector) {
    const ownerId = this.normalizeWorkspace(workspace);
    const normalizedPath = this.normalizePath(pathValue);

    if (normalizedPath === '/') {
      return this.readRoot(ownerId, selector.userId);
    }

    const account = await this.resolveAccountContext(workspace, pathValue, selector);
    const { drive } = await this.getWorkspaceDrive(ownerId, selector.userId, account.integration.id);
    const folderContext = await this.resolvePathWithCanonical(account, selector);
    const currentFolderId = folderContext.folderId;

    const listResponse = await drive.files.list({
      q: `'${currentFolderId}' in parents and trashed=false`,
      fields: 'files(id,name,mimeType,size,createdTime,modifiedTime)',
      pageSize: 1000,
    });

    const virtualPath = this.composeVirtualPath(account.accountFolderName, folderContext.canonicalSubPath);
    const files = (listResponse.data.files ?? []).map((item) => this.mapDriveItem(item, virtualPath));

    const cwdName =
      folderContext.canonicalSubPath === '/'
        ? account.accountFolderName
        : this.getLeafName(folderContext.canonicalSubPath);

    return {
      cwd: {
        id: currentFolderId,
        name: cwdName,
        isFile: false,
        hasChild: true,
        type: '',
        filterPath: this.parentPath(virtualPath),
      },
      files,
      error: null,
    };
  }

  private async readRoot(ownerId: string, userId: string) {
    const linked = await this.getLinkedIntegrations(ownerId, userId);

    return {
      cwd: {
        id: 'root',
        name: `Google Drive Accounts (${linked.length})`,
        isFile: false,
        hasChild: linked.length > 0,
        type: '',
        filterPath: '/',
      },
      files: linked.map((item) => ({
        id: item.id,
        name: this.getAccountFolderName(item),
        isFile: false,
        size: 0,
        dateModified: item.updatedAt,
        dateCreated: item.updatedAt,
        hasChild: true,
        type: '',
        filterPath: '/',
      })),
      error: null,
    };
  }

  private async createFolder(workspace: string, pathValue: string, name: string, selector: AccountSelector) {
    const account = await this.resolveAccountContext(workspace, pathValue, selector);
    const { drive } = await this.getWorkspaceDrive(account.ownerId, account.userId, account.integration.id);
    const parentId = await this.resolvePathToFolderId(account, selector);
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

  private async deleteItems(workspace: string, pathValue: string, names: string[], selector: AccountSelector) {
    this.rejectRootMutation(pathValue);

    if (!names.length) {
      throw new BadRequestException('No file or folder selected');
    }

    const account = await this.resolveAccountContext(workspace, pathValue, selector);
    const { drive } = await this.getWorkspaceDrive(account.ownerId, account.userId, account.integration.id);
    const parentId = await this.resolvePathToFolderId(account, selector);

    for (const name of names) {
      const item = await this.findItemByName(drive, parentId, name);
      if (item?.id) {
        await drive.files.delete({ fileId: item.id });
      }
    }

    return this.read(workspace, pathValue, selector);
  }

  private async renameItem(workspace: string, pathValue: string, currentName: string, newName: string, selector: AccountSelector) {
    this.rejectRootMutation(pathValue);

    const safeCurrent = currentName.trim();
    const safeNew = newName.trim();

    if (!safeCurrent || !safeNew) {
      throw new BadRequestException('Both current and new names are required');
    }

    const account = await this.resolveAccountContext(workspace, pathValue, selector);
    const { drive } = await this.getWorkspaceDrive(account.ownerId, account.userId, account.integration.id);
    const parentId = await this.resolvePathToFolderId(account, selector);
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

  private async copyItems(workspace: string, pathValue: string, targetPath: string, names: string[], selector: AccountSelector) {
    this.rejectRootMutation(pathValue);
    this.rejectRootMutation(targetPath);

    if (!names.length) {
      throw new BadRequestException('No file or folder selected');
    }

    const sourceAccount = await this.resolveAccountContext(workspace, pathValue, selector);
    const targetAccount = await this.resolveAccountContext(workspace, targetPath, selector);

    if (sourceAccount.integration.id !== targetAccount.integration.id) {
      throw new BadRequestException('Copy across different Google accounts is not supported.');
    }

    const { drive } = await this.getWorkspaceDrive(sourceAccount.ownerId, sourceAccount.userId, sourceAccount.integration.id);
    const sourceParentId = await this.resolvePathToFolderId(sourceAccount, selector);
    const targetParentId = await this.resolvePathToFolderId(targetAccount, selector);

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

  private async moveItems(workspace: string, pathValue: string, targetPath: string, names: string[], selector: AccountSelector) {
    this.rejectRootMutation(pathValue);
    this.rejectRootMutation(targetPath);

    if (!names.length) {
      throw new BadRequestException('No file or folder selected');
    }

    const sourceAccount = await this.resolveAccountContext(workspace, pathValue, selector);
    const targetAccount = await this.resolveAccountContext(workspace, targetPath, selector);

    if (sourceAccount.integration.id !== targetAccount.integration.id) {
      throw new BadRequestException('Move across different Google accounts is not supported.');
    }

    const { drive } = await this.getWorkspaceDrive(sourceAccount.ownerId, sourceAccount.userId, sourceAccount.integration.id);
    const sourceParentId = await this.resolvePathToFolderId(sourceAccount, selector);
    const targetParentId = await this.resolvePathToFolderId(targetAccount, selector);

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

  private async getDetails(workspace: string, pathValue: string, names: string[], selector: AccountSelector) {
    if (!names.length) {
      return { details: null, error: null };
    }

    const account = await this.resolveAccountContext(workspace, pathValue, selector);
    const { drive } = await this.getWorkspaceDrive(account.ownerId, account.userId, account.integration.id);
    const parentId = await this.resolvePathToFolderId(account, selector);
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
        type: item.mimeType === 'application/vnd.google-apps.folder' ? '' : extname(item.name ?? ''),
      },
      error: null,
    };
  }

  private async getWorkspaceDrive(ownerId: string, userId: string, integrationId: string) {
    const integrationData = await this.integrationService.getTokenOrApiKey({
      ownerId,
      type: 'GOOGLE_DRIVE',
      userId,
      integrationId,
    });

    this.oAuth2Client.setCredentials({
      access_token: integrationData.tokens.accessToken,
      refresh_token: integrationData.tokens.refreshToken,
    });

    return {
      drive: google.drive({ version: 'v3', auth: this.oAuth2Client }),
    };
  }

  private async resolveAccountContext(workspace: string, pathValue: string, selector: AccountSelector): Promise<AccountContext> {
    const ownerId = this.normalizeWorkspace(workspace);
    const userId = this.normalizeUserId(selector.userId);
    const linked = await this.getLinkedIntegrations(ownerId, userId);

    if (!linked.length) {
      throw new BadRequestException('No Google Drive accounts linked for this user.');
    }

    const normalizedPath = this.normalizePath(pathValue);

    if (selector.integrationId || selector.email) {
      const integration = linked.find((item) => {
        if (selector.integrationId && item.id === selector.integrationId) {
          return true;
        }
        if (selector.email && (item.info || '').toLowerCase() === selector.email.toLowerCase()) {
          return true;
        }
        return false;
      });

      if (!integration) {
        throw new BadRequestException('Selected Google account was not found for this user.');
      }

      const segments = normalizedPath.split('/').filter(Boolean);
      const accountFolderName = this.getAccountFolderName(integration);
      const hasAccountPrefix =
        segments[0] === integration.id ||
        segments[0] === accountFolderName ||
        segments[0] === (integration.info || '').trim();
      const subSegments = hasAccountPrefix ? segments.slice(1) : segments;
      const subPath = subSegments.length ? `/${subSegments.join('/')}` : '/';

      return {
        ownerId,
        userId,
        integration,
        accountFolderName,
        subPath,
      };
    }

    if (normalizedPath === '/') {
      throw new BadRequestException('Please open a linked Google account folder first.');
    }

    const segments = normalizedPath.split('/').filter(Boolean);
    const accountSegment = segments[0];
    const integration = linked.find(
      (item) =>
        item.id === accountSegment ||
        this.getAccountFolderName(item) === accountSegment ||
        (item.info || '').trim() === accountSegment,
    );

    if (!integration) {
      throw new BadRequestException(`Google account folder not found: ${accountSegment}`);
    }

    const subSegments = segments.slice(1);
    const subPath = subSegments.length ? `/${subSegments.join('/')}` : '/';
    const accountFolderName = this.getAccountFolderName(integration);

    return {
      ownerId,
      userId,
      integration,
      accountFolderName,
      subPath,
    };
  }

  private async resolvePathToFolderId(account: AccountContext, selector: AccountSelector) {
    const resolved = await this.resolvePathWithCanonical(account, selector);
    return resolved.folderId;
  }

  private async resolvePathWithCanonical(account: AccountContext, selector: AccountSelector) {
    const { drive } = await this.getWorkspaceDrive(account.ownerId, account.userId, account.integration.id);
    const rootName = this.getWorkspaceRootName(account.ownerId);
    const workspaceRoot = await this.ensureFolder(drive, 'root', rootName);

    if (account.subPath === '/') {
      return { folderId: workspaceRoot.id as string, canonicalSubPath: '/' };
    }

    const segments = account.subPath.split('/').filter(Boolean);
    let currentParentId = workspaceRoot.id as string;
    const canonicalSegments: string[] = [];

    for (const segment of segments) {
      const folder = await this.resolveFolderSegment(drive, currentParentId, segment);
      if (!folder) {
        throw new BadRequestException(`Folder not found: ${segment}`);
      }
      currentParentId = folder.id;
      canonicalSegments.push(folder.name);
    }

    return {
      folderId: currentParentId,
      canonicalSubPath: `/${canonicalSegments.join('/')}`,
    };
  }

  private async resolveFolderSegment(
    drive: drive_v3.Drive,
    parentId: string,
    segment: string,
  ): Promise<{ id: string; name: string } | null> {
    // Syncfusion can send either folder names or folder ids in path segments.
    try {
      const byId = await drive.files.get({
        fileId: segment,
        fields: 'id,name,mimeType,parents,trashed',
      });
      const parentIds = byId.data.parents ?? [];
      const isFolder = byId.data.mimeType === 'application/vnd.google-apps.folder';
      if (!byId.data.trashed && isFolder && parentIds.includes(parentId)) {
        if (byId.data.id && byId.data.name) {
          return { id: byId.data.id, name: byId.data.name };
        }
      }
    } catch {
      // Not an id in this account context, fallback to name lookup.
    }

    const byName = await this.findItemByName(drive, parentId, segment);
    if (byName?.id && byName.mimeType === 'application/vnd.google-apps.folder') {
      return { id: byName.id, name: byName.name ?? segment };
    }

    return null;
  }

  private async getLinkedIntegrations(ownerId: string, userId: string) {
    const data = await this.integrationService.getConnectedIntergrations(ownerId, userId);
    return data
      .filter((item) => item.type === 'GOOGLE_DRIVE' && item.isActive)
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)) as LinkedIntegration[];
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
      // Syncfusion expects folder paths like "/a/b/" (trailing slash), otherwise UI tree lookup can fail.
      filterPath: this.normalizeFilterPath(pathValue),
    };
  }

  private rejectRootMutation(pathValue: string) {
    if (this.normalizePath(pathValue) === '/') {
      throw new BadRequestException('Open a Google account folder before performing this action.');
    }
  }

  private getAccountFolderName(integration: LinkedIntegration) {
    const email = (integration.info || '').trim().toLowerCase();
    const emailSlug = email.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    const suffix = integration.id.slice(-6).toLowerCase();
    return emailSlug ? `drive-${emailSlug}-${suffix}` : `drive-account-${suffix}`;
  }

  private composeVirtualPath(accountFolderName: string, subPath: string) {
    if (subPath === '/') {
      return `/${accountFolderName}`;
    }

    return `/${accountFolderName}${subPath}`;
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

  private normalizeUserId(userId?: string) {
    const normalized = (userId ?? '').trim();
    if (!normalized) {
      throw new BadRequestException('userId is required');
    }
    if (normalized.length > 120) {
      throw new BadRequestException('userId is too long');
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

  private normalizeFilterPath(pathValue: string) {
    const normalized = this.normalizePath(pathValue);
    if (normalized === '/') {
      return '/';
    }

    return normalized.endsWith('/') ? normalized : `${normalized}/`;
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
