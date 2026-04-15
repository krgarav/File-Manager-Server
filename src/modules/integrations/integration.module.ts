import { forwardRef, Module } from '@nestjs/common';
import { GoogleDriveModule } from '../google/googledrive.module';
import { IntegrationController } from './integration.controller';
import { IntegrationService } from './integration.service';

@Module({
  imports: [forwardRef(() => GoogleDriveModule)],
  controllers: [IntegrationController],
  providers: [IntegrationService],
  exports: [IntegrationService],
})
export class IntegrationModule {}
