/** Minimal types for irc-upd (no published @types). */
declare module "irc-upd" {
  import { EventEmitter } from "node:events";

  export interface IrcClientOptions {
    port?: number;
    secure?: boolean;
    channels?: string[];
    realName?: string;
    showErrors?: boolean;
    debug?: boolean;
    autoConnect?: boolean;
    autoRejoin?: boolean;
    retryCount?: number | null;
    retryDelay?: number;
    floodProtection?: boolean;
    floodProtectionDelay?: number;
    userName?: string;
    password?: string;
  }

  export class Client extends EventEmitter {
    constructor(server: string, nick: string, opts?: IrcClientOptions);
    say(target: string, text: string): void;
    notice(target: string, text: string): void;
    join(channel: string, callback?: () => void): void;
    part(channel: string, message?: string): void;
    disconnect(message?: string, callback?: () => void): void;
    send(...args: string[]): void;
    out: {
      showErrors: boolean;
      showDebug: boolean;
      error: (...args: unknown[]) => void;
      debug: (...args: unknown[]) => void;
    };
  }
}
