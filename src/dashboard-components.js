// Shared Components V2 layout helpers for /ops and /war-board — one visual
// language for both leader-facing dashboards instead of two divergent one-offs.
// Verified against the real Discord API before this was built (not assumed):
// containers coexist with ActionRow buttons in one message, editing a V2 message
// works, a container holds 1-40 child components (each TextDisplay/Separator
// counts as one — comfortably clear of what these dashboards need since a table
// is rendered as a single TextDisplay block, not one component per row), and
// thumbnails work via a plain hosted URL with zero attachment-permission needs.
import {
  ContainerBuilder,
  SectionBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  ThumbnailBuilder,
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from 'discord.js';

// Standard (legacy, non-V2) Confirm/Cancel button row for an irreversible-ish
// action's confirmation embed — season-reset.js is the first caller, but
// decisions-reset.js and break-reset.js hand-build the identical pattern
// independently; new confirm flows should use this instead of a fourth copy.
export function buildConfirmCancelRow({ confirmCustomId, confirmLabel, cancelCustomId, cancelLabel = 'Cancel' }) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(confirmCustomId).setLabel(confirmLabel).setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(cancelCustomId).setLabel(cancelLabel).setStyle(ButtonStyle.Secondary),
  );
}

// Each deployment supplies its own clan badge/logo URL via the CLAN_BADGE_URL
// env var — this template ships with none. `null` (not '') when unset, since
// every consumer either checks truthiness (buildDashboardContainer) or passes
// this straight into a discord.js builder's setThumbnail()/iconURL, both of
// which treat null as "no image" but would reject an empty-string URL.
export const CLAN_BADGE_URL = process.env.CLAN_BADGE_URL?.trim() || null;

// One severity palette, reused everywhere a red/amber/green/neutral status is shown
// (war-board.js's section color, status.js's standing verdict, war.js's accent) —
// previously each view hardcoded its own copy of these same three hex values, so a
// future re-tune of "what red means" could silently drift out of sync between them.
// Not used for ops.js's tab colors — those pick a color per TAB (which section is
// open), a different axis from severity, and legitimately stay independent.
export const STATUS_COLORS = {
  critical: 0xed4245, // red — boot review / at risk
  warn: 0xfee75c,     // amber — underwatch / needs attention
  healthy: 0x57f287,  // green — all clear / good standing
  neutral: 0x99aab5,  // gray — no data / unlinked
};

// Discord TextDisplay content limit — clip dashboard blocks so a long /ops or /war
// page never fails the whole message send when one table runs long.
const TEXT_DISPLAY_MAX = 4000;

function clipTextDisplay(text) {
  const s = String(text ?? '').trim();
  if (s.length <= TEXT_DISPLAY_MAX) return s;
  return s.slice(0, TEXT_DISPLAY_MAX - 1) + '…';
}

// One medal-rank convention, reused by every leaderboard-style block (schedule.js's
// weekly member summary, the season report) instead of each hand-rolling its own
// `medals[i] ?? fallback` with a different fallback for ranks past 3rd.
const MEDALS = ['🥇', '🥈', '🥉'];
export function medalOrRank(i) {
  return MEDALS[i] ?? `${i + 1}.`;
}

function padCell(value, width, align) {
  const s = String(value ?? '');
  const clipped = s.length > width ? s.slice(0, Math.max(1, width - 1)) + '…' : s;
  return align === 'right' ? clipped.padStart(width) : clipped.padEnd(width);
}

// columns: [{ key, label, width, align: 'left'|'right' }]
// rows: plain objects keyed by column.key
// Renders a fixed-width monospace table inside a markdown code fence — Discord
// renders TextDisplay content as normal markdown, so a code fence is what actually
// gets fixed-width alignment (the bullet-list-with-emoji-separators format never did).
export function renderTable(columns, rows) {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const cols = columns.map(c => ({ ...c, width: Math.max(c.width ?? c.label.length, c.label.length) }));
  const header = cols.map(c => padCell(c.label, c.width, c.align)).join('  ');
  const divider = '-'.repeat(header.length);
  const lines = rows.map(row => cols.map(c => padCell(row[c.key], c.width, c.align)).join('  '));
  return '```\n' + [header, divider, ...lines].join('\n') + '\n```';
}

// The direct answer to "make the best and worst performer stand out" — called out
// as its own distinct block above the full table, not buried as row 1 and row N.
export function renderSpotlight({ top, bottom, topLabel = '🏆 Top performer', bottomLabel = '⚠️ Needs attention' } = {}) {
  const lines = [];
  if (top) lines.push(`**${topLabel}:** ${top}`);
  if (bottom) lines.push(`**${bottomLabel}:** ${bottom}`);
  if (!lines.length) return null;
  return lines.join('\n');
}

