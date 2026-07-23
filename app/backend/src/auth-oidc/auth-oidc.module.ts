import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '../prisma/prisma.module';
import { RedisService } from '../../cache/redis.service';
import { TokenController } from './token.controller';
import { TokenService } from './token.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';

@Module({
  imports: [ConfigModule, PrismaModule],
  controllers: [TokenController],
  providers: [TokenService, JwtAuthGuard, RedisService],
  exports: [TokenService, JwtAuthGuard],
})
export class AuthOidcModule {}
