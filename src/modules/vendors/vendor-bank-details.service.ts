
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from 'crypto';
import { PrismaService } from '../../prisma.service';

type Actor = {
  userId: bigint;
  roleId: number;
  vendorId: number;
};

type BankData = {
  accountHolderName: string;
  bankName: string;
  accountNumber: string;
  ifscCode: string;
  branchName: string;
  accountType: string;
  upiId: string;
};

@Injectable()
export class VendorBankDetailsService {
  constructor(private readonly prisma: PrismaService) {}

  private async getActor(req: any): Promise<Actor> {
    const id = String(req?.user?.userId ?? '');

    if (!/^\d+$/.test(id) || id === '0') {
      throw new UnauthorizedException('Login required');
    }

    const user = await this.prisma.dvi_users.findUnique({
      where: { userID: BigInt(id) },
    });

    if (
      !user ||
      user.deleted !== 0 ||
      user.status !== 1 ||
      user.userbanned !== 0
    ) {
      throw new ForbiddenException('Inactive user');
    }

    return {
      userId: user.userID,
      roleId: Number(user.roleID),
      vendorId: Number(user.vendor_id),
    };
  }

  private checkAccess(
    actor: Actor,
    vendorId: number,
    operation: 'read' | 'submit' | 'review',
  ) {
  if (operation === 'review') {
  if (actor.roleId !== 1) {
    throw new ForbiddenException('Admin approval required');
  }
  return;
}

if (!Number.isSafeInteger(vendorId) || vendorId <= 0) {
  throw new BadRequestException('Invalid vendor ID');
}

    if (actor.roleId === 1) return;

    // Accounts can read approved, masked details.
    if (operation === 'read' && actor.roleId === 6) return;

    // Vendors can only access their own bank details.
    if (
      actor.roleId === 2 &&
      actor.vendorId > 0 &&
      actor.vendorId === vendorId
    ) {
      return;
    }

    throw new ForbiddenException('Vendor access denied');
  }

  private async ensureVendor(vendorId: number) {
    const vendor = await this.prisma.dvi_vendor_details.findFirst({
      where: { vendor_id: vendorId, deleted: 0 },
      select: { vendor_id: true },
    });

    if (!vendor) {
      throw new NotFoundException('Vendor not found');
    }
  }

  async getMyVendor(req: any) {
    const actor = await this.getActor(req);

    if (actor.roleId !== 2 || actor.vendorId <= 0) {
      throw new ForbiddenException(
        'A linked vendor login is required',
      );
    }

    await this.ensureVendor(actor.vendorId);

    return { vendorId: actor.vendorId };
  }

  private encryptionKey(): Buffer {
    const hex = process.env.VENDOR_BANK_ENCRYPTION_KEY ?? '';

    if (!/^[a-fA-F0-9]{64}$/.test(hex)) {
      throw new ServiceUnavailableException(
        'Bank encryption is not configured',
      );
    }

    return Buffer.from(hex, 'hex');
  }

  private encrypt(vendorId: number, data: BankData): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv(
      'aes-256-gcm',
      this.encryptionKey(),
      iv,
    );

    cipher.setAAD(Buffer.from(`vendor-bank:${vendorId}`));

    const encrypted = Buffer.concat([
      cipher.update(JSON.stringify(data), 'utf8'),
      cipher.final(),
    ]);

