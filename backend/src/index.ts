import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import cookieParser from 'cookie-parser';
import { config } from './config';
import chatRoutes from './routes/chat';
import documentRoutes from './routes/documents';
import {
  authenticateAzureAdRequest,
  generateAuthState,
  getAzureAdLoginUrl,
  handleAzureAdCallback,
  signOutAzureAd,
  STATE_COOKIE,
} from './services/azureAdAuth';

const app = express();

// Middleware
app.use(cors({ origin: true, credentials: true }));
app.use(cookieParser());
app.use(express.json());

const publicDir = path.join(__dirname, '..', 'public');
const publicIndexHtmlPath = path.join(publicDir, 'index.html');
const hasBuiltFrontend = fs.existsSync(publicIndexHtmlPath);

if (hasBuiltFrontend) {
  app.use(express.static(publicDir));
}

// Routes
app.use(chatRoutes);
app.use(documentRoutes);

app.get('/api/config', (req, res) => {
  res.json({
    azureAdClientId: config.azureAd.clientId || '',
    azureAdTenantId: config.azureAd.tenantId || '',
    azureAdRedirectUri: config.azureAd.redirectUri || '',
    azureAdCertThumbprint: config.azureAd.certThumbprint || '',
  });
});

// Azure AD certificate-based authentication routes
app.get('/api/auth/login', async (req, res) => {
  try {
    const state = generateAuthState();
    res.cookie(STATE_COOKIE, state, {
      httpOnly: true,
      sameSite: 'lax',
      secure: config.nodeEnv === 'production',
      maxAge: 10 * 60 * 1000,
    });
    const url = await getAzureAdLoginUrl(state);
    res.redirect(url);
  } catch (error) {
    console.error('[AzureAD] Failed to build login URL:', error);
    res.status(500).json({ error: 'Azure AD login is not available' });
  }
});

app.get('/api/auth/callback', async (req, res) => {
  try {
    await handleAzureAdCallback(req, res);
  } catch (error) {
    console.error('[AzureAD] Callback failed:', error);
    res.redirect('/?error=azure_ad_auth_failed');
  }
});

app.get('/api/auth/me', async (req, res) => {
  try {
    const user = await authenticateAzureAdRequest(req);
    res.json({ email: user.email, name: user.name });
  } catch (error) {
    res.status(401).json({ error: 'Not authenticated' });
  }
});

app.get('/api/auth/logout', (req, res) => {
  signOutAzureAd(res);
  res.redirect('/');
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

if (hasBuiltFrontend) {
  app.get('*', (req, res) => {
    res.sendFile(publicIndexHtmlPath);
  });
} else {
  app.get('/', (req, res) => {
    res.json({ status: 'ok', message: 'Backend is running. Frontend build not found.' });
  });
}

// Start server
app.listen(config.port, () => {
  console.log(`Server running on port ${config.port}`);
  console.log(`Environment: ${config.nodeEnv}`);
});
