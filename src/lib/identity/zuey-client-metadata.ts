/**
 * Client ID Metadata Document served at GET /oauth/zuey-client.json. Its URL is our client_id at zuey.me.
 * Only the production redirect URI is listed: loopback dev servers use Dynamic Client Registration instead
 * (see resolveZueyClient), so this document can never authorize a localhost redirect.
 */
import { CALLBACK_PATH, CIMD_PATH, ZUEY_SCOPE, siteOrigin } from './zuey-oauth-client';

export interface ClientMetadataDocument {
  client_id: string;
  client_name: string;
  client_uri: string;
  logo_uri: string;
  redirect_uris: string[];
  grant_types: string[];
  response_types: string[];
  token_endpoint_auth_method: 'none';
  scope: string;
}

export function buildClientMetadataDocument(publicSiteUrl: string): ClientMetadataDocument {
  const site = siteOrigin(publicSiteUrl);
  return {
    client_id: `${site}${CIMD_PATH}`,
    client_name: 'AI Unlocked',
    client_uri: site,
    logo_uri: `${site}/icons/icon.svg`,
    redirect_uris: [`${site}${CALLBACK_PATH}`],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    scope: ZUEY_SCOPE,
  };
}
