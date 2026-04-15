import { forwardRef, Module } from '@nestjs/common';
import { IntegrationModule } from '../integrations/integration.module';
import { GoogleDriveService } from './googledrive.service';
import { GoogleDriveController } from './googledrive.controller';

@Module({
  imports: [forwardRef(() => IntegrationModule)],
  controllers: [GoogleDriveController],
  providers: [GoogleDriveService ],
  exports: [GoogleDriveService ],
})
export class GoogleDriveModule {}
