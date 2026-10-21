import './polyfills';
import { Engine } from '@envelope/core';
import { expoDriver } from './expo-driver';
import { createSqlJsShim } from './sqljs-compat';
import { DeviceStorage } from './storage';

export const storage = new DeviceStorage();

// One engine for the whole app, running the same code as the web app.
export const engine = new Engine({
  storage,
  sqlJs: createSqlJsShim(expoDriver) as any,
  persistDelay: 400,
  syncDelay: 1500,
});

let started: Promise<void> | null = null;

/** Initialise the engine and reopen the last budget, once. */
export function startEngine(): Promise<void> {
  started ??= (async () => {
    await engine.init();
    const last = await storage.getItem('lastFile');
    if (last) {
      try {
        await engine.loadFile(last);
      } catch {
        await storage.setItem('lastFile', null);
      }
    }
  })();
  return started;
}

export function send<T = any>(name: string, args?: unknown): Promise<T> {
  return engine.send(name, args) as Promise<T>;
}
