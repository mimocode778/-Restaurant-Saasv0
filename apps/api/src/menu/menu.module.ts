import { Module } from '@nestjs/common';
import { DbModule } from '../db/db.module.js';
import { MenuController } from './menu.controller.js';
import { MenuService } from './menu.service.js';

@Module({
  imports: [DbModule],
  controllers: [MenuController],
  providers: [MenuService],
})
export class MenuModule {}
