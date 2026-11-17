import express from 'express';
import cookieParser from 'cookie-parser';
import multer from 'multer';
import home from './handlers/home';
import { mountAccounting } from './engine';

const app = express();
// Web Request handlers receive the original body, before Express's JSON parser.
const accounting = process.env.ACCOUNTING_AUTH_SECRET ? await mountAccounting(app) : null;
app.get('/health', async (_request, response) => {
  try {
    if (accounting) await accounting.client.execute('SELECT 1');
    response.json({ status: 'ok', accounting: !!accounting });
  } catch {
    response.status(503).json({ status: 'unavailable' });
  }
});
// Existing Turso/Google/Stripe deployments can retain the original endpoints.
const legacy = Boolean(process.env.DATABASE_URL && process.env.STRIPE_SECRET_KEY);
// Stripe signs the raw body, so the legacy webhook is registered before the JSON parser.
if (legacy && process.env.STRIPE_WEBHOOK_SECRET) {
  const stripeWebhook = await import('./handlers/stripeWebhook');
  app.post('/stripe-webhook', stripeWebhook.rawBody, stripeWebhook.default);
}
app.use(express.json());
app.use(cookieParser());
app.use(express.static('public'));
app.get('/', home);

if (legacy) {
  const handlers = await import('./handlers');
  app.use((request, response, next) => {
    const origin = request.get('origin');
    const allowed = (process.env.LEGACY_ALLOWED_ORIGINS ?? 'https://xfactura.ro').split(',');
    if (origin && allowed.includes(origin)) {
      response.header('Access-Control-Allow-Origin', origin);
      response.header('Access-Control-Allow-Credentials', 'true');
      response.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      response.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    }
    if (request.method === 'OPTIONS') {
      response.sendStatus(204);
      return;
    }
    next();
  });
  const upload = multer({ storage: multer.memoryStorage() });
  app.post('/get-user', handlers.getUser);
  app.post('/company-details', handlers.companyDetails);
  app.post('/logout', handlers.logout);
  app.post('/google-login', handlers.googleLogin);
  app.post('/google-upload-database', upload.single('file'), handlers.googleUploadDatabase);
  app.get('/stripe-checkout-sessions', handlers.checkoutSessions);
  app.post('/stripe-checkout-sessions', handlers.checkoutSessions);
  app.post('/process-intelligent-act', handlers.processIntelligentAct);
  app.post('/store-prompt', handlers.storePrompt);
}
const port = Number(process.env.PORT ?? 8089);
const server = app.listen(port, '0.0.0.0', () => console.log(`xFactura API listening on ${port}.`));
// The process exits once closed: keep-alive sockets from the web proxy would otherwise hold the
// server open, and under `bun --watch` a finished script keeps the process waiting for changes.
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  server.close();
  server.closeAllConnections();
  if (accounting) await accounting.close();
  process.exit(0);
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
