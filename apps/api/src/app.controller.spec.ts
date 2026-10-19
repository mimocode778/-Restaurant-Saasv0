import { describe, expect, it } from 'vitest';
import { AppController } from './app.controller.js';

describe('AppController', () => {
  it('answers that the API is running', () => {
    expect(new AppController().health()).toEqual({ status: 'ok' });
  });
});
