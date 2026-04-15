import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { JwtPayload } from './auth.dto';

export const CurrentUser = createParamDecorator((_: unknown, context: ExecutionContext): JwtPayload => {
  const request = context.switchToHttp().getRequest();
  return request.user as JwtPayload;
});
