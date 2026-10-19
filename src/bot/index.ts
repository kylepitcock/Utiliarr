import {
  ActionRowBuilder, ApplicationCommandOptionType, ButtonBuilder, ButtonStyle, ChatInputCommandInteraction, Client,
  ComponentType, EmbedBuilder, Events, GatewayIntentBits, MessageFlags, REST, Routes, ButtonInteraction,
} from 'discord.js';
import { getBool, getSetting } from '../settings.js';
import { resolveTitle, searchTitles, UserFacingError } from '../services/resolve.js';
import { checkCooldown, reportSubtitle, reportVideo, touchCooldown } from '../services/report.js';
import { formatBytes, formatDuration, getQueue } from '../services/queue.js';

const commands = [
  {
    name: 'report',
    description: 'Report a bad video or subtitle and get a different one downloaded',
    options: [
      { type: ApplicationCommandOptionType.String, name: 'title', description: 'Start typing the movie or show name', required: true, autocomplete: true },
      {
        type: ApplicationCommandOptionType.String,
        name: 'issue',
        description: 'What is wrong?',
        required: true,
        choices: [{ name: 'Video / audio quality', value: 'video' }, { name: 'Subtitles', value: 'subtitle' }],
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

async function report(i: ChatInputCommandInteraction) {
  const sub = i.options.getString('issue', true) as 'video' | 'subtitle';
  const reason = i.options.getString('reason') ?? undefined;
  await i.deferReply({ flags: MessageFlags.Ephemeral });
  checkCooldown(i.user.id);
  const res = await resolveTitle(
    i.options.getString('title', true), i.options.getInteger('season'), i.options.getInteger('episode'),
    sub === 'subtitle' ? i.options.getString('language') ?? undefined : undefined,
  );

  const what = sub === 'video'
    ? `Mark **${res.title}** as a bad release and download a different one?${getBool('bot.deleteFileOnFail') ? '\n⚠️ The current file will be deleted, so playback will stop until the replacement is ready.' : ''}`
    : `Blacklist the current${res.subtitle ? ` **${res.subtitle.label}**` : ''} subtitles for **${res.title}** and fetch different ones?`;
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId('yes').setLabel('Yes, replace it').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('no').setLabel('Cancel').setStyle(ButtonStyle.Secondary),
  );
  const msg = await i.editReply({ content: what, components: [row] });
  let btn: ButtonInteraction;
  try {
    btn = await msg.awaitMessageComponent({ componentType: ComponentType.Button, time: 30_000, filter: (b) => b.user.id === i.user.id });
  } catch {
    await i.editReply({ content: 'Timed out - nothing was changed.', components: [] });
    return;
  }
  if (btn.customId === 'no') {
    await btn.update({ content: 'Cancelled.', components: [] });
    return;
  }
  await btn.update({ content: 'Working on it…', components: [] });
  touchCooldown(i.user.id);
  const who = { discordId: i.user.id, discordName: i.user.username };
  const out = sub === 'video' ? await reportVideo(res, reason, who) : await reportSubtitle(res, reason, who);
  await i.editReply({
    content: `✅ Done (${out.summary}). A replacement is being searched for **${res.title}**. If a download fails I'll keep looking automatically.`,
    components: [],
  });
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
