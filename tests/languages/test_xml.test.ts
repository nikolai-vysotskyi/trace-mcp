import { describe, it, expect } from 'vitest';
import { XmlLanguagePlugin } from '../../src/indexer/plugins/language/xml/index.js';
describe('x', () => { it('w', () => { expect(new XmlLanguagePlugin().extractSymbols('t.xml', Buffer.from('<r/>')).isOk()).toBe(true); }); });
