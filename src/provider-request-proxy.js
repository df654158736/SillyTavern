import { ProxyAgent } from 'proxy-agent';

import { color, getConfigValue } from './util.js';

const LOG_HEADER = '[Provider Request Proxy]';
const providerFetchCache = new WeakMap();
const SUPPORTED_PROXY_PROTOCOLS = new Set([
    'http:',
    'https:',
    'socks:',
    'socks4:',
    'socks4a:',
    'socks5:',
    'socks5h:',
    'pac+data:',
    'pac+file:',
    'pac+ftp:',
    'pac+http:',
    'pac+https:',
]);

/**
 * Validates and normalizes an explicit outgoing proxy URL.
 * @param {string} proxyUrl Proxy URL to validate
 * @returns {string} Normalized proxy URL
 */
export function normalizeProviderProxyUrl(proxyUrl) {
    if (typeof proxyUrl !== 'string' || !proxyUrl.trim()) {
        throw new Error('Proxy URL is empty');
    }

    const parsed = new URL(proxyUrl.trim());
    if (!SUPPORTED_PROXY_PROTOCOLS.has(parsed.protocol)) {
        throw new Error(`Unsupported proxy protocol: ${parsed.protocol}`);
    }

    return parsed.toString();
}

/**
 * Returns a copy safe for logs while retaining routing details.
 * @param {string} proxyUrl Proxy URL
 * @returns {string} Redacted URL
 */
function redactProviderProxyUrl(proxyUrl) {
    const parsed = new URL(proxyUrl);
    if (parsed.username || parsed.password) {
        parsed.username = '***';
        parsed.password = '***';
    }
    return parsed.toString();
}

/**
 * Wraps a node-fetch compatible function with an explicit proxy agent.
 * This does not mutate global agents or proxy environment variables.
 * @param {typeof import('node-fetch').default} fetchImplementation Fetch implementation
 * @param {string} proxyUrl Explicit proxy URL
 * @returns {typeof import('node-fetch').default} Proxied fetch implementation
 */
export function createExplicitProxyFetch(fetchImplementation, proxyUrl) {
    const normalizedUrl = normalizeProviderProxyUrl(proxyUrl);
    const agent = new ProxyAgent({ getProxyForUrl: () => normalizedUrl });

    return /** @type {typeof import('node-fetch').default} */ ((resource, options = {}) => {
        return fetchImplementation(resource, { ...options, agent });
    });
}

/**
 * Creates a provider-scoped fetch function from config.yaml.
 * An invalid enabled configuration fails only that provider instead of
 * silently leaking its requests to the direct network.
 * @param {typeof import('node-fetch').default} fetchImplementation Fetch implementation
 * @param {string} provider Provider configuration name
 * @returns {typeof import('node-fetch').default} Direct or provider-proxied fetch
 */
export function createProviderFetch(fetchImplementation, provider) {
    let fetchesByProvider = providerFetchCache.get(fetchImplementation);
    if (!fetchesByProvider) {
        fetchesByProvider = new Map();
        providerFetchCache.set(fetchImplementation, fetchesByProvider);
    }
    if (fetchesByProvider.has(provider)) {
        return fetchesByProvider.get(provider);
    }

    const configPath = `providerRequestProxy.${provider}`;
    const enabled = getConfigValue(`${configPath}.enabled`, false, 'boolean');
    if (!enabled) {
        fetchesByProvider.set(provider, fetchImplementation);
        return fetchImplementation;
    }

    const proxyUrl = getConfigValue(`${configPath}.url`, '');
    try {
        const normalizedUrl = normalizeProviderProxyUrl(proxyUrl);
        console.info();
        console.info(color.green(LOG_HEADER), `${provider} uses proxy:`, color.blue(redactProviderProxyUrl(normalizedUrl)));
        console.info();
        const proxiedFetch = createExplicitProxyFetch(fetchImplementation, normalizedUrl);
        fetchesByProvider.set(provider, proxiedFetch);
        return proxiedFetch;
    } catch (error) {
        const message = `${provider} proxy configuration is invalid: ${error.message}`;
        console.error(color.red(LOG_HEADER), message);
        const failedFetch = /** @type {typeof import('node-fetch').default} */ (() => Promise.reject(new Error(message)));
        fetchesByProvider.set(provider, failedFetch);
        return failedFetch;
    }
}
