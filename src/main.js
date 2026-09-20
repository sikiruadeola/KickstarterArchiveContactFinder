/**
 * main.js
 *
 * Finds Kickstarter creators whose project has not reached its funding
 * goal, using only the Internet Archive's own copies of project pages.
 * Nothing here ever sends a request to kickstarter.com itself.
 *
 * The tradeoff is stated plainly in the README: every figure reflects
 * whenever the Archive last captured that page, not the live number right
 * now. Coverage is strong and often only weeks old, but treat this as a
 * good first large batch, not a live feed.
 */

import { Actor } from 'apify';
import { CheerioCrawler, log } from 'crawlee';
import { extractEmails, extractUrls, rankEmails } from './emailFinder.js';
import { listRecentProjectUrls, fetchArchivedProject, splitLinks } from './archive.js';

await Actor.init();

const input = (await Actor.getInput()) || {};

const {
    categoryId,
    states = ['live', 'failed'],
    fromDate = '20250101',
    maxCandidates = 300,
    maxProjects = 0,
    crawlCreatorSites = true,
    maxPagesPerSite = 6,
    minimumScore = 0,
} = input;

if (!categoryId) {
    throw new Error('No categoryId supplied. Design is 7, Film and Video is 10, Games is 12, Technology is 16.');
}

const store = await Actor.openKeyValueStore('KICKSTARTER-ARCHIVE-STATE', { forceCloud: true });
const stateKey = `CATEGORY-${categoryId}`;
const savedState = (await store.getValue(stateKey)) || { seenPaths: [] };
const seenPaths = new Set(savedState.seenPaths || []);

log.info(`Listing project pages the Archive has captured since ${fromDate}.`);
const candidates = await listRecentProjectUrls({ fromDate, limit: maxCandidates });
log.info(`Archive listed ${candidates.length} distinct project pages to check.`);

const results = new Map();
const siteQueue = [];
let checked = 0;
let kept = 0;

for (const candidate of candidates) {
    if (seenPaths.has(candidate.path)) continue;
    seenPaths.add(candidate.path);
    checked += 1;

    let project;
    try {
        project = await fetchArchivedProject(candidate);
    } catch (error) {
        log.debug(`Could not read archived snapshot for ${candidate.original}: ${error.message}`);
        continue;
    }

    if (!project) continue;
    if (project.categoryId !== categoryId) continue;
    if (!states.includes(project.state)) continue;
    if (!(project.pledged < project.goal)) continue;

    kept += 1;

    const hits = [...extractEmails(project.storyText, { source: 'projectStory', sourceUrl: candidate.original })];
    const allLinks = [...new Set([...project.links, ...extractUrls(project.storyText)])];
    const { ownSites, socialProfiles } = splitLinks(allLinks);

    results.set(candidate.path, {
        ...project,
        projectUrl: candidate.original,
        archiveTimestamp: candidate.timestamp,
        linkedSites: ownSites,
        socialProfiles,
        rawHits: hits,
        pagesChecked: [candidate.original],
    });

    if (crawlCreatorSites) {
        for (const site of ownSites.slice(0, 2)) {
            siteQueue.push({ url: site, userData: { path: candidate.path, depth: 0 } });
        }
    }

    if (maxProjects > 0 && kept >= maxProjects) break;
}

await store.setValue(stateKey, { seenPaths: [...seenPaths] });
log.info(`Checked ${checked} new pages, ${kept} matched category ${categoryId} and are genuinely underfunded.`);

if (kept === 0) {
    log.info('Nothing new matched this time. Try a larger maxCandidates or an earlier fromDate for more history.');
    await Actor.exit();
}

/* Crawl each creator's own linked website, same pattern as the other tools. */

const CONTACT_LINK_WORDS = [
    'contact', 'about', 'team', 'press', 'media', 'work with', 'hire',
    'impressum', 'kontakt', 'connect', 'support', 'help', 'inquiries',
    'partnership', 'sponsor', 'advertise', 'collab',
];

const pagesSpent = new Map();

