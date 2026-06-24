import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { ONCHAIN_ADAPTER_TOKEN } from '../src/onchain/onchain.adapter';
import { MockOnchainAdapter } from '../src/onchain/onchain.adapter.mock';

jest.mock('@stellar/stellar-sdk', () => ({
  Server: jest.fn().mockImplementation(() => ({
    loadAccount: jest.fn().mockResolvedValue({ id: 'test', sequence: '0' }),
    submitTransaction: jest
      .fn()
      .mockResolvedValue({ hash: '0x123', status: 'SUCCESS' }),
  })),
  Keypair: {
    random: jest.fn().mockReturnValue({ publicKey: () => 'test-key' }),
    fromSecret: jest.fn().mockReturnValue({ publicKey: () => 'test-key' }),
  },
  Networks: { PUBLIC: 'test', TESTNET: 'test' },
  Asset: { native: jest.fn() },
  Operation: { payment: jest.fn(), createAccount: jest.fn() },
  TransactionBuilder: jest.fn().mockImplementation(() => ({
    addOperation: jest.fn().mockReturnThis(),
    build: jest.fn().mockReturnValue({ toXDR: () => 'xdr', sign: jest.fn() }),
  })),
}));

jest.mock('openai', () => ({
  OpenAI: jest.fn().mockImplementation(() => ({
    chat: {
      completions: {
        create: jest.fn().mockResolvedValue({
          choices: [{ message: { content: JSON.stringify({ verified: true }) } }],
        }),
      },
    },
  })),
}));

describe('Claim lifecycle integration', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let mockOnchainAdapter: MockOnchainAdapter;

  const base = '/api/v1/claims';

  beforeAll(async () => {
    mockOnchainAdapter = new MockOnchainAdapter();

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(ONCHAIN_ADAPTER_TOKEN)
      .useValue(mockOnchainAdapter)
      .compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );

    await app.init();
    prisma = moduleRef.get(PrismaService);
  });

  beforeEach(async () => {
    await prisma.claim.deleteMany();
    await prisma.campaign.deleteMany();
  });

  afterAll(async () => {
    await app.close();
  });

  it('covers the complete claim lifecycle from creation to archival', async () => {
    const campaign = await prisma.campaign.create({
      data: { name: 'Lifecycle Campaign', budget: 10000 },
    });

    const createRes = await request(app.getHttpServer())
      .post(base)
      .send({
        campaignId: campaign.id,
        amount: 250,
        recipientRef: 'recipient-1',
        evidenceRef: 'evidence-1',
      })
      .expect(201);

    const createdClaim = createRes.body?.data ?? createRes.body;
    expect(createdClaim.status).toBe('requested');

    const verifyRes = await request(app.getHttpServer())
      .post(`${base}/${createdClaim.id}/verify`)
      .expect(200);

    const verifiedClaim = verifyRes.body?.data ?? verifyRes.body;
    expect(verifiedClaim.status).toBe('verified');

    const approveRes = await request(app.getHttpServer())
      .post(`${base}/${createdClaim.id}/approve`)
      .expect(200);

    const approvedClaim = approveRes.body?.data ?? approveRes.body;
    expect(approvedClaim.status).toBe('approved');

    const disburseRes = await request(app.getHttpServer())
      .post(`${base}/${createdClaim.id}/disburse`)
      .expect(200);

    const disbursedClaim = disburseRes.body?.data ?? disburseRes.body;
    expect(disbursedClaim.status).toBe('disbursed');
    expect(mockOnchainAdapter.disburse).toHaveBeenCalled();

    const archiveRes = await request(app.getHttpServer())
      .patch(`${base}/${createdClaim.id}/archive`)
      .expect(200);

    const archivedClaim = archiveRes.body?.data ?? archiveRes.body;
    expect(archivedClaim.status).toBe('archived');

    const dbClaim = await prisma.claim.findUnique({
      where: { id: createdClaim.id },
    });
    expect(dbClaim?.status).toBe('archived');

    await request(app.getHttpServer())
      .post(`${base}/${createdClaim.id}/verify`)
      .expect(400);
  });
});
