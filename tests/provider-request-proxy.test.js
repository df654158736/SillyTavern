import { describe, expect, test, jest } from '@jest/globals';

import { createExplicitProxyFetch, normalizeProviderProxyUrl } from '../src/provider-request-proxy.js';

describe('provider-scoped request proxy', () => {
    test('normalizes supported proxy URLs and rejects unsupported protocols', () => {
        expect(normalizeProviderProxyUrl(' http://127.0.0.1:7890 ')).toBe('http://127.0.0.1:7890/');
        expect(normalizeProviderProxyUrl('socks5://127.0.0.1:1080')).toBe('socks5://127.0.0.1:1080');
        expect(() => normalizeProviderProxyUrl('file:///tmp/proxy.sock')).toThrow('Unsupported proxy protocol');
        expect(() => normalizeProviderProxyUrl('')).toThrow('Proxy URL is empty');
    });

    test('adds an explicit agent without changing the caller options', async () => {
        const response = { ok: true };
        const fetchImplementation = jest.fn(async () => response);
        const proxiedFetch = createExplicitProxyFetch(fetchImplementation, 'http://127.0.0.1:7890');
        const originalOptions = { method: 'POST', headers: { test: 'value' } };

        await expect(proxiedFetch('https://generativelanguage.googleapis.com/v1beta/models', originalOptions)).resolves.toBe(response);
        expect(fetchImplementation).toHaveBeenCalledTimes(1);

        const [, receivedOptions] = fetchImplementation.mock.calls[0];
        expect(receivedOptions).not.toBe(originalOptions);
        expect(receivedOptions.method).toBe('POST');
        expect(receivedOptions.headers).toBe(originalOptions.headers);
        expect(receivedOptions.agent).toBeDefined();
        expect(await receivedOptions.agent.getProxyForUrl('https://example.com')).toBe('http://127.0.0.1:7890/');
        expect(originalOptions.agent).toBeUndefined();
    });
});
