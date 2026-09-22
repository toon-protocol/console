import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { ConsoleApp } from '@/app/console-app';
import { adoptLaunchToken } from '@/lib/launch-token';

import './globals.css';

// Before the first render, and before anything can read the address bar: take
// the launch token off the URL and keep it in this tab.
adoptLaunchToken(window.location, window.history);

const root = document.getElementById('app');
if (!root) throw new Error('Root element #app not found');

createRoot(root).render(
  <StrictMode>
    <ConsoleApp />
  </StrictMode>
);
