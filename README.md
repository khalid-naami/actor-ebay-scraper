# 🏷️ eBay Arbitrage Scraper (Sold Items, Buy It Now, Auctions & Prices)

Extract live eBay product listings, sold & completed transactions, Buy It Now prices, auction bid counts, item conditions, seller feedback scores, and shipping fees across all regional eBay marketplaces.

> **Apify Store Short Description (291 chars):**  
> `Scrape eBay product listings, sold & completed items, live Buy It Now prices, auction bids, item conditions, seller feedback, and shipping across global eBay domains. Supports full sold-items arbitrage mode and fast keyword search with proxy rotation for market pricing and retail arbitrage.`

---

## 🌟 Key Features

- 💸 **Sold & Completed Items Filter (Arbitrage Mode)**: Filter by `soldItemsOnly` to extract the true historical prices buyers actually paid, not just asking prices.
- 🔨 **Auctions vs Buy It Now**: Seamlessly distinguishes fixed-price items from active auctions with live bid counts.
- 📦 **Granular Condition Filters**: Filter by Brand New, Certified Refurbished, Open Box, or Pre-Owned/Used conditions.
- ⭐ **Seller Credibility Metrics**: Captures seller usernames, total feedback score count, positive feedback percentage (e.g. "99.4%"), and Top Rated Plus badges.
- 🚚 **Accurate Shipping & Location**: Extracts shipping costs ("Free shipping" vs standard fees), item dispatch locations, and return policy terms.
- 🌍 **Global eBay Marketplaces**: Supports all major eBay domains (`ebay.com`, `ebay.co.uk`, `ebay.de`, `ebay.ca`, `ebay.com.au`, `ebay.fr`, `ebay.it`, `ebay.es`).
- 🛡️ **Anti-Bot & CAPTCHA Resistance**: Backed by residential proxy integration and automatic headless browser fallback.

---

## 📥 Input Configuration

| Field | Type | Default | Description |
|---|---|---|---|
| `productUrls` | Array | `["https://www.ebay.com/itm/..."]` | List of direct eBay item URLs. |
| `searchKeywords` | Array | `[]` | Keywords to search on eBay (e.g. `'iPhone 15 Pro Max'`). |
| `soldItemsOnly` | Boolean | `false` | When true, extracts only completed and sold listings. |
| `listingType` | String | `"all"` | Filter by format: `all`, `buyItNow` (Fixed Price), `auction`. |
| `condition` | String | `"all"` | Filter by condition: `all`, `new`, `refurbished`, `used`. |
| `ebayDomain` | String | `"ebay.com"` | Regional eBay marketplace domain. |
| `maxProducts` | Integer | `40` | Maximum product records to extract per keyword. |
| `proxyConfiguration` | Object | `{ "useApifyProxy": true }` | Apify Proxy settings to bypass IP blocks. |

---

## 📤 Output Data Format

```json
{
  "itemId": "126123456789",
  "title": "Apple iPhone 15 Pro Max - 256GB - Natural Titanium (Unlocked)",
  "price": 899.99,
  "originalPrice": 1199.00,
  "currency": "USD",
  "shippingCost": "Free shipping",
  "condition": "Certified - Refurbished",
  "listingType": "Buy It Now",
  "bidsCount": 0,
  "isSold": true,
  "soldDate": "Sold Nov 8, 2026",
  "sellerName": "quickshipelectronics",
  "sellerFeedbackScore": 482500,
  "sellerPositiveFeedback": "99.6%",
  "topRatedSeller": true,
  "location": "Dallas, Texas, United States",
  "returns": "Free 30-day returns",
  "thumbnail": "https://i.ebayimg.com/images/g/abc123456/s-l1600.jpg",
  "images": [
    "https://i.ebayimg.com/images/g/abc123456/s-l1600.jpg",
    "https://i.ebayimg.com/images/g/xyz987654/s-l1600.jpg"
  ],
  "url": "https://www.ebay.com/itm/126123456789",
  "scrapedAt": "2026-11-10T12:20:00.000Z"
}
```

---

## 💡 Practical Commercial Use Cases

1. **Retail & Online Arbitrage**: Compare eBay sold prices with Amazon or Walmart clearance prices to find profitable resale flips.
2. **Fair Market Value Appraisal**: Appraise collectibles, trading cards, luxury watches, and electronics using verified sold transactions.
3. **Auction Sniping & Monitoring**: Track active auction listings approaching their end time with low bid counts.
4. **Competitor Store Scraping**: Monitor inventory, pricing, and volume of top-rated eBay powersellers.

---

## ⚖️ License
Apache-2.0
