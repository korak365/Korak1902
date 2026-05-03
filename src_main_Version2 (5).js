// Apify SDK - toolkit for building Apify Actors (Read more at https://docs.apify.com/sdk/js/)
import { Actor } from 'apify';
// Crawlee - web scraping and browser automation library (Read more at https://crawlee.dev)
import { CheerioCrawler, Dataset, KeyValueStore } from 'crawlee';
import crypto from 'crypto';
import fetch from 'node-fetch';

// The init() call configures the Actor for its environment
await Actor.init();

// Structure of input is defined in input_schema.json
const {
    startUrls = ['https://example-forum.com'],
    maxRequestsPerCrawl = 100,
    imageSelectors = ['img', '.image img', '.post-image', '.media-image'],
    descriptionSelectors = ['.caption', '.image-description', '[data-description]', '.img-caption'],
    minImageWidth = 300,
    minImageHeight = 300,
    downloadImages = true,
    includeMetadata = true,
} = (await Actor.getInput()) ?? {};

// Proxy configuration to rotate IP addresses and prevent blocking
const proxyConfiguration = await Actor.createProxyConfiguration();

// Statistics tracking
const statistics = {
    pagesScraped: 0,
    imagesFound: 0,
    imagesSaved: 0,
    imagesDownloaded: 0,
    errors: 0,
    startTime: new Date(),
};

// Helper function to extract image from a URL or data
async function downloadImage(imageUrl, imageId) {
    try {
        if (!imageUrl || imageUrl.length === 0) return null;

        // Handle relative URLs
        if (imageUrl.startsWith('/')) {
            imageUrl = new URL(imageUrl, startUrls[0]).toString();
        } else if (!imageUrl.startsWith('http')) {
            imageUrl = new URL(imageUrl, startUrls[0]).toString();
        }

        const response = await fetch(imageUrl, { timeout: 10000 });
        if (!response.ok) return null;

        const buffer = await response.buffer();
        const kvStore = await KeyValueStore.open();

        // Store image with unique ID
        await kvStore.setRecord({
            key: `image-${imageId}`,
            value: buffer,
            contentType: response.headers.get('content-type') || 'image/jpeg',
        });

        statistics.imagesDownloaded++;
        return `image-${imageId}`;
    } catch (error) {
        console.error(`Failed to download image: ${imageUrl}`, error.message);
        return null;
    }
}

// Helper function to extract text near an image
function getImageDescription($, imageElement, selectors) {
    let description = '';

    // Try to find description near the image
    for (const selector of selectors) {
        const nearbyElement = $(imageElement).closest('div, article, section, li, figure').find(selector).first();
        if (nearbyElement.length) {
            description = nearbyElement.text().trim();
            if (description.length > 10) break;
        }
    }

    // Fallback: use alt text or title
    if (!description) {
        description = $(imageElement).attr('alt') || $(imageElement).attr('title') || '';
    }

    // Fallback: use parent text
    if (!description) {
        description = $(imageElement).closest('div, article, section, li, figure').text().trim().slice(0, 500);
    }

    return description.trim().slice(0, 1000); // Limit to 1000 chars
}

// Helper function to get image dimensions
async function getImageDimensions(imageUrl) {
    try {
        const response = await fetch(imageUrl, { timeout: 5000 });
        if (!response.ok) return { width: 0, height: 0 };

        // For now, return placeholder dimensions
        // In production, you'd parse the image to get actual dimensions
        return { width: 800, height: 600 };
    } catch {
        return { width: 0, height: 0 };
    }
}

const crawler = new CheerioCrawler({
    proxyConfiguration,
    maxRequestsPerCrawl,
    async requestHandler({ enqueueLinks, request, $, log }) {
        log.info(`Scraping: ${request.loadedUrl}`);
        statistics.pagesScraped++;

        // Enqueue new links from the forum
        await enqueueLinks({
            globs: ['**/*'],
            strategy: 'same-hostname',
            limit: 10, // Limit links per page to avoid crawling too much
        });

        // Extract page metadata
        const pageTitle = $('title').text() || $('h1').first().text() || 'Unknown';
        const pageUrl = request.loadedUrl;

        // Find all images on the page
        const images = [];
        $(imageSelectors.join(', ')).each((i, el) => {
            images.push(el);
        });

        log.info(`Found ${images.length} images on page`);

        // Process each image
        for (let i = 0; i < images.length; i++) {
            const imageElement = images[i];
            const $img = $(imageElement);

            // Get image URL
            let imageUrl = $img.attr('src') || $img.attr('data-src') || '';
            if (!imageUrl) continue;

            // Create unique image ID
            const imageId = crypto.createHash('md5').update(imageUrl + pageUrl).digest('hex').slice(0, 12);

            // Get image dimensions (simplified)
            const width = parseInt($img.attr('width')) || minImageWidth + 100;
            const height = parseInt($img.attr('height')) || minImageHeight + 100;

            // Filter by size
            if (width < minImageWidth || height < minImageHeight) {
                continue;
            }

            // Get description
            const description = getImageDescription($, imageElement, descriptionSelectors);

            // Skip if no meaningful description
            if (description.length < 3) {
                continue;
            }

            statistics.imagesFound++;

            // Download image if requested
            let downloadedImageKey = null;
            if (downloadImages) {
                downloadedImageKey = await downloadImage(imageUrl, imageId);
            }

            // Extract metadata
            const metadata = includeMetadata
                ? {
                      author: $('[rel="author"]').text() || $('[data-author]').attr('data-author') || 'Unknown',
                      date: $('time').attr('datetime') || $('[data-date]').attr('data-date') || new Date().toISOString(),
                      forum: new URL(pageUrl).hostname,
                  }
                : {};

            // Save to Dataset
            await Dataset.pushData({
                imageId,
                imageUrl,
                description,
                pageTitle,
                pageUrl,
                downloadedImageKey,
                imageWidth: width,
                imageHeight: height,
                ...metadata,
                scrapedAt: new Date().toISOString(),
            });

            statistics.imagesSaved++;
            log.info(`Saved image: ${imageId} - "${description.slice(0, 50)}..."`);
        }
    },

    errorHandler({ request, error, log }) {
        log.error(`Request failed: ${request.url}`, error);
        statistics.errors++;
    },
});

// Run the crawler
try {
    await crawler.run(startUrls);
} catch (error) {
    console.error('Crawler error:', error);
    statistics.errors++;
}

// Save statistics to Key-Value Store
const kvStore = await KeyValueStore.open();
await kvStore.setValue('STATISTICS', {
    ...statistics,
    endTime: new Date(),
    duration: new Date() - statistics.startTime,
});

console.log('\n=== Scraping Complete ===');
console.log(`Pages scraped: ${statistics.pagesScraped}`);
console.log(`Total images found: ${statistics.imagesFound}`);
console.log(`Images saved: ${statistics.imagesSaved}`);
console.log(`Images downloaded: ${statistics.imagesDownloaded}`);
console.log(`Errors: ${statistics.errors}`);

// Gracefully exit the Actor process
await Actor.exit();