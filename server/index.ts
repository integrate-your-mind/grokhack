import { WorldServer } from "./world.js";
import { startTelnetServer } from "./telnet.js";
import { startHttpServer } from "./http.js";

const TELNET_PORT = parseInt(process.env.TELNET_PORT ?? "4000", 10);
const HTTP_PORT = parseInt(process.env.PORT ?? process.env.HTTP_PORT ?? "8080", 10);

const world = new WorldServer();

startTelnetServer(world, TELNET_PORT);
startHttpServer(world, HTTP_PORT);