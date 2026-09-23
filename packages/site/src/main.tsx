import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { SiteApp } from './app/site-app';
import './site.css';

const root = document.getElementById('root');
if (root === null) throw new Error('The page has no #root to mount in.');
createRoot(root).render(
  <StrictMode>
    <SiteApp />
  </StrictMode>
);
