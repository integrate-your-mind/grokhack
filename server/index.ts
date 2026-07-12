import { loadEnvFile } from "./load-env.js";

async function boot(): Promise<void> {
  // ESM evaluates static dependencies before entering boot(). Load .env first,
  // then import every module that may capture process.env at module scope.
  loadEnvFile();

  const [{ assertX402RuntimeSafety }, { resolveReleaseSha }] = await Promise.all([
    import("./x402.js"),
    import("./release.js"),
  ]);
  process.env.GROKHACK_RELEASE_SHA = resolveReleaseSha();
  assertX402RuntimeSafety();

  const [
    { WorldServer },
    { beginTelnetDrain, startTelnetServer },
    { beginHttpDrain, startHttpServer },
    { startChatBridge },
    { startDiscordBot },
    { BIND_HOST, TELNET_BIND_HOST },
    { closePersistence, flushPersistence, initPersistence },
    { shutdownRuntime },
  ] = await Promise.all([
    import("./world.js"),
    import("./telnet.js"),
    import("./http.js"),
    import("./bridge.js"),
    import("./discord-bot.js"),
    import("./security.js"),
    import("./persistence.js"),
    import("./shutdown.js"),
  ]);

  await initPersistence();
  const world = new WorldServer();
  await world.hydrateFromDatabase();

  startChatBridge({
    onExternalChat: (from, text, channel) => world.ingestExternalChat(from, text, channel),
  });

  startDiscordBot({
    onExternalChat: (from, text) => world.ingestExternalChat(from, text, "discord"),
  });

  const TELNET_PORT = parseInt(process.env.TELNET_PORT ?? "4000", 10);
  const HTTP_PORT = parseInt(process.env.PORT ?? process.env.HTTP_PORT ?? "8080", 10);

  const telnetServer = startTelnetServer(world, TELNET_PORT);
  const httpServer = startHttpServer(world, HTTP_PORT);

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[boot] ${signal} — draining admission and flushing durable world state`);
    const exitCode = await shutdownRuntime({
      world,
      beginTransports: () => [
        beginHttpDrain(httpServer),
        ...(telnetServer ? [beginTelnetDrain(telnetServer)] : []),
      ],
      flushPersistence,
      closePersistence,
    });
    process.exit(exitCode);
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));

  console.log(
    `[boot] http=${BIND_HOST}:${HTTP_PORT} telnet=${TELNET_BIND_HOST}:${TELNET_PORT} db=duckdb`
  );
}

boot().catch((err) => {
  console.error("[boot] failed:", err);
  process.exit(1);
});
