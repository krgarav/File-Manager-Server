import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { MongooseModule } from '@nestjs/mongoose';
import { StringValue } from 'ms';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtStrategy } from './jwt.strategy';
import { User, UserSchema } from './user.schema';

const rawJwtExpiresIn = process.env.JWT_EXPIRES_IN ?? '7d';
const jwtExpiresIn: number | StringValue = /^\d+$/.test(rawJwtExpiresIn)
  ? Number(rawJwtExpiresIn)
  : (rawJwtExpiresIn as StringValue);

@Module({
  imports: [
    PassportModule,
    JwtModule.register({
      secret: process.env.JWT_SECRET || 'change-me-in-env',
      signOptions: {
        expiresIn: jwtExpiresIn,
      },
    }),
    MongooseModule.forFeature([{ name: User.name, schema: UserSchema }]),
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtStrategy],
  exports: [AuthService],
})
export class AuthModule {}
