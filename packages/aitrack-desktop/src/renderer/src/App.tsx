import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { NavLink, Route, Routes, useNavigate } from 'react-router';

import { CommitsScreen } from './screens/Commits';
import { CostScreen } from './screens/Cost';
import { LeverageScreen } from './screens/Leverage';
import { MachinesScreen } from './screens/Machines';
import { Onboarding } from './screens/Onboarding';
import { Overview } from './screens/Overview';
import { ReposScreen } from './screens/Repos';
import { SessionsScreen } from './screens/Sessions';
import { SettingsScreen } from './screens/Settings';
import { TokensScreen } from './screens/Tokens';
import { ask } from './types';

const LINKS = [
  ['/', 'Overview'],
  ['/sessions', 'Sessions'],
  ['/commits', 'Commits'],
  ['/repos', 'Repos'],
  ['/cost', 'Cost'],
  ['/leverage', 'Leverage'],
  ['/machines', 'Machines'],
  ['/settings', 'Settings'],
] as const;

export function App() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const bootstrap = useQuery({
    queryKey: ['bootstrap'],
    queryFn: () => ask('bootstrap'),
  });

  useEffect(() => {
    const theme = bootstrap.data?.theme ?? 'system';
    const dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    const resolved = theme === 'system' ? (dark ? 'dark' : 'light') : theme;
    document.documentElement.dataset.theme = resolved;
  }, [bootstrap.data?.theme]);

  useEffect(
    () => window.aitrack.onChanged(() => void queryClient.invalidateQueries()),
    [queryClient],
  );

  useEffect(() => {
    if (bootstrap.data && !bootstrap.data.onboarded) {
      void navigate('/welcome');
    }
  }, [bootstrap.data, navigate]);

  const pad = bootstrap.data?.platform === 'darwin' ? 'pl-[86px]' : 'pl-5';

  return (
    <>
      <div className="mesh" />
      <div className="relative z-10 flex h-full flex-col">
        <header className={`drag flex h-[52px] items-center ${pad} pr-5`}>
          <span className="num text-[18px]">aitrack</span>
          <span className="ml-3 text-[13px] text-[var(--muted)]">
            How much are the tools actually giving you?
          </span>
        </header>
        <div className="flex min-h-0 flex-1 gap-4 px-4 pb-4">
          <nav className="glass pane no-drag settle flex w-[196px] shrink-0 flex-col gap-1 p-3">
            {LINKS.map(([to, label]) => (
              <NavLink key={to} to={to} end={to === '/'} className="nav-link">
                {label}
              </NavLink>
            ))}
          </nav>
          <main className="no-drag min-w-0 flex-1 overflow-auto">
            <Routes>
              <Route path="/welcome" element={<Onboarding />} />
              <Route path="/" element={<Overview />} />
              <Route path="/sessions" element={<SessionsScreen />} />
              <Route path="/commits" element={<CommitsScreen />} />
              <Route path="/repos" element={<ReposScreen />} />
              <Route path="/cost" element={<CostScreen />} />
              <Route path="/leverage" element={<LeverageScreen />} />
              <Route path="/machines" element={<MachinesScreen />} />
              <Route path="/settings" element={<SettingsScreen />} />
              <Route path="/tokens" element={<TokensScreen />} />
            </Routes>
          </main>
        </div>
      </div>
    </>
  );
}
