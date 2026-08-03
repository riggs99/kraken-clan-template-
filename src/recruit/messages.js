export const applyPublicAck = 'Tracking started. Roles granted: **kraken-member** + **probation**. KRAKEN is watching.';

export const dmApproved = `You endured.

KRAKEN has finished its inspection.

You may enter.

Do not mistake this for mercy.`;

export const dmProbation = `KRAKEN is not convinced.

You are permitted to crawl forward - under probation.

One slip, one absence, one excuse...

...and KRAKEN will remember.`;

export const dmRejected = `No.

KRAKEN has seen enough.

You are discarded.

There are no appeals.`;

export const dmCooldown = `You return too soon.

KRAKEN is not ready to judge you again.

Wait. Then try.`;

// A function, not a plain constant, so the clan name is supplied by whoever
// deployed this instance (config/recruit.config.json's `clanName`) instead of
// being baked into the source at build time — the one piece of this message
// that's genuinely clan-specific; everything else is KRAKEN's own voice.
export function buildWelcomeMarkdown(clanName) {
  const name = String(clanName ?? '').trim() || 'the clan';
  return `You stand at the gates of **${name}**.
I am **KRAKEN** - ancient sentinel of war discipline.

This hall is not for noise.
It is for **clean, consistent war play**.

------------------

KRAKEN evaluates on the next **training-1 review day** after a war week completes.
The automatic review fires as soon as KRAKEN detects the war week has closed.

### The Oath
Use all **16 war battles** across a complete war week.

Show up consistently across full wars, not one-off spikes.

**No boat actions**. No repairs. No boat attacks.

### The Marks I Place
When you enter, you receive **kraken-member** + **probation**.

**kraken-member** is your baseline clan role and is always kept.

**probation** is where every new member stays through their first full war week.

**kraken-warcore** is earned only by a perfect **32/32** across **2 complete wars**.

**kraken-underwatch** is for players showing continued inconsistency or inactivity.
This is KRAKEN's warning role.
If you fall here, your place in the clan is at risk, and when the clan is full this is the first pool reviewed for removal.

------------------

### How KRAKEN Judges
New members are tracked for **1 full war week** before first allocation.

Role reviews happen on the next **training day** after the war week closes.

**warcore** has leniency, so small misses do not cause instant demotion.

Large inconsistency across **2 complete wars** drops **warcore** to **probation**.

If **probation** fails across **1 full war week**, KRAKEN moves you to **kraken-underwatch**.

If you are then inactive across **1 full war week** in the **kraken-underwatch** role, KRAKEN applies the admin boot-review role.

Training-day decisions (and reasons) are posted in **#kraken-decisions** so everyone can see what changed and why.

------------------

### When You Must Vanish
Start a **7-day** or **14-day** break in **#on-a-break** (it starts immediately; leaders are notified and can acknowledge it).
After a break ends, if there is still no war activity, KRAKEN can still move you through the war-discipline ladder based on complete-war inactivity.

Press **Agree & Join** and submit your **player tag** to start tracking.`;
}
