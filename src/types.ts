export interface Env {
  DB: D1Database;
  MEDIA: R2Bucket;
  CACHE: KVNamespace;
  ASSETS: Fetcher;
  /** Worker Loader — loads L3 theme Workers at runtime. Optional: absent on
   *  older deploys, and the runtime degrades to L1/L2 rendering when missing. */
  LOADER?: WorkerLoader;
  /** Fetcher pointing back at this Worker, handed to theme Workers so they can
   *  read content through the sandboxed theme API rather than raw bindings. */
  THEME_HOST?: Fetcher;
}

export interface User {
  id: string;
  username: string;
  email?: string | null;
  role: string;
  status: string;
}

export interface SessionUser extends User {
  sessionId: string;
}

export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
