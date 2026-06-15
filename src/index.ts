import { Hono } from 'hono';
import { authMiddleware } from './middleware/auth';
import { tenantMiddleware } from './middleware/tenant';
import { rateLimitMiddleware } from './middleware/rateLimit';
import { contactsRouter } from './routes/contacts';
import { messagesRouter } from './routes/messages';
import { broadcastsRouter } from './routes/broadcasts';
import { billingRouter } from './routes/billing';
import { filesRouter } from './routes/files';
import { webhooksRouter } from './routes/webhooks';
import { auditRouter } from './routes/audit';
import { handleBroadcastQueue } from './workers/broadcastConsumer';
import type { Bindings, Variables } from './types';

export type { Bindings, Variables } from './types';

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// Health check (no auth)
app.get('/health', (c) => c.json({ status: 'ok', timestamp: new Date().toISOString() }));

// Global middleware chain for /api/* routes
app.use('/api/*', authMiddleware);
app.use('/api/*', tenantMiddleware);
app.use('/api/*', rateLimitMiddleware);

// Route modules
app.route('/api/contacts', contactsRouter);
app.route('/api/messages', messagesRouter);
app.route('/api/broadcasts', broadcastsRouter);
app.route('/api/billing', billingRouter);
app.route('/api/files', filesRouter);
app.route('/api/audit', auditRouter);

// Webhook endpoints (no auth middleware)
app.route('/webhooks', webhooksRouter);

export default {
  fetch: app.fetch,
  queue: handleBroadcastQueue,
};
