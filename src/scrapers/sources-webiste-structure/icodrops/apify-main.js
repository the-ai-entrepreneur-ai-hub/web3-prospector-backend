import { Actor } from 'apify';
import { PlaywrightCrawler, RequestQueue } from 'crawlee';

// The main function of the Actor
await Actor.main(async () => {
    console.log('🚀 --- Starting ICO Drops Scraper --- 🚀');

    // Get the input for this actor run.
    // It will contain the maxProjects property, defaulting to 20 if not provided.
    const input = await Actor.getInput();
    const { maxProjects = 20 } = input || {};

    // Initialize the request queue and add the starting URL.
    const requestQueue = await Actor.openRequestQueue();
    await requestQueue.addRequest({
        url: 'https://icodrops.com/',
        userData: { label: 'LIST' }, // Label this as the list page
    });

    const crawler = new PlaywrightCrawler({
        requestQueue,
        headless: true, // Set to true for running in the cloud, false for local testing
        requestHandlerTimeoutSecs: 180,
        maxConcurrency: 10,

        async requestHandler({ page, request, log }) {
            const { label } = request.userData;

            // --- STAGE 1: DISCOVER PROJECTS FROM THE LIST PAGE ---
            if (label === 'LIST') {
                log.info('Processing list page to discover project URLs...');

                // The selector for all project links in the three columns
                const projectLinkSelector = '.All-Projects__item';
                await page.waitForSelector(projectLinkSelector, { timeout: 60000 });

                // Extract all unique project URLs from the page
                const projectUrls = await page.evaluate((selector) => {
                    const links = document.querySelectorAll(selector);
                    // Use a Set to automatically handle duplicate URLs found across columns
                    const uniqueUrls = new Set();
                    links.forEach(link => uniqueUrls.add(link.href));
                    return Array.from(uniqueUrls);
                }, projectLinkSelector);

                if (!projectUrls || projectUrls.length === 0) {
                    throw new Error('Could not find any project links on the main page. The website structure may have changed.');
                }

                // Limit the number of projects to scrape based on user input
                const projectsToScrape = projectUrls.slice(0, maxProjects);
                log.info(`Found ${projectUrls.length} unique projects. Enqueuing the first ${projectsToScrape.length} for detail scraping...`);

                // Add the detail page requests to the queue
                for (const url of projectsToScrape) {
                    await requestQueue.addRequest({
                        url,
                        userData: { label: 'DETAIL' }, // Label these as detail pages
                    });
                }
            }

            // --- STAGE 2: SCRAPE DETAILS FROM A PROJECT PAGE ---
            else if (label === 'DETAIL') {
                log.info(`Processing project detail page: ${request.url}...`);

                try {
                    // Wait for the main project title. This confirms the detail page is ready.
                    await page.waitForSelector('h1.Project-Page-Header__name', { timeout: 150000 });
                    log.info(`SUCCESS: Project page loaded and is ready for scraping: ${request.url}`);
                } catch (e) {
                    throw new Error(`The page ${request.url} loaded, but the title selector was not found. The website structure may have changed. Error: ${e.message}`);
                }

                // Use the existing, proven data extraction logic
                const extractedData = await page.evaluate(() => {
                    const data = {
                        projectName: null,
                        description: null,
                        socialLinks: {},
                    };

                    // Extract Project Name
                    data.projectName = document.querySelector('h1.Project-Page-Header__name')?.textContent.trim() || null;

                    // Extract Description
                    data.description = document.querySelector('.Overview-Section-Description__text')?.textContent.trim().replace('...Show More', '').trim() || null;

                    // Extract Social Links
                    const socialLinkElements = document.querySelectorAll('.Project-Page-Header__links-list a');
                    socialLinkElements.forEach(link => {
                        const textElement = link.querySelector('.capsule__text');
                        if (textElement) {
                            const text = textElement.textContent.trim().toLowerCase();
                            const url = link.href;

                            // Map the found text to our desired keys
                            if (text.includes('twitter')) data.socialLinks.twitter = url;
                            else if (text.includes('medium')) data.socialLinks.medium = url;
                            else if (text.includes('telegram') && !data.socialLinks.telegram) data.socialLinks.telegram = url;
                            else if (text.includes('github')) data.socialLinks.github = url;
                            else if (text.includes('website')) data.socialLinks.website = url;
                            else if (text.includes('whitepaper')) data.socialLinks.whitepaper = url;
                        }
                    });

                    return data;
                });

                // Add metadata to the results
                extractedData.source = 'ICODrops';
                extractedData.url = request.url;

                // Save the final, complete data object
                await Actor.pushData(extractedData);
                log.info(`✅ --- SCRAPING COMPLETE! Data for ${extractedData.projectName} saved successfully. --- ✅`);
            }
        },

        failedRequestHandler({ request, log }) {
            log.error(`Request ${request.url} failed. This is the final error after all retries.`);
        },
    });

    // Run the crawler
    await crawler.run();

    console.log('🎉 --- Crawler has finished its run successfully! --- 🎉');
});