import { isRecord } from 'aitrack-lib/data/guards';
import { errorMessage } from 'aitrack-lib/errors';

import type { AppState, Settings } from '../shared/types.js';
import type { QuotaService } from './service.js';
import { normalizeSettings } from './settings.js';

/**
 * JSON lines between the Tauri shell and this sidecar: requests carry an id
 * and get exactly one response; events flow the other way unprompted.
 */
export interface SidecarRequest {
  id: number;
  method: string;
  params?: unknown;
}

export interface TrayImage {
  /** Straight RGBA, base64. */
  rgba: string;
  size: number;
  tooltip: string;
  /** Let macOS choose the monochrome foreground for its menu-bar appearance. */
  template: boolean;
}

export type SidecarMessage =
  | { id: number; result: unknown }
  | { id: number; error: string }
  | { event: 'state'; data: AppState }
  | { event: 'settings'; data: Settings }
  | { event: 'alert'; data: { title: string; body: string } }
  | { event: 'tray'; data: TrayImage };

export interface HandlerContext {
  service: QuotaService;
  settings: () => Settings;
  saveSettings: (settings: Settings) => Promise<Settings>;
}

export function parseRequest(line: string): SidecarRequest | undefined {
  try {
    const value: unknown = JSON.parse(line);
    if (!isRecord(value)) return undefined;
    const { id, method, params } = value;
    if (typeof id !== 'number' || typeof method !== 'string') return undefined;
    return { id, method, params };
  } catch {
    return undefined;
  }
}

/** The result, or a promise of it for methods that must finish first. */
function dispatch(request: SidecarRequest, context: HandlerContext): unknown {
  switch (request.method) {
    case 'getState': {
      return context.service.state();
    }
    case 'refresh': {
      // Progress reaches the shell as state events, so the reply need not wait for a cold parse.
      void context.service.refresh(true);
      return null;
    }
    case 'sync': {
      void context.service.sync();
      return null;
    }
    case 'getSettings': {
      return context.settings();
    }
    case 'saveSettings': {
      return context.saveSettings(normalizeSettings(request.params));
    }
    default: {
      throw new Error(`Unknown method ${request.method}`);
    }
  }
}

/** One response per request, errors included, so the shell never waits forever. */
export async function handleRequest(
  request: SidecarRequest,
  context: HandlerContext,
): Promise<SidecarMessage> {
  try {
    return { id: request.id, result: await dispatch(request, context) };
  } catch (error) {
    return { id: request.id, error: errorMessage(error) };
  }
}
