export interface User {
  id: number;
  email: string;
  displayName: string;
  isAdmin: boolean;
  hasPassword: boolean;
  entraLinked: boolean;
}

export interface Me {
  user: User;
  csrf: string;
  davUrl: string;
  attachmentsDir: string;
}

export interface TreeEntry {
  path: string;
  isDir: boolean;
  size: number;
  mtimeMs: number;
}

export interface NoteFile {
  path: string;
  content: string;
  etag: string;
  mtimeMs: number;
}

export type LogoVariant = 'light' | 'dark';
export type Branding = Record<LogoVariant, string | null>;

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public body: any,
  ) {
    super(message);
  }
}

let csrfToken = '';
export const setCsrf = (t: string) => (csrfToken = t);

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  let payload: BodyInit | undefined;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  if (method !== 'GET') headers['X-CSRF-Token'] = csrfToken;
  const res = await fetch(url, { method, headers, body: payload, credentials: 'same-origin' });
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : null;
  if (!res.ok) throw new ApiError(res.status, data?.error ?? res.statusText, data);
  return data as T;
}

const q = (p: string) => encodeURIComponent(p);

export const api = {
  providers: () => request<{ local: boolean; entra: boolean }>('GET', '/auth/providers'),
  login: (email: string, password: string) => request<{ user: User; csrf: string }>('POST', '/auth/login', { email, password }),
  logout: () => request('POST', '/auth/logout'),
  me: () => request<Me>('GET', '/api/me'),
  tree: () => request<{ entries: TreeEntry[] }>('GET', '/api/tree'),
  read: (path: string) => request<NoteFile>('GET', `/api/file?path=${q(path)}`),
  save: (path: string, content: string, etag?: string, overwrite = false) =>
    request<{ path: string; etag: string; mtimeMs: number }>('PUT', '/api/file', { path, content, etag, overwrite }),
  remove: (path: string) => request('DELETE', `/api/file?path=${q(path)}`),
  move: (from: string, to: string) => request<{ path: string }>('POST', '/api/move', { from, to }),
  mkdir: (path: string) => request<{ path: string }>('POST', '/api/mkdir', { path }),
  search: (term: string) => request<{ hits: Array<{ path: string; snippet: string }> }>('GET', `/api/search?q=${q(term)}`),
  upload: (file: File, dir?: string) => {
    const fd = new FormData();
    fd.append('file', file, file.name);
    return request<{ path: string; name: string }>('POST', `/api/attachments${dir !== undefined ? `?dir=${q(dir)}` : ''}`, fd);
  },
  rawUrl: (path: string) => `/api/raw?path=${q(path)}`,
  changePassword: (current: string, next: string) => request('POST', '/api/me/password', { current, next }),
  appPasswords: () =>
    request<{ items: Array<{ id: number; label: string; lastUsedAt: number | null; createdAt: string }> }>('GET', '/api/app-passwords'),
  createAppPassword: (label: string) => request<{ id: number; label: string; token: string }>('POST', '/api/app-passwords', { label }),
  deleteAppPassword: (id: number) => request('DELETE', `/api/app-passwords/${id}`),
  users: () => request<{ users: User[] }>('GET', '/api/admin/users'),
  createUser: (u: { email: string; displayName: string; password?: string; isAdmin: boolean }) =>
    request<{ user: User }>('POST', '/api/admin/users', u),
  updateUser: (id: number, u: { displayName?: string; password?: string; isAdmin?: boolean }) =>
    request<{ user: User }>('PATCH', `/api/admin/users/${id}`, u),
  deleteUser: (id: number, deleteVault: boolean) => request('DELETE', `/api/admin/users/${id}?deleteVault=${deleteVault}`),
  reindex: () => request('POST', '/api/admin/reindex'),
  branding: () => request<Branding>('GET', '/branding'),
  uploadLogo: (variant: LogoVariant, file: File) => {
    const fd = new FormData();
    fd.append('file', file, file.name);
    return request<Branding>('POST', `/api/admin/branding/${variant}`, fd);
  },
  removeLogo: (variant: LogoVariant) => request<Branding>('DELETE', `/api/admin/branding/${variant}`),
};
