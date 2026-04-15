import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { FileManagerModule } from './modules/file-manager/file-manager.module';
import { IntegrationModule } from './modules/integrations/integration.module';

@Module({
  imports: [
    MongooseModule.forRoot(
      process.env.MONGODB_URI || process.env.mongouri || 'mongodb://localhost:27017/cloud-file-manager',
    ),
    IntegrationModule,
    FileManagerModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
