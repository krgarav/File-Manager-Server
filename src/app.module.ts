import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { MongooseModule } from '@nestjs/mongoose';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuthModule } from './modules/auth/auth.module';
import { JwtAuthGuard } from './modules/auth/jwt-auth.guard';
import { FileManagerModule } from './modules/file-manager/file-manager.module';
import { IntegrationModule } from './modules/integrations/integration.module';

@Module({
  imports: [
    MongooseModule.forRoot(
      process.env.MONGODB_URI || process.env.mongouri || 'mongodb://localhost:27017/cloud-file-manager',
    ),
    AuthModule,
    IntegrationModule,
    FileManagerModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    {
      provide: APP_GUARD,
      useClass: JwtAuthGuard,
    },
  ],
})
export class AppModule {}
