/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE_URL?: string;
  readonly VITE_OPENRM_ORGANIZATION_ID?: string;
  readonly VITE_OPENRM_PROJECT_ID?: string;
  readonly VITE_OPENRM_TOKEN?: string;
  readonly VITE_OPENRM_REVIEWER_TOKEN?: string;
  readonly VITE_OPENRM_REVIEWER_SUBJECT?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

