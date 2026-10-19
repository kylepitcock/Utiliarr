import {
  ActionRowBuilder, ApplicationCommandOptionType, ButtonBuilder, ButtonStyle, ChatInputCommandInteraction, Client,
  ComponentType, EmbedBuilder, Events, GatewayIntentBits, MessageFlags, REST, Routes, ButtonInteraction,
} from 'discord.js';
import { getBool, getSetting } from '../settings.js';
import { resolveTitle, searchTitles, UserFacingError } from '../services/resolve.js';
import { checkCooldown, reportSubtitle, reportVideo, syncSubtitle, touchCooldown } from '../services/report.js';
import { formatBytes, formatDuration, getQueue } from '../services/queue.js';

const commands = [
  {
    name: 'report',
    description: 'Report a bad video or subtitles: re-sync them or get a different one downloaded',
    options: [
      { type: ApplicationCommandOptionType.String, name: 'title', description: 'Start typing the movie or show name', required: true, autocomplete: true },
      {
        type: ApplicationCommandOptionType.String,
        name: 'issue',
        description: 'What is wrong?',
        required: true,
        choices: [
          { name: 'Video / audio quality', value: 'video' },
          { name: 'Subtitles are out of sync (re-sync them)', value: 'sync' },
          { name: 'Subtitles are wrong or bad (sync or replace)', value: 'subtitle' },
        ],
      },
      { type: ApplicationCommandOptionType.Integer, name: 'season', description: 'Season number (TV shows only)', min_value: 0 },
      { type: ApplicationCommandOptionType.Integer, name: 'episode', description: 'Episode number (TV shows only)', min_value: 0 },
      { type: ApplicationCommandOptionType.String, name: 'language', description: 'Subtitle language, e.g. en or eng (subtitle issues; optional)', max_length: 20 },
      { type: ApplicationCommandOptionType.String, name: 'reason', description: 'Details (optional)', max_length: 200 },
    ],
  },
  {
    name: 'queue',
    description: 'Show the Radarr/Sonarr download queue',
    options: [
      {
        type: ApplicationCommandOptionType.String,
        name: 'type',
        description: 'Filter',
        choices: [{ name: 'Everything', value: 'all' }, { name: 'Movies', value: 'movies' }, { name: 'TV shows', value: 'shows' }],
      },
    ],
  },
];

let client: Client | undefined;
export let botStatus = 'stopped';

export async function stopBot() {
  if (client) await client.destroy();
  client = undefined;
  botStatus = 'stopped';
}

export async function startBot() {
  await stopBot();
  const token = getSetting('discord.token');
  const clientId = getSetting('discord.clientId');
  if (!token || !clientId) {
    botStatus = 'not configured';
    return;
  }
  try {
    const rest = new REST().setToken(token);
    const guildId = getSetting('discord.guildId');
    await rest.put(guildId ? Routes.applicationGuildCommands(clientId, guildId) : Routes.applicationCommands(clientId), { body: commands });

    const c = new Client({ intents: [GatewayIntentBits.Guilds] });
    c.on(Events.InteractionCreate, (i) => {
      if (i.isChatInputCommand()) void handle(i);
      else if (i.isAutocomplete()) void searchTitles(i.options.getFocused()).then((r) => i.respond(r)).catch(() => i.respond([]).catch(() => undefined));
    });
    c.once(Events.ClientReady, (r) => {
      botStatus = `online as ${r.user.tag}`;
      console.log(`[bot] ${botStatus}`);
    });
    botStatus = 'connecting';
    await c.login(token);
    client = c;
  } catch (e) {
    botStatus = `error: ${(e as Error).message}`;
    console.error('[bot]', e);
  }
}

async function handle(i: ChatInputCommandInteraction) {
  try {
    switch (i.commandName) {
      case 'report': return await report(i);
      case 'queue': return await queue(i);
    }
  } catch (e) {
    const msg = e instanceof UserFacingError ? e.message : `Something went wrong: ${(e as Error).message}`;
    if (!(e instanceof UserFacingError)) console.error(`[bot] /${i.commandName}`, e);
    if (i.deferred || i.replied) await i.editReply({ content: msg, embeds: [], components: [] }).catch(() => undefined);
    else await i.reply({ content: msg, flags: MessageFlags.Ephemeral }).catch(() => undefined);
  }
}

const btn = (id: string, label: string, style: ButtonStyle) => new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style);

async function ask(i: ChatInputCommandInteraction, content: string, buttons: ButtonBuilder[], time = 60_000): Promise<{ id: string; b?: ButtonInteraction }> {
  const msg = await i.editReply({ content, components: [new ActionRowBuilder<ButtonBuilder>().addComponents(buttons)] });
  try {
    const b = await msg.awaitMessageComponent({ componentType: ComponentType.Button, time, filter: (x) => x.user.id === i.user.id });
    return { id: b.customId, b };
  } catch {
    await i.editReply({ content: 'Timed out - nothing was changed.', components: [] });
    return { id: 'timeout' };
  }
}

