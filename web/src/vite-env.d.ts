/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_CONTRACT_ID?: string;
  readonly VITE_RPC_URL?: string;
  readonly VITE_NETWORK?: string;
  readonly VITE_POLL_MS?: string;
  readonly VITE_SESSION_KEYS?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
