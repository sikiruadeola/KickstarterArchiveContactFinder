/**
 * emailFinder.js
 *
 * Pure functions. No network. Reused unchanged from the earlier YouTube and
 * Kickstarter tools.
 */

const PLAIN_EMAIL = /[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,24}/gi;

const BRACKETED = /([a-z0-9._%+-]+)\s*[([{]\s*at\s*[)\]}]\s*([a-z0-9.-]+)\s*(?:[([{]\s*dot\s*[)\]}]|\.)\s*([a-z]{2,24})/gi;

const SPELLED_OUT = /([a-z0-9._%+-]+)\s+at\s+([a-z0-9-]+(?:\s+dot\s+[a-z0-9-]+)*)\s+dot\s+([a-z]{2,24})/gi;

const JUNK_DOMAINS = [
    'example.com', 'example.org', 'domain.com', 'yourdomain.com', 'email.com',
    'sentry.io', 'sentry-next.wixpress.com', 'wixpress.com', 'wix.com',
    'squarespace.com', 'godaddy.com', 'shopify.com', 'myshopify.com',
    'schema.org', 'w3.org', 'gstatic.com', 'googleapis.com', 'google-analytics.com',
    'cloudflare.com', 'jquery.com', 'bootstrapcdn.com', 'fontawesome.com',
    'youtube.com', 'youtu.be', 'ytimg.com', 'facebook.com', 'twitter.com',
    'adobe.com', 'typekit.net', 'cloudfront.net', 'amazonaws.com',
    'placeholder.com', 'test.com', 'yoursite.com', 'company.com',
    'kickstarter.com', 'ksr-ugc.imgix.net', 'archive.org', 'web.archive.org',
];

const ROLE_LOCAL_PARTS = [
    'noreply', 'no-reply', 'donotreply', 'do-not-reply', 'mailer-daemon',
    'postmaster', 'abuse', 'webmaster', 'root', 'admin@localhost',
];

const BUSINESS_LOCAL_PARTS = [
    'business', 'partnerships', 'partner', 'sponsor', 'sponsorship',
    'collab', 'collabs', 'collaborations', 'press', 'media', 'pr',
    'booking', 'bookings', 'inquiries', 'enquiries', 'hello', 'hi',
    'contact', 'info', 'team', 'sales', 'support',
];

const CONTEXT_WORDS = [
    'business', 'inquir', 'enquir', 'sponsor', 'partnership', 'collab',
    'press', 'media', 'booking', 'contact', 'reach me', 'reach out',
    'work with', 'email me', 'get in touch', 'for business',
];

const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.ico', '.bmp', '.woff', '.ttf'];

function isPlausible(email) {
    if (!email || email.length > 254) return false;
    const lower = email.toLowerCase();
    if ((lower.match(/@/g) || []).length !== 1) return false;
    const [local, domain] = lower.split('@');
    if (!local || !domain) return false;
    if (local.length > 64) return false;
    if (lower.includes('..')) return false;
    if (local.startsWith('.') || local.endsWith('.')) return false;
    if (domain.startsWith('.') || domain.endsWith('.') || domain.startsWith('-')) return false;
    if (IMAGE_EXTENSIONS.some((ext) => lower.endsWith(ext))) return false;
    if (/@\d+x\./.test(lower)) return false;
    if (/^[0-9a-f]{24,}$/.test(local)) return false;
    if (JUNK_DOMAINS.some((junk) => domain === junk || domain.endsWith(`.${junk}`))) return false;
    const tld = domain.split('.').pop();
    if (!/^[a-z]{2,24}$/.test(tld)) return false;
    return true;
}

function contextAround(text, index, radius = 120) {
    const start = Math.max(0, index - radius);
    const end = Math.min(text.length, index + radius);
    return text.slice(start, end).toLowerCase();
}

export function extractEmails(text, meta = {}) {
    if (!text || typeof text !== 'string') return [];
    const found = new Map();
    const record = (raw, method, index) => {
        const email = String(raw).trim().replace(/[.,;:)\]}>'"]+$/, '').toLowerCase();
        if (!isPlausible(email)) return;
        if (found.has(email)) return;
        found.set(email, { email, method, context: contextAround(text, index), ...meta });
    };
    let m;
    PLAIN_EMAIL.lastIndex = 0;
    while ((m = PLAIN_EMAIL.exec(text)) !== null) record(m[0], 'plain', m.index);
    BRACKETED.lastIndex = 0;
    while ((m = BRACKETED.exec(text)) !== null) record(`${m[1]}@${m[2]}.${m[3]}`, 'bracketed', m.index);
    SPELLED_OUT.lastIndex = 0;
    while ((m = SPELLED_OUT.exec(text)) !== null) {
        const middle = m[2].replace(/\s+dot\s+/gi, '.');
        record(`${m[1]}@${middle}.${m[3]}`, 'spelled', m.index);
    }
    return [...found.values()];
}

export function scoreEmail(hit, opts = {}) {
    const { ownDomains = [] } = opts;
    const [local, domain] = hit.email.split('@');
    let score = 40;
    const reasons = [];
    if (hit.source === 'projectStory') { score += 25; reasons.push('written directly in the project story or description'); }
    if (hit.source === 'mailtoLink') { score += 20; reasons.push('taken from a mailto link'); }
    if (hit.source === 'contactPage') { score += 15; reasons.push('found on a contact or about page'); }
    if (hit.source === 'siteBody') { score += 5; reasons.push('found in ordinary page text'); }
    if (ownDomains.some((d) => domain === d || domain.endsWith(`.${d}`))) { score += 15; reasons.push('domain matches the creator own website'); }
    if (CONTEXT_WORDS.some((w) => (hit.context || '').includes(w))) { score += 15; reasons.push('sits next to wording about business contact'); }
    if (BUSINESS_LOCAL_PARTS.includes(local)) { score += 8; reasons.push('inbox name suggests it is meant for outsiders'); }
    if (ROLE_LOCAL_PARTS.some((r) => local.includes(r))) { score -= 45; reasons.push('looks like an automated sender that nobody reads'); }
    if (hit.method !== 'plain') { score -= 10; reasons.push('address was written in a disguised form and reassembled'); }
    score = Math.max(0, Math.min(100, score));
    let confidence = 'low';
    if (score >= 75) confidence = 'high';
    else if (score >= 55) confidence = 'medium';
    return { ...hit, score, confidence, reasons };
}

export function rankEmails(hits, ownDomains = []) {
    const scored = hits.map((h) => scoreEmail(h, { ownDomains }));
    const byEmail = new Map();
    for (const s of scored) {
        const existing = byEmail.get(s.email);
        if (!existing || s.score > existing.score) byEmail.set(s.email, s);
    }
    const list = [...byEmail.values()].sort((a, b) => b.score - a.score);
    return { emails: list, bestEmail: list.length ? list[0].email : null };
}

export function extractUrls(text) {
    if (!text) return [];
    const re = /https?:\/\/[^\s"'<>)\]]+/gi;
    return [...new Set((text.match(re) || []).map((u) => u.replace(/[.,;:)\]}]+$/, '')))];
}
