import { useEffect, useState } from 'react';

export function navigate(url: string, replace = false) {
  if (replace) history.replaceState(null, '', url);
  else history.pushState(null, '', url);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

export function useLocation() {
  const [loc, setLoc] = useState(() => ({ pathname: location.pathname, search: location.search }));
  useEffect(() => {
    const on = () => setLoc({ pathname: location.pathname, search: location.search });
    window.addEventListener('popstate', on);
    return () => window.removeEventListener('popstate', on);
  }, []);
  return loc;
}

export const noteUrl = (path: string) => `/?note=${encodeURIComponent(path)}`;