    return [
      'v1',
      iv.toString('hex'),
      cipher.getAuthTag().toString('hex'),
      encrypted.toString('hex'),
    ].join('.');
  }

  private decrypt(vendorId: number, payload: string): BankData {
    try {
      const parts = payload.split('.');
      if (parts.length !== 4 || parts[0] !== 'v1') {
        throw new Error('Unsupported encryption format');
      }

      const decipher = createDecipheriv(
        'aes-256-gcm',
        this.encryptionKey(),
        Buffer.from(parts[1], 'hex'),
      );

      decipher.setAAD(Buffer.from(`vendor-bank:${vendorId}`));
      decipher.setAuthTag(Buffer.from(parts[2], 'hex'));

      const decrypted = Buffer.concat([
        decipher.update(Buffer.from(parts[3], 'hex')),
        decipher.final(),
      ]);

      return JSON.parse(decrypted.toString('utf8')) as BankData;
    } catch {
      throw new InternalServerErrorException(
        'Unable to read secured bank details',
      );
    }
  }

  private validateBankData(body: any): BankData {
    const value = (key: string) => {
      const raw = body?.[key];
      if (typeof raw !== 'string') {
        if (raw == null) return '';
        throw new BadRequestException(`${key} must be text`);
      }
      return raw.trim();
    };

    const data: BankData = {
      accountHolderName: value('accountHolderName'),
      bankName: value('bankName'),
      accountNumber: value('accountNumber'),
      ifscCode: value('ifscCode').toUpperCase(),
      branchName: value('branchName'),
      accountType: value('accountType').toUpperCase(),
      upiId: value('upiId'),
    };

    const confirm = value('confirmAccountNumber');

    if (
      data.accountHolderName.length < 2 ||
      data.accountHolderName.length > 120 ||
      data.bankName.length < 2 ||
      data.bankName.length > 120
    ) {
      throw new BadRequestException(
        'Enter valid account holder and bank names',
      );
    }

    if (
      !/^\d{6,20}$/.test(data.accountNumber) ||
      data.accountNumber !== confirm
    ) {
      throw new BadRequestException(
        'Account number is invalid or confirmation does not match',
      );
    }

    if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(data.ifscCode)) {
      throw new BadRequestException('Invalid IFSC code');
    }

    if (data.branchName.length > 120) {
      throw new BadRequestException('Branch name is too long');
    }

    if (
      data.accountType &&
      !['SAVINGS', 'CURRENT'].includes(data.accountType)
    ) {
      throw new BadRequestException('Invalid account type');
    }

    if (
      data.upiId &&
      (data.upiId.length > 100 ||
        !/^[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+$/.test(data.upiId))
    ) {
      throw new BadRequestException('Invalid UPI ID');
    }

    // Confirmation number is deliberately never stored.
    return data;
  }

  private masked(
    vendorId: number,
    encrypted: string,
    last4: string,
  ) {
    const { accountNumber, ...safe } = this.decrypt(
      vendorId,
      encrypted,
    );

    return {
      ...safe,
      accountNumberMasked: `•••• ${last4}`,
    };
  }

  async getStatus(vendorId: number, req: any) {
    const actor = await this.getActor(req);
    this.checkAccess(actor, vendorId, 'read');
    await this.ensureVendor(vendorId);

    const canSeeRequests = actor.roleId === 1 ||
      (actor.roleId === 2 && actor.vendorId === vendorId);

    const [approved, latestRequest] = await Promise.all([
      this.prisma.dvi_vendor_bank_accounts.findUnique({
        where: { vendor_id: vendorId },
      }),
      canSeeRequests
        ? this.prisma.dvi_vendor_bank_change_requests.findFirst({
            where: { vendor_id: vendorId },
            orderBy: { request_id: 'desc' },
          })
        : Promise.resolve(null),
    ]);

    return {
      approved: approved
        ? {
            ...this.masked(
              vendorId,
              approved.encrypted_payload,
              approved.account_last4,
            ),
            approvedAt: approved.approved_at,
          }
        : null,

      lastRequest: latestRequest
        ? {
            id: latestRequest.request_id,
            status: latestRequest.status,
            requestedAt: latestRequest.requested_at,
            reviewedAt: latestRequest.reviewed_at,
            rejectionReason: latestRequest.rejection_reason,
            ...this.masked(
              vendorId,
              latestRequest.encrypted_payload,
              latestRequest.account_last4,
            ),
          }
        : null,

      canSubmit: actor.roleId === 1 ||
        (actor.roleId === 2 && actor.vendorId === vendorId),

      canReview: actor.roleId === 1,
    };
  }

  async submit(vendorId: number, body: any, req: any) {
    const actor = await this.getActor(req);
    this.checkAccess(actor, vendorId, 'submit');
    await this.ensureVendor(vendorId);

    const bank = this.validateBankData(body);
    const encrypted = this.encrypt(vendorId, bank);

    // Lock the vendor row to serialize simultaneous submissions.
    const request = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`
        SELECT vendor_id FROM dvi_vendor_details
        WHERE vendor_id = ${vendorId} AND deleted = 0
        FOR UPDATE
      `;

      const existingPending =
        await tx.dvi_vendor_bank_change_requests.findFirst({
          where: {
            vendor_id: vendorId,
            status: 'PENDING',
          },
        });

      if (existingPending) {
        throw new ConflictException(
          'A bank change is already pending Admin approval',
        );
      }

      return tx.dvi_vendor_bank_change_requests.create({
        data: {
          vendor_id: vendorId,
          encrypted_payload: encrypted,
          account_last4: bank.accountNumber.slice(-4),
          status: 'PENDING',
          created_by_user_id: actor.userId,
        },
        select: {
          request_id: true,
          status: true,
        },
      });
    });

    return {
      success: true,
      requestId: request.request_id,
      status: request.status,
      message: 'Submitted for Admin approval',
    };
  }

  async approve(requestId: number, req: any) {
    const actor = await this.getActor(req);
    this.checkAccess(actor, 0, 'review');

    return this.prisma.$transaction(async (tx) => {
      const request =
        await tx.dvi_vendor_bank_change_requests.findUnique({
          where: { request_id: requestId },
        });

      if (!request) {
        throw new NotFoundException('Bank request not found');
      }

      if (request.status !== 'PENDING') {
        throw new ConflictException('Request already reviewed');
      }

      const vendor = await tx.dvi_vendor_details.findFirst({
        where: { vendor_id: request.vendor_id, deleted: 0 },
        select: { vendor_id: true },
      });

      if (!vendor) {
        throw new NotFoundException('Vendor no longer exists');
      }

      const now = new Date();

      const claimed =
        await tx.dvi_vendor_bank_change_requests.updateMany({
          where: {
            request_id: requestId,
            status: 'PENDING',
          },
          data: {
            status: 'APPROVED',
            reviewed_by_user_id: actor.userId,
            reviewed_at: now,
            rejection_reason: null,
          },
        });

      if (claimed.count !== 1) {
        throw new ConflictException('Request already reviewed');
      }

      await tx.dvi_vendor_bank_accounts.upsert({
        where: { vendor_id: request.vendor_id },
        create: {
          vendor_id: request.vendor_id,
          encrypted_payload: request.encrypted_payload,
          account_last4: request.account_last4,
          approved_by_user_id: actor.userId,
          approved_at: now,
        },
        update: {
          encrypted_payload: request.encrypted_payload,
          account_last4: request.account_last4,
          approved_by_user_id: actor.userId,
          approved_at: now,
        },
      });

      return { success: true, status: 'APPROVED' };
    });
  }

  async reject(requestId: number, reason: unknown, req: any) {
    const actor = await this.getActor(req);
    this.checkAccess(actor, 0, 'review');

    if (typeof reason !== 'string' ||
        reason.trim().length < 5 ||
        reason.trim().length > 255) {
      throw new BadRequestException(
        'Rejection reason must be 5 to 255 characters',
      );
    }

    const updated =
      await this.prisma.dvi_vendor_bank_change_requests.updateMany({
        where: {
          request_id: requestId,
          status: 'PENDING',
        },
        data: {
          status: 'REJECTED',
          reviewed_by_user_id: actor.userId,
          reviewed_at: new Date(),
          rejection_reason: reason.trim(),
        },
      });

    if (updated.count !== 1) {
      throw new ConflictException(
        'Request not found or already reviewed',
      );
    }

    return { success: true, status: 'REJECTED' };
  }
}
