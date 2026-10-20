import { Module } from '@nestjs/common';
import { DbModule } from '../db/db.module.js';
import { StockController } from './stock.controller.js';
import { StockService } from './stock.service.js';

@Module({
  imports: [DbModule],
  controllers: [StockController],
  providers: [StockService],
})
export class StockModule {}
