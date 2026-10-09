import type { FastifyInstance } from 'fastify';
import * as oidc from 'openid-client';
import type { Config } from '../config.js';
import type { Db } from '../db/knex.js';
import { cookieOptions } from './plugin.js';
import { createSession, SESSION_COOKIE, SESSION_TTL_MS } from './sessions.js';
import { createUser, findUserByEmail, normalizeEmail } from './users.js';

const FLOW_COOKIE = 'ow_oidc';

/** Optionaler Login über Microsoft Entra ID (nur registriert, wenn ENTRA_* gesetzt ist). */
export async function entraRoutes(app: FastifyInstance, opts: { db: Db; config: Config }) {
  const { db, config } = opts;
  const entra = config.entra!;
  const redirectUri = `${config.baseUrl}/auth/callback`;
  let configuration: oidc.Configuration | undefined;
  const getConfig = async () =>
    (configuration ??= await oidc.discovery(
      new URL(`https://login.microsoftonline.com/${entra.tenantId}/v2.0`),
      entra.clientId,
      entra.clientSecret,
    ));

  app.get('/auth/entra/login', async (_req, reply) => {
    const cfg = await getConfig();
    const verifier = oidc.randomPKCECodeVerifier();
    const state = oidc.randomState();
    const nonce = oidc.randomNonce();
    const url = oidc.buildAuthorizationUrl(cfg, {
      redirect_uri: redirectUri,
      scope: 'openid profile email',
      code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
      code_challenge_method: 'S256',
      state,
      nonce,
    });
    reply.setCookie(FLOW_COOKIE, JSON.stringify({ verifier, state, nonce }), {
      ...cookieOptions(config.baseUrl, 600),
      path: '/auth',
      signed: true,
    });
    return reply.redirect(url.href);
  });

  app.get('/auth/callback', async (req, reply) => {
    const fail = (msg: string) => reply.redirect(`/login?error=${encodeURIComponent(msg)}`);
    const raw = req.cookies[FLOW_COOKIE];
    const unsigned = raw ? req.unsignCookie(raw) : undefined;
    reply.clearCookie(FLOW_COOKIE, { path: '/auth' });
    if (!unsigned?.valid || !unsigned.value) return fail('Anmeldevorgang abgelaufen, bitte erneut versuchen');
    const flow = JSON.parse(unsigned.value) as { verifier: string; state: string; nonce: string };

    let claims: oidc.IDToken | undefined;
    try {
      const tokens = await oidc.authorizationCodeGrant(await getConfig(), new URL(req.url, config.baseUrl), {
        pkceCodeVerifier: flow.verifier,
        expectedState: flow.state,
        expectedNonce: flow.nonce,
      });
      claims = tokens.claims();
    } catch (err) {
      req.log.warn({ err }, 'Entra-Login fehlgeschlagen');
      return fail('Anmeldung bei Microsoft fehlgeschlagen');
    }
    if (!claims) return fail('Keine Identitätsdaten erhalten');
    const oid = String(claims.oid ?? '');
    const tid = String(claims.tid ?? '');
    const email = normalizeEmail(String(claims.email ?? claims.preferred_username ?? ''));
    if (!oid) return fail('Kein Benutzer-Identifier (oid) im Token');
    if (!entra.allowedTenants.includes(tid)) return fail('Dieser Mandant ist nicht zugelassen');

    let user = await db('users').where({ entra_oid: oid }).first();
    if (!user && email) {
      user = await findUserByEmail(db, email);
      if (user) {
        if (user.entra_oid && user.entra_oid !== oid) return fail('Konto ist bereits mit einer anderen Microsoft-Identität verknüpft');
        await db('users').where({ id: user.id }).update({ entra_oid: oid, tenant_id: tid });
      }
    }
    if (!user) {
      if (!entra.autoCreate || !email) return fail('Kein Konto für diese Microsoft-Identität vorhanden');
      user = await createUser(db, { email, displayName: String(claims.name ?? email), entraOid: oid, tenantId: tid });
    }
    const { token } = await createSession(db, user.id);
    reply.setCookie(SESSION_COOKIE, token, cookieOptions(config.baseUrl, SESSION_TTL_MS / 1000));
    return reply.redirect('/');
  });
}
