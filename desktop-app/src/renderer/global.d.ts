import type { DesktopApi } from '../shared/contracts.ts';

declare global {
  interface Window {
    desktopApi: DesktopApi;
  }
}

export {};
