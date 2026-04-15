import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { IntegrationType } from './integration.dto';

export type IntegrationDocument = HydratedDocument<Integration>;

@Schema({ collection: 'integrations', timestamps: true })
export class Integration {
  @Prop({ required: true, index: true, trim: true })
  ownerId: string;

  @Prop({ required: true, index: true, trim: true })
  userId: string;

  @Prop({ required: true, enum: ['GOOGLE_DRIVE'], index: true })
  type: IntegrationType;

  @Prop({ required: true, trim: true })
  encryptedAccessToken: string;

  @Prop({ default: null, trim: true })
  encryptedRefreshToken?: string | null;

  @Prop({ default: null })
  scope?: string | null;

  @Prop({ default: null })
  expiryDate?: number | null;

  @Prop({ default: '', trim: true })
  info?: string;

  @Prop({ default: true })
  isActive: boolean;

  @Prop({ default: false })
  isDeleted: boolean;
}

export const IntegrationSchema = SchemaFactory.createForClass(Integration);
IntegrationSchema.index({ ownerId: 1, type: 1 });
IntegrationSchema.index(
  { ownerId: 1, userId: 1, type: 1, info: 1 },
  {
    unique: true,
    partialFilterExpression: {
      isDeleted: false,
      info: { $type: 'string', $ne: '' },
    },
  },
);
