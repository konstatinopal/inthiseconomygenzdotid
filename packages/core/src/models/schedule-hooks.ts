import type { BudgetDb } from '../db';

// Breaks the import cycle between transactions and schedules: schedules.ts
// registers the handler, transactions.ts calls it when a transaction gets linked.
type Hook = (db: BudgetDb, scheduleId: string, date: string) => void;
let hook: Hook = () => {};

export function setScheduleLinkedHook(h: Hook) {
  hook = h;
}

export function onScheduleLinked(db: BudgetDb, scheduleId: string, date: string) {
  hook(db, scheduleId, date);
}
