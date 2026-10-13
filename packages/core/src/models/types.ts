export interface AccountEntity {
  id: string;
  name: string;
  offbudget: boolean;
  closed: boolean;
  sort_order: number;
  last_reconciled: string | null;
  balance: number;
  cleared: number;
  uncleared: number;
}

export interface PayeeEntity {
  id: string;
  name: string;
  transfer_acct: string | null;
  favorite: boolean;
  learn_categories: boolean;
}

export interface CategoryEntity {
  id: string;
  name: string;
  group: string;
  is_income: boolean;
  hidden: boolean;
  sort_order: number;
}

export interface CategoryGroupEntity {
  id: string;
  name: string;
  is_income: boolean;
  hidden: boolean;
  sort_order: number;
  categories: CategoryEntity[];
}

export interface TransactionEntity {
  id: string;
  account: string;
  date: string;
  amount: number;
  payee: string | null;
  category: string | null;
  notes: string | null;
  cleared: boolean;
  reconciled: boolean;
  parent_id: string | null;
  is_parent: boolean;
  is_child: boolean;
  transfer_id: string | null;
  schedule: string | null;
  imported_id: string | null;
  imported_payee: string | null;
  starting_balance_flag: boolean;
  sort_order: number;
  subtransactions?: TransactionEntity[];
  balance?: number;
}

export type NewTransaction = Partial<Omit<TransactionEntity, 'subtransactions'>> & {
  account: string;
  date: string;
  amount?: number;
  payee_name?: string;
  subtransactions?: (Partial<TransactionEntity> & { payee_name?: string })[];
};
