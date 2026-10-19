import { Module } from '@nestjs/common';
import { DbModule } from '../db/db.module.js';
import { FloorController, FloorService } from './floor.controller.js';

@Module({
  imports: [DbModule],
  controllers: [FloorController],
  providers: [FloorService],
})
export class FloorModule {}
