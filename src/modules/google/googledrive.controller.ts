import { Controller, Get } from '@nestjs/common';

@Controller('v1/google-drive')
export class GoogleDriveController {
  @Get('health')
  getHealth() {
    return {
      provider: 'GOOGLE_DRIVE',
      status: 'available',
    };
  }
}
