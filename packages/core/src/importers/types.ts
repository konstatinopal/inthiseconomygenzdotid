export interface ParsedTransaction {
  date: string; // YYYY-MM-DD
  amount: number; // cents
  payee_name?: string | null;
  imported_payee?: string | null;
  notes?: string | null;
  category_name?: string | null;
  imported_id?: string | null;
}

export interface ParseResult {
  transactions: ParsedTransaction[];
  errors: string[];
}
