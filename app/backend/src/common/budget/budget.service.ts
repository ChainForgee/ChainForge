import { PrismaService } from '../../prisma/prisma.service';
import { Injectable, BadRequestException } from '@nestjs/common';

@Injectable()
export class BudgetService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Returns the total locked and disbursed amount for a campaign.
   * BalanceLedger.amount is Decimal; values are returned as plain numbers
   * for downstream arithmetic convenience.
   */
  async getCampaignBudgetUsage(
    campaignId: string,
  ): Promise<{ locked: number; disbursed: number }> {
    // Sum all locked amounts
    const locked = await this.prisma.balanceLedger.aggregate({
      _sum: { amount: true },
      where: {
        campaignId,
        eventType: 'lock',
      },
    });
    // Sum all disbursed amounts
    const disbursed = await this.prisma.balanceLedger.aggregate({
      _sum: { amount: true },
      where: {
        campaignId,
        eventType: 'disburse',
      },
    });

    const toNum = (
      d: { toNumber(): number } | number | null | undefined,
    ): number => {
      if (!d && d !== 0) return 0;
      return typeof d === 'object' ? d.toNumber() : (d as number);
    };

    return {
      locked: toNum(locked._sum.amount),
      disbursed: toNum(disbursed._sum.amount),
    };
  }

  /**
   * Throws if the new lock/disburse would exceed the campaign budget.
   */
  async assertWithinBudget(campaignId: string, newAmount: number) {
    const campaign = await this.prisma.campaign.findUnique({
      where: { id: campaignId },
    });
    if (!campaign) throw new BadRequestException('Campaign not found');
    const usage = await this.getCampaignBudgetUsage(campaignId);
    const total = usage.locked + usage.disbursed + newAmount;
    if (total > campaign.budget.toNumber()) {
      throw new BadRequestException('Campaign funding cap exceeded');
    }
  }
}
