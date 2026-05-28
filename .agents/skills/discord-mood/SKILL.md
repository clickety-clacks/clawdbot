---
name: discord-mood
description: "Discord release/beta mood summaries from Discrawl with quotes, no URLs by default, and issue/PR correlation."
---

# Discord Mood

Use this with `$discrawl` when asked what people say, what the vibe/mood is,
or how a beta/release is landing in Discord.

## Workflow

1. Sync when currentness matters or the user asks:

```bash
discrawl sync --update=auto --source discord
discrawl status --json
```

2. Query the relevant window with read-only Discrawl SQL. Start from the release
   time, last answer freshness, or user-provided date. Include release/version,
   update/install, fast/slow, crash/broken/regression, plugin/LCM, Codex,
   WebChat/session, and specific feature terms.

3. Pull nearby channel slices around high-signal hits so quoted messages are not
   detached from context.

4. When Discord mentions GitHub issues/PRs, verify live state with `gh api` or
   `$openclaw-pr-maintainer` before saying open/closed/merged.

## Output Rules

- Do not show Discord URLs by default. Add links only when the user explicitly
  asks for links, wants to act on a specific message, or needs exact audit
  evidence.
- Prefer short direct quotes over paraphrase-only summaries. Quote enough to
  show tone, not whole messages.
- Attribute quotes compactly: `author, #channel, HH:MM UTC: "quote"`.
- Keep quotes representative and balanced: positive, negative, uncertainty,
  and maintainer/triage if present.
- Distill first, details second. Use:
  - `freshness`
  - `net mood`
  - `good`
  - `worry`
  - `quotes`
  - `open items` when issues/PRs are involved
- Use absolute timestamps and counts. Mention known archive gaps.
- Separate runtime sentiment from update/install confidence; these often diverge.
- Avoid hype terms unless quoting users. Keep the agent's synthesis sober.

## Quote Selection

Good quote candidates:

- clear sentiment: "fast", "broken", "smooth", "unresponsive"
- multiple independent users saying the same thing
- specific repro/update/version details
- maintainer comments that frame severity or release risk

Skip:

- jokes unless they capture a broader mood
- long rants without a concrete signal
- bot/status spam unless asked for operational stats

## Common SQL Shape

```sql
select
  m.created_at,
  coalesce(nullif(mm.display_name,''), nullif(mm.global_name,''), nullif(mm.username,''), m.author_id) as author,
  coalesce(nullif(c.name,''), m.channel_id) as channel,
  m.id,
  replace(replace(substr(m.content,1,1200), char(10), ' '), char(13), ' ') as content
from messages m
left join channels c on c.id=m.channel_id and c.guild_id=m.guild_id
left join members mm on mm.guild_id=m.guild_id and mm.user_id=m.author_id
where m.guild_id='1456350064065904867'
  and m.created_at >= '<ISO start>'
  and (
    lower(m.content) like '%<version>%'
    or lower(m.content) like '%release%'
    or lower(m.content) like '%update%'
    or lower(m.content) like '%install%'
    or lower(m.content) like '%fast%'
    or lower(m.content) like '%slow%'
    or lower(m.content) like '%crash%'
    or lower(m.content) like '%broken%'
    or lower(m.content) like '%regression%'
  )
order by m.created_at asc
limit 200;
```
