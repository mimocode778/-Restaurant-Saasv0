import { Module } from '@nestjs/common';
import { DbModule } from '../db/db.module.js';
import { StaffController } from './staff.controller.js';
import { StaffService } from './staff.service.js';

@Module({
  imports: [DbModule],
  controllers: [StaffController],
  providers: [StaffService],
})
export class StaffModule {}
