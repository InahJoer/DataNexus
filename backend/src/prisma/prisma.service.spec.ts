import { Test, TestingModule } from '@nestjs/testing';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PrismaService } from './prisma.service.js';

describe('PrismaService', () => {
  let service: PrismaService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [PrismaService],
    }).compile();

    service = module.get<PrismaService>(PrismaService);
  });

  afterEach(async () => {
    await service.$disconnect();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('should connect to database and query models', async () => {
    await service.$connect();
    const workspacesCount = await service.workspace.count();
    const usersCount = await service.user.count();

    expect(workspacesCount).toBeGreaterThanOrEqual(0);
    expect(usersCount).toBeGreaterThanOrEqual(0);
  });
});
