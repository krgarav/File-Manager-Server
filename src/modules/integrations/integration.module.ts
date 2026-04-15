import { forwardRef, Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { GoogleDriveModule } from '../google/googledrive.module';
import { IntegrationController } from './integration.controller';
import { Integration, IntegrationSchema } from './integration.schema';
import { IntegrationService } from './integration.service';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: Integration.name, schema: IntegrationSchema }]),
    forwardRef(() => GoogleDriveModule),
  ],
  controllers: [IntegrationController],
  providers: [IntegrationService],
  exports: [IntegrationService],
})
export class IntegrationModule {}
