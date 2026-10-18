import { Module } from '@nestjs/common';
import { DbModule } from '../db/db.module.js';
import { SalesController } from './sales.controller.js';
import { SalesService } from './sales.service.js';

@Module({
  imports: [DbModule],
  controllers: [SalesController],
  providers: [SalesService],
})
export class SalesModule {}
