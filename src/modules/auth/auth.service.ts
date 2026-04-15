import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { JwtService } from '@nestjs/jwt';
import { Model } from 'mongoose';
import * as bcrypt from 'bcryptjs';
import { AuthUser, JwtPayload, SignInDto, SignUpDto } from './auth.dto';
import { User, UserDocument } from './user.schema';

@Injectable()
export class AuthService {
  constructor(
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
    private readonly jwtService: JwtService,
  ) {}

  async signUp(input: SignUpDto) {
    const name = this.normalizeName(input?.name);
    const email = this.normalizeEmail(input?.email);
    const workspace = this.normalizeWorkspace(input?.workspace);
    const password = this.normalizePassword(input?.password);

    const existing = await this.userModel.findOne({ email }).lean();
    if (existing) {
      throw new BadRequestException('Email is already registered.');
    }

    const passwordHash = await bcrypt.hash(password, 12);

    try {
      const created = await this.userModel.create({
        name,
        email,
        workspace,
        passwordHash,
        isActive: true,
      });

      return this.buildAuthResponse({
        userId: String(created._id),
        email,
        workspace,
        name,
      });
    } catch (error: any) {
      if (error?.code === 11000) {
        throw new BadRequestException('Email is already registered.');
      }
      throw new InternalServerErrorException('Unable to create account');
    }
  }

  async signIn(input: SignInDto) {
    const email = this.normalizeEmail(input?.email);
    const password = this.normalizePassword(input?.password);

    const user = await this.userModel
      .findOne({ email, isActive: true })
      .select('+passwordHash')
      .lean();

    if (!user?.passwordHash) {
      throw new UnauthorizedException('Invalid email or password');
    }

    const passwordMatches = await bcrypt.compare(password, user.passwordHash);
    if (!passwordMatches) {
      throw new UnauthorizedException('Invalid email or password');
    }

    return this.buildAuthResponse({
      userId: String(user._id),
      email: user.email,
      workspace: user.workspace,
      name: user.name,
    });
  }

  async getProfile(userId: string): Promise<AuthUser> {
    const user = await this.userModel.findById(userId).lean();
    if (!user || !user.isActive) {
      throw new UnauthorizedException('User not found or inactive');
    }

    return {
      userId: String(user._id),
      email: user.email,
      workspace: user.workspace,
      name: user.name,
    };
  }

  private buildAuthResponse(user: AuthUser) {
    const payload: JwtPayload = {
      sub: user.userId,
      email: user.email,
      workspace: user.workspace,
    };

    return {
      success: true,
      data: {
        token: this.jwtService.sign(payload),
        user,
      },
    };
  }

  private normalizeName(value: string) {
    const normalized = (value ?? '').trim();
    if (!normalized) {
      throw new BadRequestException('name is required');
    }
    if (normalized.length < 2 || normalized.length > 80) {
      throw new BadRequestException('name must be between 2 and 80 characters');
    }
    return normalized;
  }

  private normalizeEmail(value: string) {
    const normalized = (value ?? '').trim().toLowerCase();
    if (!normalized) {
      throw new BadRequestException('email is required');
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(normalized) || normalized.length > 200) {
      throw new BadRequestException('email is invalid');
    }

    return normalized;
  }

  private normalizeWorkspace(value: string) {
    const normalized = (value ?? '').trim();
    if (!normalized) {
      throw new BadRequestException('workspace is required');
    }
    if (normalized.length > 120) {
      throw new BadRequestException('workspace is too long');
    }
    return normalized;
  }

  private normalizePassword(value: string) {
    const normalized = (value ?? '').trim();
    if (!normalized) {
      throw new BadRequestException('password is required');
    }
    if (normalized.length < 8 || normalized.length > 128) {
      throw new BadRequestException('password must be between 8 and 128 characters');
    }
    return normalized;
  }
}
