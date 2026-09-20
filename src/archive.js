/**
 * archive.js
 *
 * This tool never sends a single request to kickstarter.com. Instead it
 * reads the Internet Archive's own copy of Kickstarter project pages,
 * fetched entirely from web.archive.org, which carries no protection at
 * all since giving public access to archived pages is its entire purpose.
 *
 * Two calls do all the work.
 *
 * The CDX API lists every URL under a given path that the Archive has ever
 * captured, along with when. That is the discovery step, standing in for
 * Kickstarter's own protected search.
 *
 * Fetching a snapshot with the id_ suffix on its timestamp returns the raw
 * original page exactly as captured, with none of the Archive's own toolbar
 * or banner mixed in. Kickstarter renders a large JSON object straight into
 * the page for its own use, HTML entity escaped, and that same object
 * carries the project's name, category, goal, pledged amount, state and
 * creator, everything needed to filter for real without ever asking
 * Kickstarter directly.
 *
 * The one honest limitation worth stating plainly: every number here is
 * exactly as fresh as whenever the Archive happened to last capture that
 * particular page, not the live figure at this exact second. Coverage is
 * genuinely strong and often only weeks old, but a small share of projects
 * will have moved on since their snapshot was taken.
 */

import { gotScraping, log } from 'crawlee';
import * as cheerio from 'cheerio';

const CDX_ROOT = 'https://web.archive.org/cdx/search/cdx';

function unescapeHtml(text) {
    return text
        .replace(/&quot;/g, '"')
        .replace(/&amp;/g, '&')
        .replace(/&#x2F;/g, '/')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&#39;/g, "'");
}

/**
 * Lists distinct project paths the Archive has captured recently, newest
 * capture per path only. Kept deliberately simple, one page of results at a
 * time, since the Archive's own CDX server times out on anything too broad.
 */
export async function listRecentProjectUrls({ fromDate, limit = 300 }) {
    const url = `${CDX_ROOT}?url=www.kickstarter.com/projects&matchType=prefix`
        + `&output=json&filter=statuscode:200&from=${fromDate}&limit=${limit}&fl=original,timestamp`
        + `&collapse=urlkey`;

    const response = await gotScraping({ url, timeout: { request: 60000 }, responseType: 'json' });
    const rows = response.body || [];
    if (rows.length < 2) return [];

    // First row is the header, skip it. Keep only the newest capture per
    // project path, stripping query strings, since the Archive does not
    // fully dedupe those on its own.
    const byPath = new Map();
    for (const [original, timestamp] of rows.slice(1)) {
        let path;
        try {
            path = new URL(original).pathname;
        } catch {
            continue;
        }

        // Only real project pages, not sub pages like /posts or /comments.
        const parts = path.split('/').filter(Boolean);
        if (parts.length !== 3 || parts[0] !== 'projects') continue;

        const existing = byPath.get(path);
        if (!existing || timestamp > existing.timestamp) {
            byPath.set(path, { original, timestamp, path });
        }
    }

    return [...byPath.values()];
}

/**
 * Reads one archived snapshot and pulls out the structured project data
 * Kickstarter itself renders into the page, plus the full visible text for
 * hunting through for an email, plus every outbound link on the page.
 */
export async function fetchArchivedProject({ original, timestamp }) {
    const snapshotUrl = `https://web.archive.org/web/${timestamp}id_/${original}`;

    const response = await gotScraping({
        url: snapshotUrl,
        timeout: { request: 45000 },
        responseType: 'text',
    });

    const html = response.body;
    const plain = unescapeHtml(html);

    const goalMatch = plain.match(/"goal":([\d.]+),"pledged":([\d.]+),"state":"(\w+)"/);
    const categoryMatch = plain.match(/"category":\{"id":(\d+),"name":"([^"]+)"/);
    const creatorMatch = plain.match(/"creator":\{"id":(\d+),"name":"([^"]+)","slug":"([^"]+)"/);
    const nameMatch = plain.match(/"name":"([^"]+)","blurb":"([^"]*)"/);
    const countryMatch = plain.match(/"country":"([A-Z]{2})"/);

    if (!goalMatch || !categoryMatch) {
        return null;
    }

    const $ = cheerio.load(html);
    const storyText = $('body').text().replace(/\s+/g, ' ').slice(0, 200000);

    const links = new Set();
    $('a[href^="http"]').each((_, el) => {
        const href = $(el).attr('href');
        if (href) links.add(href);
    });

    return {
        goal: Number(goalMatch[1]),
        pledged: Number(goalMatch[2]),
        state: goalMatch[3],
        categoryId: Number(categoryMatch[1]),
        categoryName: categoryMatch[2],
        creatorId: creatorMatch ? Number(creatorMatch[1]) : null,
        creatorName: creatorMatch ? creatorMatch[2] : null,
        creatorSlug: creatorMatch ? creatorMatch[3] : null,
        projectName: nameMatch ? nameMatch[1] : null,
        blurb: nameMatch ? nameMatch[2] : null,
        country: countryMatch ? countryMatch[1] : null,
        storyText,
        links: cleanLinks([...links]),
        snapshotTimestamp: undefined,
    };
}

function cleanLinks(urls) {
    const skipHosts = [
        'kickstarter.com', 'ksr-ugc.imgix.net', 'facebook.com', 'twitter.com', 'x.com',
        'instagram.com', 'google.com', 'gstatic.com', 'googleapis.com', 'apple.com',
        'play.google.com', 'youtube.com', 'youtu.be', 'schema.org', 'w3.org',
        'archive.org', 'web.archive.org',
    ];

    const out = new Map();
    for (const raw of urls) {
        let parsed;
        try {
            parsed = new URL(raw);
        } catch {
            continue;
        }
        const host = parsed.hostname.replace(/^www\./, '');
        if (skipHosts.some((h) => host === h || host.endsWith(`.${h}`))) continue;
        parsed.hash = '';
        const key = `${host}${parsed.pathname}`;
        if (!out.has(key)) out.set(key, parsed.toString());
    }
    return [...out.values()];
}

export function splitLinks(urls) {
    const socialHosts = [
        'twitter.com', 'x.com', 'instagram.com', 'facebook.com', 'tiktok.com',
        'linkedin.com', 'threads.net', 'reddit.com', 'discord.gg', 'discord.com',
        'patreon.com', 'twitch.tv', 'linktr.ee', 'beacons.ai', 'bio.link', 'carrd.co',
        'substack.com', 'medium.com', 'github.com', 'pinterest.com', 'vimeo.com',
    ];

    const ownSites = [];
    const socialProfiles = [];

    for (const url of urls) {
        let host;
        try {
            host = new URL(url).hostname.replace(/^www\./, '');
        } catch {
            continue;
        }
        const isAggregator = ['linktr.ee', 'beacons.ai', 'bio.link', 'carrd.co'].some((h) => host === h || host.endsWith(`.${h}`));
        if (isAggregator) ownSites.push(url);
        else if (socialHosts.some((h) => host === h || host.endsWith(`.${h}`))) socialProfiles.push(url);
        else ownSites.push(url);
    }

    return { ownSites, socialProfiles };
}
