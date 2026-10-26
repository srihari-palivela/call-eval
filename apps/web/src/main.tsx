import React from 'react';
import ReactDOM from 'react-dom/client';
import { MantineProvider } from '@mantine/core';
import { Notifications } from '@mantine/notifications';
import '@mantine/core/styles.css';
import '@mantine/charts/styles.css';
import '@mantine/dropzone/styles.css';
import '@mantine/notifications/styles.css';
import './app.css';
import { cssResolver, theme } from './theme';
import { StoreProvider } from './store';
import { App } from './App';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <MantineProvider theme={theme} cssVariablesResolver={cssResolver} defaultColorScheme="auto">
      <Notifications position="bottom-right" />
      <StoreProvider>
        <App />
      </StoreProvider>
    </MantineProvider>
  </React.StrictMode>,
);
