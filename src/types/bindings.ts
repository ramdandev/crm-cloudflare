/**
 * Cloudflare Workers environment bindings.
 * These represent the resources and secrets configured in wrangler.toml.
 */
export type Bindings = {
  /** Cloudflare D1 SQL database for all CRM transactional data */
  DB: D1Database;
  /** Cloudflare KV for caching, rate limiting, and tenant resolution */
  KV: KVNamespace;
  /** Cloudflare R2 for file and media storage */
  R2: R2Bucket;
  /** Cloudflare Queue for broadcast message processing */
  BROADCAST_QUEUE: Queue;
  /** Clerk secret key for session token verification */
  CLERK_SECRET_KEY: string;
  /** Go-Wa gateway base URL */
  GOWA_BASE_URL: string;
  /** Go-Wa gateway API key */
  GOWA_API_KEY: string;
  /** Meta Cloud API access token for WhatsApp Business */
  META_ACCESS_TOKEN: string;
  /** Meta WhatsApp Business phone number ID */
  META_PHONE_NUMBER_ID: string;
  /** iPaymu API key for payment processing */
  IPAYMU_API_KEY: string;
  /** iPaymu virtual account number */
  IPAYMU_VA: string;
  /** iPaymu shared secret for webhook signature validation */
  IPAYMU_SECRET: string;
};

/**
 * Hono context variables set by middleware.
 * Available to route handlers after middleware execution.
 */
export type Variables = {
  /** Resolved tenant ID from org-to-tenant resolution */
  tenantId: string;
  /** Authenticated user ID from Clerk */
  userId: string;
  /** Clerk Organization ID from session token */
  orgId: string;
  /** RBAC permissions from Clerk Organizations */
  permissions: string[];
};
