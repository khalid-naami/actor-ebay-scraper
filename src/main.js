import { Actor, log } from 'apify';
import { gotScraping } from 'got-scraping';
import { chromium } from 'playwright';
import {
    extractEbayItemId,
    parseEbayProductHtml,
    parseEbaySearchHtml,
} from './extractors.js';

await Actor.init();

try {
    const input = (await Actor.getInput()) || {};
    const {
        productUrls = [
            'https://www.ebay.com/itm/123456789012',
        ],
        searchKeywords = [],
        soldItemsOnly = false,
        listingType = 'all',
        condition = 'all',
        ebayDomain = 'ebay.com',
        maxProducts = 40,
        proxyConfiguration,
    } = input;

    log.info(`Starting eBay Arbitrage Scraper (Domain: ${ebayDomain}, Sold Items Only: ${soldItemsOnly})...`);

    // Setup Proxy
    let proxyUrl = undefined;
    if (proxyConfiguration) {
        const proxyConfig = await Actor.createProxyConfiguration(proxyConfiguration);
        if (proxyConfig) {
            proxyUrl = await proxyConfig.newUrl();
            log.info('Proxy enabled successfully');
        }
    }

    let totalProductsScraped = 0;
    let soldItemsCount = 0;
    let buyItNowCount = 0;
    let auctionsCount = 0;

    // Helper: Browser instance
    let browser = null;
    const getBrowser = async () => {
        if (!browser) {
            const launchOptions = {
                headless: true,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-blink-features=AutomationControlled',
                ],
            };
            if (proxyUrl) {
                try {
                    const u = new URL(proxyUrl);
                    launchOptions.proxy = {
                        server: `${u.protocol}//${u.hostname}${u.port ? ':' + u.port : ''}`,
                        ...(u.username ? { username: decodeURIComponent(u.username) } : {}),
                        ...(u.password ? { password: decodeURIComponent(u.password) } : {}),
                    };
                } catch {
                    launchOptions.proxy = { server: proxyUrl };
                }
            }
            browser = await chromium.launch(launchOptions);
        }
        return browser;
    };

    // 1. Process Direct Product URLs
    if (Array.isArray(productUrls) && productUrls.length > 0) {
        log.info(`Processing ${productUrls.length} direct eBay item URLs...`);

        for (const rawUrl of productUrls) {
            const targetUrl = typeof rawUrl === 'string' ? rawUrl : rawUrl?.url;
            if (!targetUrl) continue;

            log.info(`Fetching eBay Item: ${targetUrl}`);
            let product = null;

            // Strategy A: gotScraping
            try {
                const response = await gotScraping({
                    url: targetUrl,
                    proxyUrl,
                    headers: {
                        'accept-language': 'en-US,en;q=0.9',
                        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
                    },
                    timeout: { request: 30000 },
                });

                const html = response.body;
                if (!html.includes('Security Measure') && !html.includes('robot check')) {
                    product = parseEbayProductHtml(html, targetUrl, ebayDomain);
                }
            } catch (err) {
                log.debug(`gotScraping error for ${targetUrl}: ${err.message}`);
            }

            // Strategy B: Browser fallback
            if (!product || !product.title) {
                try {
                    log.info(`Using browser fallback for eBay item: ${targetUrl}...`);
                    const b = await getBrowser();
                    const page = await b.newPage();
                    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 35000 });
                    await page.waitForTimeout(2000);

                    const html = await page.content();
                    product = parseEbayProductHtml(html, targetUrl, ebayDomain);
                    await page.close();
                } catch (bErr) {
                    log.warning(`Browser fallback error for ${targetUrl}: ${bErr.message}`);
                }
            }

            if (product && product.title) {
                await Actor.pushData(product);
                totalProductsScraped++;
                if (product.isSold) soldItemsCount++;
                if (product.listingType === 'Buy It Now') buyItNowCount++;
                else auctionsCount++;

                log.info(`[${totalProductsScraped}] Scraped: "${product.title.slice(0, 40)}..." | ${product.currency} ${product.price ?? 'N/A'} | Format: ${product.listingType}`);
            } else {
                log.warning(`Could not extract valid item from: ${targetUrl}`);
            }

            // Polite delay
            await new Promise((r) => setTimeout(r, 1500));
        }
    }

    // 2. Process Search Keywords
    if (Array.isArray(searchKeywords) && searchKeywords.length > 0) {
        log.info(`Searching eBay for ${searchKeywords.length} keywords...`);

        for (const keyword of searchKeywords) {
            log.info(`Searching eBay for: "${keyword}" (max: ${maxProducts})`);

            let searchUrl = `https://www.${ebayDomain}/sch/i.html?_nkw=${encodeURIComponent(keyword)}&_ipg=100`;

            // Filter: Sold & Completed items (Arbitrage mode)
            if (soldItemsOnly) {
                searchUrl += '&LH_Sold=1&LH_Complete=1';
            }

            // Filter: Listing format
            if (listingType === 'buyItNow') searchUrl += '&LH_BIN=1';
            else if (listingType === 'auction') searchUrl += '&LH_Auction=1';

            // Filter: Condition
            if (condition === 'new') searchUrl += '&LH_ItemCondition=1000';
            else if (condition === 'refurbished') searchUrl += '&LH_ItemCondition=2000|2500';
            else if (condition === 'used') searchUrl += '&LH_ItemCondition=3000';

            try {
                let html = null;

                try {
                    const response = await gotScraping({
                        url: searchUrl,
                        proxyUrl,
                        headers: {
                            'accept-language': 'en-US,en;q=0.9',
                            'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
                        },
                        timeout: { request: 30000 },
                    });
                    html = response.body;
                } catch (err) {
                    log.debug(`Direct search request failed: ${err.message}`);
                }

                if (!html || html.includes('Security Measure') || html.includes('robot check')) {
                    const b = await getBrowser();
                    const page = await b.newPage();
                    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 35000 });
                    await page.waitForTimeout(3000);
                    html = await page.content();
                    await page.close();
                }

                const results = parseEbaySearchHtml(html, ebayDomain);
                const sliced = results.slice(0, maxProducts);

                for (const item of sliced) {
                    item.searchKeyword = keyword;
                    await Actor.pushData(item);
                    totalProductsScraped++;
                    if (item.isSold) soldItemsCount++;
                    if (item.listingType === 'Buy It Now') buyItNowCount++;
                    else auctionsCount++;
                }

                log.info(`Extracted ${sliced.length} search results for "${keyword}"`);

            } catch (searchErr) {
                log.error(`Error searching eBay for "${keyword}": ${searchErr.message}`);
            }
        }
    }

    if (browser) {
        await browser.close();
    }

    // Save final executive summary
    const summary = {
        totalProductsScraped,
        soldItemsCount,
        buyItNowCount,
        auctionsCount,
        domain: ebayDomain,
        status: 'SUCCEEDED',
        scrapedAt: new Date().toISOString(),
    };

    await Actor.setValue('OUTPUT', summary);
    log.info(`eBay Scraping finished successfully! Total items: ${totalProductsScraped}`);

} catch (err) {
    log.error(`Fatal execution error: ${err.message}`, { stack: err.stack });
    await Actor.setValue('OUTPUT', { status: 'FAILED', error: err.message });
} finally {
    await Actor.exit();
}
