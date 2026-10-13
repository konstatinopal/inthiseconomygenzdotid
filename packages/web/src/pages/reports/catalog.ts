export const REPORTS = [
  { id: 'net-worth', title: 'Net worth', description: 'Assets, debts and net worth at each month end' },
  { id: 'cash-flow', title: 'Cash flow', description: 'Income versus expenses each month, with a running balance' },
  { id: 'spending', title: 'Spending analysis', description: 'This month’s cumulative spending versus last month and the average' },
  { id: 'custom', title: 'Custom report', description: 'Group by category, payee, account or group, over any interval' },
  { id: 'calendar', title: 'Calendar', description: 'Daily income and expenses for a month' },
  { id: 'age-of-money', title: 'Age of money', description: 'How many days old your money is when you spend it' },
] as const;

export type ReportId = (typeof REPORTS)[number]['id'];

export const SERIES = Array.from({ length: 8 }, (_, i) => `var(--series-${i + 1})`);
