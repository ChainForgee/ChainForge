const createModelMock = () => ({
  findUnique: jest.fn(),
  findFirst: jest.fn(),
  findMany: jest.fn(),
  create: jest.fn(),
  update: jest.fn(),
  delete: jest.fn(),
  count: jest.fn(),
  upsert: jest.fn(),
  deleteMany: jest.fn(),
  updateMany: jest.fn(),
});

export class PrismaClient {
  constructor() {
    return new Proxy(this, {
      get(target, prop) {
        if (prop === '$connect') return jest.fn().mockResolvedValue(undefined);
        if (prop === '$disconnect') return jest.fn().mockResolvedValue(undefined);
        if (prop === '$on') return jest.fn();
        if (prop === '$transaction') {
          return jest.fn((cb) => Promise.resolve(typeof cb === 'function' ? cb(this) : cb));
        }
        if (typeof prop === 'symbol' || prop === 'constructor' || prop === 'then') {
          return (target as any)[prop];
        }
        return createModelMock();
      },
    });
  }
}

export const Prisma = {
  defineExtension: jest.fn(x => x),
  sql: jest.fn(),
};

// Enums
export enum CampaignStatus {
  draft = 'draft',
  active = 'active',
  paused = 'paused',
  completed = 'completed',
  archived = 'archived',
}

export enum ClaimStatus {
  requested = 'requested',
  verified = 'verified',
  approved = 'approved',
  disbursed = 'disbursed',
  archived = 'archived',
  cancelled = 'cancelled',
}

export enum VerificationChannel {
  email = 'email',
  phone = 'phone',
}

export enum VerificationSessionStatus {
  pending = 'pending',
  completed = 'completed',
  expired = 'expired',
  failed = 'failed',
}

export enum SessionType {
  otp_verification = 'otp_verification',
  claim_verification = 'claim_verification',
  multi_step_verification = 'multi_step_verification',
}

export enum SessionStepStatus {
  pending = 'pending',
  in_progress = 'in_progress',
  completed = 'completed',
  failed = 'failed',
  skipped = 'skipped',
}

export enum VerificationStatus {
  pending = 'pending',
  pending_review = 'pending_review',
  approved = 'approved',
  rejected = 'rejected',
  needs_resubmission = 'needs_resubmission',
}

export enum PurgeStrategy {
  soft_delete = 'soft_delete',
  hard_delete = 'hard_delete',
  anonymize = 'anonymize',
}

export enum InviteStatus {
  pending = 'pending',
  accepted = 'accepted',
  revoked = 'revoked',
  expired = 'expired',
}

export enum AppRole {
  admin = 'admin',
  operator = 'operator',
  client = 'client',
  ngo = 'ngo',
}

export enum EvidenceStatus {
  pending = 'pending',
  uploading = 'uploading',
  completed = 'completed',
  failed = 'failed',
}

export enum UploadSessionStatus {
  active = 'active',
  completed = 'completed',
  expired = 'expired',
  aborted = 'aborted',
}

export enum NotificationOutboxStatus {
  pending = 'pending',
  enqueued = 'enqueued',
  sent = 'sent',
  failed = 'failed',
}

export enum RegistryEntityType {
  individual = 'individual',
  household = 'household',
}

export enum EntityLinkSourceType {
  manual = 'manual',
  automatic = 'automatic',
}
