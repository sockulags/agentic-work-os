/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_AWOS_HOST?: string;
  readonly VITE_AWOS_PORT?: string;
  readonly VITE_AWOS_TOKEN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

interface Window {
  /** Injected by the Tauri shell before the app script runs. Absent in a browser. */
  __AWOS__?: { host: string; port: number; token: string };
}
