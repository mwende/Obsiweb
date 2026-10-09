import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, setCsrf, type Me } from './api';
import { Admin } from './pages/Admin';
import { Login } from './pages/Login';
import { Settings } from './pages/Settings';
import { Workspace } from './pages/Workspace';
import { navigate, useLocation } from './router';

export function App() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const loc = useLocation();

  const loadMe = useCallback(async () => {
    try {
      const m = await api.me();
      setCsrf(m.csrf);
      setMe(m);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) setMe(null);
      else throw e;
    }
  }, []);

  useEffect(() => {
    void loadMe();
  }, [loadMe]);

  if (me === undefined) return <div className="center muted">Lade …</div>;
  if (me === null || loc.pathname === '/login') {
    if (me && loc.pathname === '/login') {
      navigate('/', true);
      return null;
    }
    return <Login onLoggedIn={loadMe} />;
  }

  const logout = async () => {
    await api.logout();
    setMe(null);
    navigate('/', true);
  };

  if (loc.pathname === '/settings') return <Settings me={me} onLogout={logout} />;
  if (loc.pathname === '/admin' && me.user.isAdmin) return <Admin me={me} onLogout={logout} />;
  return <Workspace me={me} onLogout={logout} />;
}
