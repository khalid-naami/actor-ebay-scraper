/**
 * eBay Product & Search Extraction Handlers
 */

/**
 * Extract 12-digit numerical eBay Item ID from URL
 */
export function extractEbayItemId(url) {
    if (!url || typeof url !== 'string') return null;
    const match = url.match(/\/itm\/(?:[^\/]+\/)?(\d{10,14})/i) || url.match(/item=(\d{10,14})/i);
    return match ? match[1] : null;
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
        const ldMatches = html.match(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi);
        if (ldMatches) {
            for (const script of ldMatches) {
                const jsonText = script.replace(/<script[^>]*>/i, '').replace(/<\/script>/i, '').trim();
                const d = JSON.parse(jsonText);
                if (d['@type'] === 'Product') {
                    ldData = d;
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
        if (titleMatch) title = titleMatch[1].replace(/<[^>]+>/g, '').trim();
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

    const imgMatches = [...html.matchAll(/class="[^"]*(?:ux-image-filmstrip-carousel|ux-image-carousel-item)[^"]*"[^>]*src="([^"]+)"/gi)];
    for (const m of imgMatches) {
        let src = m[1].replace(/s-l\d+\.jpg$/, 's-l1600.jpg');
        images.push(src);
    }

    const thumbnail = images[0] || (typeof ldData?.image === 'string' ? ldData.image : null);

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
 * Extract listings from eBay Search Results SERP HTML
 */
export function parseEbaySearchHtml(html, domain = 'ebay.com') {
    const results = [];
    if (!html) return results;

    const items = [...html.matchAll(/<li class="[^"]*s-item[^"]*"[\s\S]*?(?=<li class="[^"]*s-item"|$)/gi)];

    for (const item of items) {
        const itemHtml = item[0];

        // Link & Item ID
        const linkMatch = itemHtml.match(/class="s-item__link"[^>]*href="([^"]+)"/i);
        if (!linkMatch) continue;

        const rawUrl = linkMatch[1];
        const cleanUrl = rawUrl.split('?')[0];
        const itemId = extractEbayItemId(cleanUrl);

        // Title
        const titleMatch = itemHtml.match(/<span role="heading"[^>]*>([\s\S]*?)<\/span>/i) ||
                           itemHtml.match(/class="s-item__title"[^>]*>([\s\S]*?)<\/(?:span|div)>/i);
        if (!titleMatch) continue;

        const title = titleMatch[1].replace(/<[^>]+>/g, '').replace(/<!--.*?-->/g, '').trim();
        if (!title || title.toLowerCase().includes('shop on ebay')) continue;

        // Price
        const priceMatch = itemHtml.match(/class="s-item__price"[^>]*>([\s\S]*?)<\/span>/i);
        const price = priceMatch ? parseEbayPrice(priceMatch[1]) : null;

        // Shipping
        const shipMatch = itemHtml.match(/class="[^"]*(?:s-item__shipping|s-item__logisticsCost)[^"]*"[^>]*>([\s\S]*?)<\/span>/i);
        const shippingCost = shipMatch ? shipMatch[1].replace(/<[^>]+>/g, '').trim() : 'Free shipping';

        // Condition
        const condMatch = itemHtml.match(/class="s-item__subtitle"[^>]*>[\s\S]*?<span[^>]*>([\s\S]*?)<\/span>/i);
        const condition = condMatch ? condMatch[1].replace(/<[^>]+>/g, '').trim() : 'Pre-Owned';

        // Sold status
        const isSold = itemHtml.includes('s-item__title--tag') && itemHtml.toLowerCase().includes('sold');
        let soldDate = null;
        if (isSold) {
            const soldMatch = itemHtml.match(/Sold\s*([A-Za-z]+\s*\d{1,2},\s*\d{4})/i);
            if (soldMatch) soldDate = soldMatch[1];
        }

        // Bids
        const bidsMatch = itemHtml.match(/class="s-item__bids"[^>]*>([\s\S]*?)<\/span>/i);
        const isAuction = Boolean(bidsMatch);
        const bidsCount = bidsMatch ? (parseInt(bidsMatch[1].replace(/[^\d]/g, ''), 10) || 0) : 0;

        // Thumbnail
        const imgMatch = itemHtml.match(/<img[^>]*src="([^"]+)"/i);
        let thumbnail = imgMatch ? imgMatch[1] : null;
        if (thumbnail) thumbnail = thumbnail.replace(/s-l\d+\.jpg$/, 's-l500.jpg');

        results.push({
            itemId,
            title,
            price,
            currency: parseEbayCurrency(itemHtml, domain),
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

    return results;
}
