import { Actor } from 'apify';
import { PuppeteerCrawler } from '@crawlee/puppeteer';

// The main function of the Actor
await Actor.main(async () => {
    console.log('>>> RUNNING THE FINAL, CORRECTED 2-STEP CRAWLER <<<');

    const requestQueue = await Actor.openRequestQueue();
    await requestQueue.addRequest({
        url: 'https://coinmarketcap.com/new/',
        userData: { label: 'LIST' },
    });

    const crawler = new PuppeteerCrawler({
        // Headless is faster and uses far less memory. It's essential for this crawler.
        headless: true,
        requestQueue,
        // This is critical for memory management. We will only process 5 pages at a time.
        maxConcurrency: 5,

        // This function will be called for each page the crawler visits.
        requestHandler: async ({ request, page, log }) => {
            const { label, data: basicCoinData } = request.userData;

            // --- STEP 1: Process the list page to find all coin detail URLs ---
            if (label === 'LIST') {
                log.info('Processing list page to discover coins...');

                const nextDataSelector = 'script#__NEXT_DATA__';
                await page.waitForSelector(nextDataSelector, { timeout: 30000 });
                const pageData = await page.evaluate(s => JSON.parse(document.querySelector(s).textContent), nextDataSelector);
                const coins = pageData?.props?.pageProps?.data?.data?.recentlyAddedList;

                if (!coins || coins.length === 0) throw new Error('Could not find coin list on the main page.');
                
                log.info(`Found ${coins.length} coins. Enqueuing their detail pages...`);

                for (const coin of coins) {
                    const detailUrl = `https://coinmarketcap.com/currencies/${coin.slug}/`;
                    await requestQueue.addRequest({
                        url: detailUrl,
                        userData: {
                            label: 'DETAIL',
                            data: {
                                name: coin.name,
                                symbol: coin.symbol,
                                url: detailUrl,
                            }
                        },
                    });
                }
            }

            // --- STEP 2: Process each detail page to extract social links from its own data script ---
            if (label === 'DETAIL') {
                log.info(`Extracting direct data from detail page: ${request.url}`);

                const nextDataSelector = 'script#__NEXT_DATA__';
                await page.waitForSelector(nextDataSelector, { timeout: 30000 });
                log.info(`Found __NEXT_DATA__ for ${basicCoinData.name}.`);

                const pageData = await page.evaluate(s => JSON.parse(document.querySelector(s).textContent), nextDataSelector);
                
                // Navigate through the JSON to find the URLs object for the specific coin.
                const urls = pageData?.props?.pageProps?.detailRes?.detail?.urls;

                const socials = {};
                if (urls) {
                    // This logic safely extracts all available links.
                    if (urls.website && urls.website.length > 0) socials.Website = urls.website[0];
                    if (urls.twitter && urls.twitter.length > 0) socials.Twitter = urls.twitter[0];
                    if (urls.source_code && urls.source_code.length > 0) socials.Github = urls.source_code[0];
                    if (urls.chat && urls.chat.length > 0) {
                        urls.chat.forEach(link => {
                            if (link.includes('discord')) socials.Discord = link;
                            else if (link.includes('t.me')) socials.Telegram = link;
                            else if (link.includes('youtube')) socials.YouTube = link;
                        });
                    }
                } else {
                    log.warning(`Could not find social URLs for ${basicCoinData.name}.`);
                }

                const finalResult = {
                    ...basicCoinData,
                    socials,
                };

                await Actor.pushData(finalResult);
                log.info(`Successfully processed and saved data for ${basicCoinData.name}.`);
            }
        },

        failedRequestHandler: ({ request, log }) => {
            log.error(`Request for ${request.url} failed and was aborted.`);
        },
    });

    await crawler.run();

    console.log('Crawler has finished successfully!');
});