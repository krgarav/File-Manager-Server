import { Module } from '@nestjs/common';
import { IntegrationModule } from '../integrations/integration.module';
import { FileManagerController } from './file-manager.controller';
import { FileManagerService } from './file-manager.service';

@Module({
  imports: [IntegrationModule],
  controllers: [FileManagerController],
  providers: [FileManagerService],
})
export class FileManagerModule {}
