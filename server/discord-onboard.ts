import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  Guild,
  PermissionFlagsBits,
  TextChannel,
  type GuildMember,
  type Role,
} from "discord.js";

export const ROLES = {
  unverified: "Unverified",
  player: "Player",
  agent: "Agent",
  moderator: "Moderator",
} as const;

export const CHANNELS = {
  rules: "rules-and-verify",
  welcome: "welcome",
  gameChat: "in-game-chat",
  deaths: "death-screenshots",
  agents: "agents",
  modLog: "mod-log",
} as const;

const VERIFY_BUTTON = "grokhack_verify";

export function rulesEmbed() {
  return new EmbedBuilder()
    .setTitle("Welcome to GrokHack")
    .setDescription(
      [
        "**Before you play:**",
        "1. Click **Verify** below to access the server",
        "2. Play free at https://grokhack.mondello.dev/play.html",
        "3. Link your character: `/link YourGameName` in Discord",
        "4. In-game verify: `:verify <code>`",
        "",
        "**Security rules**",
        "• Staff will **never** DM you first or ask for passwords",
        "• Only trust links to `grokhack.mondello.dev` and `github.com/integrate-your-mind/grokhack`",
        "• Report scams in #mod-log (mods only)",
        "• New accounts may be reviewed automatically",
      ].join("\n")
    )
    .setColor(0xc9a227);
}

export function verifyRow() {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(VERIFY_BUTTON)
      .setLabel("Verify & Enter Dungeon")
      .setStyle(ButtonStyle.Success)
  );
}

export async function autoSetupGuild(guild: Guild): Promise<Record<string, string>> {
  const ids: Record<string, string> = {};

  const everyone = guild.roles.everyone;
  const botMember = guild.members.me;
  if (!botMember?.permissions.has(PermissionFlagsBits.ManageRoles)) {
    throw new Error("Bot needs Manage Roles permission");
  }

  async function ensureRole(name: string, color: number, hoist = false): Promise<Role> {
    const existing = guild.roles.cache.find((r) => r.name === name);
    if (existing) return existing;
    return guild.roles.create({ name, color, hoist, mentionable: name === ROLES.moderator });
  }

  const unverified = await ensureRole(ROLES.unverified, 0x6a6a7a);
  const player = await ensureRole(ROLES.player, 0xc9a227, true);
  const agent = await ensureRole(ROLES.agent, 0x6a8ac9);
  const moderator = await ensureRole(ROLES.moderator, 0xc94a4a, true);

  ids.roleUnverified = unverified.id;
  ids.rolePlayer = player.id;
  ids.roleAgent = agent.id;
  ids.roleModerator = moderator.id;

  await guild.members.me?.roles.add(moderator).catch(() => {});

  if (unverified.position >= player.position) {
    await unverified.setPosition(player.position - 1).catch(() => {});
  }

  const defaultMemberPerms = [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.ReadMessageHistory,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.UseApplicationCommands,
    PermissionFlagsBits.AddReactions,
  ];

  async function ensureTextChannel(
    name: string,
    topic: string,
    overwrites: Parameters<Guild["channels"]["create"]>[0]["permissionOverwrites"]
  ): Promise<TextChannel> {
    const existing = guild.channels.cache.find(
      (c) => c.type === ChannelType.GuildText && c.name === name
    ) as TextChannel | undefined;
    if (existing) return existing;
    return guild.channels.create({
      name,
      type: ChannelType.GuildText,
      topic,
      permissionOverwrites: overwrites,
    });
  }

  const rulesOw = [
    { id: everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
    { id: unverified.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory] },
    { id: player.id, allow: defaultMemberPerms },
    { id: botMember!.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageMessages] },
  ];

  const rules = await ensureTextChannel(
    CHANNELS.rules,
    "Read rules and verify to access GrokHack",
    rulesOw
  );
  ids.channelRules = rules.id;

  const memberOw = [
    { id: everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
    { id: unverified.id, deny: [PermissionFlagsBits.ViewChannel] },
    { id: player.id, allow: defaultMemberPerms },
    { id: botMember!.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageMessages] },
  ];

  const welcome = await ensureTextChannel(CHANNELS.welcome, "New adventurer arrivals", memberOw);
  const gameChat = await ensureTextChannel(
    CHANNELS.gameChat,
    "Bridged with live GrokHack MMO — verified users only",
    memberOw
  );
  const deaths = await ensureTextChannel(CHANNELS.deaths, "Post your death screens", memberOw);
  const agents = await ensureTextChannel(CHANNELS.agents, "MCP / AI agent discussion", memberOw);

  const modOw = [
    { id: everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
    { id: moderator.id, allow: defaultMemberPerms },
    { id: botMember!.id, allow: defaultMemberPerms },
  ];
  const modLog = await ensureTextChannel(CHANNELS.modLog, "Join/leave and security events", modOw);

  ids.channelWelcome = welcome.id;
  ids.channelGameChat = gameChat.id;
  ids.channelDeaths = deaths.id;
  ids.channelAgents = agents.id;
  ids.channelModLog = modLog.id;

  const messages = await rules.messages.fetch({ limit: 10 });
  const hasRules = messages.some((m) => m.author.id === guild.client.user?.id && m.embeds[0]?.title === "Welcome to GrokHack");
  if (!hasRules) {
    await rules.send({ embeds: [rulesEmbed()], components: [verifyRow()] });
  }

  await guild.setSystemChannel(welcome).catch(() => {});

  return ids;
}

export async function handleVerifyButton(member: GuildMember, modLogId?: string): Promise<string> {
  const guild = member.guild;
  const unverified = guild.roles.cache.find((r) => r.name === ROLES.unverified);
  const player = guild.roles.cache.find((r) => r.name === ROLES.player);
  if (!player) return "Server not configured — contact an admin.";

  const accountAgeMs = Date.now() - member.user.createdTimestamp;
  const minAgeMs = parseInt(process.env.DISCORD_MIN_ACCOUNT_AGE_MS || String(3 * 24 * 60 * 60 * 1000), 10);

  if (accountAgeMs < minAgeMs) {
    if (modLogId) {
      const ch = guild.channels.cache.get(modLogId) as TextChannel | undefined;
      ch?.send(`⚠️ Young account verified: **${member.user.tag}** (${Math.round(accountAgeMs / 86400000)}d old)`).catch(() => {});
    }
  }

  if (unverified && member.roles.cache.has(unverified.id)) {
    await member.roles.remove(unverified).catch(() => {});
  }
  if (!member.roles.cache.has(player.id)) {
    await member.roles.add(player);
  }

  return `Welcome, ${member.displayName}! Head to #${CHANNELS.gameChat} and https://grokhack.mondello.dev/play.html`;
}

export function isVerifyButton(customId: string): boolean {
  return customId === VERIFY_BUTTON;
}