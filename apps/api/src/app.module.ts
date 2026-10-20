import { Module } from '@nestjs/common';
import { AppController } from './app.controller.js';
import { AuthModule } from './auth/auth.module.js';
import { DbModule } from './db/db.module.js';
import { FloorModule } from './floor/floor.module.js';
import { MenuModule } from './menu/menu.module.js';
import { SalesModule } from './sales/sales.module.js';
import { StaffModule } from './staff/staff.module.js';
import { StockModule } from './stock/stock.module.js';

@Module({
  imports: [DbModule, AuthModule, StaffModule, MenuModule, FloorModule, SalesModule, StockModule],
  controllers: [AppController],
})
export class AppModule {}
