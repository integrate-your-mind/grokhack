import { WorldServer } from "./world.js";
import { startTelnetServer } from "./telnet.js";
import { startHttpServer } from "./http.js";
import { startChatBridge } from "./bridge.js";
import { startDiscordBot } from "./discord-bot.js";
import { BIND_HOST } from "./security.js";

const TELNET_PORT = parseInt(process.env.TELNET_PORT ?? "4000", 10);
const HTTP_PORT = parseInt(process.env.PORT ?? process.env.HTTP_PORT ?? "8080", 10);

const world = new WorldServer();

startChatBridge({
  onExternalChat: (from, text, channel) => world.ingestExternalChat(from, text, channel),
});

startDiscordBot({
  onExternalChat: (from, text) => world.ingestExternalChat(from, text, "discord"),
});

startTelnetServer(world, TELNET_PORT);
startHttpServer(world, HTTP_PORT);

console.log(`[boot] bind=${BIND_HOST} http=${HTTP_PORT} telnet=${TELNET_PORT}`);