/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly AZURE_AD_CLIENT_ID?: string;
  readonly AZURE_AD_TENANT_ID?: string;
  readonly AZURE_AD_REDIRECT_URI?: string;
  readonly AZURE_AD_CERT_THUMBPRINT?: string;
}
