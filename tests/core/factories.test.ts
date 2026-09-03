import { BrowserFactory } from '../../src/core/factories/browser-factory';
import { IBrowserService } from '../../src/core/interfaces';
import { BrowserConfig } from '../../src/core/models';

describe('Browser Factory', () => {
  it('should create a browser service instance', () => {
    const config: BrowserConfig = {
      headless: true,
      userAgent: 'test-agent'
    };

    const browserService = BrowserFactory.createBrowser(config);

    expect(browserService).toBeDefined();
    expect(browserService).toBeInstanceOf(Object); // Mock ist ein Objekt
  });
});
