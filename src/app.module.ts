import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { FileManagerModule } from './modules/file-manager/file-manager.module';
import { IntegrationModule } from './modules/integrations/integration.module';

@Module({
  imports: [IntegrationModule, FileManagerModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
