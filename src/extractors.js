/**
 * eBay Product & Search Extraction Handlers
 */

function decodeHtmlEntities(str) {
    if (!str || typeof str !== 'string') return str;
    return str
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&#x27;/g, "'")
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Extract 12-digit numerical eBay Item ID from URL
 */
export function extractEbayItemId(url) {
    if (!url || typeof url !== 'string') return null;
    const match = url.match(/\/itm\/(?:[^\/]+\/)?(\d{10,14})/i) || url.match(/item=(\d{10,14})/i);
    return match ? match[1] : null;
}

export function detectEbayPageState(html, statusCode = 200) {
    if (statusCode === 404 || statusCode === 410) {
        return { state: 'unavailable', reason: `HTTP ${statusCode} (eBay listing not found)` };
    }
    if (statusCode === 503 || statusCode === 429 || statusCode === 403) {
        return { state: 'antibot_challenge', reason: `HTTP ${statusCode} eBay anti-bot challenge` };
    }
    if (statusCode >= 400) {
        return { state: 'http_error', reason: `HTTP ${statusCode}` };
    }
    if (!html || typeof html !== 'string' || html.trim().length < 20) {
        return { state: 'empty_body', reason: 'Empty or truncated HTML response' };
    }
    const rawLower = html.toLowerCase();
    const visibleLower = html
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .toLowerCase();
    const hasListingSignals =
        /\/itm\/(?:[^/"'\s]+\/)?\d{8,}/i.test(html) ||
        rawLower.includes('s-item__link') ||
        rawLower.includes('s-card__link') ||
        rawLower.includes('x-item-title') ||
        rawLower.includes('srp-results');

    if (
        visibleLower.includes('pardon our interruption') ||
        visibleLower.includes('checking your browser before you access') ||
        visibleLower.includes('please verify yourself to continue') ||
        (!hasListingSignals && (
            rawLower.includes('pardon our interruption') ||
            rawLower.includes('security measure') ||
            rawLower.includes('checking your browser') ||
            rawLower.includes('splashui/challenge') ||
            rawLower.includes('robot check')
        ))
    ) {
        return {
            state: 'antibot_challenge',
            reason: 'eBay anti-bot challenge ("Pardon Our Interruption") detected; RESIDENTIAL or UNBLOCKER proxy recommended',
        };
    }
    const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const pageTitle = titleMatch ? decodeHtmlEntities(titleMatch[1]) : '';
    if (
        /error page|page not found/i.test(pageTitle) ||
        visibleLower.includes('this listing has ended and is no longer available') ||
        visibleLower.includes('we looked everywhere. looks like this page is missing')
    ) {
        return { state: 'unavailable', reason: pageTitle || 'Listing Not Found' };
    }
    if (html.trim().length < 200) {
        return { state: 'empty_body', reason: 'Empty or truncated HTML response' };
    }
    return { state: 'ok', reason: pageTitle || 'OK' };
}

/**
 * Clean numeric price from string
 */
export function parseEbayPrice(raw) {
    if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
    if (!raw || typeof raw !== 'string') return null;
    const parts = raw.split(/\s+to\s+|\s*-\s*/);
    const target = parts[0];
    const cleaned = target.replace(/[^0-9.,]/g, '').trim();
    if (!cleaned) return null;
    if (cleaned.includes(',') && !cleaned.includes('.')) {
        return parseFloat(cleaned.replace(',', '.'));
    }
    return parseFloat(cleaned.replace(/,/g, ''));
}

/**
 * Extract currency code from string or domain
 */
export function parseEbayCurrency(raw, domain = 'ebay.com') {
    if (raw && typeof raw === 'string') {
        if (raw.includes('$')) {
            if (domain.includes('.ca')) return 'CAD';
            if (domain.includes('.com.au')) return 'AUD';
            return 'USD';
        }
        if (raw.includes('£') || raw.includes('GBP')) return 'GBP';
        if (raw.includes('€') || raw.includes('EUR')) return 'EUR';
    }
    if (domain.includes('.co.uk')) return 'GBP';
    if (domain.includes('.de') || domain.includes('.fr') || domain.includes('.it') || domain.includes('.es')) return 'EUR';
    if (domain.includes('.ca')) return 'CAD';
    if (domain.includes('.com.au')) return 'AUD';
    return 'USD';
}

/**
 * Clean numeric feedback score
 */
export function parseEbayFeedbackScore(raw) {
    if (typeof raw === 'number') return Number.isFinite(raw) ? Math.trunc(raw) : null;
    if (!raw || typeof raw !== 'string') return null;
    const digits = raw.replace(/[^\d]/g, '');
    return digits ? parseInt(digits, 10) : null;
}

/**
 * Parse product details from eBay Product HTML
 */
export function parseEbayProductHtml(html, url = '', domain = 'ebay.com') {
    if (!html) return null;

    const itemId = extractEbayItemId(url);

    // 1. JSON-LD fallback
    let ldData = null;
    try {
        const ldMatches = html.match(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi);
        if (ldMatches) {
            for (const script of ldMatches) {
                const jsonText = script.replace(/<script[^>]*>/i, '').replace(/<\/script>/i, '').trim();
                const parsed = JSON.parse(jsonText);
                const candidates = Array.isArray(parsed)
                    ? parsed
                    : Array.isArray(parsed?.['@graph'])
                        ? parsed['@graph']
                        : [parsed];
                const hit = candidates.find((d) => d && (d['@type'] === 'Product' || (Array.isArray(d['@type']) && d['@type'].includes('Product'))));
                if (hit) {
                    ldData = hit;
                    break;
                }
            }
        }
    } catch {
        // Fallback
    }

    // Title
    let title = ldData?.name || null;
    if (!title) {
        const titleMatch = html.match(/class="[^"]*x-item-title__mainTitle[^"]*"[^>]*>([\s\S]*?)<\/h1>/i) ||
                           html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
        if (titleMatch) title = decodeHtmlEntities(titleMatch[1].replace(/<[^>]+>/g, ''));
    } else {
        title = decodeHtmlEntities(title);
    }

    // Price
    let price = ldData?.offers?.price ? parseEbayPrice(String(ldData.offers.price)) : null;
    let originalPrice = null;

    const priceMatch = html.match(/class="[^"]*(?:x-price-primary|x-bin-price)[^"]*"[^>]*>[\s\S]*?<span[^>]*class="ux-textspans"[^>]*>([\s\S]*?)<\/span>/i);
    if (priceMatch && price === null) {
        price = parseEbayPrice(priceMatch[1]);
    }

    const origPriceMatch = html.match(/class="[^"]*ux-textspans--STRIKETHROUGH[^"]*"[^>]*>([\s\S]*?)<\/span>/i);
    if (origPriceMatch) {
        originalPrice = parseEbayPrice(origPriceMatch[1]);
    }

    const currency = ldData?.offers?.priceCurrency || parseEbayCurrency(html, domain);

    // Shipping Cost
    let shippingCost = 'Free shipping';
    const shipMatch = html.match(/class="[^"]*ux-labels-values--shipping[^"]*"[^>]*>[\s\S]*?<span class="ux-textspans"[^>]*>([\s\S]*?)<\/span>/i);
    if (shipMatch) {
        shippingCost = shipMatch[1].replace(/<[^>]+>/g, '').trim();
    }

    // Condition
    let condition = 'Used';
    const condMatch = html.match(/data-testid="x-item-condition"[^>]*>[\s\S]*?<span class="ux-textspans"[^>]*>([\s\S]*?)<\/span>/i);
    if (condMatch) {
        condition = condMatch[1].replace(/<[^>]+>/g, '').trim();
    }

    // Listing Format & Bids
    const isAuction = html.includes('class="x-bid-count"') || html.includes('Current bid:');
    const listingType = isAuction ? 'Auction' : 'Buy It Now';

    let bidsCount = 0;
    if (isAuction) {
        const bidsMatch = html.match(/(\d+)\s*bids/i);
        if (bidsMatch) bidsCount = parseInt(bidsMatch[1], 10);
    }

    // Sold status
    const isSold = html.includes('class="ux-textspans--POSITIVE"') && html.toLowerCase().includes('sold');
    let soldDate = null;
    if (isSold) {
        const dateMatch = html.match(/Sold\s*([A-Za-z]+\s*\d{1,2},\s*\d{4})/i);
        if (dateMatch) soldDate = dateMatch[1];
    }

    // Seller Information
    let sellerName = null;
    let sellerFeedbackScore = null;
    let sellerPositiveFeedback = null;

    const sellerMatch = html.match(/class="[^"]*x-sellercard-atf__info__about-seller[^"]*"[^>]*title="([^"]+)"/i) ||
                        html.match(/href="[^"]*\/usr\/([^"?]+)"/i);
    if (sellerMatch) sellerName = sellerMatch[1].trim();

    const scoreMatch = html.match(/\(([\d,]+)\)\s*<span/i) || html.match(/\(([\d,]+)\)/);
    if (scoreMatch) sellerFeedbackScore = parseEbayFeedbackScore(scoreMatch[1]);

    const posMatch = html.match(/(\d{2,3}(?:\.\d+)?%)\s*(?:positive feedback|positive)/i);
    if (posMatch) sellerPositiveFeedback = posMatch[1];

    const topRatedSeller = html.includes('Top Rated Plus') || html.includes('top-rated-seller');

    // Item Location & Returns
    let location = null;
    const locMatch = html.match(/class="[^"]*ux-labels-values--itemLocation[^"]*"[^>]*>[\s\S]*?<span class="ux-textspans"[^>]*>([\s\S]*?)<\/span>/i);
    if (locMatch) location = locMatch[1].replace(/<[^>]+>/g, '').trim();

    let returns = null;
    const retMatch = html.match(/class="[^"]*ux-labels-values--returns[^"]*"[^>]*>[\s\S]*?<span class="ux-textspans"[^>]*>([\s\S]*?)<\/span>/i);
    if (retMatch) returns = retMatch[1].replace(/<[^>]+>/g, '').trim();

    // Images
    const images = [];
    if (Array.isArray(ldData?.image)) images.push(...ldData.image);
    else if (typeof ldData?.image === 'string') images.push(ldData.image);

    const carouselImgBlocks = [...html.matchAll(/<img\b[^>]*class="[^"]*(?:ux-image-filmstrip-carousel|ux-image-carousel-item)[^"]*"[^>]*>/gi)];
    for (const m of carouselImgBlocks) {
        const srcMatch = m[0].match(/\b(?:data-zoom-src|data-src|src)="([^"]+)"/i);
        if (srcMatch?.[1]) {
            const src = srcMatch[1].replace(/s-l\d+\.(jpg|jpeg|png|webp)$/i, 's-l1600.$1');
            images.push(src);
        }
    }

    const thumbnail = images[0] || (typeof ldData?.image === 'string' ? ldData.image : null);

    if (!title) return null;

    return {
        itemId,
        title,
        price,
        originalPrice,
        currency,
        shippingCost,
        condition,
        listingType,
        bidsCount: isAuction ? bidsCount : 0,
        isSold,
        soldDate,
        sellerName,
        sellerFeedbackScore,
        sellerPositiveFeedback,
        topRatedSeller,
        location,
        returns,
        thumbnail,
        images: [...new Set(images)],
        url,
        scrapedAt: new Date().toISOString(),
    };
}

/**
 * Clean noisy eBay accessibility/badge phrasing from extracted titles
 */
function cleanListingTitle(raw) {
    if (!raw || typeof raw !== 'string') return '';
    return decodeHtmlEntities(
        raw
            .replace(/<!--.*?-->/g, '')
            .replace(/<[^>]+>/g, ' ')
            .replace(/Opens in a new window or tab/gi, '')
            .replace(/^New Listing\b/i, '')
    );
}

/**
 * Extract listings from eBay Search Results SERP HTML
 */
export function parseEbaySearchHtml(html, domain = 'ebay.com') {
    const results = [];
    if (!html) return results;

    const seenIds = new Set();
    const seenUrls = new Set();

    const normalizeItemUrl = (rawHref) => {
        if (!rawHref) return null;
        const clean = rawHref.split('?')[0].split('#')[0].trim();
        if (clean.startsWith('http://') || clean.startsWith('https://')) return clean;
        if (clean.startsWith('/')) return `https://www.${domain}${clean}`;
        return null;
    };

    const items = [
        ...html.matchAll(
            /<li\b[^>]*(?:\bs-item\b|\bs-card\b|data-listingid=|data-viewport=)[^>]*>[\s\S]*?(?=<li\b[^>]*(?:\bs-item\b|\bs-card\b|data-listingid=|data-viewport=)|<\/ul>|$)/gi
        ),
    ];

    for (const item of items) {
        const itemHtml = item[0];

        // Link & Item ID (supports any attribute order and s-item__link / s-card__link)
        const linkMatch =
            itemHtml.match(/<a\b[^>]*class="[^"]*(?:s-item__link|s-card__link)[^"]*"[^>]*href="([^"]+)"/i) ||
            itemHtml.match(/<a\b[^>]*href="([^"]+)"[^>]*class="[^"]*(?:s-item__link|s-card__link)/i) ||
            itemHtml.match(/<a\b[^>]*href="((?:https?:\/\/[^"]*ebay\.[^"]*)?\/itm\/[^"]+)"/i);
        if (!linkMatch) continue;

        const cleanUrl = normalizeItemUrl(linkMatch[1]);
        if (!cleanUrl || !cleanUrl.includes('/itm/')) continue;
        const itemId = extractEbayItemId(cleanUrl);
        if (itemId === '123456') continue;
        if ((itemId && seenIds.has(itemId)) || seenUrls.has(cleanUrl)) continue;

        const cleanedBlock = itemHtml.replace(/<span[^>]*class="[^"]*LIGHT_HIGHLIGHT[^"]*"[^>]*>[\s\S]*?<\/span>/gi, ' ');

        // Title (supports s-item span[role=heading], s-card div[role=heading], anchor/img alt)
        const titleMatch =
            cleanedBlock.match(/<(div|h3)\b[^>]*role="heading"[^>]*>([\s\S]*?)<\/\1>/i) ||
            cleanedBlock.match(/<span\b[^>]*role="heading"[^>]*>([\s\S]*?)<\/span>/i) ||
            cleanedBlock.match(/<(div|a)\b[^>]*class="[^"]*(?:s-item__title|s-card__title)[^"]*"[^>]*>([\s\S]*?)<\/\1>/i) ||
            cleanedBlock.match(/<span\b[^>]*class="[^"]*(?:s-item__title|s-card__title)[^"]*"[^>]*>([\s\S]*?)<\/span>/i) ||
            cleanedBlock.match(/<a\b[^>]*class="[^"]*(?:s-item__link|s-card__link)[^"]*"[^>]*>([\s\S]*?)<\/a>/i) ||
            cleanedBlock.match(/<img\b[^>]*alt="([^"]{8,})"/i);
        if (!titleMatch) continue;

        const rawTitle = titleMatch.length >= 3 ? titleMatch[2] : titleMatch[1];
        const title = cleanListingTitle(rawTitle);
        if (!title || title.length < 4 || title.toLowerCase().includes('shop on ebay')) continue;

        // Price
        const priceMatch =
            cleanedBlock.match(/class="[^"]*(?:s-item__price|s-card__price)[^"]*"[^>]*>([\s\S]{1,250}?)<\/(?:span|div)>/i) ||
            cleanedBlock.match(/((?:US\s*)?[$£€]\s*[\d,]+(?:\.\d{1,2})?)/i);
        const priceRaw = priceMatch ? decodeHtmlEntities(priceMatch[1].replace(/<[^>]+>/g, '')) : null;
        const price = priceRaw ? parseEbayPrice(priceRaw) : null;

        // Shipping
        const shipMatch = cleanedBlock.match(/class="[^"]*(?:s-item__shipping|s-item__logisticsCost|s-card__shipping|su-styled-text[^"]*secondary)[^"]*"[^>]*>([\s\S]{1,200}?)<\/span>/i);
        let shippingCost = shipMatch ? decodeHtmlEntities(shipMatch[1].replace(/<[^>]+>/g, '')) : 'Free shipping';
        if (shippingCost && !/shipping|postage|delivery|free/i.test(shippingCost)) {
            shippingCost = 'Free shipping';
        }

        // Condition
        const condMatch = cleanedBlock.match(/class="[^"]*(?:s-item__subtitle|s-card__subtitle)[^"]*"[^>]*>([\s\S]{1,250}?)<\/(?:div|span)>/i);
        const condition = condMatch ? decodeHtmlEntities(condMatch[1].replace(/<[^>]+>/g, '')) || 'Pre-Owned' : 'Pre-Owned';

        // Sold status
        const isSold = (cleanedBlock.includes('s-item__title--tag') || cleanedBlock.includes('s-card__') || /sold\s+[a-z]+\s+\d/i.test(cleanedBlock)) &&
            cleanedBlock.toLowerCase().includes('sold');
        let soldDate = null;
        if (isSold) {
            const soldMatch = cleanedBlock.match(/Sold\s*([A-Za-z]+\s*\d{1,2},\s*\d{4})/i);
            if (soldMatch) soldDate = soldMatch[1];
        }

        // Bids
        const bidsMatch = cleanedBlock.match(/class="[^"]*(?:s-item__bids|s-card__bids)[^"]*"[^>]*>([\s\S]{1,120}?)<\/span>/i) ||
            cleanedBlock.match(/(\d+\s*bids?)\b/i);
        const isAuction = Boolean(bidsMatch);
        const bidsCount = bidsMatch ? (parseInt(bidsMatch[1].replace(/[^\d]/g, ''), 10) || 0) : 0;

        // Thumbnail (supports any attribute order & lazy loading)
        const imgTagMatch = cleanedBlock.match(/<img\b[^>]*>/i);
        const imgAttrMatch = imgTagMatch?.[0]?.match(/\b(?:data-defer-load|data-src|src)="([^"]+)"/i);
        let thumbnail = imgAttrMatch?.[1] || null;
        if (thumbnail && thumbnail.startsWith('data:')) thumbnail = null;
        if (thumbnail) thumbnail = thumbnail.replace(/s-l\d+\.(jpg|jpeg|png|webp)$/i, 's-l500.$1');

        if (itemId) seenIds.add(itemId);
        seenUrls.add(cleanUrl);
        results.push({
            itemId,
            title,
            price,
            currency: parseEbayCurrency(priceRaw || cleanedBlock, domain),
            shippingCost,
            condition,
            listingType: isAuction ? 'Auction' : 'Buy It Now',
            bidsCount,
            isSold,
            soldDate,
            thumbnail,
            url: cleanUrl,
            scrapedAt: new Date().toISOString(),
        });
    }

    // Layer 2 Fallback: direct /itm/ anchor scan if eBay alters card container tags
    if (results.length === 0) {
        const anchorRegex = /<a\b[^>]*href="((?:https?:\/\/[^"]*ebay\.[^"]*)?\/itm\/[^"]+)"[^>]*>([\s\S]{1,800}?)<\/a>/gi;
        for (const m of html.matchAll(anchorRegex)) {
            const cleanUrl = normalizeItemUrl(m[1]);
            if (!cleanUrl) continue;
            const itemId = extractEbayItemId(cleanUrl);
            if (itemId === '123456') continue;
            if ((itemId && seenIds.has(itemId)) || seenUrls.has(cleanUrl)) continue;

            const ariaMatch = m[0].match(/aria-label="([^"]{8,})"/i);
            const title = cleanListingTitle(ariaMatch ? ariaMatch[1] : m[2]);
            if (!title || title.length < 8 || /shop on ebay|see more|sponsored/i.test(title)) continue;

            const start = Math.max(0, (m.index || 0) - 200);
            const snippet = html.slice(start, Math.min(html.length, (m.index || 0) + 900));
            const priceMatch = snippet.match(/((?:US\s*)?[$£€]\s*[\d,]+(?:\.\d{1,2})?)/i);
            const bidsMatch = snippet.match(/(\d+)\s*bids?\b/i);

            if (itemId) seenIds.add(itemId);
            seenUrls.add(cleanUrl);
            results.push({
                itemId,
                title,
                price: priceMatch ? parseEbayPrice(priceMatch[1]) : null,
                currency: parseEbayCurrency(priceMatch?.[1] || snippet, domain),
                shippingCost: 'Free shipping',
                condition: 'Pre-Owned',
                listingType: bidsMatch ? 'Auction' : 'Buy It Now',
                bidsCount: bidsMatch ? parseInt(bidsMatch[1], 10) || 0 : 0,
                isSold: /sold\s+[a-z]+\s+\d/i.test(snippet),
                soldDate: null,
                thumbnail: null,
                url: cleanUrl,
                scrapedAt: new Date().toISOString(),
            });
        }
    }

    return results;
}
