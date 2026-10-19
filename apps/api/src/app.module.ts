import { Module } from '@nestjs/common';
import { AppController } from './app.controller.js';
import { AuthModule } from './auth/auth.module.js';
import { DbModule } from './db/db.module.js';
import { SalesModule } from './sales/sales.module.js';
import { StaffModule } from './staff/staff.module.js';

@Module({
  imports: [DbModule, AuthModule, StaffModule, SalesModule],
  controllers: [AppController],
})
export class AppModule {}
