import { XMLParser } from 'fast-xml-parser';
import type { Entry } from '../vault/VaultService.js';
import { baseName } from '../vault/paths.js';

export type PropfindRequest = { kind: 'allprop' } | { kind: 'propname' } | { kind: 'prop'; names: string[] };

const LIVE_PROPS = [
  'displayname',
  'resourcetype',
  'getcontentlength',
  'getcontenttype',
  'getetag',
  'getlastmodified',
  'creationdate',
  'supportedlock',
  'lockdiscovery',
] as const;

// Keine Entity-Auflösung: PROPFIND braucht sie nicht (Schutz vor Entity-Expansion)
const parser = new XMLParser({ ignoreAttributes: true, removeNSPrefix: true, processEntities: false, htmlEntities: false });

export function parsePropfindBody(xml: string): PropfindRequest {
  if (!xml.trim()) return { kind: 'allprop' };
  const doc = parser.parse(xml, true);
  const pf = doc?.propfind;
  if (pf === undefined) throw new Error('kein propfind-Element');
  if (pf === '' || pf?.allprop !== undefined) return { kind: 'allprop' };
  if (pf?.propname !== undefined) return { kind: 'propname' };
  if (pf?.prop !== undefined) {
    const prop = pf.prop;
    const names = prop && typeof prop === 'object' ? Object.keys(prop) : [];
    return { kind: 'prop', names };
  }
  return { kind: 'allprop' };
}

const esc = (s: string) => s.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]!);

function propValue(name: string, e: Entry): string | undefined {
  switch (name) {
    case 'displayname':
      return `<D:displayname>${esc(baseName(e.path))}</D:displayname>`;
    case 'resourcetype':
      return e.isDir ? '<D:resourcetype><D:collection/></D:resourcetype>' : '<D:resourcetype/>';
    case 'getcontentlength':
      return e.isDir ? undefined : `<D:getcontentlength>${e.size}</D:getcontentlength>`;
    case 'getcontenttype':
      return e.isDir ? undefined : `<D:getcontenttype>${esc(e.mime ?? 'application/octet-stream')}</D:getcontenttype>`;
    case 'getetag':
      return `<D:getetag>"${esc(e.etag)}"</D:getetag>`;
    case 'getlastmodified':
      return `<D:getlastmodified>${new Date(e.mtimeMs).toUTCString()}</D:getlastmodified>`;
    case 'creationdate':
      return `<D:creationdate>${new Date(e.mtimeMs).toISOString()}</D:creationdate>`;
    case 'supportedlock':
      return '<D:supportedlock/>';
    case 'lockdiscovery':
      return '<D:lockdiscovery/>';
  }
  return undefined;
}

export function buildMultistatus(entries: Entry[], req: PropfindRequest, href: (rel: string, isDir: boolean) => string): string {
  const out: string[] = ['<?xml version="1.0" encoding="utf-8"?>', '<D:multistatus xmlns:D="DAV:">'];
  for (const e of entries) {
    out.push(`<D:response><D:href>${esc(href(e.path, e.isDir))}</D:href>`);
    if (req.kind === 'propname') {
      out.push(`<D:propstat><D:prop>${LIVE_PROPS.map((n) => `<D:${n}/>`).join('')}</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>`);
    } else {
      const names = req.kind === 'allprop' ? LIVE_PROPS : req.names;
      const found: string[] = [];
      const missing: string[] = [];
      for (const n of names) {
        const v = propValue(n, e);
        if (v !== undefined) found.push(v);
        else missing.push(`<D:${n}/>`.replace(/^<D:([^/]*:)/, '<D:'));
      }
      if (found.length) out.push(`<D:propstat><D:prop>${found.join('')}</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>`);
      if (missing.length && req.kind === 'prop') {
        out.push(`<D:propstat><D:prop>${missing.join('')}</D:prop><D:status>HTTP/1.1 404 Not Found</D:status></D:propstat>`);
      }
    }
    out.push('</D:response>');
  }
  out.push('</D:multistatus>');
  return out.join('');
}
