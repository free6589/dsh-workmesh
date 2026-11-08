import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { AppRoot } from './shell/AppRoot';
import './shell/shell.css';

const container = document.getElementById('root');
if (!container) throw new Error('#root 不存在');

createRoot(container).render(
  <StrictMode>
    <AppRoot />
  </StrictMode>,
);
