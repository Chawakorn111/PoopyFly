/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly BASE_URL: string;
  /** Absolute origin serving /data/** binaries. Empty = same origin. */
  readonly VITE_DATA_BASE?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
