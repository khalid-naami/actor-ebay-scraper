import { Actor, log } from 'apify';
import { gotScraping } from 'got-scraping';
import { chromium } from 'playwright';
import {
    detectEbayPageState,
    extractEbayItemId,
    parseEbayCurrency,
    parseEbayPrice,
    parseEbayProductHtml,
    parseEbaySearchHtml,
} from './extractors.js';

function sanitizeRecord(obj) {
    if (obj === null || obj === undefined) return undefined;
    if (typeof obj === 'number') return Number.isFinite(obj) ? obj : undefined;
    if (Array.isArray(obj)) {
        return obj.map(sanitizeRecord).filter((v) => v !== undefined);
    }
    if (typeof obj === 'object' && !(obj instanceof Date)) {
        const clean = {};
        for (const [k, v] of Object.entries(obj)) {
            const val = sanitizeRecord(v);
            if (val !== undefined) clean[k] = val;
        }
        return clean;
    }
    return obj;
}

function isProxyTransportError(errOrStatus) {
    if (errOrStatus === 597 || errOrStatus === 407 || errOrStatus === 502) return true;
    const msg = String(errOrStatus?.message || errOrStatus || '');
    return /597|UPSTREAM407|407|502|Proxy responded with|tunneling socket|ERR_TUNNEL|ERR_PROXY|ERR_CONNECTION_RESET|ERR_SSL|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ECONNREFUSED|socket hang up/i.test(msg);
}

function parsePlaywrightProxy(proxyUrlStr) {
    if (!proxyUrlStr) return undefined;
    try {
        const u = new URL(proxyUrlStr);
        return {
            server: `${u.protocol}//${u.hostname}${u.port ? `:${u.port}` : ''}`,
            ...(u.username ? { username: decodeURIComponent(u.username) } : {}),
            ...(u.password ? { password: decodeURIComponent(u.password) } : {}),
        };
    } catch {
        return { server: proxyUrlStr };
    }
}

await Actor.init();

let activeBrowser = null;
const diagnostics = [];
let totalProductsScraped = 0;
let soldItemsCount = 0;
let buyItNowCount = 0;
let auctionsCount = 0;
let activeDomain = 'ebay.com';

const closeActiveBrowser = async () => {
    if (!activeBrowser) return;
    const instance = activeBrowser;
    activeBrowser = null;
    try {
        await instance.close();
    } catch {
        // Ignore close errors during shutdown
    }
};

Actor.on('aborting', async () => {
    try {
        await closeActiveBrowser();
        await Actor.setValue('OUTPUT', {
            totalProductsScraped,
            soldItemsCount,
            buyItNowCount,
            auctionsCount,
            domain: activeDomain,
            diagnostics,
            status: 'ABORTED',
            scrapedAt: new Date().toISOString(),
        });
    } catch {
        // Ignore abort persistence errors
    }
    await Actor.exit();
});

