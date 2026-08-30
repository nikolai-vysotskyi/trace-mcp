import { useEffect, useState } from 'react';

/**
 * Is this window's document on screen right now?
 *
 * Every project tab is its own BrowserWindow, and on macOS only the selected
 * tab of a tab group is on screen — the rest report `hidden`. Anything a tab
 * holds open permanently is therefore multiplied by the number of tabs while
 * only one of them can be looked at, which is what this hook exists to stop
 * (TRA-526).
 */
export function useDocumentVisible(): boolean {
  const [visible, setVisible] = useState(() => document.visibilityState === 'visible');
  useEffect(() => {
    const onChange = () => setVisible(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', onChange);
    onChange(); // the state may have moved between render and effect
    return () => document.removeEventListener('visibilitychange', onChange);
  }, []);
  return visible;
}
