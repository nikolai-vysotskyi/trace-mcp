/** Test file — imports from classes.ts to verify test_covers edges */
import { JsonSerializer, ConsoleLogger } from './classes.js';

describe('JsonSerializer', () => {
  it('serializes to JSON', () => {
    const s = new JsonSerializer();
    expect(s.serialize()).toBeTruthy();
  });
});

describe('ConsoleLogger', () => {
  it('logs', () => {
    const l = new ConsoleLogger();
    l.log('test');
  });
});
