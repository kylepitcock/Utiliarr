import {
  ActionRowBuilder, ApplicationCommandOptionType, ButtonBuilder, ButtonStyle, ChatInputCommandInteraction, Client,
  ComponentType, EmbedBuilder, Events, GatewayIntentBits, MessageFlags, REST, Routes, ButtonInteraction,
} from 'discord.js';
import { db } from '../db.js';
import { getBool, getSetting } from '../settings.js';
import { jellyfin } from '../clients/jellyfin.js';
import { getLink, resolveNowPlaying, UserFacingError, Resolved } from '../services/resolve.js';
import { checkCooldown, reportSubtitle, reportVideo, touchCooldown } from '../services/report.js';
import { formatBytes, formatDuration, getQueue } from '../services/queue.js';

const commands = [
  {
    name: 'link',
    description: 'Link your Discord account to your Jellyfin user',
    options: [{ type: ApplicationCommandOptionType.String, name: 'username', description: 'Your Jellyfin username', required: true }],
  },
  { name: 'unlink', description: 'Unlink your Jellyfin account' },
  { name: 'nowplaying', description: 'Show what I think you are watching (to check your link works)' },
  {
    name: 'report',
    description: 'Report a problem with what you are watching right now',
    options: [
      {
        type: ApplicationCommandOptionType.Subcommand,
        name: 'video',
        description: 'Bad video/audio quality: mark it failed and download a different release',
        options: [{ type: ApplicationCommandOptionType.String, name: 'reason', description: 'What is wrong? (optional)', max_length: 200 }],
      },
      {
        type: ApplicationCommandOptionType.Subcommand,
        name: 'subtitle',
        description: 'Bad subtitles: blacklist them and download different ones',
        options: [{ type: ApplicationCommandOptionType.String, name: 'reason', description: 'What is wrong? (optional)', max_length: 200 }],
      },
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
      case 'link': return await link(i);
      case 'unlink': return await unlink(i);
      case 'nowplaying': return await nowPlaying(i);
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

async function link(i: ChatInputCommandInteraction) {
  if (!getBool('bot.allowSelfLink')) throw new UserFacingError('Self-linking is disabled. Ask an admin to link your account.');
  await i.deferReply({ flags: MessageFlags.Ephemeral });
  const user = await jellyfin.findUser(i.options.getString('username', true));
  if (!user) throw new UserFacingError('No Jellyfin user with that name was found.');
  const taken = db.prepare('SELECT discord_id FROM user_links WHERE jellyfin_user_id=? AND discord_id<>?').get(user.Id, i.user.id);
  if (taken) throw new UserFacingError('That Jellyfin user is already linked to another Discord account. Ask an admin.');
  db.prepare(
    `INSERT INTO user_links(discord_id,discord_name,jellyfin_user_id,jellyfin_user_name,created_at) VALUES(?,?,?,?,?)
     ON CONFLICT(discord_id) DO UPDATE SET jellyfin_user_id=excluded.jellyfin_user_id, jellyfin_user_name=excluded.jellyfin_user_name, discord_name=excluded.discord_name`,
  ).run(i.user.id, i.user.username, user.Id, user.Name, Date.now());
  await i.editReply(`Linked to Jellyfin user **${user.Name}**. Play something and try \`/nowplaying\`.`);
}

async function unlink(i: ChatInputCommandInteraction) {
  const r = db.prepare('DELETE FROM user_links WHERE discord_id=?').run(i.user.id);
  await i.reply({ content: r.changes ? 'Unlinked.' : 'You were not linked.', flags: MessageFlags.Ephemeral });
}

async function nowPlaying(i: ChatInputCommandInteraction) {
  await i.deferReply({ flags: MessageFlags.Ephemeral });
  const r = await resolveNowPlaying(i.user.id);
  await i.editReply(`You're watching **${r.title}**${r.subtitle ? `\nSubtitles: ${r.subtitle.label}` : '\nSubtitles: off'}`);
}

async function report(i: ChatInputCommandInteraction) {
  const sub = i.options.getSubcommand() as 'video' | 'subtitle';
  const reason = i.options.getString('reason') ?? undefined;
  await i.deferReply({ flags: MessageFlags.Ephemeral });
  checkCooldown(i.user.id);
  const res = await resolveNowPlaying(i.user.id);
  if (sub === 'subtitle' && !res.subtitle) {
    await i.editReply(`You're watching **${res.title}** but no subtitle track is selected in Jellyfin. Turn on the bad subtitles first so I know which ones to replace.`);
    return;
  }

  const what = sub === 'video'
    ? `Mark **${res.title}** as a bad release and download a different one?${getBool('bot.deleteFileOnFail') ? '\n⚠️ The current file will be deleted, so playback will stop until the replacement is ready.' : ''}`
    : `Blacklist the **${res.subtitle!.label}** subtitles for **${res.title}** and fetch different ones?`;
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
