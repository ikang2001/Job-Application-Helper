import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('桌面端页面缺少根节点');

createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
