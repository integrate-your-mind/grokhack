import {
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder,
  type Interaction,
  type Message,
  type TextChannel,
} from "discord.js";
import {
  CHANNELS,
  ROLES,
  autoSetupGuild,
  handleVerifyButton,
  isVerifyButton,
  rulesEmbed,
  verifyRow,
} from "./discord-onboard.js";
import { createLinkCode } from "./discord-links.js";

export interface DiscordBridgeHooks {
  onExternalChat: (from: string, text: string) => void;
}

let client: Client | null = null;
let hooks: DiscordBridgeHooks | null = null;
let ready = false;
let gameChatChannelId: string | null = null;
let modLogChannelId: string | null = null;

const rateBuckets = new Map<string, number[]>();
const RATE_MAX = 5;
const RATE_WINDOW_MS = 10_000;

function rateLimited(userId: string): boolean {
  const now = Date.now();
  const hits = (rateBuckets.get(userId) || []).filter((t) => now - t < RATE_WINDOW_MS);
  hits.push(now);
  rateBuckets.set(userId, hits);
  return hits.length > RATE_MAX;
}

function hasPlayerRole(member: import("discord.js").GuildMember | null): boolean {
  if (!member) return false;
  return member.roles.cache.some((r) => r.name === ROLES.player || r.name === ROLES.moderator);
}

export function startDiscordBot(h: DiscordBridgeHooks): void {
  const token = process.env.DISCORD_BOT_TOKEN || "";
  if (!token) {
    console.log("[discord] DISCORD_BOT_TOKEN not set — bot disabled. Run: npm run discord:setup");
    return;
  }

  hooks = h;
  client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildModeration,
    ],
    partials: [Partials.GuildMember],
  });

  client.once(Events.ClientReady, async (c) => {
    ready = true;
    console.log(`[discord] logged in as ${c.user.tag}`);

    const guildId = process.env.DISCORD_GUILD_ID || c.guilds.cache.first()?.id;
    if (!guildId) {
      console.warn("[discord] no guild — invite bot to your server");
      return;
    }

    const guild = await c.guilds.fetch(guildId);
    try {
      const ids = await autoSetupGuild(guild);
      gameChatChannelId = ids.channelGameChat || null;
      modLogChannelId = ids.channelModLog || null;
      console.log("[discord] auto-setup complete for", guild.name);
    } catch (err) {
      console.error("[discord] auto-setup failed:", err);
    }

    await registerSlashCommands(c.user.id, guildId);
  });

  client.on(Events.GuildMemberAdd, async (member) => {
    const unverified = member.guild.roles.cache.find((r) => r.name === ROLES.unverified);
    if (unverified) await member.roles.add(unverified).catch(() => {});

    const welcome = member.guild.channels.cache.find((c) => c.name === CHANNELS.welcome) as TextChannel | undefined;
    welcome
      ?.send(`🗡️ **${member.user.tag}** entered the lobby — verify in <#${member.guild.channels.cache.find((c) => c.name === CHANNELS.rules)?.id || "rules"}>`)
      .catch(() => {});

    const modLog = modLogChannelId
      ? (member.guild.channels.cache.get(modLogChannelId) as TextChannel)
      : undefined;
    const ageDays = Math.round((Date.now() - member.user.createdTimestamp) / 86400000);
    modLog
      ?.send(`➕ Join **${member.user.tag}** (account ${ageDays}d old)`)
      .catch(() => {});
  });

  client.on(Events.GuildMemberRemove, async (member) => {
    const modLog = modLogChannelId
      ? (member.guild.channels.cache.get(modLogChannelId) as TextChannel)
      : undefined;
    modLog?.send(`➖ Leave **${member.user.tag}**`).catch(() => {});
  });

  client.on(Events.InteractionCreate, async (interaction: Interaction) => {
    try {
      if (interaction.isButton() && isVerifyButton(interaction.customId)) {
        if (!interaction.member || !("roles" in interaction.member)) return;
        const member = await interaction.guild?.members.fetch(interaction.user.id);
        if (!member) return;
        const msg = await handleVerifyButton(member, modLogChannelId || undefined);
        await interaction.reply({ content: msg, ephemeral: true });
        return;
      }

      if (!interaction.isChatInputCommand()) return;

      if (interaction.commandName === "play") {
        await interaction.reply({
          content: "🎮 **Play GrokHack:** https://grokhack.mondello.dev/play.html\nTelnet (local): `telnet localhost 4000`",
          ephemeral: true,
        });
        return;
      }

      if (interaction.commandName === "link") {
        const gameName = interaction.options.getString("name", true);
        if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,15}$/.test(gameName)) {
          await interaction.reply({ content: "Invalid game name format.", ephemeral: true });
          return;
        }
        const code = createLinkCode(interaction.user.id, interaction.user.tag, gameName);
        await interaction.reply({
          content: [
            `Link **${gameName}** to your Discord:`,
            `1. Join https://grokhack.mondello.dev/play.html as \`${gameName}\``,
            `2. In-game type: \`:verify ${code.code}\``,
            `Code expires in 15 minutes.`,
          ].join("\n"),
          ephemeral: true,
        });
        return;
      }

      if (interaction.commandName === "status") {
        await interaction.reply({
          content: `Server: https://grokhack.mondello.dev/api/status`,
          ephemeral: true,
        });
      }
    } catch (err) {
      console.error("[discord] interaction error:", err);
    }
  });

  client.on(Events.MessageCreate, async (message: Message) => {
    if (message.author.bot || !message.guild) return;

    const member = message.member;
    const isGameChat = message.channel.id === gameChatChannelId;

    if (!hasPlayerRole(member)) {
      if (message.content.includes("discord.gg") || /https?:\/\//i.test(message.content)) {
        await message.delete().catch(() => {});
        await message.author.send("Links are blocked until you verify. Use #rules-and-verify.").catch(() => {});
      }
      return;
    }

    if (isGameChat) {
      if (rateLimited(message.author.id)) {
        await message.delete().catch(() => {});
        return;
      }
      const from = message.member?.displayName || message.author.username;
      hooks?.onExternalChat(from, message.content);
    }
  });

  client.login(token).catch((err) => {
    console.error("[discord] login failed:", err.message);
    client = null;
    ready = false;
  });
}

