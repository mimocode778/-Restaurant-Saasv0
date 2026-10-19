import { Controller, Get } from '@nestjs/common';
import { Public } from './auth/auth.guard.js';

@Controller()
export class AppController {
  // Lets a monitoring tool (or you, in a browser) check that the API is running.
  @Public()
  @Get()
  health() {
    return { status: 'ok' };
  }
}
