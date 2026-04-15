import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { IntegrationModule } from './modules/integrations/integration.module';

@Module({
  imports: [IntegrationModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