if (crawlCreatorSites && siteQueue.length > 0) {
    log.info(`Crawling ${siteQueue.length} creator websites for contact pages.`);

    const crawler = new CheerioCrawler({
        maxConcurrency: 8,
        maxRequestRetries: 2,
        requestHandlerTimeoutSecs: 45,
        failedRequestHandler: async ({ request }) => log.debug(`Gave up on ${request.url}`),

        async requestHandler({ request, $, enqueueLinks, body }) {
            const { path, depth } = request.userData;
            const record = results.get(path);
            if (!record) return;

            const origin = safeOrigin(request.url);
            const spent = pagesSpent.get(origin) || 0;
            if (spent >= maxPagesPerSite) return;
            pagesSpent.set(origin, spent + 1);

            const isContactPage = /contact|about|team|press|impressum|kontakt|connect/i.test(request.url);
            const source = isContactPage ? 'contactPage' : 'siteBody';

            const text = $('body').text().replace(/\s+/g, ' ');
            record.rawHits.push(...extractEmails(text, { source, sourceUrl: request.url }));

            $('a[href^="mailto:"]').each((_, el) => {
                const href = $(el).attr('href') || '';
                const address = href.replace(/^mailto:/i, '').split('?')[0];
                record.rawHits.push(...extractEmails(address, { source: 'mailtoLink', sourceUrl: request.url }));
            });

            const rawHtml = typeof body === 'string' ? body : body?.toString?.('utf8') || '';
            record.rawHits.push(...extractEmails(rawHtml.slice(0, 400000), { source: 'siteBody', sourceUrl: request.url }));
            record.pagesChecked.push(request.url);

            if (depth === 0) {
                const candidatesLinks = [];
                $('a[href]').each((_, el) => {
                    const href = $(el).attr('href');
                    const label = ($(el).text() || '').toLowerCase().trim();
                    if (!href) return;
                    const looksRight = CONTACT_LINK_WORDS.some((w) => label.includes(w) || href.toLowerCase().includes(w));
                    if (!looksRight) return;
                    try {
                        const abs = new URL(href, request.url);
                        if (abs.origin !== origin) return;
                        abs.hash = '';
                        candidatesLinks.push(abs.toString());
                    } catch { /* ignore */ }
                });
                const unique = [...new Set(candidatesLinks)].slice(0, maxPagesPerSite - 1);
                for (const url of unique) {
                    await crawler.addRequests([{ url, userData: { path, depth: 1 } }]);
                }
            }
        },
    });

    await crawler.run(siteQueue);
}

/* Score, rank, save. */

let withEmail = 0;

for (const record of results.values()) {
    const ownDomains = record.linkedSites.map((u) => safeHost(u)).filter(Boolean);
    const { emails } = rankEmails(record.rawHits, ownDomains);
    const keptEmails = emails.filter((e) => e.score >= minimumScore);

    if (keptEmails.length) withEmail += 1;

    await Actor.pushData({
        projectName: record.projectName,
        projectUrl: record.projectUrl,
        state: record.state,
        goal: record.goal,
        pledged: record.pledged,
        percentFunded: record.goal ? Math.round((record.pledged / record.goal) * 1000) / 10 : null,
        country: record.country,
        categoryName: record.categoryName,

        creatorName: record.creatorName,
        creatorUrl: record.creatorSlug ? `https://www.kickstarter.com/profile/${record.creatorSlug}` : null,

        bestEmail: keptEmails.length ? keptEmails[0].email : null,
        bestEmailConfidence: keptEmails.length ? keptEmails[0].confidence : null,
        bestEmailScore: keptEmails.length ? keptEmails[0].score : null,
        bestEmailFoundOn: keptEmails.length ? keptEmails[0].sourceUrl : null,
        whyThisEmail: keptEmails.length ? keptEmails[0].reasons.join('; ') : null,

        allEmails: keptEmails.map((e) => ({
            email: e.email, score: e.score, confidence: e.confidence, source: e.source, sourceUrl: e.sourceUrl, reasons: e.reasons,
        })),

        linkedSites: record.linkedSites,
        socialProfiles: record.socialProfiles,
        pagesChecked: record.pagesChecked,
        blurb: record.blurb,
        archiveSnapshotTimestamp: record.archiveTimestamp,
        note: 'Funding figures reflect whenever the Internet Archive last captured this page, not necessarily this exact moment.',
        scrapedAt: new Date().toISOString(),
    });
}

log.info(`Done. Found at least one address for ${withEmail} of ${results.size} underfunded projects found this run.`);

await Actor.exit();

function safeOrigin(url) {
    try { return new URL(url).origin; } catch { return url; }
}
function safeHost(url) {
    try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return null; }
}