try {
    const input = (await Actor.getInput()) || {};
    const {
        productUrls = [],
        searchKeywords = [],
        soldItemsOnly = false,
        listingType = 'all',
        condition = 'all',
        ebayDomain = 'ebay.com',
        maxProducts = 40,
        proxyConfiguration,
    } = input;

    activeDomain = ebayDomain;
    log.info(`Starting eBay Arbitrage Scraper (Domain: ${ebayDomain}, Sold Items Only: ${soldItemsOnly})...`);

    let proxyConfig = null;
    let proxyTransportBlocked = false;
    let isUnblockerProxy = false;

    if (proxyConfiguration) {
        try {
            proxyConfig = await Actor.createProxyConfiguration(proxyConfiguration);
            if (proxyConfig) {
                if (Array.isArray(proxyConfig.groups) && proxyConfig.groups.some((g) => /UNBLOCKER/i.test(String(g)))) {
                    isUnblockerProxy = true;
                }
                log.info('Apify Proxy enabled', {
                    groups: proxyConfig.groups || [],
                    countryCode: proxyConfig.countryCode || null,
                    isManInTheMiddle: Boolean(proxyConfig.isManInTheMiddle),
                    isUnblockerProxy,
                });
            }
        } catch (proxyErr) {
            log.warning(`Proxy initialization failed (${proxyErr.message}); continuing with direct connection.`);
        }
    }

    const pushDataWithRetry = async (records) => {
        const cleanBatch = Array.isArray(records) ? records.map(sanitizeRecord).filter(Boolean) : [];
        if (cleanBatch.length === 0) return;
        for (let attempt = 1; attempt <= 2; attempt++) {
            try {
                await Actor.pushData(cleanBatch);
                return;
            } catch (pushErr) {
                if (attempt === 2) throw pushErr;
                log.warning(`Transient dataset push error (${pushErr.message}); retrying...`);
                await new Promise((r) => setTimeout(r, 1500));
            }
        }
    };

    const getFreshProxyUrl = async () => {
        if (!proxyConfig || proxyTransportBlocked) return undefined;
        try {
            return await proxyConfig.newUrl();
        } catch {
            return undefined;
        }
    };

    const fetchHtmlWithHttp = async (url) => {
        try {
            new URL(url);
        } catch {
            return { html: '', statusCode: 0, pageState: { state: 'invalid_url', reason: `Invalid URL: ${url}` } };
        }

        const maxAttempts = proxyConfig && !proxyTransportBlocked && !isUnblockerProxy ? 2 : 1;
        let lastRes = { html: '', statusCode: 0, pageState: { state: 'transport_error', reason: 'HTTP request failed' } };

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            const attemptProxyUrl = await getFreshProxyUrl();
            const usingUnblocker = isUnblockerProxy || /UNBLOCKER/i.test(attemptProxyUrl || '');
            try {
                const response = await gotScraping({
                    url,
                    proxyUrl: attemptProxyUrl,
                    headers: {
                        'accept-language': 'en-US,en;q=0.9',
                        'accept-encoding': 'gzip, deflate, br',
                        'sec-fetch-site': 'none',
                    },
                    headerGeneratorOptions: {
                        browsers: [{ name: 'chrome' }],
                        operatingSystems: ['windows', 'linux'],
                    },
                    https: { rejectUnauthorized: false },
                    http2: !usingUnblocker,
                    sessionToken: {},
                    retry: { limit: usingUnblocker ? 0 : 1 },
                    timeout: { request: usingUnblocker ? 65000 : 25000 },
                    throwHttpErrors: false,
                });

                if (isProxyTransportError(response.statusCode)) {
                    log.warning(`HTTP proxy transport status ${response.statusCode}; switching to direct connection for remaining requests.`);
                    proxyTransportBlocked = true;
                    continue;
                }

                const html = response.body || '';
                const pageState = detectEbayPageState(html, response.statusCode);
                lastRes = { html, statusCode: response.statusCode, pageState };
                if (pageState.state !== 'antibot_challenge') {
                    return lastRes;
                }
            } catch (err) {
                if (isProxyTransportError(err)) {
                    log.warning(`Proxy transport error (${err.message}); switching to direct connection.`);
                    proxyTransportBlocked = true;
                }
                lastRes = { html: '', statusCode: 0, pageState: { state: 'transport_error', reason: err.message } };
            }
        }
        return lastRes;
    };

    const safePageContent = async (page) => {
        for (let i = 0; i < 3; i++) {
            try {
                return await page.content();
            } catch (err) {
                if (i === 2) throw err;
                await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
                await page.waitForTimeout(500);
            }
        }
        return '';
    };

    const runPlaywrightOnce = async (url, mode = 'product', attemptProxyUrl = undefined) => {
        // Inside Apify's xvfb-run container, DISPLAY is set so Chromium runs non-headless to avoid HeadlessChrome detection
        const hasXvfbDisplay = process.platform === 'linux' && Boolean(process.env.DISPLAY);
        const launchOptions = {
            headless: !hasXvfbDisplay,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--disable-webgl',
                '--disable-3d-apis',
                '--disable-software-rasterizer',
                '--disable-extensions',
                '--no-first-run',
                '--mute-audio',
                '--ignore-certificate-errors',
                '--ignore-certificate-errors-spki-list',
                '--disable-blink-features=AutomationControlled',
            ],
        };
        if (attemptProxyUrl) {
            launchOptions.proxy = parsePlaywrightProxy(attemptProxyUrl);
        }

        const browser = await chromium.launch(launchOptions);
        activeBrowser = browser;
        try {
            const browserVersion = browser.version() || '147.0.0.0';
            const cleanUserAgent = `Mozilla/5.0 (${process.platform === 'linux' ? 'X11; Linux x86_64' : 'Windows NT 10.0; Win64; x64'}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${browserVersion} Safari/537.36`;

            const context = await browser.newContext({
                ignoreHTTPSErrors: true,
                userAgent: cleanUserAgent,
                locale: 'en-US',
                viewport: { width: 1366, height: 768 },
                extraHTTPHeaders: {
                    'Accept-Language': 'en-US,en;q=0.9',
                    'Referer': `https://www.${ebayDomain}/`,
                },
            });

            await context.addInitScript(() => {
                Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
                Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
            });

            const page = await context.newPage();
            await page.route('**/*', (route) => {
                const type = route.request().resourceType();
                if (['image', 'media', 'font'].includes(type)) {
                    return route.abort();
                }
                return route.continue();
            });

            const gotoTimeoutMs = isUnblockerProxy || /UNBLOCKER/i.test(attemptProxyUrl || '') ? 65000 : 40000;
            const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: gotoTimeoutMs });
            const statusCode = resp ? resp.status() : 200;

            const waitSel = mode === 'search'
                ? 'li.s-item, li.s-card, [data-listingid], a[href*="/itm/"], form[action*="validateCaptcha"], .pardon-our-interruption'
                : 'h1, .x-item-title, form[action*="validateCaptcha"], .pardon-our-interruption';
            await page.waitForSelector(waitSel, { timeout: 12000 }).catch(() => {});
            await page.waitForTimeout(1000);

            const html = await safePageContent(page);
            const domData = mode === 'search'
                ? await page.evaluate(() => {
                    const out = [];
                    const seen = new Set();
                    const pushCard = (hrefRaw, titleRaw, cardText, thumbnailRaw) => {
                        if (!hrefRaw || !hrefRaw.includes('/itm/')) return;
                        const href = hrefRaw.split('?')[0].split('#')[0];
                        if (href.includes('/itm/123456') || seen.has(href)) return;
                        const title = (titleRaw || '').replace(/Opens in a new window or tab/gi, '').replace(/^New Listing\b/i, '').trim();
                        if (!title || title.length < 5 || title.toLowerCase().includes('shop on ebay')) return;
                        seen.add(href);
                        const priceHit = (cardText || '').match(/(?:US\s*)?[$£€]\s*[\d,]+(?:\.\d{1,2})?/);
                        const bidsHit = (cardText || '').match(/(\d+)\s*bids?\b/i);
                        const shipHit = (cardText || '').match(/(?:\+\s*[$£€][\d.,]+\s*shipping|free shipping|free delivery)/i);
                        out.push({
                            url: href,
                            title,
                            priceText: priceHit ? priceHit[0] : null,
                            shippingCost: shipHit ? shipHit[0] : 'Free shipping',
                            condition: /brand new|new/i.test(cardText || '') ? 'Brand New' : 'Pre-Owned',
                            bidsText: bidsHit ? bidsHit[0] : '',
                            isSold: /sold\s+[a-z]+\s+\d/i.test(cardText || ''),
                            thumbnail: thumbnailRaw ? thumbnailRaw.replace(/s-l\d+\.(jpg|jpeg|png|webp)$/i, 's-l500.$1') : null,
                        });
                    };

                    const cards = document.querySelectorAll('li.s-item, li.s-card, [data-listingid]');
                    for (const card of cards) {
                        const link = card.querySelector('a.s-item__link, a.s-card__link, a[href*="/itm/"]');
                        if (!link) continue;
                        const titleEl = card.querySelector('.s-item__title, .s-card__title, [role="heading"]');
                        const title = titleEl ? titleEl.innerText : (link.innerText || link.getAttribute('aria-label') || '');
                        const imgEl = card.querySelector('img');
                        const thumb = imgEl ? (imgEl.getAttribute('data-defer-load') || imgEl.getAttribute('data-src') || imgEl.src) : null;
                        const priceEl = card.querySelector('.s-item__price, .s-card__price');
                        const shipEl = card.querySelector('.s-item__shipping, .s-item__logisticsCost, .s-card__shipping');
                        const condEl = card.querySelector('.s-item__subtitle, .s-card__subtitle');
                        const bidsEl = card.querySelector('.s-item__bids, .s-card__bids');
                        const cardText = `${priceEl?.innerText || ''} ${shipEl?.innerText || ''} ${bidsEl?.innerText || ''} ${card.innerText || ''}`;
                        pushCard(link.href || link.getAttribute('href'), title, cardText, thumb);
                        if (condEl && out.length > 0 && out[out.length - 1].url === (link.href || '').split('?')[0]) {
                            const cText = (condEl.innerText || '').trim();
                            if (cText) out[out.length - 1].condition = cText;
                        }
                    }

                    if (out.length === 0) {
                        for (const a of Array.from(document.querySelectorAll('a[href*="/itm/"]')).slice(0, 120)) {
                            const box = a.closest('li, article, div') || a.parentElement;
                            const img = box ? box.querySelector('img') : null;
                            pushCard(a.href || a.getAttribute('href'), a.innerText || a.getAttribute('aria-label') || img?.alt, box?.innerText || '', img?.src);
                        }
                    }
                    return out;
                }).catch(() => [])
                : [];

            const pageState = detectEbayPageState(html, statusCode);
            return { html, statusCode, domData, pageState };
        } finally {
            if (activeBrowser === browser) activeBrowser = null;
            await browser.close().catch(() => {});
        }
    };

    const fetchWithPlaywright = async (url, mode = 'product', extractCheck = null) => {
        try {
            new URL(url);
        } catch {
            return { html: '', statusCode: 0, domData: [], pageState: { state: 'invalid_url', reason: `Invalid URL: ${url}` } };
        }

        const maxPwAttempts = proxyConfig && !proxyTransportBlocked && !isUnblockerProxy ? 2 : 1;
        let lastRes = { html: '', statusCode: 0, domData: [], pageState: { state: 'browser_error', reason: 'Playwright failed' } };

        for (let pwAttempt = 1; pwAttempt <= maxPwAttempts; pwAttempt++) {
            const pwProxyUrl = await getFreshProxyUrl();
            try {
                const res = await runPlaywrightOnce(url, mode, pwProxyUrl);
                lastRes = res;
                const hasItems = typeof extractCheck === 'function' ? extractCheck(res) : false;
                if (hasItems || res.pageState?.state === 'unavailable') {
                    return res;
                }
                if (pwAttempt < maxPwAttempts) {
                    log.warning(`Playwright attempt ${pwAttempt}/${maxPwAttempts} yielded state=${res.pageState?.state} (${res.pageState?.reason}). Retrying with a fresh proxy IP...`);
                    await new Promise((r) => setTimeout(r, 1200));
                }
            } catch (pwErr) {
                if (isProxyTransportError(pwErr)) {
                    proxyTransportBlocked = true;
                }
                lastRes = { html: '', statusCode: 0, domData: [], pageState: { state: 'browser_error', reason: pwErr.message } };
                if (pwAttempt < maxPwAttempts) {
                    log.warning(`Playwright attempt ${pwAttempt}/${maxPwAttempts} failed (${pwErr.message}). Retrying...`);
                    await new Promise((r) => setTimeout(r, 1200));
                }
            }
        }
        return lastRes;
    };

    const extractSearchResultsFromPw = (pwRes) => {
        let items = parseEbaySearchHtml(pwRes.html, ebayDomain);
        if (items.length === 0 && Array.isArray(pwRes.domData) && pwRes.domData.length > 0) {
            items = pwRes.domData.map((d) => {
                const bidsCount = d.bidsText ? (parseInt(d.bidsText.replace(/[^\d]/g, ''), 10) || 0) : 0;
                return {
                    itemId: extractEbayItemId(d.url),
                    title: d.title,
                    price: parseEbayPrice(d.priceText),
                    currency: parseEbayCurrency(d.priceText, ebayDomain),
                    shippingCost: d.shippingCost || 'Free shipping',
                    condition: d.condition || 'Pre-Owned',
                    listingType: bidsCount > 0 || d.bidsText ? 'Auction' : 'Buy It Now',
                    bidsCount,
                    isSold: Boolean(d.isSold),
                    soldDate: null,
                    thumbnail: d.thumbnail && !d.thumbnail.startsWith('data:') ? d.thumbnail : null,
                    url: d.url,
                    scrapedAt: new Date().toISOString(),
                };
            });
        }
        return items;
    };

    // Normalize inputs & guard against plain keywords passed in productUrls
    const rawProductUrls = Array.isArray(productUrls) ? productUrls : [];
    const effectiveProductUrls = [];
    const keywordSet = new Set(
        (Array.isArray(searchKeywords) ? searchKeywords : [])
            .map((k) => (typeof k === 'string' ? k.trim() : ''))
            .filter(Boolean)
    );

    for (const rawEntry of rawProductUrls) {
        const rawStr = (typeof rawEntry === 'string' ? rawEntry : rawEntry?.url || '')?.trim();
        if (!rawStr) continue;
        const normalized = /^(?:www\.)?ebay\./i.test(rawStr) ? `https://${rawStr}` : rawStr;
        let parsed = null;
        try {
            parsed = new URL(normalized);
        } catch {
            parsed = null;
        }
        if (parsed && (parsed.protocol === 'http:' || parsed.protocol === 'https:')) {
            effectiveProductUrls.push(parsed.toString());
        } else {
            log.warning(`Ignoring non-URL entry in "productUrls" ("${rawStr}") and routing it to keyword search instead.`);
            keywordSet.add(rawStr);
        }
    }

    if (effectiveProductUrls.length === 0 && keywordSet.size === 0) {
        keywordSet.add('iphone 15 pro max');
    }
    const effectiveSearchKeywords = [...keywordSet];

    // 1. Process Direct Product URLs
    if (effectiveProductUrls.length > 0) {
        log.info(`Processing ${effectiveProductUrls.length} direct eBay item URLs...`);

        for (const targetUrl of effectiveProductUrls) {
            const itemId = extractEbayItemId(targetUrl);
            log.info(`Fetching eBay item: ${targetUrl}${itemId ? ` (ID: ${itemId})` : ''}`);
            let product = null;

            const httpRes = await fetchHtmlWithHttp(targetUrl);
            if (httpRes.pageState.state === 'ok') {
                product = parseEbayProductHtml(httpRes.html, targetUrl, ebayDomain);
            }

            let finalState = product?.title ? 'ok' : httpRes.pageState.state;
            let finalReason = product?.title ? 'OK' : httpRes.pageState.reason;

            if ((!product || !product.title) && httpRes.pageState.state !== 'unavailable' && httpRes.pageState.state !== 'invalid_url') {
                log.info(`Launching browser renderer fallback for ${targetUrl} (HTTP state=${finalState}, len=${httpRes.html?.length || 0}, reason=${finalReason})...`);
                const pwRes = await fetchWithPlaywright(
                    targetUrl,
                    'product',
                    (res) => Boolean(parseEbayProductHtml(res.html, targetUrl, ebayDomain)?.title)
                );
                product = parseEbayProductHtml(pwRes.html, targetUrl, ebayDomain);
                finalState = product?.title ? 'ok' : pwRes.pageState?.state;
                finalReason = product?.title ? 'OK' : pwRes.pageState?.reason;
            }

            if (product && product.title) {
                await pushDataWithRetry([product]);
                totalProductsScraped++;
                if (product.isSold) soldItemsCount++;
                if (product.listingType === 'Buy It Now') buyItNowCount++;
                else auctionsCount++;
                diagnostics.push({ target: targetUrl, mode: 'product', state: 'ok', itemsExtracted: 1 });
                log.info(`[${totalProductsScraped}] Scraped: "${product.title.slice(0, 40)}..." | ${product.currency} ${product.price ?? 'N/A'} | Format: ${product.listingType}`);
            } else {
                const reasonMsg = finalReason || 'Target page returned no parseable item details';
                diagnostics.push({ target: targetUrl, mode: 'product', state: finalState, reason: reasonMsg, itemsExtracted: 0 });
                log.warning(`Could not extract valid item from ${targetUrl} (state=${finalState}: ${reasonMsg})`);
            }

            await new Promise((r) => setTimeout(r, 1000));
        }
    }

    // 2. Process Search Keywords (with lightweight pagination when maxProducts exceeds 1 page)
    if (effectiveSearchKeywords.length > 0) {
        log.info(`Searching eBay for ${effectiveSearchKeywords.length} keyword(s)...`);

        for (const keyword of effectiveSearchKeywords) {
            log.info(`Searching eBay for: "${keyword}" (max: ${maxProducts})`);

            let baseSearchUrl = `https://www.${ebayDomain}/sch/i.html?_nkw=${encodeURIComponent(keyword)}&_ipg=120`;
            if (soldItemsOnly) baseSearchUrl += '&LH_Sold=1&LH_Complete=1';
            if (listingType === 'buyItNow') baseSearchUrl += '&LH_BIN=1';
            else if (listingType === 'auction') baseSearchUrl += '&LH_Auction=1';
            if (condition === 'new') baseSearchUrl += '&LH_ItemCondition=1000';
            else if (condition === 'refurbished') baseSearchUrl += '&LH_ItemCondition=2000|2500';
            else if (condition === 'used') baseSearchUrl += '&LH_ItemCondition=3000';

            try {
                const collected = [];
                const seenKeys = new Set();
                let lastState = 'ok';
                let lastReason = 'OK';
                const maxPages = Math.min(5, Math.max(1, Math.ceil(maxProducts / 60)));

                for (let pageNum = 1; pageNum <= maxPages && collected.length < maxProducts; pageNum++) {
                    const searchUrl = pageNum === 1 ? baseSearchUrl : `${baseSearchUrl}&_pgn=${pageNum}`;
                    const httpRes = await fetchHtmlWithHttp(searchUrl);
                    let pageItems = parseEbaySearchHtml(httpRes.html, ebayDomain);
                    lastState = pageItems.length > 0 ? 'ok' : httpRes.pageState.state;
                    lastReason = pageItems.length > 0 ? 'OK' : httpRes.pageState.reason;

                    if (pageItems.length === 0) {
                        log.info(`Using browser fallback for eBay search "${keyword}" page ${pageNum} (HTTP state=${lastState}, len=${httpRes.html?.length || 0}, reason=${lastReason})...`);
                        const pwRes = await fetchWithPlaywright(
                            searchUrl,
                            'search',
                            (res) => extractSearchResultsFromPw(res).length > 0
                        );
                        pageItems = extractSearchResultsFromPw(pwRes);
                        lastState = pageItems.length > 0 ? 'ok' : (pwRes.pageState?.state || lastState);
                        lastReason = pageItems.length > 0 ? 'OK' : (pwRes.pageState?.reason || lastReason);
                    }

                    if (pageItems.length === 0) break;

                    let addedOnPage = 0;
                    for (const item of pageItems) {
                        const key = item.itemId || item.url;
                        if (key && seenKeys.has(key)) continue;
                        if (key) seenKeys.add(key);
                        collected.push(item);
                        addedOnPage++;
                        if (collected.length >= maxProducts) break;
                    }
                    if (addedOnPage === 0) break;
                }

                const sliced = collected.slice(0, maxProducts).map((item) => ({ ...item, searchKeyword: keyword }));
                if (sliced.length > 0) {
                    await pushDataWithRetry(sliced);
                    for (const item of sliced) {
                        totalProductsScraped++;
                        if (item.isSold) soldItemsCount++;
                        if (item.listingType === 'Buy It Now') buyItNowCount++;
                        else auctionsCount++;
                    }
                }

                diagnostics.push({
                    target: keyword,
                    mode: 'search',
                    state: sliced.length > 0 ? 'ok' : lastState,
                    reason: sliced.length > 0 ? 'OK' : (lastReason || `No search results parsed for "${keyword}"`),
                    itemsExtracted: sliced.length,
                });

                if (sliced.length > 0) {
                    log.info(`Extracted ${sliced.length} search results for "${keyword}"`);
                } else {
                    log.warning(`Extracted 0 search results for "${keyword}" (state=${lastState}: ${lastReason})`);
                }
            } catch (searchErr) {
                diagnostics.push({ target: keyword, mode: 'search', state: 'error', reason: searchErr.message, itemsExtracted: 0 });
                log.error(`Error searching eBay for "${keyword}": ${searchErr.message}`);
            }
        }
    }

    await closeActiveBrowser();

    const summary = {
        totalProductsScraped,
        soldItemsCount,
        buyItNowCount,
        auctionsCount,
        domain: ebayDomain,
        diagnostics,
        status: totalProductsScraped > 0 ? 'SUCCEEDED' : 'FAILED',
        scrapedAt: new Date().toISOString(),
    };

    await Actor.setValue('OUTPUT', summary);
    if (totalProductsScraped === 0) {
        const lastDiag = diagnostics[diagnostics.length - 1];
        const hint = lastDiag?.reason ? ` Last diagnostic: ${lastDiag.state} (${lastDiag.reason}).` : '';
        await Actor.fail(`Extracted 0 products.${hint} Verify target URLs, keywords, or enable Apify RESIDENTIAL / UNBLOCKER Proxy.`);
    }
    log.info(`eBay Scraping finished successfully! Total items: ${totalProductsScraped}`);
} catch (err) {
    await closeActiveBrowser();
    log.error(`Fatal execution error: ${err.message}`, { stack: err.stack });
    await Actor.setValue('OUTPUT', { status: 'FAILED', error: err.message, diagnostics });
    await Actor.fail(err.message);
} finally {
    await closeActiveBrowser();
    await Actor.exit();
}