async function registerSlashCommands(clientId: string, guildId: string): Promise<void> {
  const token = process.env.DISCORD_BOT_TOKEN || "";
  const commands = [
    new SlashCommandBuilder().setName("play").setDescription("Get the GrokHack play link"),
    new SlashCommandBuilder()
      .setName("link")
      .setDescription("Link your Discord to your in-game character")
      .addStringOption((o) =>
        o.setName("name").setDescription("Your GrokHack character name").setRequired(true)
      ),
    new SlashCommandBuilder().setName("status").setDescription("Game server status"),
  ].map((c) => c.toJSON());

  const rest = new REST({ version: "10" }).setToken(token);
  await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commands });
  console.log("[discord] slash commands registered");
}

export function discordOutboundChat(playerName: string, text: string): void {
  if (!client || !ready || !gameChatChannelId) return;
  const ch = client.channels.cache.get(gameChatChannelId) as TextChannel | undefined;
  ch?.send(`**[game] ${playerName}:** ${text.slice(0, 1900)}`).catch(() => {});
}

export function discordSystemMessage(text: string): void {
  if (!client || !ready || !modLogChannelId) return;
  const ch = client.channels.cache.get(modLogChannelId) as TextChannel | undefined;
  ch?.send(text).catch(() => {});
}

export function getDiscordBotStatus() {
  return {
    enabled: Boolean(process.env.DISCORD_BOT_TOKEN),
    ready,
    guildId: process.env.DISCORD_GUILD_ID || null,
    gameChatChannelId,
    invitePermissions: "1099780198434",
    setup: "npm run discord:setup",
  };
}

export async function repostRules(): Promise<boolean> {
  if (!client || !ready) return false;
  const guildId = process.env.DISCORD_GUILD_ID || client.guilds.cache.first()?.id;
  if (!guildId) return false;
  const guild = await client.guilds.fetch(guildId);
  const rules = guild.channels.cache.find((c) => c.name === CHANNELS.rules) as TextChannel | undefined;
  if (!rules) return false;
  await rules.send({ embeds: [rulesEmbed()], components: [verifyRow()] });
  return true;
}