async function report(i: ChatInputCommandInteraction) {
  const issue = i.options.getString('issue', true) as 'video' | 'subtitle' | 'sync';
  const reason = i.options.getString('reason') ?? undefined;
  await i.deferReply({ flags: MessageFlags.Ephemeral });
  checkCooldown(i.user.id);
  const res = await resolveTitle(
    i.options.getString('title', true), i.options.getInteger('season'), i.options.getInteger('episode'),
    issue === 'video' ? undefined : i.options.getString('language') ?? undefined,
  );
  const who = { discordId: i.user.id, discordName: i.user.username };
  const subLabel = res.subtitle ? ` **${res.subtitle.label}**` : '';

  let action: 'video' | 'sync' | 'replace';
  if (issue === 'video') {
    const a = await ask(i,
      `Mark **${res.title}** as a bad release and download a different one?${getBool('bot.deleteFileOnFail') ? '\n⚠️ The current file will be deleted, so playback will stop until the replacement is ready.' : ''}`,
      [btn('go', 'Yes, replace it', ButtonStyle.Danger), btn('no', 'Cancel', ButtonStyle.Secondary)], 30_000);
    if (a.id === 'timeout') return;
    if (a.id === 'no') return void (await a.b!.update({ content: 'Cancelled.', components: [] }));
    await a.b!.update({ content: 'Working on it…', components: [] });
    action = 'video';
  } else if (issue === 'sync') {
    action = 'sync';
  } else {
    const a = await ask(i,
      `What should I do about the${subLabel} subtitles for **${res.title}**?\n\n` +
      '**Sync timing (recommended)**: Bazarr re-times the subtitles you have to match the audio. Fixes most "a few seconds off" problems and keeps the same text.\n' +
      '**Delete & download another**: blacklists these subtitles and fetches a different release. Try sync first; use this if sync didn\'t help or the text itself is wrong.',
      [btn('sync', 'Sync timing (recommended)', ButtonStyle.Success), btn('replace', 'Delete & download another', ButtonStyle.Danger), btn('no', 'Cancel', ButtonStyle.Secondary)]);
    if (a.id === 'timeout') return;
    if (a.id === 'no') return void (await a.b!.update({ content: 'Cancelled.', components: [] }));
    await a.b!.update({ content: a.id === 'sync' ? 'Asking Bazarr to sync… this can take a few minutes.' : 'Working on it…', components: [] });
    action = a.id as 'sync' | 'replace';
  }
  if (issue === 'sync') await i.editReply({ content: 'Asking Bazarr to sync… this can take a few minutes.', components: [] });

  touchCooldown(i.user.id);
  if (action === 'video' || action === 'replace') {
    const out = action === 'video' ? await reportVideo(res, reason, who) : await reportSubtitle(res, reason, who);
    await i.editReply({
      content: `✅ Done (${out.summary}). A replacement is being searched for **${res.title}**. If a download fails I'll keep looking automatically, and Jellyfin will be told to rescan when it arrives.`,
      components: [],
    });
    return;
  }

  let lastEdit = 0;
  let syncing = true;
  const out = await syncSubtitle(res, reason, who, (p) => {
    if (!syncing || Date.now() - lastEdit < 2500) return;
    lastEdit = Date.now();
    const status = p.percent === null
      ? `⏳ Bazarr is syncing… (${Math.floor(p.elapsedSec / 60)}m ${p.elapsedSec % 60}s elapsed; Bazarr isn't reporting a percentage)`
      : `Syncing **${res.title}**\n${bar(p.percent)} ${p.percent}%${p.message ? `\n${p.message}` : ''}`;
    void i.editReply({ content: status, components: [] }).catch(() => undefined);
  }).finally(() => { syncing = false; });
  const next = await ask(i,
    `✅ Bazarr ${out.summary} for **${res.title}** and Jellyfin was asked to rescan. Reload the video and check it.\nStill wrong? I can delete these subtitles and download another.`,
    [btn('replace', 'Still wrong: delete & download another', ButtonStyle.Danger), btn('ok', 'It\'s fixed', ButtonStyle.Success)], 5 * 60_000);
  if (next.id === 'replace') {
    await next.b!.update({ content: 'Working on it…', components: [] });
    const r2 = await reportSubtitle(res, reason, who);
    await i.editReply({ content: `✅ Done (${r2.summary}). A different subtitle is being searched for. If a download fails I'll keep looking automatically.`, components: [] });
  } else if (next.id === 'ok') {
    await next.b!.update({ content: `✅ Glad that fixed it! (${out.summary})`, components: [] });
  }
}

function bar(pct: number) {
  const n = Math.round(pct / 10);
  return '▰'.repeat(n) + '▱'.repeat(10 - n);
}

async function queue(i: ChatInputCommandInteraction) {
  await i.deferReply();
  const which = (i.options.getString('type') ?? 'all') as 'all' | 'movies' | 'shows';
  const q = await getQueue(which);
  if (!q.items.length) {
    await i.editReply({ content: '', embeds: [new EmbedBuilder().setTitle('Download queue').setDescription('Nothing is downloading right now. 🎉').setColor(0x57f287)] });
    return;
  }
  const lines: string[] = [];
  let shown = 0;
  for (const it of q.items) {
    const icon = it.source === 'movie' ? '🎬' : '📺';
    const line = `${icon} **${it.title}**\n${bar(it.percent)} ${it.percent}% · ${it.secondsLeft === null ? it.status : formatDuration(it.secondsLeft) + ' left'}${it.warning ? ' ⚠️' : ''}`;
    if ([...lines, line].join('\n\n').length > 3600) break;
    lines.push(line);
    shown++;
  }
  if (shown < q.items.length) lines.push(`…and ${q.items.length - shown} more`);
  const embed = new EmbedBuilder()
    .setTitle('Download queue')
    .setDescription(lines.join('\n\n'))
    .setColor(0x5865f2)
    .setFooter({
      text: `${q.items.length} item${q.items.length === 1 ? '' : 's'} · ${formatBytes(q.totalLeft)} remaining · all done in ~${formatDuration(q.allDoneInSeconds)}`,
    })
    .setTimestamp();
  await i.editReply({ embeds: [embed] });
}