// Assembles one ContainerBuilder from an ordered list of content strings,
// separating each with a divider — replaces the embed field-stacking approach
// (and ops.js's unconditional primary/detail two-embed split) with one coherent,
// intentional layout per view.
// heroImageUrl: an optional large banner image shown right under the header —
// accepts either a plain URL or an `attachment://<filename>` reference (the
// message payload must include that file in `files:` either way). Only
// onboarding.js's pinned welcome post needs this today; every other dashboard
// only needs the small header thumbnail.
export function buildDashboardContainer({ accentColor, header, thumbnailUrl, heroImageUrl, blocks }) {
  const container = new ContainerBuilder();
  if (Number.isFinite(accentColor)) container.setAccentColor(accentColor);

  if (header) {
    const headerText = clipTextDisplay(header);
    if (thumbnailUrl) {
      const section = new SectionBuilder()
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(headerText))
        .setThumbnailAccessory(new ThumbnailBuilder().setURL(thumbnailUrl));
      container.addSectionComponents(section);
    } else {
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(headerText));
    }
    container.addSeparatorComponents(new SeparatorBuilder());
  }

  if (heroImageUrl) {
    const gallery = new MediaGalleryBuilder().addItems(
      new MediaGalleryItemBuilder().setURL(heroImageUrl),
    );
    container.addMediaGalleryComponents(gallery);
    container.addSeparatorComponents(new SeparatorBuilder());
  }

  const validBlocks = (Array.isArray(blocks) ? blocks : []).filter(b => typeof b === 'string' && b.trim());
  validBlocks.forEach((block, i) => {
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(clipTextDisplay(block)));
    if (i < validBlocks.length - 1) container.addSeparatorComponents(new SeparatorBuilder());
  });

  return container;
}

// Ensures a single persistent "panel" message exists in a channel, editing it in
// place when possible. Discord fixes a message's Components V2 flag at creation —
// editing a pre-V2 (legacy embed) message into a V2 payload always fails — so this
// only deletes and re-sends for that specific, unrecoverable case; any other edit
// failure (rate limit, transient outage) leaves the existing message alone so the
// next call can retry without churning the message ID or losing pinned status. If
// the delete itself fails, it stops rather than sending a second message, since
// sending anyway is exactly how the duplicate-message bug happened the first time.
// One shared implementation so every "post once, edit forever" panel in the bot
// (welcome post, appeals panel, and any future one) gets this protection for free
// instead of copy-pasting the same try/catch per file.
//
// Returns { message, changed } — changed is true only when a fresh message was
// actually sent, so the caller knows whether to persist a new stored message ID.
export async function ensurePersistentPanel({ channel, existingId, payload, pin = false, logPrefix = '[BOT]' }) {
  let existing = null;
  let fetchFailedTransiently = false;
  if (existingId) {
    try {
      existing = await channel.messages.fetch(existingId);
    } catch (e) {
      // Only a genuine "Unknown Message" (10008) means the stored ID is actually
      // stale — any other fetch failure (rate limit, network blip, brief
      // permissions hiccup) does NOT mean the message is gone, and falling through
      // to send a new one anyway would create a duplicate sitting right next to
      // the still-live original once the transient condition clears.
      if (e?.code === 10008) {
        existing = null;
      } else {
        console.error(`${logPrefix}: fetch failed (not confirmed missing — not sending a replacement):`, String(e?.message ?? e));
        fetchFailedTransiently = true;
      }
    }
  }

  if (fetchFailedTransiently) {
    return { message: null, changed: false };
  }

  if (existing) {
    try {
      await existing.edit(payload);
      return { message: existing, changed: false };
    } catch (e) {
      // A confirmed "Unknown Message" (10008) here is exactly as certain as the same
      // code on the fetch above — the fetch can return a cached Message object without
      // a true round-trip, so the first place this ever actually gets confirmed gone is
      // sometimes the edit call itself, not the fetch. Treated as confirmed missing, not
      // ambiguous/transient, so it doesn't get stuck silently stale forever.
      const confirmedMissing = e?.code === 10008;
      const isV2Immutable = !confirmedMissing && /COMPONENTS_V2/i.test(String(e?.message ?? e ?? ''));
      if (!confirmedMissing && !isV2Immutable) {
        console.error(`${logPrefix}: edit failed (transient — leaving existing message as-is):`, String(e?.message ?? e));
        return { message: existing, changed: false };
      }
      if (confirmedMissing) {
        console.error(`${logPrefix}: edit failed (message confirmed deleted) — sending a replacement:`, String(e?.message ?? e));
      } else {
        console.error(`${logPrefix}: edit failed (message predates Components V2, can't be edited into it) — deleting and re-sending:`, String(e?.message ?? e));
        try {
          await existing.delete();
        } catch (delErr) {
          console.error(`${logPrefix}: delete failed — leaving the stale message rather than risk a duplicate:`, String(delErr?.message ?? delErr));
          return { message: existing, changed: false };
        }
      }
    }
  }

  const sent = await channel.send(payload).catch(e => {
    console.error(`${logPrefix}: send failed:`, String(e?.message ?? e));
    return null;
  });
  if (sent && pin && typeof sent.pin === 'function') {
    await sent.pin().catch(() => {});
  }
  return { message: sent, changed: Boolean(sent) };
}
